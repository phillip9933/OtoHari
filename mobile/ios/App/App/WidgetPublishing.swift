import CryptoKit
import MediaPlayer
import UIKit
import WidgetKit

final class WidgetPublishing {
    private var last: PlayerWidgetSnapshot?
    private var loaded = false
    private weak var previousArt: MPMediaItemArtwork?
    private var artwork: Data?
    private func load() {
        if !loaded { last = PlayerWidgetSnapshot.read(); loaded = true }
    }
    private func digest(_ fields: [String]) -> String {
        SHA256.hash(data: (try? JSONEncoder().encode(fields)) ?? Data()).map { String(format: "%02x", $0) }.joined()
    }
    func owner(server: String, user: String?) {
        guard PlayerWidgetSnapshot.hostID != nil else { return }
        load()
        if let last, last.scope != digest([server, user ?? ""]) { clear() }
    }
    func clear() {
        guard let url = PlayerWidgetSnapshot.url else { return }
        load()
        previousArt = nil; artwork = nil
        guard last != nil || FileManager.default.fileExists(atPath: url.path) else { return }
        if FileManager.default.fileExists(atPath: url.path) {
            do { try FileManager.default.removeItem(at: url) } catch { return }
        }
        last = nil; WidgetCenter.shared.reloadTimelines(ofKind: PlayerWidgetSnapshot.kind)
    }
    func publish(server: String, user: String?, track: [String: Any], index: Int, playing: Bool, canNext: Bool, art: MPMediaItemArtwork?) {
        guard let url = PlayerWidgetSnapshot.url, let id = track["id"] as? String, !server.isEmpty, let user, !user.isEmpty else { return }
        load()
        let owner = digest([server, user]), occurrence = digest([owner, id, String(index)])
        let same = last?.occurrence == occurrence
        if !same { previousArt = nil; artwork = nil }
        if let art, art !== previousArt {
            previousArt = art
            let size = CGSize(width: 160, height: 160)
            if let image = art.image(at: size) {
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1; format.opaque = true
                let thumb = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
                artwork = thumb.jpegData(compressionQuality: 0.8)
            }
        }
        // Retain the existing cover through a cold paused restore of the same track.
        let current = PlayerWidgetSnapshot(scope: owner, occurrence: occurrence, access: same ? (last?.access ?? UUID()) : UUID(),
            title: String((track["title"] as? String ?? "").prefix(512)), artist: String((track["artist"] as? String ?? "").prefix(512)),
            playing: playing, canNext: canNext, artwork: artwork ?? (same ? last?.artwork : nil))
        guard current != last else { return }
        do {
            try JSONEncoder().encode(current).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            last = current
            WidgetCenter.shared.reloadTimelines(ofKind: PlayerWidgetSnapshot.kind)
        } catch { /* A developer build may run without the optional App Group provisioning. */ }
    }
    func action(_ raw: String, server: String, user: String?, track: String?, index: Int) -> String? {
        guard let hostID = PlayerWidgetSnapshot.hostID, let user, !user.isEmpty else { return nil }
        let occurrence = track.map { digest([digest([server, user]), $0, String(index)]) }
        return PlayerWidgetSnapshot.action(raw, hostID: hostID, occurrence: occurrence, saved: PlayerWidgetSnapshot.read())
    }
}
