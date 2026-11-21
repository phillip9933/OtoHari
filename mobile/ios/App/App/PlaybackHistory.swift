import Foundation

/// An occurrence is one AVPlayerItem. Repeat-one and identical adjacent songs
/// have distinct occurrences. Clock time advances only while audio is playing.
struct PlaybackHistory {
    struct OfflineStart: Sendable {
        let account: String, revision: Int64, timestamp: Int64
        let title: String, artist: String, album: String
    }
    enum Route: Sendable { case live, offline(OfflineStart), silent }
    struct Event {
        let occurrence: UUID, route: Route
        let operation: String, trackID: String, position: Int64, duration: Int64
        var paused: Bool?, ignoreScrobble: Bool?
        func body(device: String) -> [String: Any] {
            var body: [String: Any] = ["device": device, "source": "local", "track_id": trackID, "position_ms": position]
            if duration > 0 { body["duration_ms"] = duration }
            if let paused { body["is_paused"] = paused }
            if let ignoreScrobble { body["ignore_scrobble"] = ignoreScrobble }
            return body
        }
    }
    private struct Listen {
        let occurrence: UUID, id: String
        let route: Route
        var position: Int64, length: Int64, heard: Int64 = 0, since: Int64?
        mutating func sample(_ now: Int64) {
            if let since { heard += max(0, now - since) }
            since = nil
        }
        func event(_ operation: String) -> Event {
            Event(occurrence: occurrence, route: route, operation: operation, trackID: id, position: position, duration: length)
        }
    }
    private var active: Listen?, finished: UUID?
    var occurrence: UUID? { active?.occurrence }
    mutating func observe(_ occurrence: UUID, id: String, position: Int64, length: Int64,
                          playing: Bool, now: Int64, heartbeat: Bool = false, route: @autoclosure () -> Route = .live) -> [Event] {
        var events = [Event]()
        if let previous = active, previous.occurrence != occurrence {
            events += finish(previous.occurrence, position: previous.position, length: previous.length, now: now)
        }
        if var listen = active {
            let wasPlaying = listen.since != nil
            listen.sample(now)
            listen.position = max(0, position)
            if length > 0 { listen.length = length }
            if playing { listen.since = now }
            active = listen
            if case .live = listen.route, wasPlaying != playing || heartbeat {
                var event = listen.event("progress"); event.paused = !playing; events.append(event)
            }
        } else if playing && occurrence != finished {
            let listen = Listen(occurrence: occurrence, id: id, route: route(), position: max(0, position), length: max(0, length), since: now)
            active = listen
            if case .live = listen.route { events.append(listen.event("start")) }
        }
        return events
    }
    mutating func finish(_ occurrence: UUID, position: Int64?, length: Int64?, now: Int64) -> [Event] {
        guard var listen = active, listen.occurrence == occurrence else { return [] }
        listen.sample(now)
        if let position { listen.position = max(0, position) }
        if let length, length > 0 { listen.length = length }
        // DN gates native stop on position (>90% or within 1s). Make large seeks
        // ineligible when the actual audible interval does not reach that gate.
        let heard = listen.heard, duration = listen.length
        let listened = duration > 0 && heard > 0 && (Double(heard) > Double(duration) * 0.9 || heard >= max(duration / 2, duration - 1000))
        active = nil; finished = occurrence
        switch listen.route {
        case .live:
            var stop = listen.event("stop"); stop.ignoreScrobble = !listened
            return [stop]
        case .offline:
            let reachedEnd = Double(listen.position) > Double(duration) * 0.9 || listen.position >= duration - 1000
            return listened && reachedEnd ? [listen.event("submit")] : []
        case .silent: return []
        }
    }
}
