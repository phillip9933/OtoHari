import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Only one POST is in flight so stop precedes the next start of the same song.
/// Request destinations and credentials are fixed when each event is enqueued.
final class PlaybackReportSender: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let worker = DispatchQueue(label: "app.droppedneedle.playback-reports")
    private let configuration: URLSessionConfiguration
    private struct Report: Sendable { let request: URLRequest, permitted: @Sendable () -> Bool }
    private var pending: [Report] = [], active: (Report, URLSessionDataTask)?
    private lazy var session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    init(configuration: URLSessionConfiguration = .ephemeral) {
        configuration.httpCookieStorage = nil; configuration.urlCache = nil; configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 5; configuration.timeoutIntervalForResource = 5
        self.configuration = configuration
        super.init()
    }
    func send(_ events: [PlaybackHistory.Event], server: String, token: String, device: String,
              permitted: @escaping @Sendable () -> Bool = { true }) {
        guard !events.isEmpty, !token.isEmpty, let base = URL(string: server), base.scheme == "https",
              base.host != nil, base.user == nil, base.password == nil, base.query == nil, base.fragment == nil else { return }
        let endpoint = base.appendingPathComponent("api/v3/playback")
        let requests: [URLRequest] = events.compactMap { event in
            guard case .live = event.route, let body = try? JSONSerialization.data(withJSONObject: event.body(device: device)) else { return nil }
            var req = URLRequest(url: endpoint.appendingPathComponent(event.operation))
            req.httpMethod = "POST"; req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            return req
        }
        worker.async {
            for req in requests {
                let progress = req.url?.lastPathComponent == "progress"
                if progress && self.pending.count > 1 { continue }
                if self.pending.count >= 64 {
                    if let stale = self.pending.firstIndex(where: { $0.request.url?.lastPathComponent == "progress" }) { self.pending.remove(at: stale) }
                    else { continue }
                }
                self.pending.append(Report(request: req, permitted: permitted))
            }
            self.next()
        }
    }
    private func next() {
        while let first = pending.first, !first.permitted() { pending.removeFirst() }
        guard active == nil, !pending.isEmpty else { return }
        let report = pending.removeFirst()
        let task = session.dataTask(with: report.request) { [weak self] _, _, _ in
            guard let self else { return }
            self.worker.async { self.active = nil; self.next() }
        }
        active = (report, task); task.resume()
    }
    func permissionsChanged() {
        worker.async {
            self.pending.removeAll { !$0.permitted() }
            if let (report, task) = self.active, !report.permitted() { task.cancel() }
        }
    }
    func close() {
        worker.async { self.pending.removeAll(); self.session.invalidateAndCancel() }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
