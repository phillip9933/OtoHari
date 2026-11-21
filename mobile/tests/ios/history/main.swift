// swiftc mobile/ios/App/App/{PlaybackHistory,PlaybackReportSender,OfflineListenJournal,OfflineListenReplay}.swift mobile/tests/ios/history/main.swift -o /tmp/dn-history-test
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

let a = UUID(), b = UUID()
var history = PlaybackHistory()
// A restored queue, paused scrubs, and prebuffered next items do not open sessions.
precondition(history.observe(a, id: "song", position: 50_000, length: 100_000, playing: false, now: 0).isEmpty)
let start = history.observe(a, id: "song", position: 50_000, length: 100_000, playing: true, now: 200)
precondition(start.count == 1 && start[0].operation == "start" && start[0].position == 50_000)
let paused = history.observe(a, id: "song", position: 50_800, length: 100_000, playing: false, now: 1000)
precondition(paused.count == 1 && paused[0].paused == true)
precondition(history.observe(a, id: "song", position: 99_500, length: 100_000, playing: false, now: 80_000).isEmpty)
let early = history.finish(a, position: 99_500, length: 100_000, now: 100_000)
precondition(early.count == 1 && early[0].ignoreScrobble == true)
precondition(history.finish(a, position: 100_000, length: 100_000, now: 100_000).isEmpty)
precondition(history.observe(a, id: "song", position: 100_000, length: 100_000, playing: true, now: 100_000).isEmpty)
// A distinct repeat occurrence of the same track gets a fresh start and one counted stop.
let repeatStart = history.observe(b, id: "song", position: 0, length: 100_000, playing: true, now: 110_000)
precondition(repeatStart.count == 1 && repeatStart[0].operation == "start")
let beat = history.observe(b, id: "song", position: 30_000, length: 100_000, playing: true, now: 140_000, heartbeat: true)
precondition(beat.count == 1 && beat[0].paused == false)
_ = history.observe(b, id: "song", position: 50_000, length: 100_000, playing: false, now: 160_000)
_ = history.observe(b, id: "song", position: 50_000, length: 100_000, playing: true, now: 180_000)
let end = history.finish(b, position: 100_000, length: 100_000, now: 230_000)
precondition(end.count == 1 && end[0].ignoreScrobble == false)

final class ReceivedRequests: @unchecked Sendable {
    private let lock = NSLock()
    private var values = [URLRequest]()
    func record(_ request: URLRequest) { lock.withLock { values.append(request) } }
    func snapshot() -> [URLRequest] { lock.withLock { values } }
}
final class Fixture: URLProtocol, @unchecked Sendable {
    static let seen = ReceivedRequests(), received = DispatchSemaphore(value: 0)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.seen.record(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
        Self.received.signal()
    }
    override func stopLoading() {}
}
let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [Fixture.self]
let sender = PlaybackReportSender(configuration: config)
sender.send(start + early, server: "https://alice.example/dn", token: "fixture-alice", device: "ios-test")
sender.send(repeatStart + end, server: "https://bob.example/listen", token: "fixture-bob", device: "ios-test")
for _ in 0..<4 { precondition(Fixture.received.wait(timeout: .now()+3) == .success) }
let requests = Fixture.seen.snapshot()
precondition(requests.map { $0.url!.lastPathComponent } == ["start","stop","start","stop"])
for (i, req) in requests.enumerated() {
    precondition(req.httpMethod == "POST" && req.url?.query == nil)
    precondition(req.url?.path.hasPrefix(i < 2 ? "/dn/api/v3/playback/" : "/listen/api/v3/playback/") == true)
    precondition(req.url?.host == (i < 2 ? "alice.example" : "bob.example"))
    precondition(req.value(forHTTPHeaderField: "Authorization") == (i < 2 ? "Bearer fixture-alice" : "Bearer fixture-bob"))
    let json = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
    precondition(json["source"] as? String == "local" && json["device"] as? String == "ios-test" && json["track_id"] as? String == "song")
    if i % 2 == 0 { precondition(json["ignore_scrobble"] == nil && json["is_paused"] == nil) }
    else { precondition(json["ignore_scrobble"] as? Bool == (i == 1)) }
}
sender.close()
print("DN playback event order, time thresholds, repetitions, authenticated wire requests and account isolation passed.")

final class Value<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ value: T) { self.value = value }
    func get() -> T { lock.withLock { value } }
    func set(_ next: T) { lock.withLock { value = next } }
}
final class ScrobbleWire: @unchecked Sendable {
    typealias Request = (URLRequest, Data)
    let started = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0), finished = DispatchSemaphore(value: 0)
    let last = Value<Request?>(nil), retry = Value(false)
    func send(_ request: URLRequest, _ data: Data, _ permit: OfflineListenPermission) -> Bool {
        precondition(permit.allows)
        last.set((request,data)); started.signal()
        precondition(release.wait(timeout: .now()+5) == .success)
        let result = !permit.allows || retry.get()
        finished.signal()
        return result
    }
    func next() -> Request {
        precondition(started.wait(timeout: .now()+5) == .success)
        return last.get()!
    }
    func respond(retry: Bool) {
        self.retry.set(retry); release.signal()
        precondition(finished.wait(timeout: .now()+5) == .success)
    }
}
let root = FileManager.default.temporaryDirectory.appendingPathComponent("dn-offline-listens-" + UUID().uuidString)
defer { try? FileManager.default.removeItem(at: root) }
let now: Int64 = 1_800_000_000
let tick = Value(now), offlineMode = Value(true), changed = DispatchSemaphore(value: 0)
let folder = root.appendingPathComponent("alice"), bobFolder = root.appendingPathComponent("bob")
let alice = try OfflineListenJournal(folder: folder, clock: tick.get, changed: { changed.signal() })
let bob = try OfflineListenJournal(folder: bobFolder, clock: tick.get, changed: { changed.signal() })
func awaitCount(_ journal: OfflineListenJournal, _ count: Int) throws {
    let deadline = DispatchTime.now() + 5
    while try journal.status().pending != count { precondition(changed.wait(timeout: deadline) == .success) }
}
func event(_ route: PlaybackHistory.Route, position: Int64 = 99_000, heard: Int64 = 99_000,
           later: PlaybackHistory.Route = .live, id: String = "track") -> [PlaybackHistory.Event] {
    var history = PlaybackHistory()
    let occurrence = UUID()
    let initial = history.observe(occurrence, id: id, position: 0, length: 100_000, playing: true, now: 0, route: route)
    let paused = history.observe(occurrence, id: id, position: position, length: 100_000, playing: false, now: heard, route: later)
    let stopped = history.finish(occurrence, position: position, length: 100_000, now: heard + 30_000)
    precondition(history.finish(occurrence, position: position, length: 100_000, now: heard + 30_001).isEmpty)
    return initial + paused + stopped
}
let wire = ScrobbleWire(), replay = OfflineListenReplay(send: wire.send, clock: tick.get)
func session(_ account: OfflineListenJournal, token: String, mode: Value<Bool>) -> OfflineListenReplay.Session {
    OfflineListenReplay.Session(server: "https://fixture.invalid/" + account.account, token: token, user: account.account, account: account.account,
                                journal: account, offlineOnly: mode.get)!
}
precondition(OfflineListenReplay.Session(server: "https://fixture.invalid/bob", token: "fixture", user: "bob",
                                         account: "bob", journal: alice, offlineOnly: { false }) == nil)
let owner = session(alice, token: "old-alice-token", mode: offlineMode)
replay.authorize(owner)
offlineMode.set(false)
precondition(event(replay.route(owner, title: "Unknown path", artist: "", album: "")).isEmpty)
offlineMode.set(true); replay.connection(false)
let route = replay.route(owner, title: "Été", artist: "Fixture", album: "Night")
precondition(event(route, position: 99_999, heard: 50_000).isEmpty)
precondition(event(route, position: 50_000, heard: 99_999).isEmpty)
let complete = event(route)
precondition(complete.map(\.operation) == ["submit"])
let liveEvents = event(.live, later: route)
precondition(liveEvents.map(\.operation) == ["start","progress","stop"])
replay.connection(true)
replay.record(complete[0], journal: alice)
try awaitCount(alice, 1)
precondition(wire.last.get() == nil)
let revoked = event(route)
let optedOut = try alice.setEnabled(false)
precondition(!optedOut.enabled && optedOut.pending == 1)
precondition(event(replay.route(owner, title: "Private", artist: "", album: "")).isEmpty)
_ = try alice.setEnabled(true)
let refused = try alice.add(revoked[0], unlessDiscarded: alice.discardRevision)
precondition(!refused)
replay.authorize(nil)
precondition(event(replay.route(owner, title: "Signed out", artist: "", album: "")).isEmpty)

let reopened = try OfflineListenJournal(folder: folder, clock: tick.get, changed: { changed.signal() })
let persisted = try Data(contentsOf: folder.appendingPathComponent("listens.json"))
precondition(!String(decoding: persisted, as: UTF8.self).contains("old-alice-token"))
let on = Value(false), bobSession = session(bob, token: "bob-token", mode: on)
let fresh = session(reopened, token: "fresh-alice", mode: offlineMode)
replay.authorize(bobSession); replay.connection(false)
let bobPlay = event(replay.route(bobSession, title: "B", artist: "Other", album: ""), id: "another-song")
replay.record(bobPlay[0], journal: bob); try awaitCount(bob, 1)
replay.connection(true)
let (bobReq, bobBytes) = wire.next()
precondition(bobReq.url?.absoluteString == "https://fixture.invalid/bob/api/v3/scrobble/submit")
precondition(bobReq.value(forHTTPHeaderField: "Authorization") == "Bearer bob-token")
let bobJSON = try JSONSerialization.jsonObject(with: bobBytes) as! [String: Any]
precondition(bobJSON["track_id"] as? String == "another-song" && bobJSON["album_name"] == nil)
wire.respond(retry: false)
replay.authorize(fresh)
try awaitCount(reopened, 1)
offlineMode.set(false); replay.policyChanged()
let (aliceReq, aliceBytes) = wire.next()
precondition(aliceReq.url?.absoluteString == "https://fixture.invalid/alice/api/v3/scrobble/submit" && aliceReq.httpMethod == "POST")
precondition(aliceReq.value(forHTTPHeaderField: "Authorization") == "Bearer fresh-alice")
let aliceJSON = try JSONSerialization.jsonObject(with: aliceBytes) as! [String: Any]
precondition(aliceJSON["source"] as? String == "local" && aliceJSON["duration_ms"] as? Int == 100_000 && aliceJSON["timestamp"] as? Int64 == now)
precondition(aliceJSON["track_id"] as? String == "track" && aliceJSON["track_name"] as? String == "Été")
precondition(aliceJSON["artist_name"] as? String == "Fixture" && aliceJSON["album_name"] as? String == "Night")
wire.respond(retry: true); try awaitCount(reopened, 1)
replay.policyChanged(); replay.connection(true)
precondition(wire.started.wait(timeout: .now()) == .timedOut)
replay.connection(true, pathChanged: true)
let (movedNetwork, nextNetworkBytes) = wire.next()
precondition(movedNetwork.value(forHTTPHeaderField: "Authorization") == "Bearer fresh-alice" && nextNetworkBytes == aliceBytes)
wire.respond(retry: true); try awaitCount(reopened, 1)
let refreshed = session(reopened, token: "rotated-alice", mode: offlineMode)
replay.authorize(refreshed)
let (retried, same) = wire.next()
precondition(retried.value(forHTTPHeaderField: "Authorization") == "Bearer rotated-alice" && same == aliceBytes)
replay.authorize(bobSession)
wire.respond(retry: false); try awaitCount(reopened, 1)
replay.authorize(refreshed); _ = wire.next()
_ = try reopened.discard(); replay.policyChanged()
wire.respond(retry: true); try awaitCount(reopened, 0)
replay.authorize(nil)

let capacityFolder = root.appendingPathComponent("bounded")
let small = try OfflineListenJournal(folder: capacityFolder, rowLimit: 2, byteLimit: 1024, clock: tick.get)
func keep(_ started: Int64, name: String = "Song") throws -> Bool {
    let at = PlaybackHistory.OfflineStart(account: small.account, revision: small.revision, timestamp: started, title: name, artist: "Artist", album: "")
    return try small.add(event(.offline(at))[0], unlessDiscarded: small.discardRevision)
}
let acceptedAge = try keep(now - OfflineListenJournal.maxAge), tooOld = try keep(now - OfflineListenJournal.maxAge - 1)
let future = try keep(now + 60), tooFar = try keep(now + 61)
let oversized = try keep(now, name: String(repeating: "x", count: 1025))
precondition(acceptedAge && !tooOld && future && !tooFar && !oversized)
_ = try keep(now)
let ambiguous = try small.claim(through: small.last)!
precondition(ambiguous.row.started == now + 60)
let crash = try OfflineListenJournal(folder: capacityFolder, clock: tick.get)
let onlyRemaining = try crash.claim(through: crash.last)
precondition(onlyRemaining?.row.started == now)
let empty = try crash.claim(through: crash.last); precondition(empty == nil)
try crash.retry(onlyRemaining!)
let discarded = try crash.claim(through: crash.last)!
_ = try crash.discard(); try crash.retry(discarded)
let afterDiscard = try OfflineListenJournal(folder: capacityFolder, clock: tick.get)
let emptyAfterDiscard = try afterDiscard.status(); precondition(emptyAfterDiscard.pending == 0)
let old = PlaybackHistory.OfflineStart(account: afterDiscard.account, revision: afterDiscard.revision, timestamp: now,
                                       title: "For expiry", artist: "Artist", album: "")
let recorded = try afterDiscard.add(event(.offline(old))[0], unlessDiscarded: afterDiscard.discardRevision); precondition(recorded)
tick.set(now + OfflineListenJournal.maxAge + 1)
let expired = try afterDiscard.status(); precondition(expired.pending == 0)
print("Offline occurrence routing, exact DN payload, protected account replay, privacy changes, discard, expiry and bounded crash-safe claims passed.")

func answer(_ status: Int, _ type: String, _ text: String, length: Int? = nil) -> Bool {
    var headers = ["Content-Type":type]
    if let length { headers["Content-Length"] = String(length) }
    let response = HTTPURLResponse(url: URL(string: "https://fixture.invalid")!, statusCode: status, httpVersion: "1.1", headerFields: headers)!
    return OfflineListenPost.rejected(response, Data(text.utf8))
}
let rejection = #"{"accepted":false,"services":{}}"#, unauthenticated = #"{"error":{"code":"UNAUTHORIZED"}}"#
precondition(answer(200, "application/json", rejection))
precondition(answer(401, "application/json", unauthenticated))
precondition(!answer(200, "application/json", #"{"accepted":true,"services":{}}"#))
precondition(!answer(200, "application/json", #"{"accepted":0,"services":{}}"#))
precondition(!answer(200, "application/json", #"{"accepted":false}"#))
precondition(!answer(401, "text/html", unauthenticated) && !answer(401, "application/json", unauthenticated, length: 900))
precondition(!answer(500, "application/json", rejection) && !answer(302, "application/json", rejection))
precondition(!answer(401, "application/json", unauthenticated + String(repeating: " ", count: 8200)))

let request = URLRequest(url: URL(string: "https://fixture.invalid/dn")!), body = Data([1, 2, 3])
let grant = Value(true), permission = OfflineListenPermission(grant.get)
let blocked = OfflineListenPermission { false }
precondition(OfflineListenPost.submit(request, body, blocked))
let delegateSession = URLSession(configuration: .ephemeral), idle = delegateSession.dataTask(with: request)
let once = OfflineListenPost(body, permission)
once.urlSession(delegateSession, task: idle, needNewBodyStream: { precondition($0 != nil) })
once.urlSession(delegateSession, task: idle, needNewBodyStream: { precondition($0 == nil) })
let revokedBeforeHandoff = OfflineListenPost(body, permission)
grant.set(false)
revokedBeforeHandoff.urlSession(delegateSession, task: idle, needNewBodyStream: { precondition($0 == nil) })
idle.cancel(); delegateSession.invalidateAndCancel()

// Exercise the actual one-shot upload delegate, including a severed connection after the body.
if CommandLine.arguments.contains("--loopback") {
    let server = Process(), portOutput = Pipe()
    server.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    server.arguments = ["python3", "-u", "-c", #"""
import http.server, json, socket
routes = iter(("accepted", "rejected", "expired", "gateway", "lost", "redirect"))
class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        name = next(routes)
        assert self.path == "/dn/" + name + "/api/v3/scrobble/submit"
        assert self.headers["Authorization"] == "Bearer local-history-fixture"
        assert self.headers["Cookie"] is None
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = []
            while True:
                length = int(self.rfile.readline().split(b";")[0].strip(), 16)
                if length == 0:
                    self.rfile.readline()
                    break
                chunks.append(self.rfile.read(length))
                assert self.rfile.read(2) == b"\r\n"
            body = b"".join(chunks)
        else:
            body = self.rfile.read(int(self.headers["Content-Length"]))
        assert json.loads(body) == {"track_id":"only-this-song","source":"local"}
        if name == "lost":
            self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()
            return
        status = {"expired":401, "gateway":401, "redirect":302}.get(name, 200)
        payload = ({"error":{"code":"UNAUTHORIZED"}} if status == 401 else
                   {"accepted":name != "rejected", "services":{}})
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html" if name == "gateway" else "application/json")
        if name == "redirect": self.send_header("Location", "/forbidden")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
with http.server.HTTPServer(("127.0.0.1", 0), Fixture) as host:
    host.timeout = 10
    print(host.server_port)
    for _ in range(6): host.handle_request()
    assert next(routes, None) is None
"""#]
    server.standardOutput = portOutput; try server.run()
    defer { if server.isRunning { server.terminate() }; server.waitUntilExit() }
    let port = String(decoding: portOutput.fileHandleForReading.availableData, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    precondition(UInt16(port) != nil)
    let origin = "http://127.0.0.1:" + port
    let body = Data(#"{"track_id":"only-this-song","source":"local"}"#.utf8)
    for name in ["accepted","rejected","expired","gateway","lost","redirect"] {
        var request = URLRequest(url: URL(string: origin + "/dn/" + name + "/api/v3/scrobble/submit")!)
        request.httpMethod = "POST"; request.setValue("Bearer local-history-fixture", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let retry = OfflineListenPost.submit(request, body, OfflineListenPermission { true })
        precondition(retry == ["rejected","expired"].contains(name), "Unexpected retry decision for " + name)
    }
    server.waitUntilExit(); precondition(server.terminationStatus == 0)
    var unreachable = URLRequest(url: URL(string: origin + "/unavailable")!)
    unreachable.httpMethod = "POST"
    precondition(OfflineListenPost.submit(unreachable, body, OfflineListenPermission { true }), "Connection refused before the body must be retryable.")
    print("Real loopback submissions delivered one body per play and handled rejection, authentication, redirect, a dropped reply and a refused connection.")
}
