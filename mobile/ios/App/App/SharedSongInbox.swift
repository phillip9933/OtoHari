import Foundation

/// The share extension and host exchange one public music address. No account
/// credentials, playlist data, clipboard or network access is needed here.
enum SharedSongInbox {
    private static let hosts: Set<String> = ["open.spotify.com", "deezer.com", "www.deezer.com",
        "link.deezer.com", "music.apple.com", "geo.music.apple.com", "www.youtube.com", "youtube.com",
        "m.youtube.com", "music.youtube.com", "youtu.be", "song.link"]

    static func address(in text: String) -> String? {
        guard text.utf8.count <= 8192 else { return nil }
        for word in text.split(whereSeparator: { $0.isWhitespace }) {
            let raw = String(word)
            if raw.range(of: "^spotify:track:[A-Za-z0-9]{22}$", options: .regularExpression) != nil { return raw }
            guard var url = URLComponents(string: raw), url.scheme == "https", let host = url.host?.lowercased(),
                  hosts.contains(host), url.user == nil, url.password == nil, url.port == nil else { continue }
            let key = host.hasSuffix("music.apple.com") ? "i" : (url.path == "/watch" ? "v" : "")
            let id = url.queryItems?.first { $0.name == key && !key.isEmpty }
            url.queryItems = id.map { [$0] }
            url.fragment = nil
            if let address = url.string { return address }
        }
        return nil
    }
    static func location() throws -> URL {
        #if os(iOS)
        guard let bundle = Bundle.main.bundleIdentifier else { throw CocoaError(.fileNoSuchFile) }
        let host = Bundle.main.bundleURL.pathExtension == "appex" ? String(bundle.dropLast(".ShareSong".count)) : bundle
        guard let dir = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group." + host) else {
            throw CocoaError(.fileNoSuchFile)
        }
        return dir.appendingPathComponent("shared-song.txt")
        #else
        throw CocoaError(.fileNoSuchFile)
        #endif
    }
    static func save(_ link: String, to file: URL) throws {
        try Data(link.utf8).write(to: file, options: [.atomic, .completeFileProtection])
    }
    static func take(from path: URL) throws -> String? {
        let claimed = path.deletingLastPathComponent().appendingPathComponent(UUID().uuidString)
        do { try FileManager.default.moveItem(at: path, to: claimed) }
        catch let error as CocoaError where error.code == .fileNoSuchFile || error.code == .fileReadNoSuchFile { return nil }
        defer { try? FileManager.default.removeItem(at: claimed) }
        return address(in: try String(contentsOf: claimed, encoding: .utf8))
    }
}
