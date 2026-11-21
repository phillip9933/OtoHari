// Read the clean simulator's sign-in screen after launching the packaged app.
import Foundation
import Vision

let image = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.recognitionLanguages = ["en-US"]
try VNImageRequestHandler(url: image).perform([request])
let labels = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string.lowercased() }
exit(labels.contains(where: { $0.contains("server address") }) && labels.contains("continue") ? 0 : 1)
