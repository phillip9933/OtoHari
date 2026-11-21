import UIKit
import Capacitor

final class PlayerViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(DNPlayerPlugin())
        bridge?.registerPluginInstance(DNOutputsPlugin())
        bridge?.registerPluginInstance(DNOfflinePlugin())
        bridge?.registerPluginInstance(DNPlaylistExportPlugin())
        bridge?.registerPluginInstance(DNLauncherPlugin())
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        if let response = connectionOptions.notificationResponse { DNOfflinePlugin.receive(response) }
        if let shortcut = connectionOptions.shortcutItem { _ = DNLauncherPlugin.receive(shortcut) }
        // Register Capacitor's cold-start URL delivery before showing the bridge view.
        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        if window == nil { window = UIWindow(windowScene: windowScene) }
        if window?.rootViewController == nil { window?.rootViewController = PlayerViewController() }
        window?.makeKeyAndVisible()
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        let handled = DNLauncherPlugin.receive(shortcutItem)
        if handled, let player = window?.rootViewController as? PlayerViewController {
            player.bridge?.triggerWindowJSEvent(eventName: "dn-playlist-shortcut")
        }
        completionHandler(handled)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
