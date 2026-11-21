import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class ReadReply: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        precondition(url.host == "fixture.invalid")
        let status = url.lastPathComponent == "ignored-range" ? 200 : 206
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil,
                                       headerFields: ["Content-Type": "audio/flac"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if url.lastPathComponent == "overflow" {
            let chunk = Data(repeating: 0, count: DNReadKind.preview.limit / 2)
            client?.urlProtocol(self, didLoad: chunk)
            client?.urlProtocol(self, didLoad: chunk)
            client?.urlProtocol(self, didLoad: Data([1]))
        } else {
            client?.urlProtocol(self, didLoad: Data([0, 1]))
            client?.urlProtocol(self, didLoad: Data([2, 3]))
        }
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

func preview(_ name: String) -> DNReadTransfer.Reply? {
    let done = DispatchSemaphore(value: 0)
    var reply: DNReadTransfer.Reply?
    let transfer = DNReadTransfer(kind: .preview) { result in
        reply = result
        done.signal()
    }
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [ReadReply.self]
    let session = URLSession(configuration: config, delegate: transfer, delegateQueue: nil)
    session.dataTask(with: URL(string: "https://fixture.invalid/" + name)!).resume()
    session.finishTasksAndInvalidate()
    precondition(done.wait(timeout: .now() + 5) == .success)
    return reply
}

precondition(preview("ignored-range") == nil, "A full response cannot supply a range preview")
precondition(preview("overflow") == nil, "Chunked audio exceeded the preview budget")
let accepted = preview("bounded")
precondition(accepted?.0 == 206 && accepted?.1 == "audio/flac" && accepted?.2 == Data([0, 1, 2, 3]).base64EncodedString())
print("Bounded iPhone reads reject incorrect preview responses and chunked overflow, and preserve valid audio bytes.")
