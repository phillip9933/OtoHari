import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Called on the player’s main queue. Keep measurements only for items AVQueuePlayer has prepared.
final class PlayerLoudness {
    private var values: [String: [String: Double]] = [:]
    private var loads: [String: (UUID, PlayerJSONLoad)] = [:]

    private let configuration: URLSessionConfiguration
    init(configuration: URLSessionConfiguration = .ephemeral) { self.configuration = configuration }

    static func request(server: String, token: String, id: String) -> URLRequest? {
        guard let base = URL(string: server), base.scheme == "https", base.host != nil,
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              !token.isEmpty, OfflineFiles.validTrackID(id) else { return nil }
        let url = base.appendingPathComponent("api/v3/library/tracks").appendingPathComponent(id).appendingPathComponent("loudness")
        var request = URLRequest(url: url)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private enum Field: String, CaseIterable, CodingKey {
        case trackGain = "track_gain_db", albumGain = "album_gain_db", trackPeak = "track_peak", albumPeak = "album_peak"
        var playerKey: String {
            switch self {
            case .trackGain: return "replayGainTrackDb"
            case .albumGain: return "replayGainAlbumDb"
            case .trackPeak: return "replayGainTrackPeak"
            case .albumPeak: return "replayGainAlbumPeak"
            }
        }
    }
    private struct Response: Decodable {
        let tags: [String: Double]
        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: Field.self)
            var result: [String: Double] = [:]
            for field in Field.allCases {
                guard let number = try? fields.decode(Double.self, forKey: field), number.isFinite else { continue }
                if (field == .trackPeak || field == .albumPeak) && number <= 0 { continue }
                result[field.playerKey] = number
            }
            tags = result
        }
    }
    static func tags(_ data: Data) -> [String: Double] {
        (try? JSONDecoder().decode(Response.self, from: data))?.tags ?? [:]
    }

    func metadata(id: String, inline: [String: Any]) -> [String: Any] {
        guard let tags = values[id], !tags.isEmpty else { return inline }
        var merged = inline
        for (key, value) in tags { merged[key] = value }
        return merged
    }

    func update(ids: Set<String>, server: String, token: String, online: Bool, changed: @escaping () -> Void) {
        for id in Array(loads.keys) where !online || !ids.contains(id) { loads.removeValue(forKey: id)?.1.cancel() }
        values = values.filter { ids.contains($0.key) && (online || !$0.value.isEmpty) }
        guard online else { return }
        for id in ids where values[id] == nil && loads[id] == nil {
            guard let request = Self.request(server: server, token: token, id: id) else { continue }
            let nonce = UUID()
            let load = PlayerJSONLoad(limit: 4096) { [weak self] result in
                let measured = (try? result.get()).map(Self.tags) ?? [:]
                DispatchQueue.main.async {
                    guard let self, self.loads[id]?.0 == nonce else { return }
                    self.loads.removeValue(forKey: id)
                    self.values[id] = measured
                    if !measured.isEmpty { changed() }
                }
            }
            loads[id] = (nonce, load)
            load.start(request, configuration: configuration)
        }
    }

    func clear() {
        for (_, load) in loads.values { load.cancel() }
        loads.removeAll(); values.removeAll()
    }
}
