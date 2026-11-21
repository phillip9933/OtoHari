import AVFoundation
import AVKit
import Capacitor
import UIKit

private final class OutputPicker: UIViewController, AVRoutePickerViewDelegate {
    override func viewDidLoad() {
        super.viewDidLoad()
        title = "AirPlay"
        view.backgroundColor = .systemBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .done, target: self, action: #selector(close))
        let label = UILabel()
        label.font = .preferredFont(forTextStyle: .body)
        label.adjustsFontForContentSizeCategory = true
        label.numberOfLines = 0
        label.textAlignment = .center
        label.text = AVAudioSession.sharedInstance().currentRoute.outputs.map(\.portName).joined(separator: ", ")
        let picker = AVRoutePickerView()
        picker.delegate = self
        picker.prioritizesVideoDevices = false
        picker.activeTintColor = .systemBlue
        let stack = UIStackView(arrangedSubviews: [label, picker])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 12
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
            picker.widthAnchor.constraint(equalToConstant: 64),
            picker.heightAnchor.constraint(equalToConstant: 64)
        ])
    }
    func routePickerViewDidEndPresentingRoutes(_ routePickerView: AVRoutePickerView) { close() }
    @objc private func close() { dismiss(animated: true) }
}

@objc(DNOutputsPlugin)
public final class DNOutputsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DNOutputsPlugin"
    public let jsName = "DNOutputs"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "choose", returnType: CAPPluginReturnPromise)]

    @objc func choose(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            guard let vc = self?.bridge?.viewController, vc.presentedViewController == nil else {
                call.reject("Close the current sheet to choose an audio output.")
                return
            }
            let nav = UINavigationController(rootViewController: OutputPicker())
            nav.modalPresentationStyle = .pageSheet
            nav.sheetPresentationController?.detents = [.medium()]
            vc.present(nav, animated: true) { call.resolve() }
        }
    }
}
