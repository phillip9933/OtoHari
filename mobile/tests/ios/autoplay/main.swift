import Foundation

let artist = "0aff7d8e-17b7-4793-9dda-f1d5421020a3"
let recording = "a100e0de-ced0-4a70-a635-e2856717aa14"
let tracks: [PlayerAutoplay.Track] = [["id": "old", "artistMbid": artist, "recordingMbid": recording]]
let plan = try PlayerAutoplay.plan(tracks: tracks, exclusions: [recording])
precondition(plan["seed_type"] as? String == "items" && plan["mode"] as? String == "library")
let album = try PlayerAutoplay.plan(tracks: [["releaseGroupMbid": artist]], exclusions: [])
let genre = try PlayerAutoplay.plan(tracks: [["genre": "Rock"]], exclusions: [])
precondition(album["seed_type"] as? String == "album" && genre["seed_type"] as? String == "genre")
precondition((try? PlayerAutoplay.plan(tracks: [["id":"unknown"]], exclusions: [])) == nil)
func row(_ id: String, _ library: Bool = true) -> PlayerAutoplay.Track {
    ["local_file_id":id, "track_name":"Song", "artist_name":"Artist", "in_library":library]
}
var duplicateRecording = row("another-file"); duplicateRecording["recording_mbid"] = recording
let rows = [row("old"), row("../other"), row("not-local", false), duplicateRecording, row("cover + 1"), row("cover + 1")]
let base = URL(string:"https://music.invalid/prefix")!
let data = try JSONSerialization.data(withJSONObject:["tracks":rows])
let result = try PlayerAutoplay.suggestions(data:data, base:base, excluding:tracks)
precondition(result.count == 1 && result[0]["id"] as? String == "cover + 1")
precondition(result[0]["streamUrl"] as? String == "https://music.invalid/prefix/api/v3/stream/local/cover%20%2B%201")
print("Account radio seeds, exclusions and scoped playback URLs passed.")
