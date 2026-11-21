import AVFoundation
import Foundation
import Network

enum PlaybackNetwork: String {
    case wifi, cellular, offline, unknown

    init(_ path: NWPath) {
        if path.status == .unsatisfied { self = .offline }
        else if path.status != .satisfied { self = .unknown }
        else if path.usesInterfaceType(.cellular) { self = .cellular }
        else if path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet) { self = .wifi }
        else { self = .unknown }
    }
}

struct StreamProfile: Equatable {
    let format: String
    let rate: Int

    init(_ value: Any? = nil) {
        let object = value as? [String: Any]
        if let f = object?["format"] as? String, ["original", "mp3", "opus"].contains(f),
           let r = object?["rate"] as? Int, [64, 96, 128, 160, 192, 256, 320].contains(r) {
            format = f
            rate = r
        } else {
            format = "original"
            rate = 192
        }
    }

    static func canonical(_ url: URL) -> URL {
        guard var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        let query = parts.queryItems?.filter { !["format", "max_bitrate", "start_seconds", "estimate_content_length"].contains($0.name) }
        parts.queryItems = query?.isEmpty == false ? query : nil
        return parts.url ?? url
    }

    var requestedFormat: String {
        format == "opus" && !AVURLAsset.isPlayableExtendedMIMEType("audio/ogg; codecs=\"opus\"") ? "mp3" : format
    }
    func convertedURL(_ url: URL) -> URL? {
        guard format != "original", var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "format", value: requestedFormat),
                                                      URLQueryItem(name: "max_bitrate", value: String(rate))]
        return parts.url
    }
}

struct StreamProfiles {
    var wifi = StreamProfile()
    var cellular = StreamProfile()
    func profile(_ network: PlaybackNetwork) -> StreamProfile { network == .wifi ? wifi : cellular }
}
