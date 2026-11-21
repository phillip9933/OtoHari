import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

enum PlaybackArtworkLimits {
    static let coverBytes = 4 * 1024 * 1024, fileBytes = 16 * 1024 * 1024, fileReads = 512
    static let thumbnailPixels = 768
    static func dimensions(_ width: Int, _ height: Int) -> Bool {
        width > 0 && height > 0 && width <= 8192 && height <= 8192 && width <= 16_777_216 / height
    }
}

struct PlaybackArtworkPlan: Equatable, Sendable {
    enum Source: Equatable, Sendable { case dn, embedded }
    let server: String, user: String?, occurrence: UUID, remote: URL?, saved: URL?, networkRevision: Int?
    init(server: String, user: String?, occurrence: UUID, remote: URL?, saved: URL?, online: Bool, revision: Int? = nil) {
        self.server = server
        self.user = user
        self.occurrence = occurrence
        self.networkRevision = online ? revision : nil
        self.saved = saved?.isFileURL == true ? saved : nil
        guard online, let remote, let base = URLComponents(string: server),
              let image = URLComponents(url: remote, resolvingAgainstBaseURL: false),
              base.scheme == "https", let host = base.host, !host.isEmpty, base.user == nil, base.password == nil,
              base.query == nil, base.fragment == nil, image.scheme == "https", image.host?.lowercased() == host.lowercased(),
              (image.port ?? 443) == (base.port ?? 443), image.user == nil, image.password == nil, image.fragment == nil else {
            self.remote = nil; return
        }
        var path = base.percentEncodedPath
        while path.last == "/" { path.removeLast() }
        let safe = image.percentEncodedPath.split(separator:"/").allSatisfy { segment in
            guard let text = segment.removingPercentEncoding else { return false }
            return text != "." && text != ".." && text.rangeOfCharacter(from: CharacterSet(charactersIn: "%/\\").union(.controlCharacters)) == nil
        }
        self.remote = safe && image.percentEncodedPath.hasPrefix(path + "/api/v3/") ? remote : nil
    }
    func resolve<Image>(_ received: Data?, access: PlaybackArtworkAccess, allowed: () -> Bool,
                        read: (URL, PlaybackArtworkAccess) -> Data?, decode: (Data, PlaybackArtworkAccess) -> Image?) -> (Image, Source)? {
        guard access.active else { return nil }
        let sizes = 1...PlaybackArtworkLimits.coverBytes
        if remote != nil, let received, sizes.contains(received.count), allowed(),
           let image = decode(received, access), access.active, allowed() { return (image, .dn) }
        guard access.active, let saved, let data = read(saved, access), sizes.contains(data.count),
              access.active, let image = decode(data, access), access.active else { return nil }
        return (image, .embedded)
    }
}

/// Shares cancellation between the remote request, the native tag reader and the final thumbnail.
final class PlaybackArtworkAccess: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false, task: URLSessionTask?
    var active: Bool { lock.lock(); defer { lock.unlock() }; return !stopped }
    func begin(_ task: URLSessionTask) {
        lock.lock(); defer { lock.unlock() }
        if stopped { task.cancel() } else { self.task = task; task.resume() }
    }
    func releaseTask() { lock.lock(); defer { lock.unlock() }; task = nil }
    func cancel() {
        lock.lock(); stopped = true
        let request = task; task = nil; lock.unlock()
        request?.cancel()
    }
}

/// Audio File Services can seek directly to metadata at the end of a large song.
/// Bound actual reads, including repeated reads of the same offset, before allocating a buffer.
final class BoundedArtworkFile {
    let size: Int64
    private let file: FileHandle, access: PlaybackArtworkAccess, lock = NSLock()
    private var bytes = PlaybackArtworkLimits.fileBytes, calls = PlaybackArtworkLimits.fileReads
    init(_ url: URL, access: PlaybackArtworkAccess) throws {
        guard access.active, url.isFileURL else { throw URLError(.fileDoesNotExist) }
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
        guard values.isRegularFile == true, values.isSymbolicLink != true else { throw URLError(.fileDoesNotExist) }
        file = try FileHandle(forReadingFrom: url)
        guard let length = Int64(exactly: try file.seekToEnd()), length > 0 else { throw URLError(.cannotOpenFile) }
        size = length; self.access = access
    }
    deinit { try? file.close() }
    func read(at position: Int64, count: Int) -> Data? {
        lock.lock(); defer { lock.unlock() }
        guard access.active, position >= 0, position <= size, count >= 0, calls > 0 else { return nil }
        let needed = min(count, Int(size - position))
        guard needed <= bytes else { return nil }
        bytes -= needed; calls -= 1
        if needed == 0 { return Data() }
        do { try file.seek(toOffset: UInt64(position)); return try file.read(upToCount: needed) }
        catch { return nil }
    }
    private func number(_ bytes: Data) -> Int { bytes.reduce(0) { ($0 << 8) | Int($1) } }
    private func flacPicture(start: Int64, length: Int) -> (kind: Int, offset: Int64, count: Int)? {
        // RFC 9639 PICTURE has variable-length MIME and description fields before its image length.
        guard length >= 32, let first = read(at: start, count: 8), first.count == 8 else { return nil }
        let kind = number(first.prefix(4)), mimeLength = number(first.suffix(4))
        guard mimeLength <= 255, mimeLength <= length - 32, let mime = read(at: start + 8, count: mimeLength),
              mime != Data("-->".utf8), let text = read(at: start + 8 + Int64(mimeLength), count: 4), text.count == 4 else { return nil }
        let sizeOffset = 28 + mimeLength + number(text)
        guard sizeOffset <= length - 4, let raw = read(at: start + Int64(sizeOffset), count: 4), raw.count == 4 else { return nil }
        let count = number(raw)
        guard (1...PlaybackArtworkLimits.coverBytes).contains(count), count == length - sizeOffset - 4 else { return nil }
        return (kind, start + Int64(sizeOffset + 4), count)
    }
    func flacCover() -> Data? {
        guard read(at: 0, count: 4) == Data("fLaC".utf8) else { return nil }
        var offset: Int64 = 4
        var other: (offset: Int64, count: Int)?
        while offset <= size - 4, let header = read(at: offset, count: 4), header.count == 4 {
            let length = number(header.suffix(3))
            offset += 4
            guard Int64(length) <= size - offset else { return nil }
            if header[0] & 0x7f == 6, let picture = flacPicture(start: offset, length: length) {
                if picture.kind == 3 { return read(at: picture.offset, count: picture.count) }
                if other == nil && (picture.kind == 0 || picture.kind == 4) { other = (picture.offset, picture.count) }
            }
            if header[0] & 0x80 != 0 { break }
            offset += Int64(length)
        }
        return other.flatMap { read(at: $0.offset, count: $0.count) }
    }
}

final class PlaybackArtworkRemote: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private static let formats: Set<String> = ["image/jpeg","image/png","image/gif","image/webp","image/heic","image/heif","image/avif"]
    private let access: PlaybackArtworkAccess, allowed: @Sendable () -> Bool
    private var done: (@Sendable (Data?) -> Void)?, bytes = Data(), expected: Int64?, accepted = false
    private init(_ access: PlaybackArtworkAccess, allowed: @escaping @Sendable () -> Bool, done: @escaping @Sendable (Data?) -> Void) {
        self.access = access; self.allowed = allowed; self.done = done
    }
    static func fetch(_ url: URL, token: String, access: PlaybackArtworkAccess, allowed: @escaping @Sendable () -> Bool,
                      configuration: URLSessionConfiguration = .ephemeral, done: @escaping @Sendable (Data?) -> Void) {
        guard access.active, allowed(), !token.isEmpty, token.utf8.allSatisfy({ (33...126).contains($0) }) else { done(nil); return }
        var request = URLRequest(url:url)
        request.httpShouldHandleCookies = false
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.setValue("image/*", forHTTPHeaderField: "Accept")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.timeoutIntervalForRequest = 6; configuration.timeoutIntervalForResource = 10
        let receiver = PlaybackArtworkRemote(access, allowed: allowed, done: done)
        let session = URLSession(configuration: configuration, delegate: receiver, delegateQueue: nil)
        let task = session.dataTask(with: request)
        if allowed() { access.begin(task) } else { task.cancel() }
        session.finishTasksAndInvalidate()
    }
    private func finish(_ task: URLSessionTask, with payload: Data?) {
        guard let complete = done else { return }
        done = nil
        if payload == nil { task.cancel() }
        access.releaseTask()
        bytes = Data()
        complete(payload)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard access.active, allowed(), let http = response as? HTTPURLResponse, http.statusCode == 200,
              Self.formats.contains(http.mimeType?.lowercased() ?? ""),
              http.expectedContentLength <= Int64(PlaybackArtworkLimits.coverBytes) else {
            completionHandler(.cancel); finish(dataTask, with:nil); return
        }
        accepted = true
        if (http.value(forHTTPHeaderField:"Content-Encoding") ?? "identity").lowercased() == "identity", http.expectedContentLength >= 0 {
            expected = http.expectedContentLength
        }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard done != nil else { return }
        guard accepted, access.active, allowed(), data.count <= PlaybackArtworkLimits.coverBytes - bytes.count else {
            finish(dataTask, with:nil); return
        }
        bytes.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let valid = accepted && error == nil && access.active && allowed() && !bytes.isEmpty && (expected == nil || expected == Int64(bytes.count))
        finish(task, with: valid ? bytes : nil)
    }
}

#if canImport(AudioToolbox) && canImport(ImageIO)
import AudioToolbox
import CoreFoundation
import CoreGraphics
import ImageIO

enum PlaybackArtworkImage {
    private static let worker = DispatchQueue(label: "app.droppedneedle.playback-artwork", qos: .utility)
    static func embedded(_ url: URL, access: PlaybackArtworkAccess) -> Data? {
        guard let source = try? BoundedArtworkFile(url, access: access) else { return nil }
        if let flac = source.flacCover() { return flac }
        guard access.active else { return nil }
        return withExtendedLifetime(source) {
            var file: AudioFileID?
            let status = AudioFileOpenWithCallbacks(Unmanaged.passUnretained(source).toOpaque(), { context, position, count, buffer, actual in
                actual.pointee = 0
                let source = Unmanaged<BoundedArtworkFile>.fromOpaque(context).takeUnretainedValue()
                guard let data = source.read(at: position, count: Int(count)) else { return kAudioFileUnspecifiedError }
                data.copyBytes(to: buffer.assumingMemoryBound(to: UInt8.self), count: data.count)
                actual.pointee = UInt32(data.count)
                return noErr
            }, nil, { Unmanaged<BoundedArtworkFile>.fromOpaque($0).takeUnretainedValue().size }, nil, 0, &file)
            guard status == noErr, let file else { return nil }
            defer { AudioFileClose(file) }
            var raw: Unmanaged<CFData>?
            var count = UInt32(MemoryLayout.size(ofValue: raw))
            let read = AudioFileGetProperty(file, kAudioFilePropertyAlbumArtwork, &count, &raw)
            guard read == noErr, let data = raw?.takeRetainedValue(), access.active,
                  (1...PlaybackArtworkLimits.coverBytes).contains(CFDataGetLength(data)) else { return nil }
            return data as Data
        }
    }
    static func thumbnail(_ data: Data, access: PlaybackArtworkAccess) -> CGImage? {
        guard access.active, (1...PlaybackArtworkLimits.coverBytes).contains(data.count) else { return nil }
        let probe = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, probe),
              let type = CGImageSourceGetType(source) as String?,
              ["public.jpeg","public.png","com.compuserve.gif","org.webmproject.webp","public.heic","public.heif","public.avif"].contains(type),
              CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, probe) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              PlaybackArtworkLimits.dimensions(width.intValue, height.intValue), access.active else { return nil }
        let options = [kCGImageSourceCreateThumbnailFromImageAlways:true,
                       kCGImageSourceCreateThumbnailWithTransform:true, kCGImageSourceShouldCacheImmediately:true,
                       kCGImageSourceThumbnailMaxPixelSize:PlaybackArtworkLimits.thumbnailPixels] as CFDictionary
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options)
    }
    static func load(_ plan: PlaybackArtworkPlan, token: String, access: PlaybackArtworkAccess,
                     allowed: @escaping @Sendable () -> Bool, done: @escaping @Sendable (CGImage, PlaybackArtworkPlan.Source) -> Void) {
        let resolve: @Sendable (Data?) -> Void = { remote in
            worker.async {
                if let (image, origin) = plan.resolve(remote, access: access, allowed: allowed, read: embedded, decode: thumbnail) {
                    done(image, origin)
                }
            }
        }
        if let url = plan.remote { PlaybackArtworkRemote.fetch(url, token: token, access: access, allowed: allowed, done: resolve) }
        else { resolve(nil) }
    }
}
#endif
