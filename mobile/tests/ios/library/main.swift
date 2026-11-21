// swiftc mobile/ios/App/App/{OfflineFiles,LibraryContinuation,PlaybackArchive}.swift mobile/tests/ios/library/main.swift -o /tmp/dn-library-test
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

func page(_ ids: [Int], total: Int, next: String?) throws -> LibraryTrackPage {
    let rows: [[String: Any]] = ids.map { ["id": "song-" + String($0), "title": "Song " + String($0),
        "album_title": "Fixture", "artist_name": "Player", "album_id": "a", "cover_available": true,
        "album_artist_id": "artist-a", "disc_number": 1, "track_number": $0, "format": "flac", "genre": "Folk", "year": 2020] }
    let json = try JSONSerialization.data(withJSONObject: ["items": rows, "total": total, "next": next as Any? ?? NSNull()])
    return try JSONDecoder().decode(LibraryTrackPage.self, from: json)
}
let total = 2301, cursor = "random+seed/200=α"
let first = try page(Array(0..<200), total: total, next: cursor)
var window = try first.items.map { try $0.track() }, seen = Set(window.map(\.id)), cursors: Set = [cursor]
var state = LibraryContinuation(filters:["sort":"random","order":"asc","q":"a+b","favorites":"true"], after: cursor, loaded: 200, total: total)
try state.validate(window: window.map(\.id))
let deep = LibraryContinuation(filters: ["sort": "title", "order": "asc"], after: "cursor-860", loaded: 860, total: 1200)
try deep.validate(window: (830..<860).map { "deep-" + String($0) })
precondition(deep.loaded - 30 == 830)
let req = try state.request("https://fixture.example/dn", token:"private-fixture",restart:false)
let query = URLComponents(url:req.url!,resolvingAgainstBaseURL:false)!.queryItems!
precondition(req.url!.path == "/dn/api/v3/library/tracks" && req.url!.absoluteString.contains("%2B") && !req.url!.absoluteString.contains("private-fixture"))
precondition(query.first{$0.name=="after"}?.value == cursor && query.first{$0.name=="limit"}?.value == "100")
let directory = FileManager.default.temporaryDirectory.appendingPathComponent("dn-paged-" + UUID().uuidString)
defer { try? FileManager.default.removeItem(at: directory) }
let archive = try PlaybackArchive(folder: directory)
var largest = window.count
while state.loaded < total {
    let n = min(total, state.loaded + 100), next = n == total ? nil : "seed-" + String(n)
    let result = try state.accepting(page(Array(state.loaded..<n), total: total, next: next), existing: seen, cursors: cursors, restart: false)
    let pos = window.count - 26, keep = try LibraryContinuation.placement(current: pos, count: window.count, incoming: result.1.count, restart: false)
    let current = window[pos].id
    window = Array(window.dropFirst(keep.remove)) + result.1
    precondition(window[pos - keep.remove].id == current && pos - keep.remove == 50 && keep.firstNew > 50)
    seen.formUnion(result.1.map(\.id)); if let next { cursors.insert(next) }
    state = result.0; largest = max(largest, window.count)
    if state.loaded == 1000 {
        try archive.save(window,cursor:.init(revision:UUID(),index:50,position:32.5,repeatMode:"all"),continuation:state)
        let recovered = try archive.load()!
        precondition(recovered.cursor.position == 32.5 && recovered.continuation?.after == "seed-1000")
        precondition(recovered.continuation!.loaded - recovered.tracks.count == state.loaded - window.count)
    }
}
precondition(seen.count == total && largest <= 200 && state.after == nil)
let restart = try state.request("https://fixture.example/dn",token:"private-fixture",restart:true)
precondition(URLComponents(url:restart.url!,resolvingAgainstBaseURL:false)!.queryItems!.first{$0.name == "after"} == nil)
let new = try state.accepting(page(Array(0..<100), total: total, next: "seed-100"), existing: seen, cursors: cursors, restart: true)
precondition(new.0.loaded == 100 && new.1.first?.artworkUrl == "/api/v3/library/albums/a/artwork?size=500")
do { _ = try new.0.accepting(page([99,100],total:total,next:"seed-102"),existing:Set(new.1.map(\.id)),cursors:["seed-100"],restart:false); preconditionFailure("Duplicate accepted") } catch is OfflineFiles.Failure {}
do { _ = try new.0.accepting(page([100],total:total,next:"seed-100"),existing:[],cursors:["seed-100"],restart:false); preconditionFailure("Cursor loop accepted") } catch is OfflineFiles.Failure {}
do { _ = try new.0.accepting(page([100],total:2,next:nil),existing:[],cursors:[],restart:false); preconditionFailure("Changed total accepted") } catch is OfflineFiles.Failure {}

final class Reply: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        precondition(request.value(forHTTPHeaderField:"Authorization") == "Bearer private-fixture")
        let response = HTTPURLResponse(url:request.url!,statusCode:200,httpVersion:nil,headerFields:["Content-Type":"application/json"])!
        client?.urlProtocol(self,didReceive:response,cacheStoragePolicy:.notAllowed)
        client?.urlProtocol(self,didLoad:Data(#"{"items":[{"id":"stream","title":"Direct"}],"total":1,"next":null}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
let config = URLSessionConfiguration.ephemeral; config.protocolClasses = [Reply.self]
let done = DispatchSemaphore(value: 0)
let fetch = LibraryPageLoad { result in
    guard case let .success(page) = result else { preconditionFailure("Failed to read the DN response") }
    precondition(page.items.first?.id == "stream"); done.signal()
}
fetch.start(req,configuration:config)
precondition(done.wait(timeout:.now()+3) == .success)
print("2,301-song bounded traversal, seeded shuffle, cursor recovery, response validation and authenticated transport passed.")
