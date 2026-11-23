import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

let server = "https://dn.example/proxy/music", token = "fixture-token"
let req = PlayerLoudness.request(server: server, token: token, id: "a & b")!
precondition(req.url?.path == "/proxy/music/api/v3/library/tracks/a & b/loudness")
precondition(req.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-token")
for bad in ["", ".", "..", "../else", "a/b", "a\\b"] {
    precondition(PlayerLoudness.request(server: server, token: token, id: bad) == nil)
}
for bad in ["http://dn.example", "https://user@dn.example", "https://dn.example/?q=y", "https://dn.example/#here"] {
    precondition(PlayerLoudness.request(server: bad, token: token, id: "song") == nil)
}
let partial = Data(#"{"track_gain_db":0,"album_gain_db":null,"track_peak":-1,"album_peak":true}"#.utf8)
precondition(PlayerLoudness.tags(partial) == ["replayGainTrackDb": 0])
precondition(PlayerLoudness.tags(Data(#"{"track_gain_db":"8.5"}"#.utf8)).isEmpty)

final class Fixture: URLProtocol {
    static let lock = NSLock()
    private static var paths = [String]()
    static var requests: [String] { lock.lock(); defer { lock.unlock() }; return paths }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!, id = url.deletingLastPathComponent().lastPathComponent
        Self.lock.lock(); Self.paths.append(id); Self.lock.unlock()
        guard id != "slow" else { return }
        let status = id == "legacy" ? 404 : 200
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"track_gain_db":-8,"track_peak":0.92,"album_peak":1.1}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
func waitFor(_ predicate: () -> Bool) {
    let until = Date().addingTimeInterval(4)
    while !predicate() && Date() < until { RunLoop.current.run(until: Date().addingTimeInterval(0.01)) }
    precondition(predicate())
}
let config = URLSessionConfiguration.ephemeral
config.protocolClasses = [Fixture.self]
let player = PlayerLoudness(configuration: config)
let inline: [String: Any] = ["title": "First", "replayGainTrackDb": -1.0, "replayGainAlbumDb": -3.0]
var applied = 0
func update(_ ids: Set<String>, online: Bool = true) {
    player.update(ids: ids, server: server, token: token, online: online) { applied += 1 }
}
update(["saved"], online: false)
update(["first", "legacy"])
update(["first", "legacy"])
waitFor { applied == 1 && Fixture.requests.count == 2 }
precondition(Set(Fixture.requests) == ["first", "legacy"])
let now = player.metadata(id: "first", inline: inline)
precondition(now["replayGainTrackDb"] as? Double == -8 && now["replayGainAlbumDb"] as? Double == -3)
precondition(now["replayGainTrackPeak"] as? Double == 0.92 && now["replayGainAlbumPeak"] as? Double == 1.1)
precondition(now["title"] as? String == "First")
precondition(player.metadata(id: "legacy", inline: inline)["replayGainTrackDb"] as? Double == -1)
update(["first", "slow"])
waitFor { Fixture.requests.contains("slow") }
update(["first", "saved"], online: false)
precondition(player.metadata(id: "first", inline: inline)["replayGainTrackDb"] as? Double == -8)
update(["second"])
waitFor { applied == 2 }
precondition(!Fixture.requests.contains("saved") && Fixture.requests.count == 4)
precondition(player.metadata(id: "first", inline: inline)["replayGainTrackDb"] as? Double == -1)
player.clear()
precondition(player.metadata(id: "second", inline: inline)["replayGainTrackDb"] as? Double == -1)
print("Playback loudness, silent fallback, queue changes and offline policy passed.")
