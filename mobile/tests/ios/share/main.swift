import Foundation

let clean = "https://music.apple.com/jp/album/new/12?i=34"
precondition(SharedSongInbox.address(in: "曲名 " + clean + "&at=private") == clean)
precondition(SharedSongInbox.address(in: "https://music.apple.com.example/secret") == nil)
precondition(SharedSongInbox.address(in: "https://user:pass@music.apple.com/jp/song/12") == nil)
precondition(SharedSongInbox.address(in: String(repeating: "a", count: 8193)) == nil)
let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
defer { try? FileManager.default.removeItem(at: file) }
try SharedSongInbox.save(clean, to: file)
let once = try SharedSongInbox.take(from: file)
let again = try SharedSongInbox.take(from: file)
precondition(once == clean && again == nil)
