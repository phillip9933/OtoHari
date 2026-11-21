import Foundation

/// One protected account directory. Claiming a play removes it durably before any network write.
final class OfflineListenJournal: @unchecked Sendable {
    static let maxAge: Int64 = 14 * 24 * 60 * 60
    struct Status { let enabled: Bool, pending: Int }
    struct Row: Codable, Sendable {
        let id: Int64, occurrence: UUID, started: Int64, body: Data
    }
    struct Claim: Sendable { let row: Row, discardRevision: Int64, privacyRevision: Int64 }
    private struct Index: Codable {
        var revision: Int64 = 0, discardRevision: Int64 = 0, sequence: Int64 = 0
        var rows: [Row] = []
    }
    let account: String
    private let file: URL, lock = NSLock()
    private var index: Index
    private let rowLimit: Int, byteLimit: Int
    private let clock: @Sendable () -> Int64, changed: @Sendable () -> Void

    init(folder: URL, rowLimit: Int = 2048, byteLimit: Int = 4 * 1024 * 1024,
         clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) },
         changed: @escaping @Sendable () -> Void = {}) throws {
        self.account = folder.lastPathComponent
        self.rowLimit = rowLimit; self.byteLimit = byteLimit; self.clock = clock; self.changed = changed
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        file = folder.appendingPathComponent("listens.json")
        index = FileManager.default.fileExists(atPath: file.path)
            ? try JSONDecoder().decode(Index.self, from: Data(contentsOf: file)) : Index()
        _ = try status()
    }

    var revision: Int64 { lock.lock(); defer { lock.unlock() }; return index.revision }
    var discardRevision: Int64 { lock.lock(); defer { lock.unlock() }; return index.discardRevision }
    var last: Int64 { lock.lock(); defer { lock.unlock() }; return index.sequence }
    func permits(_ claim: Claim) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return index.discardRevision == claim.discardRevision && index.revision == claim.privacyRevision
    }
    private func valid(_ started: Int64, _ now: Int64) -> Bool { started >= now - Self.maxAge && started <= now + 60 }

    private func edit<T>(_ change: (inout Index, Int64, inout Bool) -> T) throws -> T {
        var dirty = false
        lock.lock()
        defer { lock.unlock(); if dirty { changed() } }
        let now = clock()
        var next = index
        if next.rows.contains(where: { !valid($0.started, now) }) {
            next.rows.removeAll { !valid($0.started, now) }
            dirty = true
        }
        let result = change(&next, now, &dirty)
        if dirty {
            var protection: Data.WritingOptions = [.atomic]
            #if os(iOS)
            protection.insert(.completeFileProtectionUntilFirstUserAuthentication)
            #endif
            do { try JSONEncoder().encode(next).write(to: file, options: protection) }
            catch { dirty = false; throw error }
            index = next
        }
        return result
    }
    func status() throws -> Status {
        try edit { value, _, _ in Status(enabled: value.revision.isMultiple(of: 2), pending: value.rows.count) }
    }
    func setEnabled(_ enabled: Bool) throws -> Status {
        try edit { value, _, dirty in
            if enabled != value.revision.isMultiple(of: 2) { value.revision += 1; dirty = true }
            return Status(enabled: enabled, pending: value.rows.count)
        }
    }
    func discard() throws -> Status {
        try edit { value, _, dirty in
            value.rows.removeAll(); value.discardRevision += 1; dirty = true
            return Status(enabled: value.revision.isMultiple(of: 2), pending: 0)
        }
    }
    private func bound(_ value: inout Index) {
        var used = value.rows.reduce(0) { $0 + $1.body.count }, remove = 0
        while value.rows.count - remove > rowLimit || used > byteLimit {
            used -= value.rows[remove].body.count
            remove += 1
        }
        value.rows.removeFirst(remove)
    }
    @discardableResult func add(_ event: PlaybackHistory.Event, unlessDiscarded expected: Int64) throws -> Bool {
        guard case .offline(let start) = event.route, event.operation == "submit", start.account == account,
              !event.trackID.isEmpty, event.duration > 0,
              [event.trackID, start.title, start.artist, start.album].reduce(0, { $0 + $1.utf8.count }) <= byteLimit else { return false }
        var body: [String: Any] = ["source":"local", "track_id":event.trackID, "track_name":start.title,
            "artist_name":start.artist, "duration_ms":event.duration, "timestamp":start.timestamp]
        if !start.album.isEmpty { body["album_name"] = start.album }
        let bytes = try JSONSerialization.data(withJSONObject: body)
        guard bytes.count <= byteLimit else { return false }
        return try edit { value, now, dirty in
            guard value.revision == start.revision, value.revision.isMultiple(of: 2), value.discardRevision == expected,
                  valid(start.timestamp, now), !value.rows.contains(where: { $0.occurrence == event.occurrence }) else { return false }
            value.sequence += 1
            value.rows.append(Row(id: value.sequence, occurrence: event.occurrence, started: start.timestamp, body: bytes))
            bound(&value); dirty = true
            return true
        }
    }
    func claim(through: Int64) throws -> Claim? {
        try edit { value, _, dirty in
            guard value.revision.isMultiple(of: 2), let next = value.rows.first, next.id <= through else { return nil }
            value.rows.removeFirst(); dirty = true
            return Claim(row: next, discardRevision: value.discardRevision, privacyRevision: value.revision)
        }
    }
    func retry(_ claim: Claim) throws {
        try edit { value, now, dirty in
            guard claim.discardRevision == value.discardRevision, valid(claim.row.started, now),
                  !value.rows.contains(where: { $0.id == claim.row.id }) else { return }
            let at = value.rows.firstIndex { $0.id > claim.row.id } ?? value.rows.endIndex
            value.rows.insert(claim.row, at: at); bound(&value); dirty = true
        }
    }
}
