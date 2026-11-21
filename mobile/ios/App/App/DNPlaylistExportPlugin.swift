import Capacitor
import UIKit

@objc(DNPlaylistExportPlugin)
public final class DNPlaylistExportPlugin: CAPPlugin, CAPBridgedPlugin, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    public let identifier = "DNPlaylistExportPlugin", jsName = "DNPlaylistExport"
    public let pluginMethods: [CAPPluginMethod] = ["prepare", "save", "discard", "saveLayout", "saveDiagnostics", "shareDiagnostics"].map { CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise) }

    private final class Save {
        let id: UUID, call: CAPPluginCall
        var picker: UIDocumentPickerViewController?
        init(_ id: UUID, _ call: CAPPluginCall) { self.id = id; self.call = call }
    }
    private let files = PlaylistExports.shared
    private var owned: Set<UUID> = []
    private var saving: Save?

    deinit { for id in owned { files.discard(id) } }

    @objc func prepare(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = UUID(uuidString: call.getString("id") ?? ""), let server = call.getString("serverUrl"),
                  let url = call.getString("url"), let token = call.getString("token"),
                  let format = PlaylistExportFormat(rawValue: call.getString("format") ?? ""),
                  self.owned.insert(id).inserted else {
                call.reject(PlaylistExportError.invalid.localizedDescription, PlaylistExportError.invalid.code)
                return
            }
            self.files.prepare(id, server: server, url: url, token: token, format: format) { [weak self] result in
                DispatchQueue.main.async {
                    switch result {
                    case .success(let headers): call.resolve(headers)
                    case .failure(let error):
                        self?.owned.remove(id)
                        call.reject(error.localizedDescription, error.code)
                    }
                }
            }
        }
    }

    @objc func save(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = UUID(uuidString: call.getString("id") ?? ""), self.owned.contains(id),
                  let name = call.getString("filename") else {
                call.reject(PlaylistExportError.unavailable.localizedDescription, PlaylistExportError.unavailable.code)
                return
            }
            self.chooseFile(id, call: call) { self.files.pickerFile(id, filename: name, done: $0) }
        }
    }

    @objc func saveLayout(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let text = call.getString("text") else {
                call.reject(PlaylistExportError.invalidLayout.localizedDescription, PlaylistExportError.invalidLayout.code)
                return
            }
            let id = UUID()
            self.chooseFile(id, call: call) { self.files.layoutFile(id, text: text, done: $0) }
        }
    }

    private func reviewed(_ call: CAPPluginCall) -> String? {
        guard let text = call.getString("text"), text.utf8.count <= 65536,
              let (_, store) = try? DeviceOffline.shared.account(call.getString("serverUrl"), call.getString("userId")),
              store.reviewed(text) else { call.reject("Review the diagnostic report before exporting it."); return nil }
        return text
    }
    @objc func saveDiagnostics(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let text = self.reviewed(call) else { return }
            let id = UUID()
            self.chooseFile(id, call: call) { self.files.layoutFile(id, text: text, diagnostics: true, done: $0) }
        }
    }
    @objc func shareDiagnostics(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let text = self.reviewed(call) else { return }
            guard let presenter = self.bridge?.viewController, presenter.presentedViewController == nil,
                  presenter.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive else {
                call.reject("Close the current sheet and try again."); return
            }
            let activity = UIActivityViewController(activityItems: [text], applicationActivities: nil)
            activity.popoverPresentationController?.sourceView = presenter.view
            activity.popoverPresentationController?.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
            activity.completionWithItemsHandler = { _, _, _, error in
                if error != nil { call.reject("The report could not be shared.") } else { call.resolve() }
            }
            presenter.present(activity, animated: true)
        }
    }
    private func chooseFile(_ id: UUID, call: CAPPluginCall, stage: (@escaping PlaylistExports.Completion<URL>) -> Void) {
        guard saving == nil else { call.reject("Finish the current Files picker first."); return }
        owned.insert(id)
        let save = Save(id, call)
        saving = save
        stage { [weak self] result in
            DispatchQueue.main.async {
                guard let self, self.saving === save else { return }
                switch result {
                case .failure(let error): self.finish(save, .failed(error))
                case .success(let file):
                    guard let presenter = self.bridge?.viewController,
                          presenter.viewIfLoaded?.window?.windowScene?.activationState == .foregroundActive,
                          presenter.presentedViewController == nil, !presenter.isBeingDismissed else {
                        self.finish(save, .failed(.picker))
                        return
                    }
                    let picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
                    picker.delegate = self
                    save.picker = picker
                    presenter.present(picker, animated: true)
                    picker.presentationController?.delegate = self
                }
            }
        }
    }

    @objc func discard(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = UUID(uuidString: call.getString("id") ?? ""), self.owned.remove(id) != nil else {
                call.resolve(); return
            }
            if let save = self.saving, save.id == id {
                let picker = save.picker
                self.finish(save, .failed(.cancelled)) { call.resolve() }
                picker?.dismiss(animated: false)
                return
            }
            self.files.discard(id) { call.resolve() }
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        guard let save = saving, save.picker === controller else { return }
        finish(save, .selected(urls.first))
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        guard let save = saving, save.picker === controller else { return }
        finish(save, .cancelled)
    }
    public func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard let save = saving, save.picker === presentationController.presentedViewController else { return }
        finish(save, .cancelled)
    }
    private func finish(_ save: Save, _ outcome: FilePickerOutcome, after: (() -> Void)? = nil) {
        guard saving === save else { return }
        saving = nil
        save.picker = nil
        owned.remove(save.id)
        files.finishPicker(save.id, outcome) { result in
            DispatchQueue.main.async {
                switch result {
                case .success(let saved): save.call.resolve(["saved": saved])
                case .failure(let error): save.call.reject(error.localizedDescription, error.code)
                }
                after?()
            }
        }
    }
}
