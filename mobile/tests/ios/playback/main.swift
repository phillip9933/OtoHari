// swiftc mobile/ios/App/App/{OfflineFiles,LibraryContinuation,PlaybackArchive}.swift mobile/tests/ios/playback/main.swift -o /tmp/dn-playback-test
import Foundation

let directory = FileManager.default.temporaryDirectory.appendingPathComponent("player-fixture-" + UUID().uuidString)
defer { try? FileManager.default.removeItem(at: directory) }
let alice = try PlaybackArchive(folder: directory.appendingPathComponent("a")), bob = try PlaybackArchive(folder: directory.appendingPathComponent("b"))
let track = try JSONDecoder().decode(OfflineFiles.Track.self, from: Data("""
{"id":"t","title":"Signal","artist":"Fixture","album":"Arrival","streamUrl":"/api/v3/stream/local/t?token=secret","artworkUrl":"/api/v3/library/albums/a/artwork?token=secret&size=512","token":"secret","duration":150}
""".utf8))
let initial = PlaybackArchive.Cursor(revision: UUID(), index: 1, position: 2.5, repeatMode: "one")
try alice.save([track, track], cursor: initial)
let bytes = try Data(contentsOf: directory.appendingPathComponent("a/queue.json"))
precondition(!String(decoding: bytes, as: UTF8.self).contains("secret"))
var cursor = initial; cursor.position = 38.25
try alice.checkpoint(cursor)
let restored = try PlaybackArchive(folder: directory.appendingPathComponent("a")).load()!
precondition(restored.tracks.count == 2 && restored.cursor.index == 1 && restored.cursor.position == 38.25 && restored.cursor.repeatMode == "one")
precondition(restored.tracks[0].artworkUrl == "/api/v3/library/albums/a/artwork?size=512")
let missing = try bob.load()
precondition(missing == nil)
var next = initial; next.revision = UUID(); next.index = 0; next.position = 0; next.repeatMode = "off"
try alice.save([track], cursor: next)
try alice.checkpoint(cursor)
let large = Array(repeating: track, count: 2_001)
try bob.save(large, cursor: next)
let largeRestored = try bob.load()
precondition(largeRestored?.tracks.count == 2_001)
let huge = OfflineFiles.Track(id: "huge", title: String(repeating: "x", count: 3_145_728), album: "", artist: "",
                              streamUrl: "/api/v3/stream/local/huge", artworkUrl: nil, duration: nil)
do { try bob.save([huge], cursor: next); preconditionFailure("Oversized current queue was saved") }
catch is OfflineFiles.Failure {}
let preserved = try bob.load()
precondition(preserved?.tracks.count == 2_001)
let largeUndo = PlaybackArchive.Previous(tracks: [huge], cursor: next, continuation: nil, order: nil, playing: false)
try bob.save([track], cursor: next, previous: largeUndo)
let smallRestored = try bob.load()
precondition(smallRestored?.tracks.count == 1 && smallRestored?.previous == nil)
let current = try alice.load()!
precondition(current.cursor.index == 0 && current.cursor.position == 0)
try alice.erase()
let cleared = try alice.load()
precondition(cleared == nil)
var sleep = PlaybackSleep()
let repeatedTimerTrack = UUID(), nextTimerTrack = UUID()
sleep.after(repeatedTimerTrack, count: 2)
precondition(!sleep.reachedEnd(repeatedTimerTrack) && sleep.remaining == 1)
sleep.moved(to: nextTimerTrack)
precondition(sleep.reachedEnd(nextTimerTrack) && sleep.state == nil)
try sleep.minutes(1, now: 0, finishLast: true)
precondition(!sleep.finishCurrent(now: 59_999, track: repeatedTimerTrack))
precondition(sleep.finishCurrent(now: 60_001, track: repeatedTimerTrack))
precondition(sleep.reachedEnd(repeatedTimerTrack) && sleep.state == nil)
let one = UUID(), two = UUID()
try sleep.minutes(1, now: 5000)
precondition(sleep.state?["endsAt"] as? Double == 65_000)
sleep.moved(to: two)
precondition(!sleep.expire(now: 64_999))
precondition(sleep.expire(now: 65_000) && sleep.state == nil)
sleep.after(one)
precondition(!sleep.reachedEnd(two))
sleep.moved(to: one)
precondition(sleep.reachedEnd(one) && sleep.state == nil)
sleep.after(one); sleep.moved(to: two); precondition(sleep.state == nil)
try sleep.minutes(240, now: 0); sleep.cancel(); precondition(sleep.state == nil)
do { try sleep.minutes(241, now: 0); preconditionFailure("Invalid timer accepted") }
catch is OfflineFiles.Failure {}
print("Paused queue persistence, private metadata, cursor revisions and sleep boundaries passed.")

// Only an accepted, paired end may resume a still-requested occurrence.
var intent = PlaybackIntent()
intent.beginInterruption()
precondition(intent.endInterruption(recommended: true, now: 0) == .hold)
intent.userActivated()
precondition(intent.endInterruption(recommended: false, now: 1) == .hold && intent.canPlay)
intent.beginInterruption(); intent.beginInterruption()
precondition(intent.requested && !intent.canPlay) // The listener can cancel the pending Play.
precondition(intent.permission(now: 2) == .hold, "Seek completion during interruption")
precondition(intent.permission(now: 3) == .hold, "Page completion during interruption")
precondition(intent.endInterruption(recommended: true, now: 4) == .play)
precondition(intent.endInterruption(recommended: false, now: 5) == .hold && intent.canPlay)
intent.beginInterruption()
precondition(intent.endInterruption(recommended: false, now: 6) == .hold && !intent.requested)
precondition(intent.endInterruption(recommended: true, now: 7) == .hold)

// An in-app/remote Pause or a disappearing output revokes the same request.
for pauseBeforeBegin in [false, true] {
    intent.userActivated()
    if pauseBeforeBegin { intent.pause() }
    intent.beginInterruption()
    if !pauseBeforeBegin { intent.pause() }
    precondition(intent.permission(now: 10) == .hold, "A buffered seek must remain paused")
    precondition(intent.endInterruption(recommended: true, now: 11) == .hold)
    precondition(intent.permission(now: 12) == .hold, "A late library page must remain paused")
}
intent.userActivated(); intent.beginInterruption()
precondition(intent.endInterruption(recommended: true, now: 20) == .play)
intent.pause() // The route change may also arrive just after the interruption ends.
precondition(intent.permission(now: 21) == .hold)
precondition(intent.endInterruption(recommended: true, now: 22) == .hold)

// Wall time has advanced while the app and the timer dispatch source were suspended.
intent.userActivated(); try intent.sleep.minutes(1, now: 0); intent.beginInterruption()
precondition(intent.permission(now: 59_999) == .hold)
precondition(intent.endInterruption(recommended: true, now: 60_000) == .timerExpired)
precondition(!intent.requested && intent.sleep.state == nil && intent.permission(now: 60_001) == .hold)
intent.userActivated()
precondition(intent.permission(now: 60_002) == .play, "A later explicit Play can start")
try intent.sleep.minutes(1, now: 0); intent.beginInterruption()
precondition(intent.permission(now: 60_000) == .timerExpired, "A seek or page can observe the missed deadline first")
precondition(intent.endInterruption(recommended: true, now: 60_010) == .hold)
intent.userActivated(); try intent.sleep.minutes(1, now: 0); intent.beginInterruption()
precondition(intent.endInterruption(recommended: true, now: 59_999) == .play)
precondition(intent.permission(now: 60_000) == .timerExpired, "A deadline between recommendation and seek completion still wins")
precondition(intent.permission(now: 60_001) == .hold, "A delayed page cannot rearm the expired timer")

intent.userActivated(); intent.sleep.after(one); intent.beginInterruption()
precondition(!intent.reachedEnd(two) && intent.requested, "A different queue occurrence ended")
precondition(intent.reachedEnd(one) && !intent.requested)
precondition(intent.endInterruption(recommended: true, now: 70_000) == .hold)
intent.beginInterruption()
intent.userActivated() // A new explicit Play successfully reacquired audio without a matching end.
precondition(intent.endInterruption(recommended: false, now: 70_001) == .hold && intent.canPlay)
intent.beginInterruption(); intent = PlaybackIntent() // Signed out or restored paused to a different account.
precondition(intent.endInterruption(recommended: true, now: 70_002) == .hold && !intent.requested)
print("Interruption recommendations, deferred playback, explicit pause, route loss and suspended sleep deadlines passed.")

// Queues may contain two occurrences of the same recording. Priority and order follow the occurrences.
let keys = (0..<7).map { _ in UUID() }
var order = PlayerQueueOrder()
let ids = Dictionary(uniqueKeysWithValues: keys.enumerated().map { ($0.element, String($0.offset / 2)) })
let fingerprint: ([String]) -> String = { $0.joined(separator: "|") }
order.inserted([keys[2]], after: keys[1], placement: "upNext")
precondition(order.insertion("next", in: keys, current: 0) == 1)
precondition(order.insertion("upNext", in: keys, current: 0) == 3)
let shuffled = order.toggle(keys, current: 0, ids: ids, excluded: nil, hash: fingerprint)
precondition(shuffled[0] == keys[0] && shuffled[1] == keys[2] && Set(shuffled) == Set(keys))
let normalOrder = order.saved(shuffled)
var resumedOrder = PlayerQueueOrder(normalOrder, keys: shuffled, current: 0)
let back = resumedOrder.toggle(shuffled, current: 0, ids: ids, excluded: nil, hash: fingerprint)
precondition(back == [keys[0], keys[2], keys[1]] + Array(keys[3...]))
precondition(resumedOrder.original == nil && resumedOrder.extras == [keys[2]])
let savedPrevious = PlaybackArchive.Previous(tracks: [track], cursor: next, continuation: nil, order: nil, playing: false)
try alice.save([track, track], cursor: initial, order: nil, previous: savedPrevious)
let withBackup = try alice.load()
precondition(withBackup?.previous?.tracks.first?.id == track.id && withBackup?.previous?.playing == false)
print("Up Next, duplicate recordings, reversible shuffle and archived previous queues passed.")
