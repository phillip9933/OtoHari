import Foundation

/// Both targets use this small, credential-free display record. The normal app does not request a shared container.
struct PlayerWidgetSnapshot: Codable, Equatable {
    static let kind = "DNNowPlaying"
    static var hostID: String? {
        #if DN_PLAYER_WIDGET
        guard let bundle = Bundle.main.bundleIdentifier, !bundle.isEmpty else { return nil }
        return bundle.hasSuffix(".NowPlayingWidget") ? String(bundle.dropLast(".NowPlayingWidget".count)) : bundle
        #else
        return nil
        #endif
    }
    static var url: URL? {
        #if os(iOS)
        guard let hostID else { return nil }
        return FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group." + hostID)?
            .appendingPathComponent("now-playing.json", isDirectory: false)
        #else
        return nil
        #endif
    }
    let scope: String, occurrence: String, access: UUID
    let title: String, artist: String, playing: Bool, canNext: Bool, artwork: Data?
    static func read() -> Self? {
        guard let url, let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize, size <= 300_000,
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
    static func action(_ raw: String, hostID: String, occurrence: String?, saved: Self?) -> String? {
        guard let link = URLComponents(string: raw), link.scheme == hostID + ".widgets", link.host == "player",
              link.user == nil, link.password == nil, link.port == nil, link.fragment == nil else { return nil }
        if link.path == "/open" && link.query == nil { return "open" }
        guard ["/play", "/pause", "/previous", "/next"].contains(link.path), let saved, saved.occurrence == occurrence,
              link.queryItems == [URLQueryItem(name: "item", value: saved.access.uuidString)] else { return nil }
        return String(link.path.dropFirst())
    }
    static func link(_ action: String = "open", access: UUID? = nil) -> URL? {
        guard let hostID else { return nil }
        var link = URLComponents()
        link.scheme = hostID + ".widgets"; link.host = "player"; link.path = "/" + action
        if let access { link.queryItems = [URLQueryItem(name: "item", value: access.uuidString)] }
        return link.url
    }
}
