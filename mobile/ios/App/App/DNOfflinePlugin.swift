import Capacitor
import CryptoKit
import Foundation
import UIKit
import UserNotifications
import ImageIO
import Network
import UniformTypeIdentifiers

final class DeviceOffline {
    static let shared = DeviceOffline()
    static let mediaChanged = Notification.Name("DNOfflineMediaChanged")
    static let historyChanged = Notification.Name("DNOfflineHistoryChanged")
    static let connectionChanged = Notification.Name("DNOfflineConnectionChanged")
    private let guardLock = NSLock(), monitor = NWPathMonitor()
    private var stores = [String: OfflineFiles]()
    private var journals = [String: OfflineListenJournal]()
    private init() {
        monitor.pathUpdateHandler = { _ in NotificationCenter.default.post(name: Self.connectionChanged, object: nil) }
        monitor.start(queue: DispatchQueue(label: "app.droppedneedle.offline-path"))
        DispatchQueue.global(qos: .utility).async { self.expireHistory() }
    }

    static func directory(_ category: String, address: String?, user: String?) throws -> (URL, URL) {
        guard let address, let base = URL(string: address), let user, !user.isEmpty, base.scheme == "https",
              base.host != nil, base.user == nil, base.password == nil, base.query == nil, base.fragment == nil else {
            throw OfflineFiles.Failure("Reconnect to DN to identify this library.")
        }
        let scope = SHA256.hash(data: Data((address.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "\n" + user).utf8))
            .map { String(format: "%02x", $0) }.joined()
        var folder = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent(category, isDirectory: true).appendingPathComponent(scope, isDirectory: true)
        if !FileManager.default.fileExists(atPath: folder.path) {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication, .posixPermissions: 0o700])
            var flags = URLResourceValues(); flags.isExcludedFromBackup = true
            try folder.setResourceValues(flags)
        }
        return (base, folder)
    }
    func account(_ address: String?, _ user: String?) throws -> (URL, OfflineFiles) {
        let (base, folder) = try Self.directory("DNOffline", address: address, user: user)
        let scope = folder.lastPathComponent
        guardLock.lock(); defer { guardLock.unlock() }
        if let existing = stores[scope] { return (base, existing) }
        let store = try OfflineFiles(folder: folder) {
            DispatchQueue.main.async { NotificationCenter.default.post(name: Self.mediaChanged, object: nil) }
        }
        stores[scope] = store
        return (base, store)
    }
    func history(_ address: String?, _ user: String?) throws -> OfflineListenJournal {
        let (_, folder) = try Self.directory("DNListenHistory", address: address, user: user)
        guardLock.lock(); defer { guardLock.unlock() }
        if let journal = journals[folder.lastPathComponent] { return journal }
        let journal = try OfflineListenJournal(folder: folder, changed: {
            DispatchQueue.main.async { NotificationCenter.default.post(name: Self.historyChanged, object: nil) }
        })
        journals[folder.lastPathComponent] = journal
        return journal
    }
    private func expireHistory() {
        guard let support = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false),
              let folders = try? FileManager.default.contentsOfDirectory(at: support.appendingPathComponent("DNListenHistory"),
                  includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { return }
        for folder in folders where folder.lastPathComponent.count == 64 && folder.lastPathComponent.allSatisfy(\.isHexDigit) {
            guardLock.lock()
            if let journal = journals[folder.lastPathComponent] { _ = try? journal.status() }
            else { _ = try? OfflineListenJournal(folder: folder) }
            guardLock.unlock()
        }
    }
    var networkName: String { PlaybackNetwork(monitor.currentPath).rawValue }
    func permitted(_ options: OfflineFiles.Options) -> Bool {
        let path = monitor.currentPath
        return path.status == .satisfied && (!options.unmeteredOnly || (!path.isExpensive && !path.isConstrained && !path.usesInterfaceType(.cellular)))
    }
    private let aheadQueue = DispatchQueue(label: "app.droppedneedle.queue-cache", qos: .utility)
    private var aheadKey: AheadKey?, aheadTransfer: OfflineTransfer?, aheadRevision = UUID()
    private struct AheadKey: Equatable {
        let server: String, user: String, token: String, connection: String, profile: StreamProfile
        let ids: [String], rate: Int
    }
    func cacheUpcoming(server: String, user: String?, token: String, tracks: [[String: Any]],
                       network: PlaybackNetwork, profile: StreamProfile) {
        aheadQueue.async {
            guard let user, !token.isEmpty, !tracks.isEmpty,
                  let (base, store) = try? self.account(server, user) else {
                self.aheadKey = nil; self.aheadRevision = UUID(); self.aheadTransfer?.cancel(); self.aheadTransfer = nil; return
            }
            let options = store.options()
            let count = options.aheadCount(network.rawValue)
            let songs = options.offlineOnly ? [] : tracks.prefix(count).compactMap { try? Self.track($0, base) }
            let key = AheadKey(server: server, user: user, token: token, connection: network.rawValue,
                               profile: profile, ids: songs.map { $0.0.id }, rate: options.aheadRate(network.rawValue))
            guard key != self.aheadKey else { return }
            self.aheadKey = key; self.aheadRevision = UUID(); self.aheadTransfer?.cancel(); self.aheadTransfer = nil
            self.readAhead(songs[...], key: key, store: store, revision: self.aheadRevision)
        }
    }
    private func readAhead(_ songs: ArraySlice<(OfflineFiles.Track, URL)>, key: AheadKey, store: OfflineFiles, revision: UUID) {
        guard revision == aheadRevision else { return }
        var pending = songs
        while let (song, url) = pending.popFirst() {
            guard PlaybackNetwork(monitor.currentPath).rawValue == key.connection else { break }
            guard let ticket = try? store.begin(song, origin: .cached, source: key.connection) else { continue }
            let rest = pending
            let transfer = OfflineTransfer(store: store, track: song, ticket: ticket, rateKiBps: key.rate) { [weak self] _ in
                guard let self else { return }
                self.aheadQueue.async { self.readAhead(rest, key: key, store: store, revision: revision) }
            }
            aheadTransfer = transfer
            transfer.start(url, key.token, profile: key.profile)
            return
        }
        aheadTransfer = nil
    }
    func permitsTransfer(_ store: OfflineFiles, _ ticket: OfflineFiles.Ticket) -> Bool {
        guard store.active(ticket) else { return false }
        if ticket.origin == .cached, let connection = ticket.source {
            return PlaybackNetwork(monitor.currentPath).rawValue == connection
        }
        return permitted(store.options())
    }
    static func track(_ data: [String: Any], _ base: URL) throws -> (OfflineFiles.Track, URL) {
        var track = try JSONDecoder().decode(OfflineFiles.Track.self, from: JSONSerialization.data(withJSONObject: data))
        guard OfflineFiles.validTrackID(track.id) else {
            throw OfflineFiles.Failure("Choose a local library song.")
        }
        let endpoint = base.appendingPathComponent("api/v3/stream/local").appendingPathComponent(track.id)
        // Derive the only permissible download address from the DN server and track ID.
        let local = "/api/v3/stream/local/" + track.id
        guard let supplied = URLComponents(string: track.streamUrl),
              (supplied.scheme == nil && supplied.host == nil && supplied.path == local) ||
                (supplied.scheme == "https" && supplied.host?.lowercased() == base.host?.lowercased() && (supplied.port ?? 443) == (base.port ?? 443) &&
                 supplied.user == nil && supplied.password == nil && supplied.path == endpoint.path),
              let encoded = track.id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) else {
            throw OfflineFiles.Failure("Choose a song from this DroppedNeedle library.")
        }
        track.streamUrl = "/api/v3/stream/local/" + encoded
        if let art = track.artworkUrl {
            let absolute = art.hasPrefix("/api/v3/") ? URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + art) : URL(string: art)
            if let absolute, absolute.scheme == "https", absolute.host?.lowercased() == base.host?.lowercased(),
               (absolute.port ?? 443) == (base.port ?? 443), absolute.user == nil, absolute.password == nil,
               absolute.standardized.path.hasPrefix(base.appendingPathComponent("api/v3").path + "/"),
               let components = URLComponents(url: absolute, resolvingAgainstBaseURL: false),
               let range = components.percentEncodedPath.range(of: "/api/v3/", options: .backwards) {
                track.artworkUrl = String(components.percentEncodedPath[range.lowerBound...]) + "?size=500"
            } else { track.artworkUrl = nil }
        }
        return (track, endpoint)
    }
    static func audio(_ mime: String?) -> Bool {
        guard let mime = mime?.lowercased() else { return false }
        return mime.hasPrefix("audio/") || ["application/ogg", "application/flac", "application/octet-stream"].contains(mime)
    }
}

private final class OfflineTransfer: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let store: OfflineFiles, track: OfflineFiles.Track, ticket: OfflineFiles.Ticket
    let done: (Error?) -> Void
    private var failure: Error?, installed = false
    private let pace: ReadAheadPace
    private var started: TimeInterval = 0, received: Int64 = 0
    init(store: OfflineFiles, track: OfflineFiles.Track, ticket: OfflineFiles.Ticket, rateKiBps: Int = 0, done: @escaping (Error?) -> Void) {
        self.store = store; self.track = track; self.ticket = ticket; self.done = done; self.pace = ReadAheadPace(rateKiBps: rateKiBps)
    }
    private let lock = NSLock()
    private var task: URLSessionDownloadTask?, cancelled = false
    private var rawRetry: URLRequest?
    func cancel() {
        lock.lock(); cancelled = true; task?.cancel(); lock.unlock()
    }
    func start(_ url: URL, _ token: String, profile: StreamProfile) {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            done(OfflineFiles.Failure("Invalid DN stream address.")); return
        }
        parts.queryItems = [URLQueryItem(name: "format", value: "raw")]
        guard let raw = parts.url else { done(OfflineFiles.Failure("Invalid DN stream address.")); return }
        var request = URLRequest(url: raw)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let converted = profile.convertedURL(url) {
            rawRetry = request; request.url = converted
        }
        fetch(request)
    }
    private func fetch(_ request: URLRequest) {
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil; config.httpCookieStorage = nil; config.urlCredentialStorage = nil
        config.timeoutIntervalForRequest = 30; config.timeoutIntervalForResource = 600
        let restricted = ticket.origin == .cached && ticket.source != nil ? ticket.source != "cellular" : store.options().unmeteredOnly
        config.allowsCellularAccess = !restricted
        config.allowsExpensiveNetworkAccess = !restricted; config.allowsConstrainedNetworkAccess = !restricted
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        let download = session.downloadTask(with: request)
        started = ProcessInfo.processInfo.systemUptime; received = 0
        lock.lock(); task = download
        if cancelled { download.cancel() } else { download.resume() }
        lock.unlock()
        session.finishTasksAndInvalidate()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let options = store.options()
        if let http = downloadTask.response as? HTTPURLResponse, http.statusCode != 200 || !DeviceOffline.audio(http.mimeType) {
            failure = OfflineFiles.Failure("DN could not serve this audio file.")
        } else if !DeviceOffline.shared.permitsTransfer(store, ticket) ||
            (ticket.origin == .cached && max(totalBytesWritten, totalBytesExpectedToWrite) > Int64(options.cacheMiB) * OfflineFiles.mib) ||
            (ticket.origin == .automatic && (options.autoDownload != ticket.source || max(totalBytesWritten, totalBytesExpectedToWrite) > Int64(options.downloadMiB) * OfflineFiles.mib)) {
            failure = OfflineFiles.Failure("Download stopped by Offline settings.")
        }
        if failure != nil { downloadTask.cancel(); return }
        received = totalBytesWritten
        let wait = pace.wait(bytes: received, elapsed: ProcessInfo.processInfo.systemUptime - started)
        if wait > 0.05 && downloadTask.state == .running {
            downloadTask.suspend()
            DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + wait) {
                if downloadTask.state == .suspended { downloadTask.resume() }
            }
        }
    }
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo url: URL) {
        do {
            guard DeviceOffline.shared.permitsTransfer(store, ticket) else {
                throw OfflineFiles.Failure("Download stopped by offline settings.")
            }
            guard let http = downloadTask.response as? HTTPURLResponse, http.statusCode == 200, DeviceOffline.audio(http.mimeType),
                  http.value(forHTTPHeaderField: "Content-Range") == nil,
                  let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size > 0,
                  let range = PlaybackByteRange(status: http.statusCode, header: nil, bytes: http.expectedContentLength,
                                                coding: http.value(forHTTPHeaderField: "Content-Encoding"), offset: 0),
                  range.end == nil || range.end == Int64(size) else { throw OfflineFiles.Failure("DN could not serve the complete audio file.") }
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let header = try handle.read(upToCount: 128) ?? Data()
            let text = String(decoding: header, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard !["<html", "<!doctype", "<?xml"].contains(where: { text.hasPrefix($0) }) else {
                throw OfflineFiles.Failure("DN returned a sign-in page instead of audio.")
            }
            let ext = http.mimeType.flatMap { UTType(mimeType: $0)?.preferredFilenameExtension } ?? track.format ?? "audio"
            lock.lock(); defer { lock.unlock() }
            guard !cancelled else { throw URLError(.cancelled) }
            try store.install(url, bytes: Int64(size), ext: ext, track: track, ticket: ticket, mime: http.mimeType)
            installed = true
        } catch { failure = error }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if (task.response as? HTTPURLResponse)?.statusCode == 409, let raw = rawRetry,
           DeviceOffline.shared.permitsTransfer(store, ticket) {
            rawRetry = nil; failure = nil; fetch(raw); return
        }
        if let missing = store.missingPlaylistAudio(ticket, httpStatus: (task.response as? HTTPURLResponse)?.statusCode) {
            done(missing); return
        }
        let fallback: Error? = installed ? nil : OfflineFiles.Failure("The audio download was incomplete.")
        let issue = failure ?? error ?? fallback
        let wait = issue == nil ? pace.wait(bytes: received, elapsed: ProcessInfo.processInfo.systemUptime - started) : 0
        if wait > 0.05 { DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + wait) { self.done(nil) } }
        else { done(issue) }
    }
}

private final class DownloadRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

private enum DownloadExtras {
    static func prepare(_ row: OfflineFiles.Row, base: URL, store: OfflineFiles, token: String, refresh: Bool = false) async {
        func enabled() -> Bool {
            !Task.isCancelled && store.preparation(row.track.id)?.name == row.name && DeviceOffline.shared.permitted(store.options())
        }
        guard enabled() else { return }
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil; config.urlCredentialStorage = nil; config.urlCache = nil
        config.timeoutIntervalForRequest = 10; config.timeoutIntervalForResource = 20
        let allow = !store.options().unmeteredOnly
        config.allowsCellularAccess = allow; config.allowsConstrainedNetworkAccess = allow; config.allowsExpensiveNetworkAccess = allow
        let session = URLSession(configuration: config, delegate: DownloadRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        for kind in ["artwork", "lyrics"] {
            guard enabled() else { return }
            let url: URL, limit: Int
            if kind == "artwork" {
                guard let path = OfflineFiles.coverPath(row.track.artworkUrl) else { continue }
                if !refresh, let cover = store.companion(kind, key: path) {
                    try? store.retainCompanion(kind, value: cover, for: row)
                    continue
                }
                guard let address = URL(string: base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path + "?size=500") else { continue }
                url = address; limit = 768 * 1024
            } else {
                if !refresh, store.companion(kind, key: row.track.id) != nil { continue }
                url = base.appendingPathComponent("api/v3/library/tracks").appendingPathComponent(row.track.id).appendingPathComponent("lyrics")
                limit = 256 * 1024
            }
            var request = URLRequest(url: url)
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            do {
                let (bytes, response) = try await session.bytes(for: request)
                guard let http = response as? HTTPURLResponse, enabled() else { return }
                if kind == "lyrics" && http.statusCode == 404 {
                    try store.retainCompanion(kind, value: "null", for: row); continue
                }
                guard http.statusCode == 200, http.expectedContentLength <= limit, let mime = http.mimeType?.lowercased(),
                      kind == "artwork" ? ["image/jpeg", "image/png", "image/webp", "image/avif"].contains(mime) : mime == "application/json" else { continue }
                var data = Data()
                for try await byte in bytes {
                    if data.count >= limit || (data.count.isMultiple(of: 16384) && !enabled()) { break }
                    data.append(byte)
                }
                guard enabled(), !data.isEmpty, data.count < limit else { continue }
                let value: String
                if kind == "artwork" {
                    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                          let width = props[kCGImagePropertyPixelWidth] as? Int, let height = props[kCGImagePropertyPixelHeight] as? Int,
                          (1...4096).contains(width), (1...4096).contains(height) else { continue }
                    value = "data:" + mime + ";base64," + data.base64EncodedString()
                } else {
                    guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                          json["is_synced"] is Bool, json["lines"] is [Any], let text = String(data: data, encoding: .utf8) else { continue }
                    value = text
                }
                try store.retainCompanion(kind, value: value, for: row, reuseArtwork: false)
            } catch { continue }
        }
        if enabled(), store.options().downloadWaveforms == true, let file = store.playable(row.track.id),
           store.representation(row.track.id, file: file)?.name == row.name, store.peaks(row.track.id, file: file) == nil {
            let peaks = await PlaybackWaveform.prepare(file: file, duration: row.track.duration ?? 0)
            if enabled(), peaks.count == 112, let data = try? JSONEncoder().encode(peaks) {
                try? store.retainCompanion("peaks", value: String(decoding: data, as: UTF8.self), for: row)
            }
        }
    }
}

@objc(DNOfflinePlugin)
public final class DNOfflinePlugin: CAPPlugin, CAPBridgedPlugin, NotificationHandlerProtocol {
    public let identifier = "DNOfflinePlugin", jsName = "DNOffline"
    public let pluginMethods: [CAPPluginMethod] = ["snapshot", "options", "configure", "clearCache", "remove", "cancelAutomatic", "planAutomatic", "canSyncCollections", "planCollections", "clearAutomaticPlaylist", "save", "cancelTransfer",
            "enqueueManual", "manualStatus", "cancelManual", "retryManual", "resumeManual", "disconnectDownloads",
            "downloadNotificationSettings", "openDownloadNotificationSettings", "takeDownloadNotification",
            "companion", "diagnostics", "metadataTargets", "applyMetadata", "historySettings", "setOfflineHistory", "discardOfflineHistory"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private let worker = DispatchQueue(label: "app.droppedneedle.offline")
    private var transfers = [UUID: OfflineTransfer]()
    private var extras = [UUID: (OfflineFiles, Task<Void, Never>)]()
    private struct ManualOwner {
        let server: String, user: String, token: String, base: URL, store: OfflineFiles
    }
    private var manualOwner: ManualOwner?
    private var activeJob: (id: UUID, track: String)?
    private var finishingTime: UIBackgroundTaskIdentifier = .invalid // Accessed on the main queue.
    private var backgroundExpired = false // Accessed on worker.
    private var lifecycle = [NSObjectProtocol]()
    private var observer: NSObjectProtocol?, historyObserver: NSObjectProtocol?
    public override func load() {
        if bridge?.notificationRouter.localNotificationHandler == nil { bridge?.notificationRouter.localNotificationHandler = self }
        let center = NotificationCenter.default
        lifecycle.append(center.addObserver(forName: DeviceOffline.connectionChanged, object: nil, queue: nil) { [weak self] _ in
            self?.worker.async { [weak self] in self?.advanceManual(); self?.notifyManual() }
        })
        lifecycle.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.worker.async { [weak self] in
                guard let self, self.activeJob != nil else { return }
                DispatchQueue.main.async { self.beginFinishingTime() }
            }
        })
        lifecycle.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.endFinishingTime()
            self?.worker.async { [weak self] in self?.backgroundExpired = false; self?.advanceManual() }
        })
        observer = NotificationCenter.default.addObserver(forName: DeviceOffline.mediaChanged, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("mediaChanged", data: [:])
            self?.worker.async { [weak self] in self?.advanceManual() }
        }
        historyObserver = NotificationCenter.default.addObserver(forName: DeviceOffline.historyChanged, object: nil, queue: .main) { [weak self] _ in
            self?.notifyListeners("historyChanged", data: [:])
        }
    }
    deinit { for token in lifecycle + [observer, historyObserver].compactMap({ $0 }) { NotificationCenter.default.removeObserver(token) } }
    private func endFinishingTime() {
        if finishingTime != .invalid {
            UIApplication.shared.endBackgroundTask(finishingTime); finishingTime = .invalid
        }
    }
    private func beginFinishingTime() {
        guard UIApplication.shared.applicationState != .active, finishingTime == .invalid else { return }
        finishingTime = UIApplication.shared.beginBackgroundTask(withName: "Finish music download") { [weak self] in
            guard let self else { return }
            self.worker.async {
                self.backgroundExpired = true
                if let job = self.activeJob { self.cancel(job.id); self.activeJob = nil }
                self.notifyManual()
            }
            self.endFinishingTime()
        }
    }
    private func history(_ call: CAPPluginCall, _ operation: @escaping (OfflineListenJournal) throws -> OfflineListenJournal.Status) {
        worker.async {
            do {
                let journal = try DeviceOffline.shared.history(call.getString("serverUrl"), call.getString("userId"))
                let status = try operation(journal)
                call.resolve(["enabled":status.enabled, "pending":status.pending])
            } catch { call.reject("Could not access offline listening history.") }
        }
    }
    @objc func historySettings(_ call: CAPPluginCall) { history(call) { try $0.status() } }
    @objc func setOfflineHistory(_ call: CAPPluginCall) {
        guard let enabled = call.getBool("enabled") else { call.reject("Choose whether to record offline listens."); return }
        history(call) { try $0.setEnabled(enabled) }
    }
    @objc func discardOfflineHistory(_ call: CAPPluginCall) { history(call) { try $0.discard() } }
    private func run(_ call: CAPPluginCall, _ block: @escaping (OfflineFiles) throws -> [String: Any]) {
        worker.async {
            do { let (_, store) = try DeviceOffline.shared.account(call.getString("serverUrl"), call.getString("userId")); call.resolve(try block(store)) }
            catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func diagnostics(_ call: CAPPluginCall) {
        run(call) { store in
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
            let system = ProcessInfo.processInfo.operatingSystemVersion
            let journal = try DeviceOffline.shared.history(call.getString("serverUrl"), call.getString("userId"))
            return ["text": try store.diagnostics(version: version, system: [system.majorVersion, system.minorVersion, system.patchVersion].map(String.init).joined(separator: "."),
                network: DeviceOffline.shared.networkName, pendingListens: journal.status().pending)]
        }
    }
    @objc func metadataTargets(_ call: CAPPluginCall) {
        run(call) { store in
            guard !store.options().offlineOnly else { throw OfflineFiles.Failure("Reconnect to update saved music.") }
            return ["targets": store.rows().map { ["id": $0.track.id, "album": $0.track.albumId ?? "", "version": $0.name] }]
        }
    }
    @objc func applyMetadata(_ call: CAPPluginCall) {
        worker.async {
            do {
                guard let token = call.getString("token"), !token.isEmpty,
                      let batch = call.getArray("updates", [String: Any].self), batch.count <= 100 else { throw OfflineFiles.Failure("Invalid metadata batch.") }
                let (base, store) = try DeviceOffline.shared.account(call.getString("serverUrl"), call.getString("userId"))
                guard let refreshID = call.getString("transferId").flatMap(UUID.init(uuidString:)), self.extras[refreshID] == nil else {
                    throw OfflineFiles.Failure("Invalid metadata refresh.")
                }
                var updated = [String]()
                for item in batch {
                    guard let data = item["track"] as? [String: Any], let expected = item["version"] as? String else { throw OfflineFiles.Failure("Invalid saved track.") }
                    let (track, _) = try DeviceOffline.track(data, base)
                    if try store.refresh(track, expected: expected) { updated.append(track.id) }
                }
                let ids = updated
                let refresh = Task {
                    for id in ids {
                        if Task.isCancelled { break }
                        if let row = store.preparation(id) { await DownloadExtras.prepare(row, base: base, store: store, token: token, refresh: true) }
                    }
                    self.worker.async { self.extras.removeValue(forKey: refreshID); call.resolve(["updated": ids]) }
                }
                self.extras[refreshID] = (store, refresh)
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func snapshot(_ call: CAPPluginCall) {
        run(call) { store in
            let items: [[String: Any]] = try store.rows().map { (["track": try OfflineFiles.dictionary($0.track), "bytes": $0.bytes,
                                                               "origin": $0.origin.rawValue, "pinned": $0.origin == .downloaded, "used": $0.used] as [String: Any]).merging($0.mime.map { ["mime": $0] } ?? [:]) { a, _ in a } }
            return ["options": try OfflineFiles.dictionary(store.options()), "items": items, "pinnedPlaylists": store.pinnedPlaylists()]
        }
    }
    @objc func companion(_ call: CAPPluginCall) {
        run(call) { store in
            guard let kind = call.getString("kind"), let key = call.getString("key"),
                  let value = store.companion(kind, key: key) else { return [:] }
            return ["source": value]
        }
    }
    @objc func options(_ call: CAPPluginCall) { run(call) { try OfflineFiles.dictionary($0.options()) } }
    @objc func configure(_ call: CAPPluginCall) {
        run(call) { store in
            let data = try JSONSerialization.data(withJSONObject: call.getObject("options") ?? [:])
            let next = try JSONDecoder().decode(OfflineFiles.Options.self, from: data)
            let clearNotice = store.options().notifyDownloads == true && next.notifyDownloads != true
            try store.configure(next, clearUnpinned: call.getBool("clearUnpinned") == true)
            if clearNotice { self.clearNotification(store) }
            return try OfflineFiles.dictionary(store.options())
        }
    }
    @objc func remove(_ call: CAPPluginCall) { run(call) { try $0.remove(call.getArray("ids", String.self) ?? []); return [:] } }
    @objc func clearCache(_ call: CAPPluginCall) { run(call) { try $0.clearCache(); return [:] } }
    @objc func cancelAutomatic(_ call: CAPPluginCall) { run(call) { try $0.cancelAutomatic(); return [:] } }
    @objc func planAutomatic(_ call: CAPPluginCall) {
        run(call) { store in
            guard let source = call.getString("source"), let ids = call.getArray("ids", String.self),
                  call.options["keepExisting"] == nil || call.getBool("keepExisting") != nil else {
                throw OfflineFiles.Failure("Choose a valid automatic download source and track list.")
            }
            guard DeviceOffline.shared.permitted(store.options()) else { return ["ids": [String]()] }
            return ["ids": try store.plan(source, ids: ids, keepExisting: call.getBool("keepExisting") ?? false)]
        }
    }
    @objc func canSyncCollections(_ call: CAPPluginCall) {
        run(call) { store in
            let options = store.options()
            return ["permitted": !options.offlineOnly && DeviceOffline.shared.permitted(options)]
        }
    }
    @objc func planCollections(_ call: CAPPluginCall) {
        run(call) { store in
            guard let source = call.getString("source"), let raw = call.getArray("pins", JSObject.self),
                  let rows = call.getArray("members", JSObject.self) else { throw OfflineFiles.Failure("Invalid offline collections.") }
            let decoder = JSONDecoder()
            let pins = try decoder.decode([OfflineFiles.Pin].self, from: JSONSerialization.data(withJSONObject: raw))
            let members = try decoder.decode([OfflineFiles.Membership].self, from: JSONSerialization.data(withJSONObject: rows))
            guard DeviceOffline.shared.permitted(store.options()) else { return ["ids": [String]()] }
            return ["ids": try store.planPins(expected: pins, source: source, members: members)]
        }
    }
    @objc func clearAutomaticPlaylist(_ call: CAPPluginCall) {
        run(call) { store in try OfflineFiles.dictionary(store.clearAutomaticPlaylist(call.getString("source") ?? "")) }
    }
    @objc func cancelTransfer(_ call: CAPPluginCall) {
        run(call) { store in
            if let id = call.getString("transferId").flatMap(UUID.init(uuidString:)),
               let transfer = self.transfers[id], transfer.store === store { transfer.cancel() }
            if let id = call.getString("transferId").flatMap(UUID.init(uuidString:)),
               let (owner, task) = self.extras[id], owner === store { task.cancel() }
            return [:]
        }
    }
    private func cancel(_ id: UUID) {
        transfers[id]?.cancel(); extras[id]?.1.cancel()
    }
    private func download(base: URL, store: OfflineFiles, track: OfflineFiles.Track, url: URL, source: String?,
                          token: String, id: UUID, done: @escaping (Error?) -> Void) {
        do {
            guard transfers[id] == nil, extras[id] == nil else { throw OfflineFiles.Failure("Download already in progress.") }
            @Sendable func finish() {
                guard !token.isEmpty, let row = store.preparation(track.id), DeviceOffline.shared.permitted(store.options()) else {
                    done(nil); return
                }
                let task = Task {
                    await DownloadExtras.prepare(row, base: base, store: store, token: token)
                    self.worker.async { self.extras.removeValue(forKey: id); done(nil) }
                }
                self.extras[id] = (store, task)
            }
            guard let ticket = try store.begin(track, origin: source == nil ? .downloaded : .automatic, source: source) else { finish(); return }
            guard !token.isEmpty else { throw OfflineFiles.Failure("Reconnect to download this song.") }
            let options = store.options()
            guard !options.offlineOnly, DeviceOffline.shared.permitted(options) else { throw OfflineFiles.Failure("Connect to a permitted network or change Offline settings.") }
            let profile = StreamProfile(options.downloadQuality.map { ["format": $0.format, "rate": $0.rate] as [String: Any] })
            let transfer = OfflineTransfer(store: store, track: track, ticket: ticket) { error in
                self.worker.async {
                    self.transfers.removeValue(forKey: id)
                    if let error { done(error) } else { finish() }
                }
            }
            self.transfers[id] = transfer
            transfer.start(url, token, profile: profile)
        } catch { done(error) }
    }

    private static var notificationTap = DownloadNotificationTap() // Accessed on the main queue.
    @discardableResult static func receive(_ response: UNNotificationResponse) -> Bool {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return false }
        let request = response.notification.request
        return notificationTap.receive(scope: request.content.userInfo["dn-download-scope"] as? String,
                                       identifier: request.identifier, delivered: response.notification.date)
    }
    public func willPresent(notification: UNNotification) -> UNNotificationPresentationOptions { [] }
    public func didReceive(response: UNNotificationResponse) {
        DispatchQueue.main.async {
            if Self.receive(response) { self.bridge?.triggerWindowJSEvent(eventName: "dn-download-notification") }
        }
    }
    @objc func takeDownloadNotification(_ call: CAPPluginCall) {
        worker.async {
            let owner = try? DeviceOffline.shared.account(call.getString("serverUrl"), call.getString("userId")).1.accountDirectory
            DispatchQueue.main.async {
                call.resolve(["open": Self.notificationTap.take(owner: owner)])
            }
        }
    }
    @objc func downloadNotificationSettings(_ call: CAPPluginCall) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined: call.resolve(["state": "undecided"])
            case .authorized, .provisional, .ephemeral: call.resolve(["state": "on"])
            default: call.resolve(["state": "appOff"])
            }
        }
    }
    @objc func openDownloadNotificationSettings(_ call: CAPPluginCall) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            if settings.authorizationStatus == .notDetermined {
                center.requestAuthorization(options: [.alert]) { _, error in
                    if error != nil { call.reject("Could not request notification permission.") } else { call.resolve() }
                }
            } else {
                DispatchQueue.main.async {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { call.reject("Could not open Settings."); return }
                    UIApplication.shared.open(url) { opened in
                        if opened { call.resolve() } else { call.reject("Could not open Settings.") }
                    }
                }
            }
        }
    }
    private func clearNotification(_ store: OfflineFiles) {
        let scope = store.accountDirectory, ids = [DownloadNotificationTap.prefix + scope]
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: ids)
        center.removeDeliveredNotifications(withIdentifiers: ids)
        DispatchQueue.main.async {
            Self.notificationTap.clear(owner: scope)
        }
    }
    private func notifyDownloadCompletion(_ store: OfflineFiles) {
        guard store.options().notifyDownloads == true else { return }
        let queue = store.manualQueue(), failed = queue.jobs.filter { $0.failure != nil }.count
        guard queue.jobs.count == failed, failed + queue.saved > 0 else { return }
        let scope = store.accountDirectory, content = UNMutableNotificationContent()
        let ja = Locale.preferredLanguages.first?.hasPrefix("ja") == true
        content.title = failed > 0 ? (ja ? "ダウンロードを確認してください" : "Downloads need attention") :
            (ja ? "ダウンロード完了" : "Downloads complete")
        content.body = ja ? "\(queue.saved) 曲を保存。失敗 \(failed) 曲。" :
            (failed > 0 ? "\(queue.saved) saved · \(failed) failed" : "\(queue.saved) saved for offline playback")
        content.userInfo = ["dn-download-scope": scope]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: DownloadNotificationTap.prefix + scope, content: content, trigger: nil), withCompletionHandler: nil)
    }
    private func notifyManual() {
        DispatchQueue.main.async { self.notifyListeners("manualChanged", data: [:]) }
    }
    private func status(_ store: OfflineFiles) -> [String: Any] {
        let options = store.options()
        return store.manualQueue().status(current: manualOwner?.store === store ? activeJob?.track : nil,
                                          permitted: DeviceOffline.shared.permitted(options), offline: options.offlineOnly)
    }
    private func setOwner(_ call: CAPPluginCall) throws -> ManualOwner {
        guard let server = call.getString("serverUrl"), let user = call.getString("userId"),
              let token = call.getString("token"), !token.isEmpty else { throw OfflineFiles.Failure("Reconnect to resume downloads.") }
        let (base, store) = try DeviceOffline.shared.account(server, user)
        if manualOwner?.store !== store || manualOwner?.token != token {
            if let activeJob { cancel(activeJob.id); self.activeJob = nil }
        }
        let owner = ManualOwner(server: server, user: user, token: token, base: base, store: store)
        manualOwner = owner
        return owner
    }
    private func advanceManual() {
        guard activeJob == nil, !backgroundExpired, let owner = manualOwner else { return }
        let options = owner.store.options(), allowed = !options.offlineOnly && DeviceOffline.shared.permitted(options)
        let queue = owner.store.manualQueue()
        guard let job = queue.jobs.first(where: { $0.failure == nil && (allowed || owner.store.playable($0.track.id) != nil) }) else {
            DispatchQueue.main.async { self.endFinishingTime() }; return
        }
        let id = UUID(); activeJob = (id, job.track.id); notifyManual()
        let url = owner.base.appendingPathComponent("api/v3/stream/local").appendingPathComponent(job.track.id)
        download(base: owner.base, store: owner.store, track: job.track, url: url, source: nil, token: owner.token, id: id) { error in
            self.worker.async {
                guard self.activeJob?.id == id else { return }
                self.activeJob = nil
                if error == nil || (DeviceOffline.shared.permitted(owner.store.options()) && !owner.store.options().offlineOnly) {
                    do {
                        try owner.store.finishManual(job.track.id, failure: error == nil ? nil : "DN could not save this song. Reconnect and retry.")
                        self.notifyDownloadCompletion(owner.store)
                    }
                    catch { self.notifyManual(); return }
                }
                self.notifyManual(); self.advanceManual()
            }
        }
    }
    @objc func resumeManual(_ call: CAPPluginCall) {
        worker.async {
            do { _ = try self.setOwner(call); self.advanceManual(); call.resolve() }
            catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func enqueueManual(_ call: CAPPluginCall) {
        worker.async {
            do {
                let owner = try self.setOwner(call)
                guard let input = call.getArray("tracks", [String: Any].self) else { throw OfflineFiles.Failure("Choose local songs.") }
                let tracks = try input.map { try DeviceOffline.track($0, owner.base).0 }
                let result = try owner.store.enqueue(tracks)
                if result.added > 0 { self.clearNotification(owner.store) }
                self.advanceManual(); self.notifyManual()
                call.resolve(["queued": result.added, "saved": result.saved, "alreadyQueued": result.already,
                              "failed": 0, "status": self.status(owner.store)])
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func manualStatus(_ call: CAPPluginCall) { run(call) { self.status($0) } }
    @objc func retryManual(_ call: CAPPluginCall) {
        run(call) { store in try store.retryManual(); self.advanceManual(); self.notifyManual(); return self.status(store) }
    }
    private func clearManual(_ store: OfflineFiles, disconnect: Bool) throws {
        if manualOwner?.store === store {
            if let activeJob { cancel(activeJob.id); self.activeJob = nil }
            if disconnect { manualOwner = nil }
        }
        if disconnect {
            for (_, transfer) in transfers where transfer.store === store { transfer.cancel() }
            for (_, (owner, task)) in extras where owner === store { task.cancel() }
            try store.cancelAutomatic()
        }
        try store.cancelManual(); clearNotification(store); notifyManual()
        if activeJob == nil { DispatchQueue.main.async { self.endFinishingTime() } }
    }
    @objc func cancelManual(_ call: CAPPluginCall) {
        run(call) { store in try self.clearManual(store, disconnect: false); return self.status(store) }
    }
    @objc func disconnectDownloads(_ call: CAPPluginCall) {
        run(call) { store in try self.clearManual(store, disconnect: true); return [:] }
    }
    @objc func save(_ call: CAPPluginCall) {
        worker.async {
            do {
                let (base, store) = try DeviceOffline.shared.account(call.getString("serverUrl"), call.getString("userId"))
                let (track, url) = try DeviceOffline.track(call.getObject("track") ?? [:], base)
                let source = call.getBool("collection") == true ? "pinnedCollections" : call.getString("source")
                if call.options["source"] != nil && source.map(OfflineFiles.enabledSource) != true {
                    throw OfflineFiles.Failure("Choose a supported automatic download source.")
                }
                let id = call.getString("transferId").flatMap(UUID.init(uuidString:)) ?? UUID()
                self.download(base: base, store: store, track: track, url: url, source: source,
                              token: call.getString("token") ?? "", id: id) { error in
                    if let error { call.reject(error.localizedDescription, (error as? OfflineFiles.Failure)?.code) }
                    else { call.resolve() }
                }
            } catch { call.reject(error.localizedDescription) }
        }
    }
}
