import Foundation

/// The catalogue and cursor carry the same revision. A partially updated cursor
/// can never move an older playlist, even across a process restart.
final class PlaybackArchive {
    struct Cursor: Codable {
        var revision: UUID, index: Int, position: Double, repeatMode: String
    }
    struct Previous: Codable {
        let tracks: [OfflineFiles.Track], cursor: Cursor, continuation: LibraryContinuation?
        let order: PlayerQueueOrder.Saved?, playing: Bool
    }
    struct Record: Codable {
        let tracks: [OfflineFiles.Track]
        var cursor: Cursor
        var continuation: LibraryContinuation?
        var order: PlayerQueueOrder.Saved?
        var previous: Previous?
    }
    private let queueURL: URL, cursorURL: URL
    private let files = FileManager.default
    init(folder: URL) throws {
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        queueURL = folder.appendingPathComponent("queue.json")
        cursorURL = folder.appendingPathComponent("cursor.json")
    }
    private func valid(_ cursor: Cursor, count: Int) -> Bool {
        return cursor.index >= 0 && cursor.index < count && cursor.position.isFinite && cursor.position >= 0 &&
            ["one", "all", "off"].contains(cursor.repeatMode)
    }
    /// Persist the typed catalogue whitelist and only relative DN resource paths.
    private func safe(_ input: OfflineFiles.Track) throws -> OfflineFiles.Track {
        var track = input
        guard !track.id.isEmpty, track.id != ".", track.id != "..", !track.id.contains("/"), !track.id.contains("\\"),
              let stream = URLComponents(string: track.streamUrl), stream.scheme == nil, stream.host == nil,
              stream.path == "/api/v3/stream/local/" + track.id else { throw OfflineFiles.Failure("Invalid saved track.") }
        track.streamUrl = stream.percentEncodedPath
        if let art = track.artworkUrl, let url = URLComponents(string: art), url.scheme == nil, url.host == nil,
           url.path.hasPrefix("/api/v3/"), !url.path.split(separator: "/").contains("..") {
            let size = url.queryItems?.first { $0.name == "size" }?.value.flatMap(Int.init)
            track.artworkUrl = url.percentEncodedPath
            if let size, (1...9999).contains(size) { track.artworkUrl = url.percentEncodedPath + "?size=" + String(size) }
        } else { track.artworkUrl = nil }
        return track
    }
    private func checked(_ tracks: [OfflineFiles.Track], _ cursor: Cursor, _ continuation: LibraryContinuation?,
                         _ order: PlayerQueueOrder.Saved?) throws -> [OfflineFiles.Track] {
        guard tracks.count <= 2000 && valid(cursor, count: tracks.count) else { throw OfflineFiles.Failure("Invalid saved queue.") }
        let extras = Set(order?.extras ?? [])
        try continuation?.validate(window: tracks.indices.filter { !extras.contains($0) }.map { tracks[$0].id })
        return try tracks.map(safe)
    }
    private func checkedPrevious(_ previous: Previous) throws -> Previous {
        return Previous(tracks: try checked(previous.tracks, previous.cursor, previous.continuation, previous.order),
                        cursor: previous.cursor, continuation: previous.continuation, order: previous.order, playing: previous.playing)
    }
    func save(_ tracks: [OfflineFiles.Track], cursor: Cursor, continuation: LibraryContinuation? = nil,
              order: PlayerQueueOrder.Saved? = nil, previous: Previous? = nil) throws {
        let record = Record(tracks: try checked(tracks, cursor, continuation, order), cursor: cursor,
                            continuation: continuation, order: order, previous: try previous.map(checkedPrevious))
        let data = try JSONEncoder().encode(record)
        guard data.count <= 3_145_728 else { throw OfflineFiles.Failure("The queue is too large to restore.") }
        try write(data, to: queueURL)
    }
    func checkpoint(_ cursor: Cursor) throws {
        guard cursor.position.isFinite, cursor.position >= 0 else { return }
        try write(JSONEncoder().encode(cursor), to: cursorURL)
    }
    private func write(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }
    func load() throws -> Record? {
        guard files.fileExists(atPath: queueURL.path) else { return nil }
        guard let size = try queueURL.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 3_145_728 else { throw OfflineFiles.Failure("Invalid saved queue.") }
        var record = try JSONDecoder().decode(Record.self, from: Data(contentsOf: queueURL))
        record = Record(tracks: try checked(record.tracks, record.cursor, record.continuation, record.order),
                        cursor: record.cursor, continuation: record.continuation, order: record.order,
                        previous: try record.previous.map(checkedPrevious))
        if let data = try? Data(contentsOf: cursorURL), let cursor = try? JSONDecoder().decode(Cursor.self, from: data),
           cursor.revision == record.cursor.revision && valid(cursor, count: record.tracks.count) { record.cursor = cursor }
        return record
    }
    func erase() throws {
        for url in [queueURL, cursorURL] where files.fileExists(atPath: url.path) { try files.removeItem(at: url) }
    }
}

struct PlaybackSleep {
    private(set) var endsAt: Double?, track: UUID?
    private(set) var remaining = 0, finishLast = false
    mutating func minutes(_ n: Int, now: Double, finishLast: Bool = false) throws {
        guard (1...240).contains(n) else { throw OfflineFiles.Failure("Choose a timer from 1 to 240 minutes.") }
        cancel(); endsAt = now + Double(n) * 60_000; self.finishLast = finishLast
    }
    mutating func after(_ id: UUID, count: Int = 1) { cancel(); track = id; remaining = count }
    mutating func cancel() { endsAt = nil; track = nil; remaining = 0; finishLast = false }
    mutating func finishCurrent(now: Double, track id: UUID?) -> Bool {
        guard finishLast, let id, let endsAt, now >= endsAt else { return false }
        after(id); return true
    }
    mutating func expire(now: Double) -> Bool {
        guard let deadline = endsAt, now >= deadline else { return false }
        cancel(); return true
    }
    mutating func reachedEnd(_ id: UUID) -> Bool {
        guard track == id else { return false }
        if remaining > 1 { remaining -= 1; track = nil; return false }
        cancel(); return true
    }
    mutating func moved(to id: UUID?) {
        if let track, track != id { cancel() }
        else if remaining > 0 { track = id }
    }
    var state: [String: Any]? {
        if let endsAt { return ["mode": "minutes", "endsAt": endsAt, "finishTrack": finishLast] }
        return remaining == 0 ? nil : ["mode": "track", "remaining": remaining]
    }
}

/// Tracks the listener's request across audio session interruptions and asynchronous item changes.
struct PlaybackIntent {
    enum Permission { case play, hold, timerExpired }
    private(set) var requested = false, interrupted = false
    var sleep = PlaybackSleep()
    var canPlay: Bool { requested && !interrupted }

    // Only a newly requested Play that successfully activated the audio session can supersede a missing end.
    mutating func userActivated() { requested = true; interrupted = false }
    mutating func pause() { requested = false }
    mutating func beginInterruption() { interrupted = true }
    mutating func endInterruption(recommended: Bool, now: Double) -> Permission {
        guard interrupted else { return .hold }
        interrupted = false
        if !recommended { pause() }
        return permission(now: now)
    }
    mutating func permission(now: Double) -> Permission {
        if sleep.expire(now: now) { pause(); return .timerExpired }
        return canPlay ? .play : .hold
    }
    mutating func reachedEnd(_ track: UUID) -> Bool {
        guard sleep.reachedEnd(track) else { return false }
        pause(); return true
    }
}
