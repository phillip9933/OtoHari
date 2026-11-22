import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(Capacitor)
import Capacitor
#endif

enum DNReadKind: String {
    case artwork, preview, search
    var limit: Int { self == .preview ? 2 * 1024 * 1024 : 8 * 1024 * 1024 }
    var accept: String {
        switch self {
        case .artwork: return "image/*"
        case .preview: return "audio/*, application/octet-stream"
        case .search: return "application/json"
        }
    }
    func accepts(_ mime: String) -> Bool {
        switch self {
        case .artwork: return ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"].contains(mime)
        case .preview: return mime.hasPrefix("audio/") || ["application/octet-stream", "application/ogg", "application/flac"].contains(mime)
        case .search: return mime == "application/json"
        }
    }
}

// Each ephemeral session delivers its delegate calls serially. Bytes are checked before appending.
final class DNReadTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let kind: DNReadKind
    private var buffer = Data()
    private var status = 0, limit = 0
    private var mime = "", readBody = false, accepted = false
    typealias Reply = (Int, String, String?)
    private let completion: (Reply?) -> Void
    init(kind: DNReadKind, completion: @escaping (Reply?) -> Void) {
        self.kind = kind
        self.completion = completion
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse else { completionHandler(.cancel); return }
        status = http.statusCode
        mime = http.mimeType?.lowercased() ?? ""
        let ok = (200...299).contains(status)
        let warming = kind == .artwork && status == 202
        readBody = !warming && (ok || mime == "application/json")
        limit = ok ? kind.limit : 32768
        guard warming || !ok || (status == (kind == .preview ? 206 : 200) && kind.accepts(mime)),
              !readBody || response.expectedContentLength <= Int64(limit) else { completionHandler(.cancel); return }
        accepted = true
        completionHandler(readBody ? .allow : .cancel)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard accepted, readBody else { return }
        guard data.count <= limit - buffer.count else { accepted = false; dataTask.cancel(); return }
        buffer.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard accepted, error == nil || !readBody else { completion(nil); return }
        let text = !(200...299).contains(status) || kind == .search
        let data = text ? String(data: buffer, encoding: .utf8) : buffer.base64EncodedString()
        completion((status, mime, readBody ? data : nil))
    }
}

#if canImport(Capacitor)
@objc(DNReadPlugin)
public final class DNReadPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DNReadPlugin"
    public let jsName = "DNRead"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "read", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise)
    ]
    private let lock = NSLock()
    private var active: [UUID: URLSessionDataTask] = [:]

    @objc func read(_ call: CAPPluginCall) {
        guard let id = UUID(uuidString: call.getString("id") ?? ""), let kind = DNReadKind(rawValue: call.getString("kind") ?? ""),
              let token = call.getString("token"), !token.isEmpty, token.utf8.allSatisfy({ (33...126).contains($0) }),
              let base = URLComponents(string: call.getString("server") ?? ""), let host = base.host?.lowercased(),
              let url = URLComponents(string: call.getString("url") ?? ""), let endpoint = url.url,
              base.scheme == "https" || (base.scheme == "http" && ["localhost","127.0.0.1","::1","[::1]"].contains(host)),
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              url.scheme == base.scheme, url.host?.lowercased() == host, url.port == base.port,
              url.user == nil, url.password == nil, url.fragment == nil else { call.reject("Invalid DroppedNeedle read."); return }
        let prefix = base.percentEncodedPath.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let api = (prefix.isEmpty ? "" : "/" + prefix) + "/api/v3/"
        guard url.percentEncodedPath.hasPrefix(api),
              url.percentEncodedPath.split(separator: "/").allSatisfy({ part in
                guard let decoded = part.removingPercentEncoding else { return false }
                return decoded != ".." && decoded != "." && !decoded.contains("/") && !decoded.contains("\\")
              }) else { call.reject("Invalid DroppedNeedle read."); return }
        var request = URLRequest(url: endpoint)
        request.httpShouldHandleCookies = false
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue(kind.accept, forHTTPHeaderField: "Accept")
        if kind == .preview { request.setValue("bytes=0-2097151", forHTTPHeaderField: "Range") }
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        config.timeoutIntervalForResource = 30
        let transfer = DNReadTransfer(kind: kind) { [weak self] reply in
            if let self { self.lock.lock(); self.active.removeValue(forKey: id); self.lock.unlock() }
            guard let (status, type, data) = reply else { call.reject("Could not finish the DroppedNeedle request."); return }
            var result: [String: Any] = ["status": status, "type": type]
            result["data"] = data
            call.resolve(result)
        }
        lock.lock()
        guard active[id] == nil else { lock.unlock(); call.reject("Duplicate read."); return }
        let session = URLSession(configuration: config, delegate: transfer, delegateQueue: nil)
        let task = session.dataTask(with: request)
        active[id] = task
        lock.unlock()
        task.resume()
        session.finishTasksAndInvalidate()
    }

    @objc func cancel(_ call: CAPPluginCall) {
        if let id = UUID(uuidString: call.getString("id") ?? "") {
            lock.lock(); let task = active[id]; lock.unlock(); task?.cancel()
        }
        call.resolve()
    }
    deinit { for task in active.values { task.cancel() } }
}
#endif
