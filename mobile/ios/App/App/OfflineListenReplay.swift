import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class OfflineListenPermission: @unchecked Sendable {
    private let check: @Sendable () -> Bool, lock = NSLock()
    private var cancelled = false
    private var cancellation: (@Sendable () -> Void)?
    init(_ check: @escaping @Sendable () -> Bool) { self.check = check }
    var allows: Bool {
        lock.lock(); let stopped = cancelled; lock.unlock()
        return !stopped && check()
    }
    func onCancel(_ callback: (@Sendable () -> Void)?) {
        lock.lock(); let stopped = cancelled
        cancellation = stopped ? nil : callback; lock.unlock()
        if stopped { callback?() }
    }
    func cancel() {
        lock.lock(); cancelled = true; let action = cancellation; cancellation = nil; lock.unlock()
        action?()
    }
}

/// The worker drains one authenticated account on login, reconnection, opt-in or a completed play.
/// A rejected submission needs a later wake; the playback heartbeat never starts a retry.
final class OfflineListenReplay: @unchecked Sendable {
    final class Session: @unchecked Sendable {
        let base: URL, token: String, user: String?, journal: OfflineListenJournal?
        let offlineOnly: () -> Bool
        init?(server: String, token: String, user: String?, account: String?, journal: OfflineListenJournal?, offlineOnly: @escaping () -> Bool) {
            guard !token.isEmpty, let base = URL(string: server), base.scheme == "https", base.host != nil,
                  base.user == nil, base.password == nil, base.query == nil, base.fragment == nil else { return nil }
            if let journal, user?.isEmpty != false || journal.account != account { return nil }
            self.base = base; self.token = token; self.user = user; self.journal = journal; self.offlineOnly = offlineOnly
        }
    }
    typealias Submit = @Sendable (URLRequest, Data, OfflineListenPermission) -> Bool
    private let send: Submit, clock: @Sendable () -> Int64
    private let lock = NSLock(), worker = DispatchQueue(label: "app.droppedneedle.offline-listens")
    private let writes = DispatchQueue(label: "app.droppedneedle.completed-listens")
    private var session: Session?, connected: Bool?, active: OfflineListenPermission?
    private var eligible = false, sending = false, again = false
    init(send: @escaping Submit = OfflineListenPost.submit, clock: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) }) {
        self.send = send; self.clock = clock
    }
    func authorize(_ next: Session?) {
        lock.lock(); let old = active; session = next; eligible = false; lock.unlock()
        old?.cancel(); policyChanged()
    }
    func connection(_ reachable: Bool?, pathChanged: Bool = false) {
        lock.lock()
        if pathChanged && connected == true && reachable == true { eligible = false }
        connected = reachable; lock.unlock()
        policyChanged()
    }
    private func state() -> (Session?, Bool?) {
        lock.lock(); defer { lock.unlock() }; return (session, connected)
    }
    func live(_ owner: Session) -> Bool {
        let (current, connected) = state()
        return current === owner && connected == true && !owner.offlineOnly()
    }
    private func permitted(_ owner: Session) -> Bool {
        live(owner) && owner.journal?.revision.isMultiple(of: 2) == true
    }
    func route(_ owner: Session?, title: String, artist: String, album: String) -> PlaybackHistory.Route {
        let (current, connected) = state()
        guard let owner, current === owner else { return .silent }
        let offline = owner.offlineOnly()
        if connected == true && !offline { return .live }
        guard offline || connected == false, let journal = owner.journal else { return .silent }
        let revision = journal.revision
        guard revision.isMultiple(of: 2) else { return .silent }
        return .offline(.init(account: journal.account, revision: revision, timestamp: clock(), title: title, artist: artist, album: album))
    }
    func policyChanged() {
        let owner = state().0
        let allowed = owner.map(permitted) ?? false
        lock.lock()
        guard session === owner else { lock.unlock(); return }
        let gained = !eligible && allowed, attempt = active
        eligible = allowed
        lock.unlock()
        if let attempt, !attempt.allows { attempt.cancel() }
        if gained { wake() }
    }
    func record(_ event: PlaybackHistory.Event, journal: OfflineListenJournal) {
        let revision = journal.discardRevision
        writes.async {
            if (try? journal.add(event, unlessDiscarded: revision)) == true, self.state().0?.journal === journal { self.wake() }
        }
    }
    private func wake() {
        guard let owner = state().0, permitted(owner) else { return }
        lock.lock()
        guard session === owner else { lock.unlock(); return }
        again = true
        if sending { lock.unlock(); return }
        sending = true; lock.unlock()
        worker.async {
            while let current = self.nextWake() { try? self.drain(current) }
        }
    }
    private func nextWake() -> Session? {
        lock.lock(); defer { lock.unlock() }
        guard again, let session else { sending = false; return nil }
        again = false; return session
    }
    private func drain(_ owner: Session) throws {
        guard let journal = owner.journal else { return }
        let through = journal.last
        while permitted(owner), let claim = try journal.claim(through: through) {
            let attempt = OfflineListenPermission { [weak self] in self?.permitted(owner) == true && journal.permits(claim) }
            lock.lock(); active = attempt; lock.unlock()
            var request = URLRequest(url: owner.base.appendingPathComponent("api/v3/scrobble/submit"))
            request.httpMethod = "POST"; request.httpShouldHandleCookies = false
            request.setValue("Bearer " + owner.token, forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            let retry = !attempt.allows || send(request, claim.row.body, attempt)
            lock.lock(); active = nil; lock.unlock()
            if retry { try journal.retry(claim); return }
        }
    }
}

/// DN deduplicates only its 200 recent names for one hour. Once the one-shot body may have
/// left the phone, an ambiguous result stays consumed, including a process exit.
final class OfflineListenPost: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let payload: Data, permit: OfflineListenPermission
    private let lock = NSLock(), finished = DispatchSemaphore(value: 0)
    private var bodyStream: InputStream?, stopped = false, retry = false
    private var neverRequested = false
    private var response: HTTPURLResponse?, answer = Data(), tooLarge = false
    init(_ payload: Data, _ permit: OfflineListenPermission) { self.payload = payload; self.permit = permit }
    static func submit(_ request: URLRequest, _ data: Data, _ permit: OfflineListenPermission) -> Bool {
        OfflineListenPost(data, permit).run(request, configuration: .ephemeral)
    }
    func run(_ request: URLRequest, configuration: URLSessionConfiguration) -> Bool {
        guard permit.allows else { return true }
        configuration.httpCookieStorage = nil; configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForRequest = 5; configuration.timeoutIntervalForResource = 5
        let delegate = OperationQueue(); delegate.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegate)
        var request = request
        request.setValue(String(payload.count), forHTTPHeaderField: "Content-Length")
        let task = session.uploadTask(withStreamedRequest: request)
        permit.onCancel { task.cancel() }
        task.resume(); session.finishTasksAndInvalidate()
        defer { permit.onCancel(nil) }
        if finished.wait(timeout: .now() + 8) == .timedOut {
            lock.lock(); stopped = true; let safe = bodyStream == nil; lock.unlock()
            task.cancel(); return safe
        }
        lock.lock(); defer { lock.unlock() }; return retry
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, needNewBodyStream completionHandler: @escaping (InputStream?) -> Void) {
        lock.lock()
        let stream = bodyStream == nil && !stopped && permit.allows ? InputStream(data: payload) : nil
        if let stream { bodyStream = stream }
        lock.unlock(); completionHandler(stream)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response as? HTTPURLResponse
        tooLarge = response.expectedContentLength > 8192
        completionHandler(tooLarge ? .cancel : .allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !tooLarge, data.count <= 8192 - answer.count else { tooLarge = true; dataTask.cancel(); return }
        answer.append(data)
    }
    private struct Rejection: Decodable { let accepted: Bool }
    static func rejected(_ http: HTTPURLResponse, _ data: Data) -> Bool {
        let type = http.mimeType?.lowercased() ?? ""
        guard type == "application/json" || type.hasSuffix("+json"), data.count <= 8192,
              (http.expectedContentLength < 0 || http.expectedContentLength == Int64(data.count)),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return false }
        if http.statusCode == 401 { return (json["error"] as? [String: Any])?["code"] as? String == "UNAUTHORIZED" }
        return (200..<300).contains(http.statusCode) && (try? JSONDecoder().decode(Rejection.self, from: data).accepted) == false
            && json["services"] is [String: Any]
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
        let attempts = metrics.transactionMetrics
        neverRequested = !attempts.isEmpty && attempts.allSatisfy {
            $0.requestStartDate == nil && $0.countOfRequestBodyBytesSent == 0 && $0.response == nil
        }
    }
    private func failedBeforeBody(_ task: URLSessionTask, _ error: NSError) -> Bool {
        guard response == nil else { return false }
        guard let bodyStream else { return true }
        guard error.domain == NSURLErrorDomain, task.countOfBytesSent == 0,
              [NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed, NSURLErrorCannotConnectToHost,
               NSURLErrorNotConnectedToInternet].contains(error.code) else { return false }
        if neverRequested || bodyStream.streamStatus == .notOpen { return true }
        // URLSession can open the one-shot stream before connecting. After completion,
        // recovering every original byte proves the body was never read.
        guard bodyStream.streamStatus == .open, !payload.isEmpty else { return false }
        var buffer = [UInt8](repeating: 0, count: min(payload.count, 4096)), remaining = payload.count
        while remaining > 0 {
            let read = bodyStream.read(&buffer, maxLength: min(buffer.count, remaining))
            guard read > 0 else { return false }
            remaining -= read
        }
        return true
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        if error == nil, !tooLarge, let response { retry = Self.rejected(response, answer) }
        else if let error { retry = failedBeforeBody(task, error as NSError) }
        stopped = true; lock.unlock()
        finished.signal()
    }
}
