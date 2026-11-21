import Foundation

struct TrackFades {
    let fadeInMs: Int
    let fadeOutMs: Int
    let smart: Bool

    init(_ input: Int, _ output: Int, smart: Bool) {
        let durations = [0, 500, 2000, 4000, 8000]
        self.fadeInMs = durations.contains(input) ? input : 0
        self.fadeOutMs = durations.contains(output) ? output : 0
        self.smart = smart
    }
    func gain(position: Double, duration: Double, keepIntro: Bool, keepTail: Bool) -> Float {
        let input = keepIntro ? 0 : Double(fadeInMs) / 1000
        let output = keepTail ? 0 : Double(fadeOutMs) / 1000
        let scale = duration > 0 && input + output > duration ? duration / (input + output) : 1
        return Float(max(0, min(1, input > 0 ? position / (input * scale) : 1,
                                output > 0 && duration > 0 ? (duration - position) / (output * scale) : 1)))
    }
    private static func quiet(_ bins: [Double]) -> Double {
        let count = bins.prefix(while: { $0 <= 0.063 }).count
        return count >= 2 ? Double(count) / 10 : 0
    }
    private static func pulses(_ bins: [Double]) -> (hits: [Int], period: Double)? {
        var hits = [Int]()
        for i in bins.indices.dropFirst() {
            let level = bins[i], previous = bins[i - 1]
            if level >= 0.09, level - previous >= 0.035, level >= 1.45 * previous,
               hits.last.map({ i - $0 >= 3 }) ?? true { hits.append(i) }
        }
        guard hits.count >= 5, let first = hits.first, let last = hits.last else { return nil }
        let period = Double(last - first) / Double(hits.count - 1)
        guard (3...10).contains(period),
              zip(hits.dropFirst(), hits).allSatisfy({ abs(Double($0.0 - $0.1) - period) <= 1 }) else { return nil }
        return (hits, period)
    }
    static func overlap(tail: [Double], head: [Double], outgoing: Double, incoming: Double) -> Double {
        let cap = min(8, outgoing / 2, incoming / 2)
        let quietTime = min(cap, quiet(tail) + quiet(head))
        if quietTime >= 0.4 { return quietTime }
        guard let a = pulses(Array(tail.reversed())), let b = pulses(head),
              abs(a.period - b.period) <= 0.1 * min(a.period, b.period) else { return 0 }
        for count in (2...4).reversed() {
            let seconds = Double(tail.count - a.hits[a.hits.count - count] + b.hits[0]) / 10
            if seconds >= 0.4 && seconds <= cap { return seconds }
        }
        return 0
    }
    static func albumSequence(_ a: [String: Any], _ b: [String: Any]) -> Bool {
        func artist(_ track: [String: Any]) -> String {
            if let albumArtist = track["albumArtist"] as? String, !albumArtist.isEmpty { return albumArtist }
            return track["artist"] as? String ?? ""
        }
        let same: Bool
        if let first = a["albumId"] as? String, !first.isEmpty, let second = b["albumId"] as? String, !second.isEmpty {
            same = first == second
        } else {
            let album = a["album"] as? String ?? ""
            same = !album.isEmpty && album.lowercased() == (b["album"] as? String)?.lowercased() && !artist(a).isEmpty && artist(a).lowercased() == artist(b).lowercased()
        }
        guard same, let t = a["trackNumber"] as? Int, t > 0, let n = b["trackNumber"] as? Int, n > 0 else { return false }
        let disc = a["discNumber"] as? Int ?? 1, next = b["discNumber"] as? Int ?? 1
        return (disc == next && t < Int.max && n == t + 1) || (disc < Int.max && next == disc + 1 && n == 1)
    }
}
