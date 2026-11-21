import Foundation

let identifier = "com.example.fixture", access = UUID()
let current = PlayerWidgetSnapshot(scope: "account", occurrence: "track", access: access, title: "Song", artist: "Artist",
                                   playing: true, canNext: true, artwork: Data([1,2]))
let prefix = identifier + ".widgets://player/"
func action(_ url: String, _ occurrence: String? = "track") -> String? {
    PlayerWidgetSnapshot.action(url, hostID: identifier, occurrence: occurrence, saved: current)
}
precondition(action(prefix + "open", nil) == "open")
for command in ["next","previous","play","pause"] {
    let link = prefix + command + "?item=" + access.uuidString
    precondition(action(link) == command)
    precondition(action(link, "other account or track") == nil && action(link, nil) == nil)
    precondition(action(link + "&extra=1") == nil)
    precondition(action(prefix + command) == nil)
    precondition(action(prefix + command + "?item=" + UUID().uuidString) == nil)
}
for url in ["bad.widgets://player/open", prefix + "unknown", prefix + "open?aux=1",
            identifier + ".widgets://user@player/open", prefix + "open#fragment"] { precondition(action(url) == nil) }
let encoded = try JSONEncoder().encode(current)
let decoded = try JSONDecoder().decode(PlayerWidgetSnapshot.self, from: encoded)
precondition(decoded == current)
print("Widget transport links reject stale tracks, other accounts and unrelated URLs; display state round-trips.")
