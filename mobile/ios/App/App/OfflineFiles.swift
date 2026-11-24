import Foundation

/// One instance per signed-in library. All index changes are atomic and a track
/// is visible only while its complete audio matches the length recorded here.
final class OfflineFiles {
    enum Origin: String, Codable { case cached, automatic, downloaded }
    enum PlaybackSource: Equatable { case saved(URL), network, unavailable }
    struct Quality: Codable, Equatable {
        var format: String
        var rate: Int
        var valid: Bool { ["original", "mp3", "opus"].contains(format) && [64, 96, 128, 160, 192, 256, 320].contains(rate) }
    }
    struct Pin: Codable, Equatable {
        let kind: String, id: String, name: String
        var group: String?, filters: [String: String]?
        var key: String { kind + "\n" + id }
        var valid: Bool {
            guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 512,
                  !id.isEmpty, id.count <= 256, id != ".", id != "..", !OfflineFiles.containsControl(id) else { return false }
            switch kind {
            case "recent", "favorites": return id == kind
            case "artist": return OfflineFiles.validTrackID(id)
            case "playlist": return true
            case "filter":
                let keys = ["q", "sort", "order", "favorites", "rating", "rating_mode", "formats", "format_mode"]
                return ["songs", "artists", "albums"].contains(group ?? "") &&
                    filters?.allSatisfy { keys.contains($0.key) && $0.value.count <= 4096 } == true
            default: return false
            }
        }
    }
    struct Membership: Codable, Equatable {
        let kind: String, id: String
        var name: String, ids: [String], complete: Bool
        var key: String { kind + "\n" + id }
    }
    struct Options: Codable {
        var autoCache = false, offlineOnly = false, unmeteredOnly = true
        var cacheMiB = 512, downloadMiB = 512
        var autoDownload = "off"
        var offlinePins: [Pin]?
        var completeDownloads: Bool?, downloadWaveforms: Bool?, notifyDownloads: Bool?
        var downloadQuality: Quality?
        var readAheadWifi: Int?, readAheadCellular: Int?
        var readAheadWifiKiBps: Int?, readAheadCellularKiBps: Int?
        func aheadRate(_ network: String) -> Int {
            if network == "wifi" { return readAheadWifiKiBps ?? 0 }
            if network == "cellular" { return readAheadCellularKiBps ?? 0 }
            return 0
        }
        func aheadCount(_ network: String) -> Int {
            if network == "wifi" { return readAheadWifi ?? 0 }
            if network == "cellular" { return readAheadCellular ?? 0 }
            return 0
        }
    }
    struct Track: Codable {
        let id: String, title: String, album: String, artist: String
        var streamUrl: String, artworkUrl: String?, duration: Double?
        var albumId: String?, artistId: String?, albumArtist: String?, albumArtistId: String?
        var genre: String?, format: String?, year: Int?, trackNumber: Int?, discNumber: Int?
        var dateAdded: Double?, favorite: Bool?, rating: Int?
        var artistMbid: String?, releaseGroupMbid: String?, recordingMbid: String?
        var sourceSampleRate: Int?, sourceBitDepth: Int?, sourceBitrate: Int?
        var replayGainAlbumDb: Double?, replayGainTrackDb: Double?, replayGainAlbumPeak: Double?, replayGainTrackPeak: Double?
    }
    struct Row: Codable {
        var track: Track, origin: Origin, name: String, bytes: Int64, used: Double
        var mime: String?
    }
    struct Ticket {
        let id: String, revision: Int, generation: Int, transferRevision: Int, origin: Origin, source: String?
        fileprivate let owner: UUID
    }
    struct Failure: LocalizedError {
        let message: String, code: String?
        init(_ message: String, code: String? = nil) { self.message = message; self.code = code }
        var errorDescription: String? { message }
    }
    struct ManualJob: Codable {
        var track: Track, failure: String?
    }
    struct ManualQueue: Codable {
        var jobs = [ManualJob](), saved = 0
        func status(current: String?, permitted: Bool, offline: Bool) -> [String: Any] {
            let failed = jobs.filter { $0.failure != nil }, pending = jobs.count - failed.count
            let state: String
            if pending == 0 { state = !failed.isEmpty ? "failed" : saved > 0 ? "complete" : "idle" }
            else if offline { state = "waitingOffline" }
            else if !permitted { state = "waitingNetwork" }
            else { state = current == nil ? "queued" : "downloading" }
            var value: [String: Any] = ["state": state, "total": saved + jobs.count, "saved": saved,
                "failed": failed.count, "pending": pending, "lastError": failed.last?.failure ?? "",
                "failures": failed.prefix(20).map { ["id": $0.track.id, "title": $0.track.title, "artist": $0.track.artist, "reason": $0.failure ?? ""] }]
            if let current, let song = jobs.first(where: { $0.track.id == current })?.track {
                value["current"] = ["id": song.id, "title": song.title, "artist": song.artist]
            }
            return value
        }
    }
    private struct Index: Codable {
        var options = Options(), rows = [String: Row](), revisions = [String: Int]()
        var memberships: [String: Membership]?
        var manual: ManualQueue?
        var excluded = Set<String>(), cacheGeneration = 0, autoGeneration = 0
    }
    private var index: Index
    private var reviewedReport: String?
    private var transferRevision = 0
    private var plannedPinIDs = Set<String>()
    private let folder: URL, indexURL: URL, lock = NSLock()
    private let owner = UUID()
    private let files = FileManager.default
    private let changed: () -> Void
    static let mib: Int64 = 1_048_576
    static let maxAudioBytes = 512 * mib
    static func hasDiskRoom(at folder: URL, for bytes: Int64) -> Bool {
        guard bytes >= 0, bytes <= maxAudioBytes,
              let values = try? FileManager.default.attributesOfFileSystem(forPath: folder.path),
              let free = values[.systemFreeSize] as? NSNumber else { return false }
        return free.int64Value - 64 * mib >= bytes
    }
    func hasDiskRoom(for bytes: Int64) -> Bool { Self.hasDiskRoom(at: folder, for: bytes) }
    var accountDirectory: String { folder.lastPathComponent }

    init(folder: URL, changed: @escaping () -> Void = {}) throws {
        self.folder = folder
        self.indexURL = folder.appendingPathComponent("library.json")
        self.changed = changed
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        if files.fileExists(atPath: indexURL.path) {
            index = try JSONDecoder().decode(Index.self, from: Data(contentsOf: indexURL))
        } else { index = Index() }
        let names = Set(index.rows.values.flatMap { [$0.name, $0.name + ".lyrics", $0.name + ".artwork", $0.name + ".peaks"] })
        for file in try files.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
            where file.lastPathComponent != "library.json" && !names.contains(file.lastPathComponent) {
            try? files.removeItem(at: file)
        }
    }
    func diagnostics(version: String, system: String, network: String, pendingListens: Int) throws -> String {
        lock.lock(); defer { lock.unlock() }
        let rows = index.rows.values.filter { file($0) != nil }
        var storage = [String: [String: Int64]]()
        for origin in [Origin.cached, .automatic, .downloaded] {
            let group = rows.filter { $0.origin == origin }
            storage[origin.rawValue] = ["tracks": Int64(group.count), "bytes": group.reduce(0) { $0 + $1.bytes }]
        }
        let jobs = index.manual?.jobs ?? []
        let report: [String: Any] = ["appVersion": version, "platform": "iOS", "systemVersion": system,
            "connection": network, "offlineOnly": index.options.offlineOnly, "storage": storage,
            "pendingListens": pendingListens, "pendingDownloads": jobs.filter { $0.failure == nil }.count,
            "failedDownloads": jobs.filter { $0.failure != nil }.count]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        let text = String(decoding: data, as: UTF8.self)
        reviewedReport = text
        return text
    }
    func reviewed(_ text: String) -> Bool {
        lock.lock(); defer { lock.unlock() }; return reviewedReport == text && !text.isEmpty
    }
    func refresh(_ track: Track, expected: String) throws -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard !index.options.offlineOnly else { throw Failure("Reconnect to update saved music.") }
        guard var row = index.rows[track.id], row.name == expected, file(row) != nil else { return false }
        let oldArtwork = Self.coverPath(row.track.artworkUrl), oldRating = row.track.rating
        row.track = track
        if track.rating == nil { row.track.rating = oldRating }
        var next = index; next.rows[track.id] = row; try commit(next, notify: false)
        if oldArtwork != Self.coverPath(track.artworkUrl), let url = sidecar(row, "artwork") { try? files.removeItem(at: url) }
        return true
    }
    func manualQueue() -> ManualQueue {
        lock.lock(); defer { lock.unlock() }; return index.manual ?? ManualQueue()
    }
    func enqueue(_ tracks: [Track]) throws -> (added: Int, saved: Int, already: Int) {
        lock.lock(); defer { lock.unlock() }
        var next = index, queue = index.manual ?? ManualQueue()
        if queue.jobs.isEmpty { queue.saved = 0 }
        var ids = Set(queue.jobs.map { $0.track.id }), added = 0, saved = 0, already = 0
        for track in tracks {
            guard Self.validTrackID(track.id) else { throw Failure("Choose a local library song.") }
            if let row = next.rows[track.id], row.origin == .downloaded, file(row) != nil { saved += 1; continue }
            if ids.insert(track.id).inserted {
                queue.jobs.append(ManualJob(track: track, failure: nil)); added += 1
            } else { already += 1 }
        }
        guard !tracks.isEmpty else { return (0, 0, 0) }
        queue.saved += saved; next.manual = queue; try commit(next, notify: false)
        return (added, saved, already)
    }
    func finishManual(_ id: String, failure: String?) throws {
        lock.lock(); defer { lock.unlock() }
        guard var queue = index.manual, let i = queue.jobs.firstIndex(where: { $0.track.id == id }) else { return }
        if let failure { queue.jobs[i].failure = failure }
        else { queue.jobs.remove(at: i); queue.saved += 1 }
        var next = index; next.manual = queue; try commit(next, notify: false)
    }
    func retryManual() throws {
        lock.lock(); defer { lock.unlock() }
        var next = index
        if var queue = next.manual {
            for i in queue.jobs.indices { queue.jobs[i].failure = nil }
            next.manual = queue; try commit(next, notify: false)
        }
    }
    func cancelManual() throws {
        lock.lock(); defer { lock.unlock() }
        var next = index
        for job in next.manual?.jobs ?? [] { next.revisions[job.track.id, default: 0] += 1 }
        next.manual = nil; try commit(next, notify: false)
    }
    func options() -> Options { lock.lock(); defer { lock.unlock() }; return index.options }
    func onlineRevision() -> Int? {
        lock.lock(); defer { lock.unlock() }
        return index.options.offlineOnly ? nil : transferRevision
    }
    private func file(_ row: Row) -> URL? {
        guard row.bytes > 0, !row.name.contains("/"), !row.name.hasPrefix(".") else { return nil }
        let path = folder.appendingPathComponent(row.name)
        guard let values = try? path.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true, let size = values.fileSize, Int64(size) == row.bytes else { return nil }
        return path
    }
    func rows() -> [Row] {
        lock.lock(); defer { lock.unlock() }
        return index.rows.values.filter { file($0) != nil }.sorted { $0.used > $1.used }
    }
    private static func now() -> Double { Date().timeIntervalSince1970 * 1000 }
    private func commit(_ next: Index, notify: Bool = true) throws {
        try JSONEncoder().encode(next).write(to: indexURL, options: .atomic)
        let old = index
        index = next
        for (id, row) in old.rows where next.rows[id]?.name != row.name {
            if let url = file(row) { try? files.removeItem(at: url) }
            for kind in ["artwork", "lyrics", "peaks"] {
                if let url = sidecar(row, kind) { try? files.removeItem(at: url) }
            }
        }
        if notify { changed() }
    }
    static func coverPath(_ value: String?) -> String? {
        guard let value, let url = URLComponents(string: value), url.scheme == nil, url.host == nil,
              value.hasPrefix("/api/v3/") else { return nil }
        let path = url.percentEncodedPath
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        func id(_ position: Int) -> Bool { parts[position].removingPercentEncoding.map(validTrackID) == true }
        if parts.count == 6 && parts[3] == "covers" && parts[4] == "release-group" && id(5) { return path }
        if parts.count == 7 && parts[3] == "library" && parts[4] == "albums" && id(5) && parts[6] == "artwork" { return path }
        return nil
    }
    private func sidecar(_ row: Row, _ kind: String) -> URL? {
        guard ["artwork", "lyrics", "peaks"].contains(kind), !row.name.contains("/"), !row.name.hasPrefix(".") else { return nil }
        return folder.appendingPathComponent(row.name + "." + kind)
    }
    func preparation(_ id: String) -> Row? {
        lock.lock(); defer { lock.unlock() }
        guard index.options.completeDownloads != false, !index.options.offlineOnly,
              let row = index.rows[id], row.origin != .cached, file(row) != nil else { return nil }
        return row
    }
    func companion(_ kind: String, key: String) -> String? {
        lock.lock(); defer { lock.unlock() }
        if (kind == "lyrics" || kind == "peaks"), let row = index.rows[key], file(row) != nil, let url = sidecar(row, kind) {
            return try? String(contentsOf: url, encoding: .utf8)
        }
        guard kind == "artwork", let cover = Self.coverPath(key) else { return nil }
        for row in index.rows.values where Self.coverPath(row.track.artworkUrl) == cover {
            if let url = sidecar(row, kind), file(row) != nil,
               let data = try? String(contentsOf: url, encoding: .utf8) { return data }
        }
        return nil
    }
    func retainCompanion(_ kind: String, value: String, for row: Row, reuseArtwork: Bool = true) throws {
        lock.lock(); defer { lock.unlock() }
        guard index.rows[row.track.id]?.name == row.name, index.options.completeDownloads != false,
              !index.options.offlineOnly, file(row) != nil, let dest = sidecar(row, kind) else { return }
        if reuseArtwork, kind == "artwork", let path = Self.coverPath(row.track.artworkUrl) {
            for other in index.rows.values where other.name != row.name && Self.coverPath(other.track.artworkUrl) == path {
                if let existing = sidecar(other, kind), files.fileExists(atPath: existing.path),
                   (try? files.linkItem(at: existing, to: dest)) != nil { return }
            }
        }
        guard value.utf8.count <= (kind == "artwork" ? 1_048_640 : 262_144) else { return }
        try Data(value.utf8).write(to: dest, options: .atomic)
    }
    func peaks(_ id: String, file current: URL) -> [Float]? {
        lock.lock(); defer { lock.unlock() }
        guard let row = index.rows[id], file(row) == current, let dataURL = sidecar(row, "peaks"),
              let data = try? Data(contentsOf: dataURL), data.count <= 4096,
              let values = try? JSONDecoder().decode([Float].self, from: data), values.count == 112,
              values.allSatisfy({ $0.isFinite && (0...1).contains($0) }) else { return nil }
        return values
    }
    func representation(_ id: String, file current: URL) -> Row? {
        lock.lock(); defer { lock.unlock() }
        guard let row = index.rows[id], file(row) == current else { return nil }
        return row
    }
    func playable(_ id: String) -> URL? {
        lock.lock(); defer { lock.unlock() }
        return playable(id, touch: true)
    }
    func source(_ id: String, touch: Bool = false) -> PlaybackSource {
        lock.lock(); defer { lock.unlock() }
        if let url = playable(id, touch: touch) { return .saved(url) }
        return index.options.offlineOnly ? .unavailable : .network
    }
    private func playable(_ id: String, touch: Bool) -> URL? {
        guard var row = index.rows[id], let url = file(row) else { return nil }
        if touch && row.origin != .downloaded && Self.now() - row.used > 60_000 {
            row.used = Self.now()
            var next = index; next.rows[id] = row
            try? commit(next, notify: false)
        }
        return url
    }
    private func remove(_ id: String, from next: inout Index) {
        next.rows.removeValue(forKey: id)
        next.revisions[id, default: 0] += 1
    }
    private func prune(_ origin: Origin, limit: Int, in next: inout Index) {
        var remaining = Int64(limit) * Self.mib
        for row in next.rows.values.sorted(by: { $0.used > $1.used }) where row.origin == origin {
            if file(row) != nil && row.bytes <= remaining { remaining -= row.bytes }
            else { remove(row.track.id, from: &next) }
        }
    }
    private static func containsControl(_ text: String) -> Bool {
        text.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) }
    }
    static func validTrackID(_ id: String) -> Bool {
        !id.isEmpty && id != "." && id != ".." && !id.contains("/") && !id.contains("\\") && !containsControl(id)
    }
    private static func playlistSource(_ source: String) -> Bool {
        guard source.hasPrefix("playlist:") else { return false }
        let encoded = source.utf8.dropFirst("playlist:".utf8.count)
        guard (2...342).contains(encoded.count) else { return false }
        let payload = String(decoding: encoded, as: UTF8.self)
        let base64 = payload.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let padding = String(repeating: "=", count: (4 - encoded.count % 4) % 4)
        guard let bytes = Data(base64Encoded: base64 + padding), (1...256).contains(bytes.count) else { return false }
        let canonical = bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let id = String(decoding: bytes, as: UTF8.self)
        return canonical == payload && Data(id.utf8) == bytes && id != "." && id != ".." && !containsControl(id)
    }
    static func enabledSource(_ source: String) -> Bool {
        source == "recent" || source == "favorites" || playlistSource(source)
    }
    func configure(_ options: Options, clearUnpinned: Bool = false) throws {
        let limits = [128, 256, 512, 1024, 2048, 4096]
        let ahead = [0, 1, 2, 3, 5, 10, 20], rates = [0, 64, 128, 256, 512, 1024, 2048, 4096, 8192]
        guard rates.contains(options.readAheadWifiKiBps ?? 0), rates.contains(options.readAheadCellularKiBps ?? 0),
              options.downloadQuality?.valid != false, ahead.contains(options.readAheadWifi ?? 0),
              ahead.contains(options.readAheadCellular ?? 0), limits.contains(options.cacheMiB), limits.contains(options.downloadMiB),
              options.autoDownload == "off" || Self.enabledSource(options.autoDownload) else { throw Failure("Choose a supported storage setting.") }
        let pins = options.offlinePins ?? []
        guard pins.allSatisfy({ $0.valid }), Set(pins.map(\.key)).count == pins.count else {
            throw Failure("Choose valid offline collections.")
        }
        lock.lock(); defer { lock.unlock() }
        let connectionChanged = options.offlineOnly != index.options.offlineOnly || options.unmeteredOnly != index.options.unmeteredOnly
        var next = index
        if (index.options.autoCache && !options.autoCache) || options.readAheadWifi != index.options.readAheadWifi ||
            options.readAheadCellular != index.options.readAheadCellular { next.cacheGeneration += 1 }
        let pinsChanged = options.offlinePins != index.options.offlinePins || options.autoDownload != index.options.autoDownload
        if pinsChanged || options.offlineOnly != index.options.offlineOnly { next.autoGeneration += 1 }
        if pinsChanged {
            let keys = Set(pins.map(\.key))
            next.memberships = next.memberships?.filter { keys.contains($0.key) }
            if clearUnpinned && pins.isEmpty && options.autoDownload == "off" {
                removeAutomatic(except: [], from: &next)
            }
        }
        next.options = options
        prune(.cached, limit: options.cacheMiB, in: &next)
        prune(.automatic, limit: options.downloadMiB, in: &next)
        try commit(next)
        if pinsChanged { plannedPinIDs.removeAll() }
        if connectionChanged { transferRevision += 1 }
    }
    func remove(_ ids: [String]) throws {
        lock.lock(); defer { lock.unlock() }
        var next = index
        let removed = Set(ids)
        next.manual?.jobs.removeAll { removed.contains($0.track.id) }
        for id in removed { next.excluded.insert(id); remove(id, from: &next) }
        try commit(next)
    }
    func clearCache() throws {
        lock.lock(); defer { lock.unlock() }
        var next = index; next.cacheGeneration += 1
        prune(.cached, limit: 0, in: &next)
        try commit(next)
    }
    func cancelAutomatic() throws {
        lock.lock(); defer { lock.unlock() }
        var next = index; next.autoGeneration += 1
        try commit(next, notify: false)
    }
    func active(_ ticket: Ticket, bytes: Int64 = 0) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard bytes >= 0, bytes <= Self.maxAudioBytes, ticket.revision == (index.revisions[ticket.id] ?? 0), permitsTransfer(ticket) else { return false }
        switch ticket.origin {
        case .cached: return bytes <= Int64(index.options.cacheMiB) * Self.mib
        case .automatic: return bytes <= Int64(index.options.downloadMiB) * Self.mib
        case .downloaded: return true
        }
    }
    func missingPlaylistAudio(_ ticket: Ticket, httpStatus: Int?) -> Failure? {
        guard httpStatus == 404 || httpStatus == 410, ticket.origin == .automatic,
              let source = ticket.source, (source == "pinnedCollections" || Self.playlistSource(source)), active(ticket) else { return nil }
        return Failure("DN could not find this song’s audio file.", code: "DN_AUDIO_NOT_FOUND")
    }
    private func permitsTransfer(_ ticket: Ticket) -> Bool {
        guard ticket.owner == owner, ticket.transferRevision == transferRevision, !index.options.offlineOnly,
              allowed(ticket.id, ticket.origin, ticket.source) else { return false }
        switch ticket.origin {
        case .automatic: return ticket.generation == index.autoGeneration
        case .cached: return ticket.generation == index.cacheGeneration
        case .downloaded: return true
        }
    }
    func plan(_ source: String, ids: [String], keepExisting: Bool = false) throws -> [String] {
        lock.lock(); defer { lock.unlock() }
        if source == "off" { return [] }
        guard Self.enabledSource(source) else { throw Failure("Choose a valid automatic download source.") }
        guard source == index.options.autoDownload, !index.options.offlineOnly else { return [] }
        var wanted = Set<String>(), ordered = [String]()
        for id in ids.prefix(source.hasPrefix("playlist:") ? ids.count : 25) {
            guard Self.validTrackID(id) else { throw Failure("The download source contains an invalid library song.") }
            if wanted.insert(id).inserted { ordered.append(id) }
        }
        if !keepExisting {
            var next = index
            removeAutomatic(except: wanted, from: &next)
            if next.rows.count != index.rows.count { try commit(next) }
        }
        return ordered.filter { id in
            guard !index.excluded.contains(id) else { return false }
            guard let row = index.rows[id], file(row) != nil else { return true }
            return row.origin == .cached
        }
    }
    func pinnedPlaylists() -> [[String: Any]] {
        lock.lock(); defer { lock.unlock() }
        return (index.memberships ?? [:]).values.filter { $0.kind == "playlist" }.map {
            ["id": $0.id, "name": $0.name, "ids": $0.ids]
        }
    }

    func planPins(expected: [Pin], source: String, members: [Membership]) throws -> [String] {
        lock.lock(); defer { lock.unlock() }
        guard !index.options.offlineOnly, expected == (index.options.offlinePins ?? []), !expected.isEmpty,
              source == index.options.autoDownload else { throw Failure("Offline collections changed. Update them again.") }
        var keys = Set(expected.map(\.key))
        if source == "recent" || source == "favorites" { keys.insert(source + "\n" + source) }
        if Self.playlistSource(source) {
            var b64 = String(source.dropFirst(9)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            b64 += String(repeating: "=", count: (4 - b64.count % 4) % 4)
            if let data = Data(base64Encoded: b64), let id = String(data: data, encoding: .utf8) { keys.insert("playlist\n" + id) }
        }
        guard Set(members.map(\.key)) == keys, members.count == keys.count,
              members.allSatisfy({ $0.ids.allSatisfy(Self.validTrackID) }) else { throw Failure("Incomplete collection update.") }
        var next = index, retained = [String: Membership](), wanted = Set<String>(), encountered = Set<String>(), ordered = [String]()
        for member in members {
            for id in member.ids where encountered.insert(id).inserted { ordered.append(id) }
            wanted.formUnion(member.ids)
            if member.complete {
                retained[member.key] = member
            } else if let previous = index.memberships?[member.key] {
                // Offline browsing keeps the last confirmed order, including repeated songs.
                retained[member.key] = previous
                wanted.formUnion(previous.ids)
            }
        }
        next.memberships = retained
        if members.allSatisfy({ $0.complete }) { removeAutomatic(except: wanted, from: &next) }
        if index.memberships != retained || next.rows.count != index.rows.count { try commit(next) }
        plannedPinIDs = wanted
        return ordered.filter { id in
            guard !index.excluded.contains(id) else { return false }
            guard let row = index.rows[id], file(row) != nil else { return true }
            return row.origin == .cached
        }
    }

    private func removeAutomatic(except wanted: Set<String>, from next: inout Index) {
        for (id, row) in index.rows where row.origin == .automatic && !wanted.contains(id) { remove(id, from: &next) }
    }
    func clearAutomaticPlaylist(_ source: String) throws -> Options {
        lock.lock(); defer { lock.unlock() }
        guard Self.playlistSource(source), source == index.options.autoDownload else { throw Failure("The selected download playlist changed.") }
        var next = index
        next.autoGeneration += 1
        next.options.autoDownload = "off"
        removeAutomatic(except: [], from: &next)
        try commit(next)
        return next.options
    }
    private func allowed(_ id: String, _ origin: Origin, _ source: String?) -> Bool {
        switch origin {
        case .cached:
            guard !index.options.offlineOnly else { return false }
            if let source { return index.options.aheadCount(source) > 0 && !index.excluded.contains(id) }
            return index.options.autoCache && !index.excluded.contains(id)
        case .automatic:
            let selected = source == "pinnedCollections" ? plannedPinIDs.contains(id) :
                source == index.options.autoDownload && source.map(Self.enabledSource) == true
            return selected && !index.options.offlineOnly && !index.excluded.contains(id)
        case .downloaded: return true
        }
    }
    private func room(_ bytes: Int64) throws {
        let occupied = index.rows.values.filter { $0.origin == .automatic && file($0) != nil }.reduce(Int64(0)) { $0 + $1.bytes }
        guard bytes <= Int64(index.options.downloadMiB) * Self.mib - occupied else { throw Failure("The automatic download limit has been reached.") }
    }
    /// A stronger request can retain the exact same verified bytes offline.
    func begin(_ track: Track, origin: Origin, source: String? = nil) throws -> Ticket? {
        lock.lock(); defer { lock.unlock() }
        guard allowed(track.id, origin, source) else { return nil }
        if var row = index.rows[track.id], file(row) != nil {
            if origin == .cached || (origin == .automatic && row.origin != .cached) { return nil }
            if origin == .automatic { try room(row.bytes) }
            var next = index
            if origin == .downloaded { next.excluded.remove(track.id) }
            row.origin = origin; row.used = Self.now()
            // Preserve known library tags when upgrading from a sparse queue entry.
            var merged = try Self.dictionary(row.track)
            for (key, value) in try Self.dictionary(track) { merged[key] = value }
            row.track = try JSONDecoder().decode(Track.self, from: JSONSerialization.data(withJSONObject: merged))
            next.rows[track.id] = row; try commit(next)
            return nil
        }
        return Ticket(id: track.id, revision: index.revisions[track.id] ?? 0,
                      generation: origin == .automatic ? index.autoGeneration : index.cacheGeneration,
                      transferRevision: transferRevision, origin: origin, source: source, owner: owner)
    }
    @discardableResult
    func install(_ temporary: URL, bytes: Int64, ext: String, track: Track, ticket: Ticket, mime: String? = nil) throws -> URL? {
        lock.lock(); defer { lock.unlock() }
        guard ticket.id == track.id, ticket.revision == (index.revisions[track.id] ?? 0) else { throw Failure("The offline copy was removed.") }
        guard permitsTransfer(ticket) else {
            if ticket.origin == .downloaded { throw Failure("Download stopped by offline settings.") }
            return nil
        }
        if ticket.origin == .cached && bytes > Int64(index.options.cacheMiB) * Self.mib { return nil }
        if let old = index.rows[track.id], file(old) != nil,
           (ticket.origin == .cached || old.origin == .downloaded || (ticket.origin == .automatic && old.origin == .automatic)) { return nil }
        if ticket.origin == .automatic { try room(bytes) }
        guard bytes > 0, let size = try temporary.resourceValues(forKeys: [.fileSizeKey]).fileSize, Int64(size) == bytes else { throw Failure("The audio download was incomplete.") }
        let suffix = !ext.isEmpty && ext.count <= 8 && ext.allSatisfy({ $0.isLetter || $0.isNumber }) ? ext : "audio"
        guard hasDiskRoom(for: bytes) else { throw Failure("Insufficient space for this audio file.") }
        let dest = folder.appendingPathComponent(UUID().uuidString + "." + suffix)
        do { try files.copyItem(at: temporary, to: dest) }
        catch { try? files.removeItem(at: dest); throw error }
        var next = index
        next.rows[track.id] = Row(track: track, origin: ticket.origin, name: dest.lastPathComponent, bytes: bytes, used: Self.now(), mime: mime)
        if ticket.origin == .downloaded { next.excluded.remove(track.id) }
        if ticket.origin == .cached { prune(.cached, limit: index.options.cacheMiB, in: &next) }
        do { try commit(next) }
        catch { try? files.removeItem(at: dest); throw error }
        return next.rows[track.id]?.name == dest.lastPathComponent ? dest : nil
    }
    static func dictionary<T: Encodable>(_ value: T) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any] else { throw Failure("Invalid offline metadata.") }
        return object
    }
}

/// Byte coordinates of one HTTP response used for playback and offline storage.
// URLSession reports cumulative bytes in bursts; use elapsed transfer time for the next read deadline.
struct ReadAheadPace {
    let rateKiBps: Int
    func wait(bytes: Int64, elapsed: TimeInterval) -> TimeInterval {
        guard rateKiBps > 0, bytes > 0 else { return 0 }
        return max(0, Double(bytes) / (1024 * Double(rateKiBps)) - max(0, elapsed))
    }
}

struct PlaybackByteRange {
    let start: Int64, end: Int64?, total: Int64?

    init?(status: Int, header: String?, bytes: Int64, coding: String?, offset: Int64) {
        guard offset >= 0 else { return nil }
        let identity = coding == nil || coding?.trimmingCharacters(in: .whitespaces).lowercased() == "identity"
        if status == 200 {
            guard offset == 0 else { return nil }
            start = 0; total = identity && bytes >= 0 ? bytes : nil; end = total
            return
        }
        guard status == 206, identity, let header else { return nil }
        func decimal(_ value: Substring) -> Int64? {
            guard !value.isEmpty, value.utf8.allSatisfy({ (48...57).contains($0) }) else { return nil }
            return Int64(value)
        }
        let parts = header.trimmingCharacters(in: .whitespaces).split(separator: " ")
        guard parts.count == 2, parts[0].lowercased() == "bytes" else { return nil }
        let span = parts[1].split(separator: "/", omittingEmptySubsequences: false)
        guard span.count == 2 else { return nil }
        let bounds = span[0].split(separator: "-", omittingEmptySubsequences: false)
        guard bounds.count == 2, let first = decimal(bounds[0]), let last = decimal(bounds[1]),
              first == offset, first <= last, last < Int64.max,
              bytes < 0 || bytes == last + 1 - first else { return nil }
        let size = decimal(span[1])
        guard span[1] == "*" || size.map({ last < $0 }) == true else { return nil }
        start = first; end = last + 1; total = size
    }

    /// A complete response stands alone. Partial responses need a common strong validator (RFC 9110 §15.3.7.3).
    func cacheIdentity(tag: String?, modified: String?, date: String?, request: Int) -> String? {
        guard let total, total > 0 else { return nil }
        if let tag = tag?.trimmingCharacters(in: .whitespaces) {
            let raw = tag.utf8
            if raw.count >= 2, raw.first == 34, raw.last == 34,
               raw.dropFirst().dropLast().allSatisfy({ $0 == 33 || (35...126).contains($0) || $0 >= 128 }) {
                return "etag:" + tag
            }
        } else if let modified, let date {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
            if let mtime = formatter.date(from: modified), let sent = formatter.date(from: date),
               sent.timeIntervalSince(mtime) >= 60 { return "mtime:" + modified }
        }
        return start == 0 && end == total ? "response:" + String(request) : nil
    }
}

/// AVFoundation can request the header, the tail, then overlapping seek ranges.
struct OfflineCoverage {
    let length: Int64
    private(set) var ranges: [Range<Int64>] = []
    init(length: Int64) { self.length = length }
    mutating func add(_ offset: Int64, count: Int) -> Bool {
        guard offset >= 0, offset <= length, count > 0, Int64(count) <= length - offset else { return false }
        var merged = offset..<(offset + Int64(count))
        var output: [Range<Int64>] = []
        for part in ranges {
            if part.upperBound < merged.lowerBound || part.lowerBound > merged.upperBound { output.append(part) }
            else { merged = min(part.lowerBound, merged.lowerBound)..<max(part.upperBound, merged.upperBound) }
        }
        output.append(merged)
        ranges = output.sorted { $0.lowerBound < $1.lowerBound }
        return ranges.count == 1 && ranges[0] == 0..<length
    }
}


/// Scene launch and the notification delegate can report the same tap.
struct DownloadNotificationTap {
    static let prefix = "app.droppedneedle.downloads."
    private var pending: String?, last: (String, Date)?

    mutating func receive(scope: String?, identifier: String, delivered: Date) -> Bool {
        guard let scope, scope.utf8.count == 64, scope.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              identifier == Self.prefix + scope else { return false }
        if last?.0 == scope && last?.1 == delivered { return false }
        last = (scope, delivered)
        pending = scope
        return true
    }

    mutating func take(owner: String?) -> Bool {
        defer { pending = nil }
        return owner != nil && pending == owner
    }

    mutating func clear(owner: String) {
        if pending == owner { pending = nil }
    }
}
