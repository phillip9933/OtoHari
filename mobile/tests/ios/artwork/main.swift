import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

let server = "https://fixture.invalid/dn"
let url = URL(string: server + "/api/v3/library/albums/a/cover?size=500")!
let file = FileManager.default.temporaryDirectory.appendingPathComponent("dn-artwork-" + UUID().uuidString)
try Data([1, 2, 3]).write(to: file)
defer { try? FileManager.default.removeItem(at: file) }
let occurrence = UUID()
func plan(_ allowed: Bool, _ remote: URL? = url, _ saved: URL? = file) -> PlaybackArtworkPlan {
    PlaybackArtworkPlan(server: server, user: "listener", occurrence: occurrence, remote: remote, saved: saved, online: allowed)
}
precondition(plan(false).remote == nil && plan(false).saved == file && plan(true).remote == url)
precondition(plan(true, URL(string: "https://elsewhere.invalid/cover")).remote == nil)
precondition(plan(true, URL(string: "https://fixture.invalid/other/api/v3/cover")).remote == nil)
precondition(plan(true, URL(string: server + "/api/v3/../other")).remote == nil)
precondition(plan(true, URL(string: server + "/api/v3/%2e%2e/other")).remote == nil)
precondition(plan(false, nil, url).saved == nil)
precondition(plan(true) != PlaybackArtworkPlan(server: server, user: "other", occurrence: occurrence, remote: url, saved: file, online: true))
precondition(plan(true) != PlaybackArtworkPlan(server: server, user: "listener", occurrence: UUID(), remote: url, saved: file, online: true))
precondition(PlaybackArtworkLimits.dimensions(4096,4096) && !PlaybackArtworkLimits.dimensions(4096,4097))
precondition(!PlaybackArtworkLimits.dimensions(8193,1) && !PlaybackArtworkLimits.dimensions(0,5))
precondition(!PlaybackArtworkLimits.dimensions(Int.max,Int.max))

let tagged = URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("server/tests/fixtures/library")
let picture = Data(base64Encoded:"iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFElEQVR4nGMUCehhgAEmBiSAwgEAItQA9m5S+84AAAAASUVORK5CYII=")!
for name in ["management_full.flac", "management_two_icons.flac"] {
    let audio = try BoundedArtworkFile(tagged.appendingPathComponent(name), access: PlaybackArtworkAccess())
    precondition(audio.flacCover() == picture)
}
let noTag = try BoundedArtworkFile(tagged.appendingPathComponent("flac_no_tags.flac"), access: PlaybackArtworkAccess())
precondition(noTag.flacCover() == nil)
let storage = FileManager.default.temporaryDirectory.appendingPathComponent("dn-artwork-account-" + UUID().uuidString)
defer { try? FileManager.default.removeItem(at: storage) }
let library = try OfflineFiles(folder: storage.appendingPathComponent("listener"))
let other = try OfflineFiles(folder: storage.appendingPathComponent("other"))
let song = OfflineFiles.Track(id:"s", title:"Fixture", album:"Fixture", artist:"Fixture", streamUrl:"/api/v3/stream/local/s", artworkUrl:nil, duration:nil)
let origin = storage.appendingPathComponent("transferred.flac")
try FileManager.default.copyItem(at: tagged.appendingPathComponent("management_full.flac"), to: origin)
let length = try origin.resourceValues(forKeys:[.fileSizeKey]).fileSize!
let ticket = try library.begin(song, origin:.downloaded)!
try library.install(origin, bytes:Int64(length), ext:"flac", track:song, ticket:ticket)
guard case let .saved(complete) = library.source("s") else { fatalError("Expected completed download") }
precondition(other.source("s") == .network)
let scoped = try BoundedArtworkFile(complete, access:PlaybackArtworkAccess())
precondition(scoped.flacCover() == picture)
let permission = library.onlineRevision()
var options = library.options(); options.offlineOnly = true; try library.configure(options)
precondition(library.onlineRevision() == nil && library.source("s") == .saved(complete))
options.offlineOnly = false; try library.configure(options)
precondition(permission != nil && library.onlineRevision() != permission)
let truncated = try FileHandle(forWritingTo:complete); try truncated.truncate(atOffset:4); try truncated.close()
precondition(library.source("s") == .network)
// A successful DN cover needs no file read. Invalid bytes or a policy change during decode use the saved song.
let dn = Data([1]), local = Data([2])
var online = true
var localReads = 0
let fromFile: (URL, PlaybackArtworkAccess) -> Data? = { chosen, _ in
    precondition(chosen == file); localReads += 1; return local
}
let good = plan(true).resolve(dn, access: PlaybackArtworkAccess(), allowed: { true }, read: fromFile, decode: { value,_ in value })
precondition(good?.1 == .dn && good?.0 == dn && localReads == 0)
let bad = plan(true).resolve(dn, access: PlaybackArtworkAccess(), allowed: { true }, read: fromFile,
                             decode: { value,_ in value == local ? value : nil })
precondition(bad?.1 == .embedded && bad?.0 == local && localReads == 1)
let changed = plan(true).resolve(dn, access: PlaybackArtworkAccess(), allowed: { online }, read: fromFile,
                                decode: { value,_ in online = false; return value })
precondition(changed?.1 == .embedded && changed?.0 == local && localReads == 2)
let stopped = plan(false).resolve(nil, access: PlaybackArtworkAccess(), allowed: { false },
                                 read: { _, access in access.cancel(); return local }, decode: { data,_ in data })
precondition(stopped == nil)
#if canImport(AudioToolbox) && canImport(ImageIO)
let nativeAccess = PlaybackArtworkAccess()
let mp3 = tagged.appendingPathComponent("management_full.mp3")
guard let native = PlaybackArtworkImage.embedded(mp3, access: nativeAccess),
      let thumbnail = PlaybackArtworkImage.thumbnail(native, access: nativeAccess) else { fatalError("Missing MP3 front cover") }
precondition(thumbnail.width == 4 && thumbnail.height == 3)
#endif

let access = PlaybackArtworkAccess()
let reader = try BoundedArtworkFile(file, access: access)
precondition(reader.size == 3 && reader.read(at: 1, count: Int.max) == Data([2,3]))
precondition(reader.read(at: -1, count: 1) == nil)
access.cancel()
precondition(reader.read(at: 0, count: 1) == nil)
let sparse = try FileHandle(forWritingTo: file)
try sparse.truncate(atOffset: 500_000_000); try sparse.close()
let bounded = try BoundedArtworkFile(file, access: PlaybackArtworkAccess())
precondition(bounded.read(at: 499_999_999, count: 100) == Data([0]))
precondition(bounded.read(at: 0, count: PlaybackArtworkLimits.fileBytes + 1) == nil)
let budget = try BoundedArtworkFile(file, access: PlaybackArtworkAccess())
for _ in 0..<4 { precondition(budget.read(at: 0, count: PlaybackArtworkLimits.coverBytes)?.count == PlaybackArtworkLimits.coverBytes) }
precondition(budget.read(at: 0, count: 1) == nil)
let many = try BoundedArtworkFile(file, access: PlaybackArtworkAccess())
for _ in 0..<PlaybackArtworkLimits.fileReads { precondition(many.read(at: 0, count: 1) == Data([1])) }
precondition(many.read(at: 0, count: 1) == nil)

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = true
    var allowed: Bool { lock.lock(); defer { lock.unlock() }; return flag }
    func stop() { lock.lock(); defer { lock.unlock() }; flag = false }
}
let gate = Flag()
final class Reply: URLProtocol, @unchecked Sendable {
    static let started = DispatchSemaphore(value:0), stopped = DispatchSemaphore(value:0)
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let u = request.url!
        precondition(u.host == "fixture.invalid" && request.value(forHTTPHeaderField: "Authorization") == "Bearer synthetic")
        let name = u.lastPathComponent
        precondition(name != "already-offline")
        var headers = ["Content-Type":"image/jpeg"]
        var status = 200
        switch name {
        case "large": headers["Content-Length"] = String(PlaybackArtworkLimits.coverBytes + 1)
        case "short": headers["Content-Length"] = "300"
        case "proxy": headers["Content-Type"] = "text/html"
        case "redirect": status = 302; headers["Location"] = "https://elsewhere.invalid/"
        case "missing": status = 404
        default: break
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url:u,statusCode:status,httpVersion:nil,headerFields:headers)!, cacheStoragePolicy:.notAllowed)
        if name == "switch" { gate.stop() }
        let chunk = name == "chunks" ? Data(repeating:42,count:1024*1024) : Data([1,2,3])
        for _ in 0..<(name == "chunks" ? 5 : 1) { client?.urlProtocol(self,didLoad:chunk) }
        if name == "pending" { Self.started.signal(); return }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { if request.url?.lastPathComponent == "pending" { Self.stopped.signal() } }
}
final class ArtworkResult: @unchecked Sendable {
    let done = DispatchSemaphore(value:0)
    var value: Data?
    func finish(_ data: Data?) { value = data; done.signal() }
    func wait() -> Data? { precondition(done.wait(timeout:.now()+3) == .success); return value }
}
func fetch(_ route:String) -> Data? {
    let u = URL(string:server+"/api/v3/media/"+route)!
    let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [Reply.self]
    let answer = ArtworkResult()
    PlaybackArtworkRemote.fetch(u, token:"synthetic", access:PlaybackArtworkAccess(),
                                allowed:{ gate.allowed }, configuration:config, done:answer.finish)
    return answer.wait()
}
precondition(fetch("cover") == Data([1,2,3]))
let former = PlaybackArtworkAccess(), stale = ArtworkResult(), blocked = URLSessionConfiguration.ephemeral
blocked.protocolClasses = [Reply.self]
PlaybackArtworkRemote.fetch(URL(string:server+"/api/v3/media/pending")!, token:"synthetic", access:former,
                            allowed:{ true }, configuration:blocked, done:stale.finish)
precondition(Reply.started.wait(timeout:.now()+3) == .success)
former.cancel()
precondition(stale.wait() == nil && Reply.stopped.wait(timeout:.now()+3) == .success)
for name in ["large","short","chunks","proxy","redirect","missing","switch","already-offline"] { precondition(fetch(name) == nil) }
print("Playback artwork origin, occurrence, offline policy, read budgets, image limits and bounded transport passed.")
