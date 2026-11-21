// swiftc mobile/ios/App/App/OfflineFiles.swift mobile/tests/ios/offline/main.swift -o /tmp/dn-offline-test
import Foundation

let root = FileManager.default.temporaryDirectory.appendingPathComponent("offline-fixture-" + UUID().uuidString)
try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }
let directory = root.appendingPathComponent("listener-a")
let other = try OfflineFiles(folder: root.appendingPathComponent("listener-b"))
let track = try JSONDecoder().decode(OfflineFiles.Track.self, from: Data("""
{"id":"song","title":"Starlight","artist":"Fixture","album":"Night","streamUrl":"/api/v3/stream/local/song","year":2001,"genre":"Folk","rating":5}
""".utf8))
let audio = root.appendingPathComponent("fixture.wav")
let bytes = Data([82, 73, 70, 70, 1, 2, 3])
try bytes.write(to: audio)
var store = try OfflineFiles(folder: directory)
let initial = store.options()
precondition(initial.autoDownload == "off" && !initial.autoCache)
let disabled = try store.begin(track, origin: .automatic, source: "recent")
precondition(disabled == nil)
var options = initial
options.autoCache = true; options.autoDownload = "recent"; options.downloadMiB = 128
try store.configure(options)

let cache = try store.begin(track, origin: .cached)!
try store.install(audio, bytes: Int64(bytes.count), ext: "wav", track: track, ticket: cache)
precondition(store.rows().first?.origin == .cached)
let firstURL = store.playable(track.id)!
precondition(store.source(track.id) == .saved(firstURL) && other.source(track.id) == .network)
let upgrade = try store.begin(track, origin: .automatic, source: "recent")
precondition(upgrade == nil && store.rows().first?.origin == .automatic && store.playable(track.id) == firstURL)
try store.clearCache()
precondition(store.playable(track.id) == firstURL)
let manual = try store.begin(track, origin: .downloaded)
precondition(manual == nil && store.rows().first?.origin == .downloaded)
let planned = try store.plan("recent", ids: [])
precondition(planned.isEmpty && store.rows().first?.origin == .downloaded)
store = try OfflineFiles(folder: directory)
let restored = try Data(contentsOf: store.playable(track.id)!)
precondition(restored == bytes && store.rows().first?.track.rating == 5 && other.playable(track.id) == nil)
try store.remove([track.id])
let excluded = try store.plan("recent", ids: [track.id])
precondition(excluded.isEmpty && store.rows().isEmpty)
let pending = try store.begin(track, origin: .downloaded)!
try store.remove([track.id])
do { try store.install(audio, bytes: Int64(bytes.count), ext: "wav", track: track, ticket: pending); preconditionFailure("A removal must win over an in-flight save.") }
catch let failure as OfflineFiles.Failure { precondition(failure.message.contains("removed")) }
let ticket = try store.begin(track, origin: .downloaded)!
var offline = store.options()
offline.offlineOnly = true
try store.configure(offline)
precondition(!store.active(ticket) && store.source(track.id) == .unavailable)
offline.offlineOnly = false
try store.configure(offline)
precondition(!store.active(ticket) && store.source(track.id) == .network)
do { try store.install(audio, bytes: Int64(bytes.count), ext: "wav", track: track, ticket: ticket); preconditionFailure("Turning off network use cancels a pending manual transfer.") }
catch let failure as OfflineFiles.Failure { precondition(failure.message.contains("settings")) }
let replacement = try store.begin(track, origin: .downloaded)!
do { try store.install(audio, bytes: 15, ext: "wav", track: track, ticket: replacement); preconditionFailure("Incomplete audio must not be published.") }
catch let failure as OfflineFiles.Failure { precondition(failure.message.contains("incomplete")) }
try store.install(audio, bytes: Int64(bytes.count), ext: "wav", track: track, ticket: replacement)
precondition(store.rows().count == 1)
var coverage = OfflineCoverage(length: 10)
precondition(!coverage.add(8, count: 2))
precondition(!coverage.add(0, count: 2))
precondition(!coverage.add(3, count: 5))
precondition(!coverage.add(2, count: 9))
precondition(coverage.add(1, count: 3))
precondition(coverage.ranges == [0..<10])
let part = PlaybackByteRange(status: 206, header: "bytes 2-7/10", bytes: 6, coding: nil, offset: 2)!
precondition(part.start == 2 && part.end == 8 && part.total == 10)
let mtime = "Wed, 21 Oct 2015 07:28:00 GMT", date = "Wed, 21 Oct 2015 07:30:00 GMT"
precondition(part.cacheIdentity(tag: "\"v1\"", modified: nil, date: nil, request: 4) == "etag:\"v1\"")
precondition(part.cacheIdentity(tag: nil, modified: mtime, date: date, request: 4) == "mtime:" + mtime)
precondition(part.cacheIdentity(tag: "W/\"v1\"", modified: mtime, date: date, request: 4) == nil)
precondition(part.cacheIdentity(tag: nil, modified: mtime, date: mtime, request: 4) == nil)
precondition(part.cacheIdentity(tag: nil, modified: nil, date: nil, request: 4) == nil)
for bad in ["bytes 3-8/10", "bytes 2-1/10", "bytes 2-7/7", "bytes 2-7/00x", "bytes 2-9223372036854775807/*"] {
    precondition(PlaybackByteRange(status: 206, header: bad, bytes: -1, coding: nil, offset: 2) == nil)
}
precondition(PlaybackByteRange(status: 206, header: "bytes 2-7/10", bytes: 5, coding: nil, offset: 2) == nil)
precondition(PlaybackByteRange(status: 206, header: "bytes 2-7/10", bytes: 6, coding: "gzip", offset: 2) == nil)
precondition(PlaybackByteRange(status: 200, header: nil, bytes: 10, coding: nil, offset: 2) == nil)
precondition(PlaybackByteRange(status: 206, header: "bytes 2-7/*", bytes: 6, coding: nil, offset: 2)!.total == nil)
let whole = PlaybackByteRange(status: 200, header: nil, bytes: 10, coding: "identity", offset: 0)!
precondition(whole.cacheIdentity(tag: nil, modified: nil, date: nil, request: 4) == "response:4")
precondition(whole.cacheIdentity(tag: nil, modified: nil, date: nil, request: 5) == "response:5")
print("Offline storage, retention, isolation, HTTP byte ranges and representation validation passed.")

func playlistSource(_ id: String) -> String {
    "playlist:" + Data(id.utf8).base64EncodedString().replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
let lists = try OfflineFiles(folder: root.appendingPathComponent("playlist-listener"))
let firstList = playlistSource("週末 / side B"), secondList = playlistSource("Rainy day")
var prefs = lists.options()
prefs.autoCache = true
prefs.autoDownload = firstList
try lists.configure(prefs)
let ordered = (0..<40).map { "song-" + String($0) }
let plannedPlaylist = try lists.plan(firstList, ids: [ordered[0]] + ordered + [ordered[30]])
precondition(plannedPlaylist == ordered)

func song(_ id: String) -> OfflineFiles.Track {
    OfflineFiles.Track(id: id, title: "Fixture", album: "Album", artist: "Artist", streamUrl: "/api/v3/stream/local/" + id,
                       artworkUrl: nil, duration: nil)
}
func saveSong(_ store: OfflineFiles, _ id: String, _ origin: OfflineFiles.Origin, _ source: String? = nil) throws {
    let track = song(id)
    if let ticket = try store.begin(track, origin: origin, source: source) {
        try store.install(audio, bytes: Int64(bytes.count), ext: "wav", track: track, ticket: ticket)
    }
}
func refused<T>(_ operation: () throws -> T) {
    do { _ = try operation(); preconditionFailure("An invalid playlist operation unexpectedly succeeded.") }
    catch { precondition(error is OfflineFiles.Failure) }
}
let maxID = String(repeating: "🪕", count: 64)
precondition(OfflineFiles.enabledSource(playlistSource(maxID)))
for malformed in ["playlist:", "playlist:YQ==", "playlist:Yh", "playlist:_w", "playlist:AA", playlistSource(".."),
                  playlistSource("."), playlistSource("a\u{7f}"), playlistSource("a\u{80}"), playlistSource(maxID + "x")] {
    var invalid = prefs; invalid.autoDownload = malformed
    refused { try lists.configure(invalid) }
    refused { try lists.plan(malformed, ids: []) }
    precondition(lists.options().autoDownload == firstList)
}
try other.configure(prefs)
try saveSong(other, "orphan", .automatic, firstList)
try saveSong(lists, "manual", .downloaded)
try saveSong(lists, "cache", .cached)
try saveSong(lists, "unrelated-cache", .cached)
try saveSong(lists, ordered[39], .automatic, firstList)
try saveSong(lists, "orphan", .automatic, firstList)
try lists.remove([ordered[7]])
let membership = ["manual", "cache", "cache"] + ordered + [ordered[30]]
let expected = ["cache"] + ordered.filter { $0 != ordered[7] && $0 != ordered[39] }
let additive = try lists.plan(firstList, ids: membership, keepExisting: true)
precondition(additive == expected && lists.playable("orphan") != nil)
refused { try lists.plan(firstList, ids: membership + ["../broken"]) }
precondition(lists.playable("orphan") != nil)
let reconciled = try lists.plan(firstList, ids: membership)
precondition(reconciled == expected && lists.playable("orphan") == nil && other.playable("orphan") != nil)
let cacheFile = lists.playable("cache")
try saveSong(lists, "cache", .automatic, firstList)
precondition(lists.playable("cache") == cacheFile && lists.rows().contains { $0.track.id == "cache" && $0.origin == .automatic })

let downloading = song("in-flight"), started = try lists.begin(downloading, origin: .automatic, source: firstList)!
let manualMissing = try lists.begin(song("manual-missing"), origin: .downloaded)!
for status in [404, 410] {
    precondition(lists.missingPlaylistAudio(started, httpStatus: status)?.code == "DN_AUDIO_NOT_FOUND")
    precondition(lists.missingPlaylistAudio(manualMissing, httpStatus: status) == nil)
    precondition(other.missingPlaylistAudio(started, httpStatus: status) == nil)
}
for status: Int? in [nil, 200, 206, 302, 400, 401, 403, 408, 409, 429, 500, 503] {
    precondition(lists.missingPlaylistAudio(started, httpStatus: status) == nil)
}
let oversizedTrack = song("oversized")
let oversizedTicket = try lists.begin(oversizedTrack, origin: .automatic, source: firstList)!
do {
    try lists.install(audio, bytes: 513 * OfflineFiles.mib, ext: "wav", track: oversizedTrack, ticket: oversizedTicket)
    preconditionFailure("A playlist transfer must honor the automatic quota.")
} catch let failure as OfflineFiles.Failure { precondition(failure.message.contains("limit")) }
precondition(!other.active(started))
prefs.autoDownload = secondList
try lists.configure(prefs)
precondition(lists.missingPlaylistAudio(started, httpStatus: 404) == nil)
let stale = try lists.plan(firstList, ids: [])
precondition(stale.isEmpty && lists.playable(ordered[39]) != nil)
refused { try lists.clearAutomaticPlaylist(firstList) }
prefs.autoDownload = firstList
try lists.configure(prefs)
precondition(!lists.active(started))
try lists.install(audio, bytes: Int64(bytes.count), ext: "wav", track: downloading, ticket: started)
precondition(lists.playable(downloading.id) == nil)
prefs.autoDownload = "off"
try lists.configure(prefs)
precondition(lists.playable("cache") != nil)
prefs.autoDownload = secondList
prefs.offlineOnly = true
try lists.configure(prefs)
let cleared = try lists.clearAutomaticPlaylist(secondList)
precondition(cleared.autoDownload == "off" && cleared.offlineOnly)
precondition(Set(lists.rows().map(\.track.id)) == ["manual", "unrelated-cache"] && other.playable("orphan") != nil)
prefs.offlineOnly = false
prefs.autoDownload = firstList
try lists.configure(prefs)
let excludedAfterClear = try lists.plan(firstList, ids: [ordered[7]])
precondition(excludedAfterClear.isEmpty)
for source in ["recent", "favorites"] {
    prefs.autoDownload = source
    try lists.configure(prefs)
    let classic = try lists.plan(source, ids: ordered)
    precondition(classic == Array(ordered.prefix(25)).filter { $0 != ordered[7] })
    let classicTicket = try lists.begin(song("classic-missing"), origin: .automatic, source: source)!
    precondition(lists.missingPlaylistAudio(classicTicket, httpStatus: 410) == nil)
}
print("Playlist automatic downloads passed for ordered membership, partial resolution, missing audio responses, source changes, account isolation and explicit clearing.")

let iosFolder = root.appendingPathComponent("iphone-queue")
var phone = try OfflineFiles(folder: iosFolder)
var queueOptions = phone.options()
queueOptions.readAheadWifi = 2
queueOptions.readAheadCellular = 0
queueOptions.readAheadWifiKiBps = 128
queueOptions.downloadQuality = .init(format: "mp3", rate: 192)
try phone.configure(queueOptions)
let aheadTrack = song("ahead")
let aheadTicket = try phone.begin(aheadTrack, origin: .cached, source: "wifi")!
let cellularTicket = try phone.begin(aheadTrack, origin: .cached, source: "cellular")
precondition(cellularTicket == nil)
try phone.install(audio, bytes: Int64(bytes.count), ext: "mp3", track: aheadTrack, ticket: aheadTicket, mime: "audio/mpeg")
let playedFile = phone.playable("ahead")!
precondition(phone.representation("ahead", file: playedFile)?.mime == "audio/mpeg")
precondition(phone.representation("other", file: playedFile) == nil)
precondition(ReadAheadPace(rateKiBps: 128).wait(bytes: 262144, elapsed: 0.5) == 1.5)
precondition(ReadAheadPace(rateKiBps: 0).wait(bytes: 262144, elapsed: 0) == 0)

var albumOne = song("one")
albumOne.artworkUrl = "/api/v3/library/albums/fixture/artwork?size=500"
var albumTwo = song("two")
albumTwo.artworkUrl = albumOne.artworkUrl
let queued = try phone.enqueue([albumOne, albumTwo, albumOne])
precondition(queued.added == 2 && queued.already == 1)
phone = try OfflineFiles(folder: iosFolder)
precondition(phone.manualQueue().jobs.map(\.track.id) == ["one", "two"])
let savedTicket = try phone.begin(albumOne, origin: .downloaded)!
try phone.install(audio, bytes: Int64(bytes.count), ext: "wav", track: albumOne, ticket: savedTicket)
try phone.finishManual("one", failure: nil)
try phone.finishManual("two", failure: "Unavailable")
precondition(phone.manualQueue().status(current: nil, permitted: true, offline: false)["state"] as? String == "failed")
try phone.retryManual()
let oldTicket = try phone.begin(albumTwo, origin: .downloaded)!
try phone.cancelManual()
precondition(!phone.active(oldTicket) && phone.manualQueue().jobs.isEmpty && phone.playable("one") != nil)
let firstRow = phone.preparation("one")!
try phone.retainCompanion("artwork", value: "data:image/png;base64,fixture", for: firstRow)
try phone.retainCompanion("lyrics", value: "null", for: firstRow)
let prepared = Array(repeating: Float(0.5), count: 112)
let preparedJSON = String(decoding: try JSONEncoder().encode(prepared), as: UTF8.self)
try phone.retainCompanion("peaks", value: preparedJSON, for: firstRow)
precondition(phone.peaks("one", file: phone.playable("one")!) == prepared)
precondition(phone.peaks("one", file: playedFile) == nil)
let secondTicket = try phone.begin(albumTwo, origin: .downloaded)!
try phone.install(audio, bytes: Int64(bytes.count), ext: "wav", track: albumTwo, ticket: secondTicket)
let secondRow = phone.preparation("two")!
try phone.retainCompanion("artwork", value: phone.companion("artwork", key: albumTwo.artworkUrl!)!, for: secondRow)
let report = try phone.diagnostics(version: "1.0", system: "18.5", network: "wifi", pendingListens: 2)
precondition(phone.reviewed(report) && !other.reviewed(report) && !phone.reviewed(report + "!"))
precondition(!report.contains("fixture") && !report.contains("Artist") && !report.contains("Bearer") && !report.contains("server"))
try phone.remove(["one"])
precondition(phone.companion("lyrics", key: "one") == nil && phone.companion("artwork", key: albumTwo.artworkUrl!) != nil)
let staleRefresh = try phone.refresh(albumTwo, expected: firstRow.name)
precondition(!staleRefresh)
try phone.remove(["two"])
precondition(phone.companion("artwork", key: albumTwo.artworkUrl!) == nil)
precondition(OfflineFiles.coverPath("/api/v3/library/albums/%2f/artwork") == nil)
precondition(OfflineFiles.coverPath("/api/v3/me") == nil)
let restoredOpts = try OfflineFiles(folder: iosFolder).options()
precondition(restoredOpts.downloadQuality?.format == "mp3" && restoredOpts.aheadRate("wifi") == 128)
print("Durable manual queue, read-ahead policies, companion retention, metadata versions and privacy-safe report passed.")

let collectionStore = try OfflineFiles(folder: root.appendingPathComponent("collection-listener"))
let favPin = OfflineFiles.Pin(kind: "favorites", id: "favorites", name: "Favorites")
let playlistPin = OfflineFiles.Pin(kind: "playlist", id: "list", name: "Party")
let selection = [favPin, playlistPin]
var collectionOptions = collectionStore.options()
collectionOptions.offlinePins = selection
try collectionStore.configure(collectionOptions)
let both = OfflineFiles.Membership(kind: "favorites", id: "favorites", name: "Favorites", ids: ["shared", "favorite"], complete: true)
let firstPlaylist = OfflineFiles.Membership(kind: "playlist", id: "list", name: "Party", ids: ["shared", "shared", "playlist"], complete: true)
let firstUnavailablePlaylist = OfflineFiles.Membership(kind: "playlist", id: "list", name: "Party", ids: ["unconfirmed"], complete: false)
_ = try collectionStore.planPins(expected: selection, source: "off", members: [both, firstUnavailablePlaylist])
precondition(collectionStore.pinnedPlaylists().isEmpty)
let collectionPending = try collectionStore.planPins(expected: selection, source: "off", members: [both, firstPlaylist])
precondition(collectionPending == ["shared", "favorite", "playlist"])
for id in collectionPending {
    let song = song(id), ticket = try collectionStore.begin(song, origin: .automatic, source: "pinnedCollections")!
    precondition(collectionStore.active(ticket, bytes: Int64(bytes.count)))
    precondition(!collectionStore.active(ticket, bytes: Int64(collectionOptions.downloadMiB) * OfflineFiles.mib + 1))
    try collectionStore.install(audio, bytes: Int64(bytes.count), ext: "wav", track: song, ticket: ticket)
}
try saveSong(collectionStore, "keep", .downloaded)
let confirmedPlaylist = collectionStore.pinnedPlaylists()[0]["ids"] as? [String]
precondition(confirmedPlaylist == firstPlaylist.ids)
let reopenedCollection = try OfflineFiles(folder: root.appendingPathComponent("collection-listener"))
let partial = OfflineFiles.Membership(kind: "playlist", id: "list", name: "Party", ids: [], complete: false)
_ = try reopenedCollection.planPins(expected: selection, source: "off", members: [both,partial])
precondition(reopenedCollection.playable("playlist") != nil)
precondition(reopenedCollection.pinnedPlaylists()[0]["ids"] as? [String] == firstPlaylist.ids)
try reopenedCollection.remove(["favorite"])
collectionOptions.offlinePins = [favPin]
try reopenedCollection.configure(collectionOptions, clearUnpinned: true)
let wantedAfterRemoval = try reopenedCollection.planPins(expected: [favPin], source: "off", members: [both])
precondition(wantedAfterRemoval.isEmpty && reopenedCollection.playable("shared") != nil && reopenedCollection.playable("playlist") == nil)
do {
    _ = try reopenedCollection.planPins(expected: selection, source: "off", members: [both, firstPlaylist])
    preconditionFailure("Stale collection selection accepted")
} catch is OfflineFiles.Failure {}
collectionOptions.offlinePins = []
try reopenedCollection.configure(collectionOptions, clearUnpinned: true)
precondition(reopenedCollection.rows().map { $0.track.id } == ["keep"])
print("Overlapping iPhone pins share files, retain partial memberships and respect manual copies and exclusions.")


var notification = DownloadNotificationTap()
let listenerA = String(repeating: "a", count: 64), listenerB = String(repeating: "b", count: 64)
let delivery = Date(), request = DownloadNotificationTap.prefix + listenerA
precondition(!notification.receive(scope: "bad", identifier: request, delivered: delivery))
precondition(!notification.receive(scope: listenerA, identifier: "unrelated", delivered: delivery))
precondition(notification.receive(scope: listenerA, identifier: request, delivered: delivery))
precondition(!notification.receive(scope: listenerA, identifier: request, delivered: delivery))
precondition(!notification.take(owner: listenerB) && !notification.take(owner: listenerA))
precondition(notification.receive(scope: listenerA, identifier: request, delivered: delivery.addingTimeInterval(1)))
notification.clear(owner: listenerB)
precondition(notification.take(owner: listenerA) && !notification.take(owner: listenerA))
print("Download notification ownership, duplicate delivery and one-time consumption passed.")
