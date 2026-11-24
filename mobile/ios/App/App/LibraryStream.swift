import AVFoundation
import UniformTypeIdentifiers

/// AVFoundation asks for byte ranges while seeking. Stream those bytes from DN
/// through an ephemeral session so credentials never enter a media URL or cookie jar.
final class LibraryStream: NSObject, AVAssetResourceLoaderDelegate, URLSessionDataDelegate {
    private let token: String
    private let url: URL
    private var pending: [Int: AVAssetResourceLoadingRequest] = [:]
    private var tasks: [ObjectIdentifier: URLSessionDataTask] = [:]
    private var session: URLSession?
    private var conversion: ConvertedTrack?
    private let capture: OfflinePlaybackCapture?
    private struct ReadRange {
        var current: Int64
        let response: PlaybackByteRange, wantedEnd: Int64?, identity: String?, mime: String
    }
    private var ranges: [Int: ReadRange] = [:]
    private(set) var openedMIME: String?, deliveryKind: String?
    private(set) var errorMessage: String?, failure: Error?
    var completeFile: URL? { conversion?.completeFile ?? capture?.installedFile }
    let asset: AVURLAsset

    init(url: URL, token: String, profile: StreamProfile, capture: OfflinePlaybackCapture? = nil) {
        self.capture = capture
        self.url = url
        self.token = token
        var parts = URLComponents()
        parts.scheme = "dnlibrary"
        parts.host = "track"
        parts.path = "/" + UUID().uuidString
        self.asset = AVURLAsset(url: parts.url!)
        super.init()
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.urlCredentialStorage = nil
        session = URLSession(configuration: config, delegate: self, delegateQueue: .main)
        asset.resourceLoader.setDelegate(self, queue: .main)
        if let converted = profile.convertedURL(url) {
            conversion = ConvertedTrack(original: url, converted: converted, token: token, capture: capture, received: { [weak self] mime, kind in
                DispatchQueue.main.async { self?.openedMIME = mime; self?.deliveryKind = kind }
            }, direct: { [weak self] url, loading in
                _ = self?.loadDirect(loading, from: url)
            }, error: { [weak self] message, cause in self?.errorMessage = message; self?.failure = cause })
        }
    }

    func close() {
        capture?.close()
        ranges.removeAll()
        conversion?.close()
        conversion = nil
        session?.invalidateAndCancel()
        session = nil
        pending.removeAll()
        tasks.removeAll()
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader,
                        shouldWaitForLoadingOfRequestedResource loading: AVAssetResourceLoadingRequest) -> Bool {
        if let conversion {
            conversion.request(loading)
            return true
        }
        return loadDirect(loading, from: url)
    }

    private func loadDirect(_ loading: AVAssetResourceLoadingRequest, from url: URL) -> Bool {
        guard let session else { return false }
        var request = URLRequest(url: url)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let data = loading.dataRequest {
            let offset = max(data.requestedOffset, data.currentOffset)
            var range = "bytes=\(offset)-"
            if !data.requestsAllDataToEndOfResource {
                let (end, overflow) = data.requestedOffset.addingReportingOverflow(Int64(data.requestedLength))
                guard !overflow, offset >= 0, offset <= end else {
                    loading.finishLoading(with: URLError(.badServerResponse)); return true
                }
                if end == offset { loading.finishLoading(); return true }
                range += String(end - 1)
            }
            request.setValue(range, forHTTPHeaderField: "Range")
        } else {
            request.setValue("bytes=0-1", forHTTPHeaderField: "Range")
        }
        let task = session.dataTask(with: request)
        tasks[ObjectIdentifier(loading)] = task
        pending[task.taskIdentifier] = loading
        task.resume()
        return true
    }

    func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel loading: AVAssetResourceLoadingRequest) {
        conversion?.cancel(loading)
        if let task = tasks.removeValue(forKey: ObjectIdentifier(loading)) {
            pending.removeValue(forKey: task.taskIdentifier)
            ranges.removeValue(forKey: task.taskIdentifier)
            task.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let loading = pending[dataTask.taskIdentifier] else {
            completionHandler(.cancel)
            return
        }
        guard let http = response as? HTTPURLResponse, DeviceOffline.audio(http.mimeType) else {
            finish(dataTask, loading, error: URLError(.badServerResponse))
            completionHandler(.cancel)
            return
        }
        let offset = max(loading.dataRequest?.requestedOffset ?? 0, loading.dataRequest?.currentOffset ?? 0)
        guard let range = PlaybackByteRange(status: http.statusCode,
                                            header: http.value(forHTTPHeaderField: "Content-Range"),
                                            bytes: response.expectedContentLength,
                                            coding: http.value(forHTTPHeaderField: "Content-Encoding"),
                                            offset: offset) else {
            finish(dataTask, loading, error: URLError(.badServerResponse))
            completionHandler(.cancel)
            return
        }
        openedMIME = http.mimeType
        if conversion == nil { deliveryKind = "original" }
        if let info = loading.contentInformationRequest {
            if let mime = response.mimeType { info.contentType = UTType(mimeType: mime)?.identifier }
            if let length = range.total { info.contentLength = length }
            info.isByteRangeAccessSupported = http.statusCode == 206 || http.value(forHTTPHeaderField: "Accept-Ranges") == "bytes"
        }
        guard let wanted = loading.dataRequest else {
            tasks.removeValue(forKey: ObjectIdentifier(loading))
            pending.removeValue(forKey: dataTask.taskIdentifier)
            loading.finishLoading()
            completionHandler(.cancel)
            return
        }
        let identity = capture == nil ? nil : range.cacheIdentity(
            tag: http.value(forHTTPHeaderField: "ETag"), modified: http.value(forHTTPHeaderField: "Last-Modified"),
            date: http.value(forHTTPHeaderField: "Date"), request: dataTask.taskIdentifier)
        let wantedEnd = wanted.requestsAllDataToEndOfResource ? nil : wanted.requestedOffset + Int64(wanted.requestedLength)
        ranges[dataTask.taskIdentifier] = ReadRange(current: offset, response: range, wantedEnd: wantedEnd,
                                                    identity: identity, mime: http.mimeType ?? "application/octet-stream")
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        let id = dataTask.taskIdentifier
        guard let range = ranges[id], let loading = pending[id] else { return }
        let (next, overflow) = range.current.addingReportingOverflow(Int64(data.count))
        guard !overflow, next <= (range.response.end ?? Int64.max) else {
            finish(dataTask, loading, error: URLError(.badServerResponse))
            return
        }
        if let key = range.identity, let total = range.response.total {
            capture?.receive(data, at: range.current, length: total, validator: key, mime: range.mime)
        }
        let limit = min(next, range.wantedEnd ?? next)
        loading.dataRequest?.respond(with: limit == next ? data : Data(data.prefix(Int(limit - range.current))))
        ranges[id]?.current = next
        if range.wantedEnd == limit && next != range.response.end {
            finish(dataTask, loading, error: nil)
        }
    }

    private func finish(_ task: URLSessionDataTask, _ loading: AVAssetResourceLoadingRequest, error: Error?) {
        ranges.removeValue(forKey: task.taskIdentifier)
        pending.removeValue(forKey: task.taskIdentifier)
        tasks.removeValue(forKey: ObjectIdentifier(loading))
        if let error { failure = error; loading.finishLoading(with: error) } else { loading.finishLoading() }
        task.cancel()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let range = ranges.removeValue(forKey: task.taskIdentifier)
        guard let loading = pending.removeValue(forKey: task.taskIdentifier) else { return }
        tasks.removeValue(forKey: ObjectIdentifier(loading))
        if let error { failure = error; loading.finishLoading(with: error) }
        else if let range, let end = range.response.end, range.current != end {
            let lost = URLError(.networkConnectionLost)
            failure = lost; loading.finishLoading(with: lost)
        } else { loading.finishLoading() }
    }
}
