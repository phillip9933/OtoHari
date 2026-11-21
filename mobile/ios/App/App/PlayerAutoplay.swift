import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Requests related library recordings from the listener's DN instance.
final class PlayerAutoplay {
    typealias Track = [String: Any]
    private var request: PlayerJSONLoad?
    private var revision = UUID()
    var loading: Bool { request != nil }

    static func setting(server: String, user: String?, enabled: Bool? = nil) -> Bool {
        guard !server.isEmpty, let user, !user.isEmpty,
              let data = try? JSONEncoder().encode([server, user]) else { return false }
        let key = "dn.autoplay." + data.base64EncodedString()
        if let enabled { UserDefaults.standard.set(enabled, forKey: key) }
        return UserDefaults.standard.bool(forKey: key)
    }

    func cancel() {
        revision = UUID()
        request?.cancel()
        request = nil
    }

    private static func mbid(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        return UUID(uuidString: value)?.uuidString.lowercased()
    }

    static func plan(tracks: [Track], exclusions: [String]) throws -> Track {
        let items: [Track] = tracks.suffix(25).reversed().compactMap { track in
            guard let artist = mbid(track["artistMbid"]) else { return nil }
            var seed: Track = ["artist_mbid": artist, "artist_name": track["artist"] as? String ?? ""]
            seed["album_mbid"] = mbid(track["releaseGroupMbid"])
            seed["album_name"] = track["album"] as? String
            return seed
        }
        var body: Track = ["mode": "library", "count": 25, "items": items, "exclude_recording_mbids": Array(exclusions.suffix(500))]
        if !items.isEmpty { body["seed_type"] = "items" }
        else if let group = mbid(tracks.last?["releaseGroupMbid"]) { body["seed_type"] = "album"; body["seed_id"] = group }
        else if let genre = tracks.last?["genre"] as? String, !genre.isEmpty { body["seed_type"] = "genre"; body["seed_id"] = genre }
        else { throw OfflineFiles.Failure("This queue has no artist, album or genre that DroppedNeedle can use for autoplay.") }
        return body
    }

    static func suggestions(data: Data, base: URL, excluding tracks: [Track]) throws -> [Track] {
        let json = try JSONSerialization.jsonObject(with: data) as? Track
        guard let rows = json?["tracks"] as? [Track] else { throw OfflineFiles.Failure("DN returned an invalid radio plan.") }
        var ids = Set(tracks.compactMap { $0["id"] as? String })
        var recordings = Set(tracks.compactMap { mbid($0["recordingMbid"]) })
        var result: [Track] = []
        for row in rows {
            guard row["in_library"] as? Bool == true, let id = row["local_file_id"] as? String,
                  !id.isEmpty, id != ".", id != "..", !id.contains("/"), !id.contains("\\"),
                  id.rangeOfCharacter(from: .controlCharacters) == nil, !ids.contains(id),
                  let title = row["track_name"] as? String, let artist = row["artist_name"] as? String else { continue }
            let recording = mbid(row["recording_mbid"])
            if let recording, recordings.contains(recording) { continue }
            ids.insert(id)
            if let recording { recordings.insert(recording) }
            guard let segment = id.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) else { continue }
            let api = base.appendingPathComponent("api/v3/").absoluteString
            var track: Track = ["id": id, "title": title, "artist": artist, "album": row["album_name"] as? String ?? "",
                                "streamUrl": api + "stream/local/" + segment]
            track["recordingMbid"] = recording
            track["artistMbid"] = mbid(row["artist_mbid"])
            if let group = mbid(row["album_mbid"]) {
                track["releaseGroupMbid"] = group
                track["artworkUrl"] = api + "covers/release-group/" + group + "?size=500"
            }
            for (source, target) in [("duration_s", "duration"), ("file_format", "format"), ("replaygain_track_gain", "replayGainTrackDb"),
                                     ("replaygain_album_gain", "replayGainAlbumDb"), ("replaygain_track_peak", "replayGainTrackPeak"),
                                     ("replaygain_album_peak", "replayGainAlbumPeak")] {
                if let value = row[source], !(value is NSNull) { track[target] = value }
            }
            result.append(track)
            if result.count == 25 { break }
        }
        guard !result.isEmpty else { throw OfflineFiles.Failure("DroppedNeedle found no new library tracks for this queue.") }
        return result
    }

    func load(server: String, user: String?, token: String, tracks: [Track],
              completion: @escaping (Result<[Track], Error>) -> Void) {
        cancel()
        let ticket = revision
        guard let base = URL(string: server), base.scheme == "https", base.host != nil,
              base.user == nil, base.password == nil, base.query == nil, base.fragment == nil,
              user?.isEmpty == false, !token.isEmpty, let last = tracks.last else {
            completion(.failure(OfflineFiles.Failure("Reconnect to load more library songs."))); return
        }
        func fetch(_ req: URLRequest, _ receive: @escaping (Result<Data, Error>) -> Void) {
            var req = req
            req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            let task = PlayerJSONLoad { [weak self] result in
                DispatchQueue.main.async {
                    guard let self, self.revision == ticket else { return }
                    self.request = nil
                    receive(result)
                }
            }
            request = task
            task.start(req)
        }
        func submit(_ seeds: [Track]) throws {
            let body = try Self.plan(tracks: seeds, exclusions: tracks.compactMap { Self.mbid($0["recordingMbid"]) })
            var req = URLRequest(url: base.appendingPathComponent("api/v3/discover/radio/plan"))
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
            fetch(req) { result in
                completion(result.flatMap { data in Result { try Self.suggestions(data: data, base: base, excluding: tracks) } })
            }
        }
        if (try? Self.plan(tracks: tracks, exclusions: [])) != nil {
            do { try submit(tracks) } catch { completion(.failure(error)) }
            return
        }
        var parts = URLComponents(url: base.appendingPathComponent("api/v3/library/tracks"), resolvingAgainstBaseURL: false)!
        var query = [URLQueryItem(name: "q", value: last["title"] as? String ?? ""), URLQueryItem(name: "limit", value: "100")]
        if let id = last["albumId"] as? String { query.append(URLQueryItem(name: "album_id", value: id)) }
        else if let id = last["artistId"] as? String { query.append(URLQueryItem(name: "artist_id", value: id)) }
        parts.queryItems = query
        parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        guard let url = parts.url else { completion(.failure(OfflineFiles.Failure("Invalid library address."))); return }
        fetch(URLRequest(url: url)) { result in
            do {
                let json = try JSONSerialization.jsonObject(with: result.get()) as? Track
                let row = (json?["items"] as? [Track])?.first { $0["id"] as? String == last["id"] as? String }
                var seed = last
                for (key, field) in [("artist_mbid", "artistMbid"), ("release_group_mbid", "releaseGroupMbid"), ("genre", "genre")] {
                    if let value = row?[key] as? String { seed[field] = value }
                }
                try submit(Array(tracks.dropLast()) + [seed])
            } catch { completion(.failure(error)) }
        }
    }
}
