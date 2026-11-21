import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum PlaylistExportError: LocalizedError {
    case invalid, invalidLayout, unavailable, picker, cancelled, response, tooLarge, network, file, unauthorized, http(Int)

    var code: String {
        switch self {
        case .invalid: return "INVALID_EXPORT"
        case .invalidLayout: return "INVALID_LAYOUT"
        case .unavailable: return "EXPORT_UNAVAILABLE"
        case .picker: return "EXPORT_PICKER_UNAVAILABLE"
        case .cancelled: return "EXPORT_CANCELLED"
        case .response: return "INVALID_RESPONSE"
        case .network: return "EXPORT_NETWORK"
        case .file: return "EXPORT_FILE"
        case .tooLarge: return "EXPORT_TOO_LARGE"
        case .unauthorized: return "DN_UNAUTHORIZED"
        case .http(let status): return "HTTP_\(status)"
        }
    }
    var errorDescription: String? {
        switch self {
        case .invalid: return "Check the playlist address and export filename."
        case .invalidLayout: return "Use player layout text no larger than 64 KiB."
        case .unavailable: return "Prepare the playlist again before saving."
        case .picker: return "Return to DroppedNeedle and close any open sheet before saving the file."
        case .cancelled: return "Playlist export cancelled."
        case .response: return "DN returned an incomplete or unexpected file. Check the server address and sign-in proxy."
        case .network: return "The connection to DN stopped before the export finished."
        case .tooLarge: return "The playlist export exceeds the size limit."
        case .file: return "Could not write the export file. Check the available storage and try again."
        case .unauthorized: return "Your DroppedNeedle session expired."
        case .http(let status): return "DN returned HTTP \(status)."
        }
    }
}

enum PlaylistExportFormat: String, Sendable {
    case m3u8, csv
    var mime: String { self == .m3u8 ? "audio/x-mpegurl" : "text/csv" }

    private func safeSegment(_ encoded: Substring) -> Bool {
        guard let value = encoded.removingPercentEncoding, !value.isEmpty, value != ".", value != ".." else { return false }
        return value.rangeOfCharacter(from: CharacterSet(charactersIn: "/\\%").union(.controlCharacters)) == nil
    }
    func request(server: String, url: String, token: String) throws -> URLRequest {
        guard !token.isEmpty, token.utf8.allSatisfy({ (33...126).contains($0) }),
              !server.contains("\\"), !url.contains("\\"),
              let base = URLComponents(string: server), let target = URLComponents(string: url),
              let host = base.host?.lowercased(), !host.isEmpty, let scheme = base.scheme?.lowercased(),
              scheme == "https" || (scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)),
              target.scheme?.lowercased() == scheme, target.host?.lowercased() == host,
              (base.port ?? (scheme == "https" ? 443 : 80)) == (target.port ?? (scheme == "https" ? 443 : 80)),
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              target.user == nil, target.password == nil, target.fragment == nil else { throw PlaylistExportError.invalid }
        var basePath = base.percentEncodedPath
        while basePath.last == "/" { basePath.removeLast() }
        let route = basePath + "/api/v3/playlists/"
        let path = target.percentEncodedPath
        guard basePath.split(separator: "/").allSatisfy(safeSegment), path.hasPrefix(route) else { throw PlaylistExportError.invalid }
        let tail = path.dropFirst(route.count).split(separator: "/", omittingEmptySubsequences: false)
        let query = target.queryItems ?? []
        guard tail.count == 2, safeSegment(tail[0]), tail[1] == "export",
              query.allSatisfy({ $0.name == "format" || $0.name == "prefix" }),
              Set(query.map(\.name)).count == query.count,
              query.first(where: { $0.name == "format" })?.value == rawValue,
              let endpoint = target.url else { throw PlaylistExportError.invalid }
        var request = URLRequest(url: endpoint)
        request.httpShouldHandleCookies = false
        request.setValue(mime, forHTTPHeaderField: "Accept")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        return request
    }
    func validFilename(_ name: String) -> Bool {
        let forbidden = CharacterSet(charactersIn: "<>:\"/\\|?*\u{202a}\u{202b}\u{202c}\u{202d}\u{202e}\u{2066}\u{2067}\u{2068}\u{2069}").union(.controlCharacters)
        return name.utf8.count <= 250 && !name.hasPrefix(".") && name.count > rawValue.count + 1
            && name.rangeOfCharacter(from: forbidden) == nil && name.lowercased().hasSuffix("." + rawValue)
    }
}

enum FilePickerOutcome: Sendable {
    case selected(URL?), cancelled, failed(PlaylistExportError)
}

private func privateAttributes(directory: Bool) -> [FileAttributeKey:Any] {
    var result: [FileAttributeKey:Any] = [.posixPermissions: directory ? 0o700 : 0o600]
    #if os(iOS)
    result[.protectionKey] = FileProtectionType.complete
    #endif
    return result
}

struct PlaylistExportBudget {
    var maxBytes: Int64 = 64 * 1024 * 1024
    var freeBytes: (URL) throws -> Int64 = { url in
        let attributes = try FileManager.default.attributesOfFileSystem(forPath: url.path)
        guard let free = attributes[.systemFreeSize] as? NSNumber else { throw PlaylistExportError.file }
        return free.int64Value
    }

    func check(_ bytes: Int64, written: Int64, folder: URL) throws {
        guard bytes <= maxBytes - written else { throw PlaylistExportError.tooLarge }
        guard let free = try? freeBytes(folder), free >= 32 * 1024 * 1024,
              bytes <= free - 32 * 1024 * 1024 else { throw PlaylistExportError.file }
    }
}

/// Each export owns one private file. URLSession delivers network callbacks on the same serial queue as cancellation.
final class PlaylistExports: @unchecked Sendable {
    static let shared = PlaylistExports(root: FileManager.default.temporaryDirectory.appendingPathComponent("dn-playlist-exports"))
    typealias Completion<T> = @Sendable (Result<T, PlaylistExportError>) -> Void
    private let root: URL, configuration: URLSessionConfiguration
    private let budget: PlaylistExportBudget
    private let io = DispatchQueue(label: "app.droppedneedle.playlist-export")
    private let delegateQueue = OperationQueue()
    private var transfers: [UUID: PlaylistExportTransfer] = [:]
    private var layouts: [UUID: URL] = [:]
    private static let maxLayoutBytes = 65_536
    private var opened = false

    init(root: URL, configuration: URLSessionConfiguration = .ephemeral, budget: PlaylistExportBudget = .init()) {
        self.root = root
        self.budget = budget
        self.configuration = configuration
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 900
        delegateQueue.underlyingQueue = io
        delegateQueue.maxConcurrentOperationCount = 1
        io.async { [weak self] in try? self?.openRoot() }
    }
    private func openRoot() throws {
        guard !opened else { return }
        // A process restart invalidates every picker handle from the previous run.
        let files = FileManager.default
        if files.fileExists(atPath: root.path) { try files.removeItem(at: root) }
        try files.createDirectory(at: root, withIntermediateDirectories: true, attributes: privateAttributes(directory: true))
        opened = true
    }
    private func createFolder(_ id: UUID) throws -> URL {
        guard transfers[id] == nil && layouts[id] == nil else { throw PlaylistExportError.invalid }
        try openRoot()
        let folder = root.appendingPathComponent(id.uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false, attributes: privateAttributes(directory: true))
        return folder
    }
    func prepare(_ id: UUID, server: String, url: String, token: String, format: PlaylistExportFormat,
                 done: @escaping Completion<[String:String]>) {
        io.async {
            do {
                let request = try format.request(server: server, url: url, token: token)
                let folder = try self.createFolder(id)
                let job = PlaylistExportTransfer(format: format, folder: folder, budget: self.budget)
                self.transfers[id] = job
                job.start(request, configuration: self.configuration, queue: self.delegateQueue) { result in
                    if case .failure = result { self.transfers.removeValue(forKey: id) }
                    done(result)
                }
            } catch { done(.failure(error as? PlaylistExportError ?? .file)) }
        }
    }
    func layoutFile(_ id: UUID, text: String, diagnostics: Bool = false, done: @escaping Completion<URL>) {
        io.async {
            let bytes = Data(text.utf8.prefix(Self.maxLayoutBytes + 1))
            guard bytes.count <= Self.maxLayoutBytes else { done(.failure(.invalidLayout)); return }
            do {
                let folder = try self.createFolder(id)
                let file = folder.appendingPathComponent(diagnostics ? "droppedneedle-diagnostics.json" : "droppedneedle-player-layout.json", isDirectory: false)
                guard FileManager.default.createFile(atPath: file.path, contents: bytes, attributes: privateAttributes(directory: false)) else {
                    try? FileManager.default.removeItem(at: folder)
                    throw PlaylistExportError.file
                }
                self.layouts[id] = folder
                done(.success(file))
            } catch { done(.failure(error as? PlaylistExportError ?? .file)) }
        }
    }
    func pickerFile(_ id: UUID, filename: String, done: @escaping Completion<URL>) {
        io.async {
            guard let job = self.transfers[id] else { done(.failure(.unavailable)); return }
            do { done(.success(try job.pickerFile(filename))) }
            catch { done(.failure(error as? PlaylistExportError ?? .file)) }
        }
    }
    func discard(_ id: UUID, done: @escaping @Sendable () -> Void = {}) {
        io.async {
            self.transfers.removeValue(forKey: id)?.discard()
            if let folder = self.layouts.removeValue(forKey: id) { try? FileManager.default.removeItem(at: folder) }
            done()
        }
    }
    func finishPicker(_ id: UUID, _ outcome: FilePickerOutcome, done: @escaping Completion<Bool>) {
        discard(id) {
            switch outcome {
            case .selected(.some): done(.success(true))
            case .selected(.none): done(.failure(.file))
            case .cancelled: done(.success(false))
            case .failed(let error): done(.failure(error))
            }
        }
    }
}

private final class PlaylistExportTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let format: PlaylistExportFormat, folder: URL
    private let budget: PlaylistExportBudget
    private var file: URL, handle: FileHandle?, task: URLSessionDataTask?
    private var done: PlaylistExports.Completion<[String:String]>?
    private var headers: [String:String]?, unauthorizedBody: Data?, expected: Int64?, written: Int64 = 0
    private var ready = false

    init(format: PlaylistExportFormat, folder: URL, budget: PlaylistExportBudget) {
        self.budget = budget
        self.format = format
        self.folder = folder
        self.file = folder.appendingPathComponent("partial")
    }
    func start(_ request: URLRequest, configuration: URLSessionConfiguration, queue: OperationQueue,
               done: @escaping PlaylistExports.Completion<[String:String]>) {
        self.done = done
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        let task = session.dataTask(with: request)
        self.task = task
        task.resume()
        session.finishTasksAndInvalidate()
    }
    func pickerFile(_ name: String) throws -> URL {
        guard ready else { throw PlaylistExportError.unavailable }
        guard format.validFilename(name) else { throw PlaylistExportError.invalid }
        let destination = folder.appendingPathComponent(name, isDirectory: false)
        if destination != file {
            try FileManager.default.moveItem(at: file, to: destination)
            file = destination
        }
        return file
    }
    func discard() {
        if done != nil { finish(.failure(.cancelled)) }
        else { try? FileManager.default.removeItem(at: folder) }
    }
    private func finish(_ result: Result<[String:String], PlaylistExportError>) {
        guard let completion = done else { return }
        done = nil
        if case .failure = result {
            task?.cancel()
            try? handle?.close()
            try? FileManager.default.removeItem(at: folder)
        }
        handle = nil
        task = nil
        unauthorizedBody = nil
        completion(result)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard done != nil, let http = response as? HTTPURLResponse else {
            completionHandler(.cancel); finish(.failure(.response)); return
        }
        let mime = http.value(forHTTPHeaderField: "Content-Type")?.components(separatedBy: ";").first?
            .trimmingCharacters(in: .whitespaces).lowercased()
        let coding = (http.value(forHTTPHeaderField: "Content-Encoding") ?? "identity").lowercased()
        if coding == "identity" && http.expectedContentLength >= 0 { expected = http.expectedContentLength }
        if http.statusCode == 401 && mime == "application/json" {
            guard (expected ?? 0) <= 16384 else {
                completionHandler(.cancel); finish(.failure(.http(401))); return
            }
            unauthorizedBody = Data()
            completionHandler(.allow)
            return
        }
        guard http.statusCode == 200, mime == format.mime else {
            completionHandler(.cancel)
            finish(.failure(http.statusCode == 200 ? .response : .http(http.statusCode)))
            return
        }
        do { try budget.check(max(0, http.expectedContentLength), written: 0, folder: folder) }
        catch { completionHandler(.cancel); finish(.failure(error as? PlaylistExportError ?? .file)); return }
        guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: privateAttributes(directory: false)),
              let handle = try? FileHandle(forWritingTo: file) else {
            completionHandler(.cancel); finish(.failure(.file)); return
        }
        self.handle = handle
        var selected: [String:String] = [:]
        selected["contentDisposition"] = http.value(forHTTPHeaderField: "Content-Disposition")
        selected["skippedTracks"] = http.value(forHTTPHeaderField: "X-DroppedNeedle-Skipped-Tracks")
        headers = selected
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard done != nil else { return }
        if let body = unauthorizedBody {
            guard data.count <= 16384 - body.count else { finish(.failure(.http(401))); return }
            unauthorizedBody?.append(data)
            return
        }
        guard let handle, Int64(data.count) <= (expected ?? Int64.max) - written else { finish(.failure(.response)); return }
        do {
            try budget.check(Int64(data.count), written: written, folder: folder)
            try handle.write(contentsOf: data)
            written += Int64(data.count)
        } catch { finish(.failure(error as? PlaylistExportError ?? .file)) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard done != nil else { return }
        if let body = unauthorizedBody {
            let json = (try? JSONSerialization.jsonObject(with: body)) as? [String:Any]
            let code = (json?["error"] as? [String:Any])?["code"] as? String
            let complete = error == nil && (expected == nil || expected == Int64(body.count))
            finish(.failure(complete && code == "UNAUTHORIZED" ? .unauthorized : .http(401)))
            return
        }
        guard error == nil else { finish(.failure(.network)); return }
        guard let headers, let handle, written > 0, expected == nil || written == expected else { finish(.failure(.response)); return }
        do { try handle.close(); self.handle = nil }
        catch { finish(.failure(.file)); return }
        ready = true
        finish(.success(headers))
    }
}
