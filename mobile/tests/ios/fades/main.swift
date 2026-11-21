import Foundation

let independent = TrackFades(500, 0, smart: false)
precondition(independent.gain(position: 0.25, duration: 10, keepIntro: false, keepTail: false) == 0.5)
precondition(independent.gain(position: 9.9, duration: 10, keepIntro: false, keepTail: false) == 1)
let fadeOut = TrackFades(0, 2000, smart: false)
precondition(fadeOut.gain(position: 0, duration: 10, keepIntro: false, keepTail: false) == 1)
precondition(fadeOut.gain(position: 9, duration: 10, keepIntro: false, keepTail: false) == 0.5)
precondition(fadeOut.gain(position: 9, duration: 10, keepIntro: false, keepTail: true) == 1)
func quiet(_ bins: Int) -> [Double] { Array(repeating: 0.015, count: bins) + [0.25] }
precondition(TrackFades.overlap(tail: quiet(14), head: quiet(10), outgoing: 6, incoming: 6) == 2.4)
precondition(TrackFades.overlap(tail: quiet(0), head: quiet(2), outgoing: 40, incoming: 40) == 0)
precondition(TrackFades.overlap(tail: quiet(60), head: quiet(80), outgoing: 5, incoming: 10) == 2.5)
precondition(TrackFades.overlap(tail: quiet(80), head: quiet(80), outgoing: 20, incoming: 20) == 8)
func pulse(_ every: Int, _ phase: Int) -> [Double] {
    (0..<60).map { $0 % every == phase ? 0.4 : 0.12 }
}
let tail = Array(pulse(5, 1).reversed())
precondition(TrackFades.overlap(tail: tail, head: pulse(5, 2), outgoing: 6, incoming: 6) == 2.1)
precondition(TrackFades.overlap(tail: tail, head: pulse(7, 2), outgoing: 6, incoming: 6) == 0)
let a: [String: Any] = ["albumId": "album", "trackNumber": 8]
precondition(TrackFades.albumSequence(a, ["albumId": "album", "trackNumber": 9]))
precondition(TrackFades.albumSequence(a, ["albumId": "album", "discNumber": 2, "trackNumber": 1]))
precondition(!TrackFades.albumSequence(a, ["albumId": "other", "trackNumber": 9]))
print("Independent fades, measured overlap bounds and ordered albums passed.")
