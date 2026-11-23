import AVFoundation
import CryptoKit
import Foundation

/// Profiles are local to the phone. AVAudioSession's port UID distinguishes two Bluetooth headsets.
final class PlayerSound {
    private static let centers = [31000, 62000, 125000, 250000, 500000, 1000000, 2000000, 4000000, 8000000, 16000000]
    private static let flat = Array(repeating: 0, count: centers.count)
    private let defaults = UserDefaults.standard
    private var route: AVAudioSessionPortDescription? { AVAudioSession.sharedInstance().currentRoute.outputs.first }
    private func key(_ port: AVAudioSessionPortDescription) -> String {
        SHA256.hash(data: Data(port.uid.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private struct Equalizer {
        var enabled: Bool
        var levels: [Int]
        var preset: String
        var dictionary: [String: Any] { ["enabled": enabled, "levels": levels, "preset": preset] }
    }
    private func equalizer(_ port: AVAudioSessionPortDescription?) -> Equalizer {
        let change = port.flatMap { defaults.dictionary(forKey: "dn.eq.route." + key($0)) }
            ?? defaults.dictionary(forKey: "dn.eq.global")
        let levels = change?["levels"] as? [Int] ?? []
        return Equalizer(enabled: change?["enabled"] as? Bool == true, levels: levels.count == Self.centers.count ? levels : Self.flat,
                         preset: change?["preset"] as? String ?? "Flat")
    }
    static let speeds = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
    var speed: Float {
        let value = defaults.double(forKey: "dn.playback.speed")
        return Float(Self.speeds.contains(value) ? value : 1)
    }
    var replayGain: String { defaults.string(forKey: "dn.playback.replayGain") ?? "off" }
    func configure(speed: Double?, mode: String?) throws {
        guard speed.map(Self.speeds.contains) ?? true,
              mode.map({ ["off", "album", "track"].contains($0) }) ?? true else { throw OfflineFiles.Failure("Choose a supported playback setting.") }
        if let speed { defaults.set(speed, forKey: "dn.playback.speed") }
        if let mode { defaults.set(mode, forKey: "dn.playback.replayGain") }
    }
    var settings: [String: Any] { ["speed": Double(speed), "replayGain": replayGain] }
    var external: Bool { route?.portType == .airPlay }
    var eqState: [String: Any] {
        if external { return ["available": false, "reason": "The AirPlay receiver controls this output."] }
        let port = route
        var result = equalizer(port).dictionary
        result["centers"] = Self.centers; result["available"] = true; result["minimum"] = -1200; result["maximum"] = 1200
        if let port {
            let id = key(port)
            result["output"] = ["id": id, "name": port.portName, "assigned": defaults.object(forKey: "dn.eq.route." + id) != nil] as [String: Any]
        }
        return result
    }
    func assign(id: String, assigned: Bool) throws {
        guard !external, let port = route, id == key(port) else { throw OfflineFiles.Failure("The audio output changed. Select the current output.") }
        let path = "dn.eq.route." + id
        if !assigned { defaults.removeObject(forKey: path) }
        else if defaults.object(forKey: path) == nil { defaults.set(equalizer(nil).dictionary, forKey: path) }
    }
    func configureEqualizer(id: String?, enabled: Bool, centers: [Int]?, levels: [Int]?, preset: String) throws {
        guard !external, centers == Self.centers, let levels, levels.count == Self.centers.count,
              levels.allSatisfy({ (-1200...1200).contains($0) }), preset.count <= 64 else { throw OfflineFiles.Failure("Choose valid equalizer bands.") }
        let port = route
        if let id, id != port.map(key) { throw OfflineFiles.Failure("The audio output changed. Select the current output.") }
        let path = port.map { "dn.eq.route." + key($0) }
        let profile = Equalizer(enabled: enabled, levels: levels, preset: preset)
        defaults.set(profile.dictionary, forKey: path.flatMap { defaults.object(forKey: $0) != nil ? $0 : nil } ?? "dn.eq.global")
    }
    func output() -> [String: Any] {
        let session = AVAudioSession.sharedInstance()
        var out: [String: Any] = settings
        guard let port = route else { return out }
        out["destination"] = port.portName
        out["remote"] = external
        if !external && session.sampleRate > 0 { out["outputRate"] = Int(session.sampleRate.rounded()) }
        switch port.portType {
        case .builtInSpeaker: out["route"] = "speaker"
        case .builtInReceiver: out["route"] = "earpiece"
        case .headphones, .lineOut: out["route"] = "wired"
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE: out["route"] = "bluetooth"
        case .usbAudio: out["route"] = "usb"
        case .HDMI: out["route"] = "hdmi"
        default: break
        }
        return out
    }
    private func gain(_ metadata: [String: Any]) -> Double {
        guard replayGain != "off" else { return 1 }
        func tag(_ key: String) -> Double? {
            guard let n = metadata[key] as? Double, n.isFinite else { return nil }
            return n
        }
        let album = replayGain == "album" && tag("replayGainAlbumDb") != nil
        guard let db = tag(album ? "replayGainAlbumDb" : "replayGainTrackDb") else { return 1 }
        let factor = pow(10, min(60, max(-60, db)) / 20)
        let peak = tag(album ? "replayGainAlbumPeak" : "replayGainTrackPeak") ?? tag(album ? "replayGainTrackPeak" : "replayGainAlbumPeak")
        return peak.map { $0 > 0 ? min(factor, 1 / $0) : factor } ?? factor
    }
    private static let metadataKeys = ["REPLAYGAIN_ALBUM_GAIN": "replayGainAlbumDb", "REPLAYGAIN_TRACK_GAIN": "replayGainTrackDb",
                                       "REPLAYGAIN_ALBUM_PEAK": "replayGainAlbumPeak", "REPLAYGAIN_TRACK_PEAK": "replayGainTrackPeak"]
    private static func gainKey(_ raw: String?) -> String? {
        guard let name = raw?.uppercased() else { return nil }
        return metadataKeys.first { name == $0.key || name.hasSuffix("/" + $0.key) || name.hasSuffix(":" + $0.key) }?.value
    }
    /// AVFoundation can expose a Vorbis comment or an ID3 TXXX / freeform iTunes field.
    /// Read only scalar gain fields and skip attached images and other binary metadata.
    private static func embeddedGain(_ asset: AVAsset, missingFrom tags: [String: Any]) async -> [String: Any] {
        var result = tags
        guard let items = try? await asset.load(.metadata) else { return result }
        for item in items {
            let name = item.key as? String, identifier = item.identifier?.rawValue
            var field = gainKey(name) ?? gainKey(identifier)
            var raw: String?
            if field == nil {
                let kind = [name, identifier].compactMap { $0?.uppercased() }
                guard kind.contains(where: { $0 == "TXXX" || $0.hasSuffix("/TXXX") || $0.contains("----") }) else { continue }
                if let fields = (try? await item.load(.value)) as? [String: Any] {
                    field = gainKey(fields["description"] as? String) ?? gainKey(fields["info"] as? String) ?? gainKey(fields["name"] as? String)
                    raw = fields["value"] as? String ?? fields["text"] as? String ?? (fields["values"] as? [String])?.first
                }
                if field == nil, let extra = try? await item.load(.extraAttributes) {
                    field = extra.values.compactMap { gainKey($0 as? String) }.first
                }
            }
            guard let field, result[field] as? Double == nil else { continue }
            if raw == nil { raw = try? await item.load(.stringValue) }
            guard var value = raw?.trimmingCharacters(in: .whitespacesAndNewlines) else { continue }
            if value.lowercased().hasSuffix("db") { value = String(value.dropLast(2)).trimmingCharacters(in: .whitespaces) }
            if let number = Double(value), number.isFinite { result[field] = number }
        }
        return result
    }
    private var revision = UUID()
    func invalidate() { revision = UUID() }

    func apply(to item: AVPlayerItem, metadata: [String: Any]) {
        let eq = equalizer(route), mode = replayGain
        let prefix = mode == "album" ? "replayGainAlbum" : "replayGainTrack"
        let lookup = mode != "off" && (metadata[prefix + "Db"] as? Double == nil || metadata[prefix + "Peak"] as? Double == nil)
        guard !external && (eq.enabled || lookup || gain(metadata) != 1) else { item.audioMix = nil; return }
        let levels = (eq.enabled ? eq.levels : Self.flat).map { NSNumber(value: $0) }
        let revision = self.revision
        Task { @MainActor [weak item, weak self] in
            guard let asset = item?.asset,
                  let tracks = try? await asset.loadTracks(withMediaType: .audio),
                  let track = tracks.first, let item, let self, self.revision == revision else { return }
            let initial = self.gain(metadata)
            item.audioMix = (eq.enabled || initial != 1) ? DNProcessingMix(track, levels, initial) : nil
            guard lookup else { return }
            let tags = await Self.embeddedGain(asset, missingFrom: metadata)
            guard self.revision == revision else { return }
            let amplitude = self.gain(tags)
            if amplitude != initial {
                item.audioMix = (eq.enabled || amplitude != 1) ? DNProcessingMix(track, levels, amplitude) : nil
            }
        }
    }
    var eqEnabled: Bool { equalizer(route).enabled }
}
