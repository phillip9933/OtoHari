import Capacitor
import CryptoKit
import UIKit

@objc(DNLauncherPlugin)
public final class DNLauncherPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DNLauncherPlugin", jsName = "DNLauncher"
    public let pluginMethods = ["pinPlaylist", "playlistPinned", "takePlaylist", "clearShortcuts"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    private static var pending: (owner: String, id: String)?
    private static func digest(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private func owner(_ call: CAPPluginCall) -> String? {
        guard let server = call.getString("serverUrl"), !server.isEmpty,
              let user = call.getString("userId"), !user.isEmpty else { return nil }
        return Self.digest(server + "\u{0}" + user)
    }
    private static func type(owner: String, id: String) -> String {
        "app.droppedneedle.mobile.playlist." + digest(owner + "\u{0}" + id)
    }

    @objc func playlistPinned(_ call: CAPPluginCall) {
        guard let owner = owner(call), let id = call.getString("id") else { call.resolve(["pinned": false]); return }
        DispatchQueue.main.async {
            let type = Self.type(owner: owner, id: id)
            call.resolve(["pinned": UIApplication.shared.shortcutItems?.contains { $0.type == type } == true])
        }
    }

    @objc func pinPlaylist(_ call: CAPPluginCall) {
        guard let owner = owner(call), let id = call.getString("id"), !id.isEmpty,
              let name = call.getString("name"), !name.isEmpty else {
            call.reject("Reopen the playlist to add a shortcut.")
            return
        }
        DispatchQueue.main.async {
            let type = Self.type(owner: owner, id: id)
            let others = (UIApplication.shared.shortcutItems ?? []).filter {
                $0.type != type && $0.userInfo?["owner"] as? String == owner
            }
            if call.getBool("remove") == true {
                UIApplication.shared.shortcutItems = others
                call.resolve()
                return
            }
            let shortcut = UIApplicationShortcutItem(type: type, localizedTitle: name,
                localizedSubtitle: nil, icon: UIApplicationShortcutIcon(systemImageName: "music.note.list"),
                userInfo: ["owner": owner as NSString, "id": id as NSString])
            // iOS chooses how many quick actions fit. Show the most recent pin first.
            UIApplication.shared.shortcutItems = [shortcut] + others
            call.resolve()
        }
    }

    static func receive(_ shortcut: UIApplicationShortcutItem) -> Bool {
        guard let owner = shortcut.userInfo?["owner"] as? String,
              let id = shortcut.userInfo?["id"] as? String, !id.isEmpty,
              shortcut.type == type(owner: owner, id: id) else { return false }
        pending = (owner, id)
        return true
    }

    @objc func clearShortcuts(_ call: CAPPluginCall) {
        guard let owner = owner(call) else { call.resolve(); return }
        DispatchQueue.main.async {
            if let shortcuts = UIApplication.shared.shortcutItems {
                UIApplication.shared.shortcutItems = shortcuts.filter { $0.userInfo?["owner"] as? String != owner }
            }
            if Self.pending?.owner == owner { Self.pending = nil }
            call.resolve()
        }
    }

    @objc func takePlaylist(_ call: CAPPluginCall) {
        guard let owner = owner(call) else { call.resolve(); return }
        DispatchQueue.main.async {
            if let shortcuts = UIApplication.shared.shortcutItems,
               shortcuts.contains(where: { $0.userInfo?["owner"] as? String != owner }) {
                UIApplication.shared.shortcutItems = shortcuts.filter { $0.userInfo?["owner"] as? String == owner }
            }
            let request = Self.pending
            Self.pending = nil
            if let request, request.owner == owner { call.resolve(["id": request.id]) }
            else { call.resolve() }
        }
    }
}
