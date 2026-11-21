import AVFoundation
import Foundation
import UniformTypeIdentifiers

/// DN can return a chunked conversion without an exact length or seekable ranges.
/// Stage it once so AVFoundation gets the actual byte count and independent seek cursors.
final class ConvertedTrack: NSObject, URLSessionDataDelegate {
    private static let limit: Int64 = 96 * 1024 * 1024
    private static let directory: URL? = {
        let manager = FileManager.default
        let path = manager.temporaryDirectory.appendingPathComponent("dn-converted-playback", isDirectory: true)
        do {
            if manager.fileExists(atPath: path.path) { try manager.removeItem(at: path) }
            try manager.createDirectory(at: path, withIntermediateDirectories: true,
                                        attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            return path
        } catch { return nil }
    }()
    static func cleanPreviousSession() { _ = directory }

    private enum Mode { case waiting, downloading, ready, direct(URL), failed, closed }
    private let worker = DispatchQueue(label: "app.droppedneedle.converted-audio")
    private let original: URL
    private let request: URLRequest
    private let received: (String?, String) -> Void
    private let onDirect: (URL, AVAssetResourceLoadingRequest) -> Void
    private let capture: OfflinePlaybackCapture?
    private let onError: (String) -> Void
    private var session: URLSession!
    private var mode = Mode.waiting
    private var file: URL?
    private var handle: FileHandle?
    private var size: Int64 = 0
    private var type = ""
    private var pending: [ObjectIdentifier: AVAssetResourceLoadingRequest] = [:]

    init(original: URL, converted: URL, token: String, capture: OfflinePlaybackCapture?, received: @escaping (String?, String) -> Void, direct: @escaping (URL, AVAssetResourceLoadingRequest) -> Void,
         error: @escaping (String) -> Void) {
        self.capture = capture
        self.received = received
        self.original = original
        var request = URLRequest(url: converted)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        self.request = request
        onDirect = direct
        onError = error
        super.init()
        let delegate = OperationQueue()
        delegate.maxConcurrentOperationCount = 1
        delegate.underlyingQueue = worker
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        session = URLSession(configuration: config, delegate: self, delegateQueue: delegate)
    }

    func request(_ loading: AVAssetResourceLoadingRequest) {
        worker.async {
            guard !loading.isCancelled else { return }
            switch self.mode {
            case .waiting:
                self.pending[ObjectIdentifier(loading)] = loading
                self.mode = .downloading
                self.session.dataTask(with: self.request).resume()
            case .downloading: self.pending[ObjectIdentifier(loading)] = loading
            case .ready: self.serve(loading)
            case let .direct(url): self.redirect(loading, to: url)
            case .failed: loading.finishLoading(with: URLError(.cannotDecodeContentData))
            case .closed: break
            }
        }
    }
    func cancel(_ loading: AVAssetResourceLoadingRequest) {
        worker.async { self.pending.removeValue(forKey: ObjectIdentifier(loading)) }
    }
    func close() {
        session.invalidateAndCancel()
        worker.async {
            self.mode = .closed
            self.pending.removeAll()
            self.removeFile()
        }
    }
    private func removeFile() {
        try? handle?.close()
        handle = nil
        if let file { try? FileManager.default.removeItem(at: file); self.file = nil }
    }
    private func drain(_ action: (AVAssetResourceLoadingRequest) -> Void) {
        let all = Array(pending.values)
        pending.removeAll()
        for loading in all where !loading.isCancelled { action(loading) }
    }
    private func fail(_ message: String) {
        mode = .failed
        session.invalidateAndCancel()
        removeFile()
        DispatchQueue.main.async { self.onError(message) }
        drain { $0.finishLoading(with: URLError(.cannotDecodeContentData)) }
    }
    private func redirect(_ loading: AVAssetResourceLoadingRequest, to url: URL) {
        DispatchQueue.main.async { if !loading.isCancelled { self.onDirect(url, loading) } }
    }
    private func useDirect(_ url: URL) {
        mode = .direct(url)
        session.invalidateAndCancel()
        removeFile()
        drain { redirect($0, to: url) }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard case .downloading = mode, let http = response as? HTTPURLResponse else { completionHandler(.cancel); return }
        if http.statusCode == 409 { received(nil, "fallback"); completionHandler(.cancel); useDirect(original); return }
        let mime = http.mimeType?.lowercased() ?? ""
        guard http.statusCode == 200, mime.hasPrefix("audio/") || ["application/ogg", "application/flac", "application/octet-stream"].contains(mime) else {
            completionHandler(.cancel); fail("DroppedNeedle could not return audio for this track."); return
        }
        if http.value(forHTTPHeaderField: "Accept-Ranges")?.lowercased() == "bytes",
           response.expectedContentLength > 0, let url = request.url {
            // DN can serve a compatible original directly even when a conversion was requested.
            received(mime, "original"); completionHandler(.cancel); useDirect(url); return
        }
        guard response.expectedContentLength <= Self.limit else { completionHandler(.cancel); tooLarge(); return }
        guard let dir = Self.directory else { completionHandler(.cancel); fail("Device storage is unavailable for converted audio."); return }
        let output = dir.appendingPathComponent(UUID().uuidString)
        guard FileManager.default.createFile(atPath: output.path, contents: nil,
                                             attributes: [.posixPermissions: 0o600, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else {
            completionHandler(.cancel); fail("Device storage is unavailable for converted audio."); return
        }
        file = output
        do { handle = try FileHandle(forWritingTo: output) }
        catch { completionHandler(.cancel); fail("Device storage is unavailable for converted audio."); return }
        received(mime, "converted")
        type = UTType(mimeType: mime)?.identifier ?? UTType.audio.identifier
        completionHandler(.allow)
    }
    private func tooLarge() {
        fail("This conversion exceeds the 96 MiB playback buffer. Choose Original for this network to stream this track.")
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard case .downloading = mode, let handle else { return }
        guard Int64(data.count) <= Self.limit - size else { tooLarge(); return }
        do { try handle.write(contentsOf: data); size += Int64(data.count) }
        catch { fail("Device storage is unavailable for converted audio.") }
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard case .downloading = mode else { return }
        guard error == nil, let file, size > 0, let http = task.response as? HTTPURLResponse,
              let range = PlaybackByteRange(status: http.statusCode, header: nil, bytes: http.expectedContentLength,
                                            coding: http.value(forHTTPHeaderField: "Content-Encoding"), offset: 0),
              range.end == nil || range.end == size else {
            fail("The converted track could not be downloaded in full."); return
        }
        do { try handle?.close(); handle = nil }
        catch { fail("The converted track could not be read."); return }
        capture?.converted(file, bytes: size, type: type)
        mode = .ready
        session.finishTasksAndInvalidate()
        drain(serve)
    }
    private func serve(_ loading: AVAssetResourceLoadingRequest) {
        guard let file, !loading.isCancelled else { return }
        if let content = loading.contentInformationRequest {
            content.contentType = type
            content.contentLength = size
            content.isByteRangeAccessSupported = true
        }
        do {
            if let data = loading.dataRequest {
                let start = max(data.requestedOffset, data.currentOffset)
                guard start >= 0, start <= size, data.requestedOffset >= 0 else { throw URLError(.badServerResponse) }
                let (to, overflow) = data.requestedOffset.addingReportingOverflow(Int64(data.requestedLength))
                var remaining = (data.requestsAllDataToEndOfResource || overflow ? size : min(size, to)) - start
                let input = try FileHandle(forReadingFrom: file)
                defer { try? input.close() }
                try input.seek(toOffset: UInt64(start))
                while remaining > 0 && !loading.isCancelled {
                    guard let bytes = try input.read(upToCount: Int(min(remaining, 64 * 1024))), !bytes.isEmpty else { throw URLError(.cannotDecodeContentData) }
                    data.respond(with: bytes)
                    remaining -= Int64(bytes.count)
                }
            }
            if !loading.isCancelled { loading.finishLoading() }
        } catch { if !loading.isCancelled { loading.finishLoading(with: error) } }
    }
}
