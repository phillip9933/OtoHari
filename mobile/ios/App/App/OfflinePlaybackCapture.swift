import Foundation
import UniformTypeIdentifiers

/// Copies bytes already delivered for playback, including noncontiguous reads.
final class OfflinePlaybackCapture {
    private let queue = DispatchQueue(label: "app.droppedneedle.offline-capture")
    private let store: OfflineFiles, track: OfflineFiles.Track, ticket: OfflineFiles.Ticket
    private var file: URL?, output: FileHandle?, coverage: OfflineCoverage?, validator: String?, done = false
    // Published on main for the AVPlayerItem that owns this exact transfer.
    private(set) var installedFile: URL?
    private static let temp: URL? = {
        let files = FileManager.default
        let path = files.temporaryDirectory.appendingPathComponent("dn-playback-cache", isDirectory: true)
        if files.fileExists(atPath: path.path) { try? files.removeItem(at: path) }
        do {
            try files.createDirectory(at: path, withIntermediateDirectories: true,
                                      attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
            return path
        } catch { return nil }
    }()
    init?(store: OfflineFiles, track: OfflineFiles.Track) {
        guard DeviceOffline.shared.permitted(store.options()), let ticket = try? store.begin(track, origin: .cached) else { return nil }
        self.store = store; self.track = track; self.ticket = ticket
    }
    private func clear() {
        try? output?.close(); output = nil
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil; coverage = nil; validator = nil
    }
    func close() { queue.async { self.done = true; self.clear() } }
    func receive(_ data: Data, at offset: Int64, length: Int64, validator: String?, mime: String) {
        queue.async {
            guard !self.done else { return }
            let options = self.store.options()
            guard length > 0, length <= Int64(options.cacheMiB) * OfflineFiles.mib, self.store.active(self.ticket),
                  DeviceOffline.shared.permitted(options) else { self.done = true; self.clear(); return }
            do {
                if let existing = self.coverage, existing.length != length || self.validator != validator { self.clear() }
                if self.output == nil {
                    guard let folder = Self.temp else { return }
                    let file = folder.appendingPathComponent(UUID().uuidString)
                    guard FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600]) else { return }
                    self.file = file; self.output = try FileHandle(forWritingTo: file)
                    self.coverage = OfflineCoverage(length: length); self.validator = validator
                }
                guard offset >= 0, offset <= length, Int64(data.count) <= length - offset else { return }
                try self.output?.seek(toOffset: UInt64(offset))
                try self.output?.write(contentsOf: data)
                if self.coverage?.add(offset, count: data.count) == true, let file = self.file {
                    try self.output?.close(); self.output = nil
                    let ext = UTType(mimeType: mime)?.preferredFilenameExtension ?? self.track.format ?? "audio"
                    let installed = try self.store.install(file, bytes: length, ext: ext, track: self.track, ticket: self.ticket)
                    DispatchQueue.main.async { self.installedFile = installed }
                    self.done = true; self.clear()
                }
            } catch { self.done = true; self.clear() }
        }
    }
    /// ConvertedTrack already stages the complete conversion on its worker queue.
    func converted(_ url: URL, bytes: Int64, type: String) {
        queue.sync {
            guard !done, DeviceOffline.shared.permitted(store.options()) else { return }
            let ext = UTType(type)?.preferredFilenameExtension ?? "audio"
            try? store.install(url, bytes: bytes, ext: ext, track: track, ticket: ticket)
            done = true; clear()
        }
    }
}
