import UIKit
import UniformTypeIdentifiers

final class ShareSongViewController: UIViewController {
    private let message = UILabel()
    private let action = UIButton(type: .system)
    private var song: String?
    private func text(_ en: String, _ ja: String) -> String {
        Locale.preferredLanguages.first?.hasPrefix("ja") == true ? ja : en
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        message.font = .preferredFont(forTextStyle: .body)
        message.numberOfLines = 0
        message.text = text("Reading song link…", "曲のリンクを読み込み中…")
        action.setTitle(text("Save to Search", "検索に保存"), for: .normal)
        action.isEnabled = false
        action.addTarget(self, action: #selector(save), for: .touchUpInside)
        let cancel = UIButton(type: .system)
        cancel.setTitle(text("Close", "閉じる"), for: .normal)
        cancel.addTarget(self, action: #selector(close), for: .touchUpInside)
        let stack = UIStackView(arrangedSubviews: [message, action, cancel])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor)])
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
        read(providers[...])
    }

    private func read(_ providers: ArraySlice<NSItemProvider>) {
        guard let provider = providers.first else {
            message.text = text("Share a song link from Apple Music, Spotify, Deezer, YouTube or song.link.",
                                "Apple Music、Spotify、Deezer、YouTube、song.linkの曲リンクを共有してください。")
            return
        }
        let url = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier)
        let type = url ? UTType.url.identifier : UTType.plainText.identifier
        guard provider.hasItemConformingToTypeIdentifier(type) else { read(providers.dropFirst()); return }
        provider.loadItem(forTypeIdentifier: type, options: nil) { [weak self] item, _ in
            let value = (item as? URL)?.absoluteString ?? (item as? String) ?? ""
            DispatchQueue.main.async {
                guard let self else { return }
                guard let address = SharedSongInbox.address(in: value) else { self.read(providers.dropFirst()); return }
                self.song = address
                self.message.text = self.text("Open OtoHari after saving to find this song on DroppedNeedle.",
                                              "保存した後、OtoHariを開くとDroppedNeedleでこの曲を検索できます。")
                self.action.isEnabled = true
            }
        }
    }

    @objc private func save() {
        guard let song else { return }
        do { try SharedSongInbox.save(song, to: SharedSongInbox.location()); close() }
        catch { message.text = text("Could not save this link. Try again.", "リンクを保存できませんでした。もう一度お試しください。") }
    }
    @objc private func close() {
        extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
