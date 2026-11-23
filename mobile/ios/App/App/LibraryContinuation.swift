import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

struct LibraryContinuation: Codable {
    static let pageSize = 100, refillAt = 25, previousLimit = 50
    static let keys: Set<String> = ["q", "sort", "order", "album_id", "artist_id", "genre", "formats", "format_mode", "rating", "rating_mode", "favorites"]
    var filters: [String: String], after: String?, loaded: Int, total: Int
    static func placement(current: Int, count: Int, incoming: Int, restart: Bool) throws -> (remove: Int, firstNew: Int) {
        let remove = restart ? count : max(0, current - previousLimit)
        guard (0..<count).contains(current), incoming > 0, incoming <= pageSize, count - remove + incoming <= 300 else {
            throw OfflineFiles.Failure("The next library page exceeds the mobile queue limit.")
        }
        return (remove, count - remove)
    }
    func validate(window: [String]) throws {
        guard total > 0, loaded > 0, loaded <= total, loaded >= window.count, !window.isEmpty,
              Set(window).count == window.count,
              (loaded < total) == (after != nil), after.map({ !$0.isEmpty && $0.utf8.count <= 8192 }) ?? true,
              filters.allSatisfy({ Self.keys.contains($0.key) && $0.value.utf8.count <= 4096 }) else {
            throw OfflineFiles.Failure("Invalid library queue cursor.")
        }
    }
    func request(_ server: String, token: String, restart: Bool) throws -> URLRequest {
        guard let base = URL(string: server), base.scheme == "https", base.host != nil, base.user == nil, base.password == nil,
              base.query == nil, base.fragment == nil, !token.isEmpty, restart || after != nil else {
            throw OfflineFiles.Failure("Reconnect to load more library songs.")
        }
        let endpoint = base.appendingPathComponent("api/v3/library/tracks")
        var parts = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)!
        var query = filters.sorted(by: { $0.key < $1.key }).map { URLQueryItem(name: $0.key, value: $0.value) }
        query.append(URLQueryItem(name: "limit", value: String(Self.pageSize)))
        if !restart, let after { query.append(URLQueryItem(name: "after", value: after)) }
        parts.queryItems = query
        // URLComponents leaves '+' literal, which form-style query decoding treats as a space.
        parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        var req = URLRequest(url: parts.url!); req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        return req
    }
    func accepting(_ page: LibraryTrackPage, existing: Set<String>, cursors: Set<String>, restart: Bool) throws -> (LibraryContinuation, [OfflineFiles.Track]) {
        let changed = OfflineFiles.Failure("The library changed during playback. Start this library queue again.")
        let tracks = try page.items.map { try $0.track() }, ids = Set(tracks.map(\.id))
        let before = restart ? 0 : loaded
        guard !tracks.isEmpty, tracks.count <= Self.pageSize, ids.count == tracks.count,
              page.total == total, restart || ids.isDisjoint(with: existing), page.total >= before,
              tracks.count <= page.total - before else { throw changed }
        let count = before + tracks.count
        guard (count < page.total) == (page.next != nil),
              page.next.map({ !$0.isEmpty && $0.utf8.count <= 8192 && (restart || !cursors.contains($0)) }) ?? true else { throw changed }
        return (LibraryContinuation(filters: filters, after: page.next, loaded: count, total: page.total), tracks)
    }
}

struct LibraryTrackPage: Decodable {
    let items: [Row], total: Int, next: String?
    struct Row: Decodable {
        let id: String, title: String
        let album_title: String?, artist_name: String?, album_id: String?, release_group_mbid: String?
        let artist_id: String?, album_artist_id: String?, album_artist_name: String?, genre: String?, format: String?
        let artist_mbid: String?, album_artist_mbid: String?, recording_mbid: String?
        let sample_rate: Int?, bit_depth: Int?, bit_rate: Int?
        let replaygain_album_gain: Double?, replaygain_track_gain: Double?, replaygain_album_peak: Double?, replaygain_track_peak: Double?
        let duration_seconds: Double?, date_added: Double?, year: Int?, disc_number: Int?, track_number: Int?
        let favorite: Bool?, art_missing: Bool?, cover_available: Bool?
        private func segment(_ id: String) throws -> String {
            guard !id.isEmpty, id != ".", id != "..", !id.contains("/"), !id.contains("\\"),
                  let escaped = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) else {
                throw OfflineFiles.Failure("DN returned an invalid library track.")
            }
            return escaped
        }
        func track() throws -> OfflineFiles.Track {
            let path = "/api/v3/stream/local/" + (try segment(id))
            var art: String?
            if art_missing != true {
                if cover_available == true, let album = album_id, !album.isEmpty { art = "/api/v3/library/albums/" + (try segment(album)) + "/artwork?size=500" }
                else if let group = release_group_mbid, !group.isEmpty { art = "/api/v3/covers/release-group/" + (try segment(group)) + "?size=500" }
            }
            return OfflineFiles.Track(id: id, title: title, album: album_title ?? "", artist: artist_name ?? "", streamUrl: path,
                artworkUrl: art, duration: duration_seconds, albumId: album_id, artistId: artist_id, albumArtist: album_artist_name,
                albumArtistId: album_artist_id, genre: genre, format: format, year: year, trackNumber: track_number,
                discNumber: disc_number, dateAdded: date_added, favorite: favorite,
                artistMbid: artist_mbid ?? album_artist_mbid, releaseGroupMbid: release_group_mbid, recordingMbid: recording_mbid,
                sourceSampleRate: sample_rate, sourceBitDepth: bit_depth, sourceBitrate: bit_rate,
                replayGainAlbumDb: replaygain_album_gain, replayGainTrackDb: replaygain_track_gain,
                replayGainAlbumPeak: replaygain_album_peak, replayGainTrackPeak: replaygain_track_peak)
        }
    }
}

/// Accumulate at most one bounded DN JSON page. On redirects or malformed
/// responses the current playback window remains intact for a retry.
final class LibraryPageLoad: PlayerJSONLoad, @unchecked Sendable {
    init(_ done: @escaping (Result<LibraryTrackPage, Error>) -> Void) {
        super.init { result in done(result.flatMap { data in
            Result { try JSONDecoder().decode(LibraryTrackPage.self, from: data) }
        }) }
    }
}

class PlayerJSONLoad: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let limit: Int
    private let done: (Result<Data, Error>) -> Void
    private var body = Data(), failure: Error?
    private var session: URLSession?
    private let lock = NSLock()
    init(limit: Int = 2 * 1024 * 1024, _ done: @escaping (Result<Data, Error>) -> Void) {
        self.limit = limit; self.done = done
    }
    func start(_ request: URLRequest, configuration: URLSessionConfiguration = .ephemeral) {
        configuration.urlCache = nil; configuration.httpCookieStorage = nil; configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 15; configuration.timeoutIntervalForResource = 30
        let s = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        lock.lock(); session = s; lock.unlock()
        s.dataTask(with: request).resume(); s.finishTasksAndInvalidate()
    }
    func cancel() { lock.lock(); let s = session; lock.unlock(); s?.invalidateAndCancel() }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200, http.mimeType?.lowercased() == "application/json",
              http.expectedContentLength <= Int64(limit) else {
            failure = OfflineFiles.Failure("DN could not return the requested music."); completionHandler(.cancel); return
        }
        completionHandler(.allow)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard data.count <= limit - body.count else { failure = OfflineFiles.Failure("The DN response was too large."); dataTask.cancel(); return }
        body.append(data)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); self.session = nil; lock.unlock()
        if let e = failure ?? error { done(.failure(e)); return }
        done(.success(body))
    }
}
