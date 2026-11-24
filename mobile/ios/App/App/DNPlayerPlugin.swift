import AVFoundation
import Capacitor
import CryptoKit
import MediaPlayer
import Network
import UIKit

@objc(DNPlayerPlugin)
public final class DNPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DNPlayerPlugin"
    public let jsName = "DNPlayer"
    public let pluginMethods: [CAPPluginMethod] = ["getState", "setQueue", "command", "getTrackFade", "setTrackFade",
                                                   "getStreamNetwork", "setStreamProfiles", "restore", "waveform", "cancelWaveform", "autoplaySetting",
                                                   "signalPath", "soundSettings", "getEqualizer", "setEqualizer", "setEqualizerOutput", "widgetAction"].map {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }

    private var player = AVQueuePlayer()
    private let sound = PlayerSound()
    private let loudness = PlayerLoudness()
    private let widget = WidgetPublishing()
    private let waveforms = PlaybackWaveform()
    private struct Track {
        let key = UUID()
        let data: [String: Any]
        let url: URL
        let saved: OfflineFiles.Track
    }
    private enum RepeatMode: String { case off, all, one }
    private let reports = PlaybackReportSender()
    private let offlineHistory = OfflineListenReplay()
    private var historyOwner: OfflineListenReplay.Session?
    private var history = PlaybackHistory(), historyItem: AVPlayerItem?
    private static let reportingDevice: String = {
        if let stored = UserDefaults.standard.string(forKey: "dn.playbackDevice") { return stored }
        let id = "ios-" + UUID().uuidString.prefix(8).lowercased()
        UserDefaults.standard.set(id, forKey: "dn.playbackDevice")
        return id
    }()
    private let archiveWorker = DispatchQueue(label: "app.droppedneedle.queue-storage")
    private var continuation: LibraryContinuation?, pageLoad: LibraryPageLoad?, pageID = UUID()
    private var pageProblem: String?, waitingForWindow = false
    private var seenLibraryIDs = Set<String>(), seenCursors = Set<String>()
    private var archive: PlaybackArchive?, revision = UUID(), generation = 0
    private var deferredPosition: Double?, seekInFlight = false
    private var progressObserver: Any?
    private var intent = PlaybackIntent(), sleepWake: DispatchWorkItem?
    private var repeatMode: RepeatMode = .off
    private var queueVersion = UUID().uuidString
    private var queue: [Track] = [] {
        didSet { queueVersion = UUID().uuidString }
    }
    private var order = PlayerQueueOrder() {
        didSet { queueVersion = UUID().uuidString }
    }
    private var previousQueue: PlaybackArchive.Previous?
    private let suggestions = PlayerAutoplay()
    private var suggestionID = UUID(), suggestionProblem: String?, waitingForSuggestions = false
    private var serverAddress = ""
    private var userID: String?
    private var profiles = StreamProfiles()
    private let pathMonitor = NWPathMonitor()
    private var network = PlaybackNetwork.unknown
    private var gateways = [NWEndpoint]()
    private var pathAvailable = false
    private var routeVersion = 0
    private var reconnect = PlaybackReconnect()
    private var reconnectWork: DispatchWorkItem?
    private weak var failedStream: AVPlayerItem?
    private var lastItemPosition = 0.0, reconnectStart: Double?, stalledAt: Double?
    private weak var observedItem: AVPlayerItem?
    private var token = ""
    private var index = -1 {
        didSet {
            // A suspended seek can move past queued picks before AVPlayer promotes an item.
            if index != oldValue && !order.priority.isEmpty { queueVersion = UUID().uuidString }
        }
    }
    private var streams: [ObjectIdentifier: (key: UUID, occurrence: UUID, profile: StreamProfile,
                                             source: OfflineFiles.PlaybackSource, network: PlaybackNetwork, route: Int, stream: LibraryStream?)] = [:]
    private var observations: [NSKeyValueObservation] = []
    private var itemStatus: NSKeyValueObservation?
    private var listeners: [NSObjectProtocol] = []
    private var commands: [(MPRemoteCommand, Any)] = []
    private var error: String?
    private var artwork: MPMediaItemArtwork?
    private var artworkPlan: PlaybackArtworkPlan?, artworkAccess: PlaybackArtworkAccess?

    public override func load() {
        DispatchQueue.global(qos: .utility).async { ConvertedTrack.cleanPreviousSession() }
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let next = PlaybackNetwork(path)
            let changed = self.network != next || self.gateways != path.gateways
            if changed { self.routeVersion += 1 }
            self.network = next; self.gateways = path.gateways; self.pathAvailable = path.status == .satisfied
            self.offlineHistory.connection(path.status == .requiresConnection ? nil : path.status == .satisfied, pathChanged: changed)
            self.reports.permissionsChanged()
            if next == .offline { self.cancelSuggestions() }
            if !self.queue.isEmpty {
                self.updateCurrentItem(); self.sampleHistory(); self.loadWindow()
                self.scheduleReconnectIfNeeded()
            }
        }
        pathMonitor.start(queue: .main)
        DispatchQueue.main.async { [weak self] in self?.observePlayback() }
    }

    @objc func getStreamNetwork(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(["network": self.network.rawValue]) }
    }

    @objc func setStreamProfiles(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.serverAddress == call.getString("serverUrl"), self.userID == call.getString("userId") {
                self.profiles = StreamProfiles(wifi: StreamProfile(call.getObject("wifi")),
                                               cellular: StreamProfile(call.getObject("cellular")))
                self.updateCurrentItem()
            }
            call.resolve()
        }
    }

    private var fadeObserver: Any?
    private let transitionReader = PlaybackWaveform()
    private var fades = TrackFades(0, 0, smart: false)
    private weak var keepIntro: AVPlayerItem?
    private final class Mix {
        let outgoing: AVPlayerItem
        let queued: AVPlayerItem
        var incoming: AVQueuePlayer?
        var overlap: Double?
        var start: Double?
        init(_ outgoing: AVPlayerItem, _ queued: AVPlayerItem) { self.outgoing = outgoing; self.queued = queued }
    }
    private var mix: Mix?

    private func cancelMix() {
        transitionReader.stop()
        if let mix {
            mix.incoming?.pause()
            if keepIntro === mix.queued && keepIntro !== player.currentItem { keepIntro = nil }
        }
        mix = nil
        player.actionAtItemEnd = intent.sleep.track == nil ? .advance : .pause
    }

    private func applyFade() {
        guard let item = player.currentItem, queue.indices.contains(index) else {
            cancelMix(); player.volume = 1; return
        }
        let next = player.items().dropFirst().first
        let smart = fades.smart && intent.sleep.endsAt == nil && intent.sleep.remaining == 0 && repeatMode != .one
            && intent.canPlay && !seekInFlight && deferredPosition == nil && !player.isExternalPlaybackActive
            && !AVAudioSession.sharedInstance().currentRoute.outputs.contains(where: { $0.portType == .airPlay })
        if let mix, !smart || mix.outgoing !== item || mix.queued !== next { cancelMix() }
        let at = position, length = duration, remaining = length - at
        if smart, mix == nil, length > 0, remaining <= 16, let next,
           let entry = streams[ObjectIdentifier(next)], let nextTrack = queue.first(where: { $0.key == entry.key }),
           nextTrack.key != queue[index].key {
            let transition = Mix(item, next)
            mix = transition
            if TrackFades.albumSequence(queue[index].data, nextTrack.data) {
                transition.overlap = 0; keepIntro = next
            } else {
                transitionReader.overlap(item.asset, next.asset) { [weak self, weak transition] seconds in
                    guard let self, let transition, self.mix === transition, self.player.currentItem === transition.outgoing else { return }
                    transition.overlap = seconds
                    if seconds != nil { self.keepIntro = transition.queued }
                    if let seconds, seconds > 0 {
                        let incomingItem = AVPlayerItem(asset: transition.queued.asset)
                        self.applySound(to: incomingItem, track: nextTrack)
                        let incoming = AVQueuePlayer(items: [incomingItem])
                        incoming.allowsExternalPlayback = false
                        incoming.volume = 0
                        transition.incoming = incoming
                    }
                    self.applyFade()
                }
            }
        }
        var gain = fades.gain(position: at, duration: length, keepIntro: fades.smart && protectedIntro === item, keepTail: mix?.overlap != nil)
        if let mix, let seconds = mix.overlap, let incoming = mix.incoming, !player.isExternalPlaybackActive {
            if incoming.currentItem?.status == .failed {
                mix.incoming = nil; mix.overlap = nil; keepIntro = nil
                player.actionAtItemEnd = .advance
            } else if remaining > 0 && remaining <= seconds && player.timeControlStatus == .playing {
                if mix.start == nil && incoming.currentItem?.status == .readyToPlay {
                    incoming.playImmediately(atRate: max(0.01, player.rate))
                    mix.start = at
                    player.actionAtItemEnd = .pause
                }
                if let start = mix.start, incoming.timeControlStatus == .playing {
                    let progress = min(1, max(0, (at - start) / max(0.001, length - start)))
                    gain *= Float(cos(progress * .pi / 2))
                    incoming.volume = Float(sin(progress * .pi / 2))
                }
            }
        }
        player.volume = gain
    }

    // Promote the already-playing queue. Its clock and decoded intro continue across the boundary.
    private func finishMix(_ ended: AVPlayerItem) -> Bool {
        guard let mix, mix.outgoing === ended, mix.start != nil, let incoming = mix.incoming,
              let item = incoming.currentItem, incoming.timeControlStatus == .playing,
              let next = streams[ObjectIdentifier(mix.queued)], intent.canPlay, !player.isExternalPlaybackActive else {
            if let mix, mix.start != nil, mix.outgoing === ended {
                cancelMix(); player.advanceToNextItem(); updateCurrentItem(); playWhenReady(); return true
            }
            return false
        }
        self.mix = nil; transitionReader.stop()
        stopTransportObservers()
        player.pause(); player.removeAllItems()
        streams.removeValue(forKey: ObjectIdentifier(mix.queued))
        streams[ObjectIdentifier(item)] = next
        player = incoming
        player.allowsExternalPlayback = true
        player.actionAtItemEnd = .advance
        player.volume = 1
        keepIntro = item
        updateCurrentItem()
        observeTransport()
        sampleHistory(); checkpoint()
        return true
    }

    private func observeFades() {
        if let fadeObserver { player.removeTimeObserver(fadeObserver); self.fadeObserver = nil }
        applyFade()
        if fades.smart || fades.fadeInMs > 0 || fades.fadeOutMs > 0 {
            fadeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 20), queue: .main) { [weak self] _ in
                self?.applyFade()
            }
        }
    }

    @objc func getTrackFade(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["fadeInMs": self.fades.fadeInMs, "fadeOutMs": self.fades.fadeOutMs, "smart": self.fades.smart])
        }
    }

    @objc func setTrackFade(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let legacy = call.getInt("milliseconds") ?? 0
            self.cancelMix()
            self.fades = TrackFades(call.getInt("fadeInMs") ?? legacy, call.getInt("fadeOutMs") ?? legacy, smart: call.getBool("smart") ?? false)
            UserDefaults.standard.set(["fadeInMs": self.fades.fadeInMs, "fadeOutMs": self.fades.fadeOutMs, "smart": self.fades.smart], forKey: "dn.trackFades.v2")
            self.observeFades()
            call.resolve()
        }
    }

    private func stopTransportObservers() {
        observations.removeAll()
        if let progressObserver { player.removeTimeObserver(progressObserver); self.progressObserver = nil }
        if let fadeObserver { player.removeTimeObserver(fadeObserver); self.fadeObserver = nil }
    }

    private weak var protectedIntro: AVPlayerItem?
    private func observeTransport() {
        observeFades()
        observations.append(player.observe(\.currentItem, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async { self?.updateCurrentItem(); self?.sampleHistory(); self?.applyFade() }
        })
        observations.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                if self.player.timeControlStatus != .paused && !self.playbackAllowed() { self.player.pause() }
                if self.player.timeControlStatus == .waitingToPlayAtSpecifiedRate {
                    if self.mix?.start != nil { self.cancelMix() }
                    self.scheduleReconnectIfNeeded()
                }
                self.sampleHistory(); self.publishNowPlaying()
            }
        })
        progressObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 5, preferredTimescale: 1), queue: .main) { [weak self] _ in
            self?.playbackAllowed(); self?.checkpoint(); self?.sampleHistory(heartbeat: true)
        }
    }

    private func observePlayback() {
        let stored = UserDefaults.standard.dictionary(forKey: "dn.trackFades.v2")
        let legacy = UserDefaults.standard.integer(forKey: "dn.trackFades")
        fades = TrackFades(stored?["fadeInMs"] as? Int ?? legacy, stored?["fadeOutMs"] as? Int ?? legacy, smart: stored?["smart"] as? Bool ?? false)
        observeTransport()
        let center = NotificationCenter.default
        listeners.append(center.addObserver(forName: DeviceOffline.mediaChanged, object: nil, queue: .main) { [weak self] _ in
            self?.offlineHistory.policyChanged(); self?.reports.permissionsChanged()
            self?.offlineFilesChanged()
        })
        listeners.append(center.addObserver(forName: DeviceOffline.historyChanged, object: nil, queue: .main) { [weak self] _ in
            self?.offlineHistory.policyChanged()
        })
        listeners.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.checkpoint() })
        listeners.append(center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            if !self.token.isEmpty { self.identifyHistory() }
            self.playbackAllowed()
        })
        listeners.append(center.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            guard let self, let item = note.object as? AVPlayerItem else { return }
            if item === self.historyItem { self.finishHistory(ended: true) }
            if self.finishMix(item) { return }
            guard self.player.currentItem === item || (self.player.currentItem == nil && self.observedItem === item) else { return }
            if let entry = self.streams[ObjectIdentifier(item)], self.intent.sleep.track == entry.key {
                if self.intent.reachedEnd(entry.key) { self.pause() }
                else if let following = self.nextIndex(automatic: true) { self.move(to: following) }
                else if self.hasNextPage { self.atWindowEnd() }
                else { self.intent.sleep.cancel(); self.pause() }
                return
            }
            if self.nextIndex(automatic: true) == nil {
                if self.hasNextPage {
                    self.atWindowEnd()
                } else if self.allowsSuggestions && self.suggestionProblem == nil && self.intent.requested {
                    self.waitingForSuggestions = true; self.loadSuggestions()
                } else { self.pause() }
            }
        })
        listeners.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), queue: .main) { [weak self] note in
            guard let self, let value = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: value) else { return }
            switch type {
            case .began:
                self.intent.beginInterruption()
                if #available(iOS 17.0, *), let reason = note.userInfo?[AVAudioSessionInterruptionReasonKey] as? UInt,
                   reason == AVAudioSession.InterruptionReason.routeDisconnected.rawValue { self.intent.pause() }
                self.silence()
            case .ended:
                let flags = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                let recommendation = AVAudioSession.InterruptionOptions(rawValue: flags).contains(.shouldResume)
                let permission = self.intent.endInterruption(recommended: recommendation, now: self.wallTime)
                guard self.apply(permission) else { return }
                do { try self.activateAudio(); self.startRequestedPlayback(afterInterruption: true) }
                catch { self.pause(); self.error = "Audio playback is unavailable." }
            @unknown default: break
            }
        })
        listeners.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] note in
            self?.refreshSound()
            if let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
               reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue {
                self?.pause()
            }
        })
        listeners.append(center.addObserver(forName: .AVPlayerItemPlaybackStalled, object: nil, queue: .main) { [weak self] note in
            guard let self, let item = note.object as? AVPlayerItem, item === self.player.currentItem,
                  self.playbackAllowed(), self.streams[ObjectIdentifier(item)]?.source == .network else { return }
            self.stalledAt = self.position
            self.scheduleReconnectIfNeeded()
        })
        listeners.append(center.addObserver(forName: .AVPlayerItemFailedToPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            guard let self, let item = note.object as? AVPlayerItem, item === self.player.currentItem else { return }
            self.itemFailed(item, cause: note.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error)
        })
        let remote = MPRemoteCommandCenter.shared()
        bind(remote.playCommand) { p, _ in try p.resume() }
        bind(remote.pauseCommand) { p, _ in p.pause() }
        bind(remote.togglePlayPauseCommand) { p, _ in try p.toggle() }
        bind(remote.nextTrackCommand) { p, _ in try p.next() }
        bind(remote.previousTrackCommand) { p, _ in try p.previous() }
        remote.changePlaybackRateCommand.supportedPlaybackRates = PlayerSound.speeds.map { NSNumber(value: $0) }
        bind(remote.changePlaybackRateCommand) { p, event in
            guard let speed = (event as? MPChangePlaybackRateCommandEvent)?.playbackRate else { return }
            try p.sound.configure(speed: Double(speed), mode: nil)
            p.refreshSound(); p.publishNowPlaying()
        }
        bind(remote.changeRepeatModeCommand) { p, event in
            guard let mode = (event as? MPChangeRepeatModeCommandEvent)?.repeatType else { return }
            switch mode {
            case .one: p.repeatMode = .one
            case .all: p.repeatMode = .all
            case .off: p.repeatMode = .off
            @unknown default: return
            }
            p.cancelSuggestions(); p.cancelMix(); p.updateCurrentItem(); p.saveQueue()
        }
        bind(remote.changeShuffleModeCommand) { p, event in
            guard let mode = (event as? MPChangeShuffleModeCommandEvent)?.shuffleType,
                  mode == .items || mode == .off, (p.order.original != nil) != (mode == .items) else { return }
            p.cancelSuggestions(); p.detachWindow()
            p.edit("shuffleUpcoming", from: -1, to: -1); p.saveQueue()
        }
        bind(remote.changePlaybackPositionCommand) { p, event in
            if let position = event as? MPChangePlaybackPositionCommandEvent { p.seek(position.positionTime) }
        }
    }

    private func bind(_ command: MPRemoteCommand, _ action: @escaping (DNPlayerPlugin, MPRemoteCommandEvent) throws -> Void) {
        let target = command.addTarget { [weak self] event in
            guard let self else { return .commandFailed }
            DispatchQueue.main.async {
                do { try action(self, event) } catch { self.error = "Audio playback is unavailable." }
            }
            return .success
        }
        commands.append((command, target))
    }

    private func activateAudio() throws {
        let audio = AVAudioSession.sharedInstance()
        try audio.setCategory(.playback, mode: .default, policy: .longFormAudio)
        try audio.setActive(true)
    }

    private static func milliseconds(_ seconds: Double?) -> Int64? {
        guard let seconds, seconds.isFinite, seconds >= 0, seconds < Double(Int64.max / 1000) else { return nil }
        return Int64((seconds * 1000).rounded())
    }
    private var elapsedMS: Int64 { Int64(ProcessInfo.processInfo.systemUptime * 1000) }
    private func identifyHistory() {
        if let historyOwner, historyOwner.base.absoluteString == serverAddress, historyOwner.user == userID,
           historyOwner.token == token, userID == nil || historyOwner.journal != nil { return }
        let known = userID?.isEmpty == false
        let files = known ? (try? DeviceOffline.shared.account(serverAddress, userID))?.1 : nil
        let journal = known ? (try? DeviceOffline.shared.history(serverAddress, userID)) : nil
        historyOwner = OfflineListenReplay.Session(server: serverAddress, token: token, user: userID, account: files?.accountDirectory, journal: journal) {
            files?.options().offlineOnly ?? known
        }
        offlineHistory.authorize(historyOwner); reports.permissionsChanged()
    }
    private func sendHistory(_ events: [PlaybackHistory.Event]) {
        guard !events.isEmpty, let owner = historyOwner else { return }
        for event in events {
            switch event.route {
            case .offline:
                if let journal = owner.journal { offlineHistory.record(event, journal: journal) }
            case .live:
                if offlineHistory.live(owner) {
                    reports.send([event], server: owner.base.absoluteString, token: owner.token, device: Self.reportingDevice,
                                 permitted: { [offlineHistory] in offlineHistory.live(owner) })
                }
            case .silent: break
            }
        }
    }
    private func finishHistory(ended: Bool = false) {
        guard let occurrence = history.occurrence else { historyItem = nil; return }
        let length = Self.milliseconds(historyItem?.duration.seconds)
        let events = history.finish(occurrence, position: ended ? length : Self.milliseconds(historyItem?.currentTime().seconds),
                                    length: length, now: elapsedMS)
        historyItem = nil
        sendHistory(events)
    }
    private func sampleHistory(heartbeat: Bool = false, pausedForReplacement: Bool = false) {
        let item = player.currentItem
        if let last = historyItem, last !== item { finishHistory() }
        guard let item, let entry = streams[ObjectIdentifier(item)], let track = queue.first(where: { $0.key == entry.key }),
              let id = track.data["id"] as? String else { return }
        if item.status == .failed && failedStream !== item && !PlaybackReconnect.recoverable(entry.stream?.failure ?? item.error) {
            finishHistory(); return
        }
        let playing = !pausedForReplacement && item.status == .readyToPlay && failedStream !== item && intent.canPlay && player.timeControlStatus == .playing && deferredPosition == nil && !seekInFlight
        let seconds = item.currentTime().seconds
        if seconds.isFinite, item.status == .readyToPlay, failedStream !== item, deferredPosition == nil,
           seconds > 0 || playing { lastItemPosition = max(0, seconds) }
        if let at = stalledAt, abs(lastItemPosition - at) > 0.25 { stalledAt = nil }
        if playing, let start = reconnectStart, lastItemPosition >= start + 10 {
            reconnect = PlaybackReconnect(); reconnectStart = nil
        }
        let position = Self.milliseconds(deferredPosition ?? lastItemPosition) ?? 0
        let length = Self.milliseconds(item.duration.seconds) ?? Self.milliseconds(track.data["duration"] as? Double) ?? 0
        let replay = offlineHistory, owner = historyOwner
        let events = history.observe(entry.occurrence, id: id, position: position, length: length, playing: playing,
                                     now: elapsedMS, heartbeat: heartbeat, route: replay.route(owner,
                                         title: track.data["title"] as? String ?? "", artist: track.data["artist"] as? String ?? "",
                                         album: track.data["album"] as? String ?? ""))
        if history.occurrence == entry.occurrence { historyItem = item }
        if !events.isEmpty { sendHistory(events) }
    }
    private var wallTime: Double { Date().timeIntervalSince1970 * 1000 }
    private func apply(_ permission: PlaybackIntent.Permission) -> Bool {
        if permission == .timerExpired { sleepWake?.cancel(); sleepWake = nil; silence() }
        return permission == .play
    }
    @discardableResult private func playbackAllowed() -> Bool {
        let current = intent.requested && queue.indices.contains(index) ? queue[index].key : nil
        if intent.sleep.finishCurrent(now: wallTime, track: current) { updateSleepBoundary() }
        let permission = intent.permission(now: wallTime)
        return apply(permission)
    }
    private func playWhenReady() {
        guard playbackAllowed(), deferredPosition == nil, !seekInFlight, let item = player.currentItem, failedStream !== item,
              player.timeControlStatus == .paused else { return }
        player.playImmediately(atRate: sound.speed)
    }
    private func updateSleepBoundary() {
        cancelMix()
        player.actionAtItemEnd = intent.sleep.track != nil ? .pause : .advance
        if intent.sleep.track != nil {
            for upcoming in player.items().dropFirst() {
                player.remove(upcoming); streams.removeValue(forKey: ObjectIdentifier(upcoming))?.stream?.close()
            }
        }
    }
    private func scheduleSleep() {
        sleepWake?.cancel(); sleepWake = nil
        guard let deadline = intent.sleep.endsAt else { return }
        let work = DispatchWorkItem { [weak self] in
            self?.playbackAllowed()
            if self?.intent.sleep.endsAt != nil { self?.scheduleSleep() }
        }
        sleepWake = work
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, deadline / 1000 - Date().timeIntervalSince1970), execute: work)
    }
    private func cursor() -> PlaybackArchive.Cursor? {
        guard queue.indices.contains(index) else { return nil }
        return PlaybackArchive.Cursor(revision: revision, index: index, position: position, repeatMode: repeatMode.rawValue)
    }
    private func checkpoint() {
        guard let archive, let cursor = cursor(), player.currentItem != nil || deferredPosition != nil else { return }
        archiveWorker.async { try? archive.checkpoint(cursor) }
    }
    private func prepareQueue(_ tracks: [Track], index: Int, position: Double, order: PlayerQueueOrder,
                              continuation: LibraryContinuation?, previous: PlaybackArchive.Previous?) throws -> PlaybackArchive.Prepared {
        let cursor = PlaybackArchive.Cursor(revision: UUID(), index: index, position: position, repeatMode: repeatMode.rawValue)
        return try PlaybackArchive.prepare(tracks.map(\.saved), cursor: cursor, continuation: continuation,
                                           order: order.saved(tracks.map(\.key)), previous: previous)
    }
    private func saveQueue(_ prepared: PlaybackArchive.Prepared? = nil, completion: ((Error?) -> Void)? = nil) {
        guard let archive else {
            completion?(userID == nil ? nil : OfflineFiles.Failure("Could not open the queue on this iPhone."))
            return
        }
        revision = prepared?.revision ?? UUID()
        guard let cursor = cursor() else { completion?(OfflineFiles.Failure("Choose a track first.")); return }
        let tracks = prepared == nil ? queue.map(\.saved) : []
        let savedOrder = prepared == nil ? order.saved(queue.map(\.key)) : nil
        let attached = continuation, previous = previousQueue
        archiveWorker.async {
            do {
                let record = try prepared ?? PlaybackArchive.prepare(tracks, cursor: cursor, continuation: attached,
                                                                     order: savedOrder, previous: previous)
                try archive.write(record)
                DispatchQueue.main.async {
                    if self.revision == cursor.revision && !record.keepsPrevious { self.previousQueue = nil }
                    completion?(nil)
                }
            } catch {
                DispatchQueue.main.async {
                    if self.revision == cursor.revision { self.error = "Could not save the queue on this iPhone." }
                    completion?(error)
                }
            }
        }
    }
    private func applySound(to item: AVPlayerItem, track: Track) {
        sound.apply(to: item, metadata: loudness.metadata(id: track.saved.id, inline: track.data))
    }

    private func updateLoudness() {
        guard sound.replayGain != "off", !sound.external else { loudness.clear(); return }
        let ids = Set(player.items().compactMap { item in
            streams[ObjectIdentifier(item)].flatMap { entry in queue.first(where: { $0.key == entry.key })?.saved.id }
        })
        let store = (try? DeviceOffline.shared.account(serverAddress, userID))?.1
        let online = network != .offline && (store.map { !$0.options().offlineOnly } ?? (userID == nil))
        loudness.update(ids: ids, server: serverAddress, token: token, online: online) { [weak self] in self?.refreshItemMixes() }
    }

    private func refreshItemMixes() {
        sound.invalidate()
        for item in player.items() {
            if let entry = streams[ObjectIdentifier(item)], let track = queue.first(where: { $0.key == entry.key }) {
                applySound(to: item, track: track)
            }
        }
        if let mix, let item = mix.incoming?.currentItem, let next = streams[ObjectIdentifier(mix.queued)],
           let track = queue.first(where: { $0.key == next.key }) { applySound(to: item, track: track) }
    }

    private func refreshSound() {
        updateLoudness()
        refreshItemMixes()
        if player.rate != 0 && intent.canPlay { player.rate = sound.speed }
        if let incoming = mix?.incoming, incoming.rate != 0 && intent.canPlay { incoming.rate = sound.speed }
    }
    @objc func soundSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                let speed = call.getDouble("speed"), mode = call.getString("replayGain")
                if speed != nil || mode != nil { try self.sound.configure(speed: speed, mode: mode); self.refreshSound() }
                call.resolve(self.sound.settings)
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func getEqualizer(_ call: CAPPluginCall) {
        DispatchQueue.main.async { call.resolve(self.sound.eqState) }
    }
    @objc func setEqualizer(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try self.sound.configureEqualizer(id: call.getString("outputId"), enabled: call.getBool("enabled") ?? false,
                                                  centers: call.getArray("centers", Int.self), levels: call.getArray("levels", Int.self),
                                                  preset: call.getString("preset") ?? "")
                self.refreshSound(); call.resolve(self.sound.eqState)
            } catch { call.reject(error.localizedDescription) }
        }
    }
    @objc func setEqualizerOutput(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                try self.sound.assign(id: call.getString("outputId") ?? "", assigned: call.getBool("assigned") ?? false)
                self.refreshSound(); call.resolve(self.sound.eqState)
            } catch { call.reject(error.localizedDescription) }
        }
    }
    private func delivery() -> [String: Any]? {
        guard let item = player.currentItem, let entry = streams[ObjectIdentifier(item)] else { return nil }
        switch entry.source {
        case .unavailable: return nil
        case .saved(let url):
            guard queue.indices.contains(index), let id = queue[index].data["id"] as? String,
                  let (_, store) = try? DeviceOffline.shared.account(serverAddress, userID),
                  let row = store.representation(id, file: url) else { return ["source": "device"] }
            var result: [String: Any] = ["source": row.origin.rawValue]
            result["mime"] = row.mime
            return result
        case .network:
            var result: [String: Any] = ["source": "network", "profile": entry.network == .wifi ? "wifi" : "cellular",
                                        "network": entry.network.rawValue, "requestedFormat": entry.profile.requestedFormat]
            if entry.profile.format != "original" { result["requestedRate"] = entry.profile.rate }
            if let stream = entry.stream {
                result["mime"] = stream.openedMIME
                result["response"] = stream.deliveryKind
            }
            return result
        }
    }
    @objc func widgetAction(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = call.getString("url"), let server = call.getString("serverUrl"),
                  let user = call.getString("userId"), self.serverAddress == server, self.userID == user else {
                call.resolve(["opened": false]); return
            }
            let track = self.queue.indices.contains(self.index) ? self.queue[self.index].data["id"] as? String : nil
            guard let action = self.widget.action(url, server: server, user: user, track: track, index: self.index) else {
                call.resolve(["opened": false]); return
            }
            do {
                switch action {
                case "play": if !self.intent.requested { try self.resume() }
                case "pause": self.pause()
                case "previous": try self.previous()
                case "next": try self.next()
                default: break
                }
                self.publishNowPlaying(); call.resolve(["opened": true])
            } catch { call.reject("Audio playback is unavailable.") }
        }
    }
    @objc func signalPath(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var result = self.sound.output()
            if self.queue.indices.contains(self.index) { result["id"] = self.queue[self.index].data["id"] }
            if let item = self.player.currentItem { result["equalizer"] = item.audioMix != nil && self.sound.eqEnabled }
            result["delivery"] = self.delivery()
            call.resolve(result)
        }
    }
    private func previousSnapshot() -> PlaybackArchive.Previous? {
        guard let cursor = cursor() else { return nil }
        return PlaybackArchive.Previous(tracks: queue.map(\.saved), cursor: cursor,
                                     continuation: continuation, order: order.saved(queue.map(\.key)), playing: intent.requested)
    }
    private func restorePrevious() throws {
        guard let old = previousQueue, let base = URL(string: serverAddress) else { return }
        let restored = try old.tracks.map { try queueTrack($0, base: base) }
        let current = previousSnapshot()
        if old.playing { try requestPlayback() } else { pause() }
        finishHistory(); clearItems()
        previousQueue = current
        queue = restored; index = old.cursor.index
        order = PlayerQueueOrder(old.order, keys: restored.map(\.key), current: index)
        repeatMode = RepeatMode(rawValue: old.cursor.repeatMode) ?? .off
        attachWindow(old.continuation, tracks: restored)
        move(to: index, from: old.cursor.position)
        saveQueue()
    }
    private var allowsSuggestions: Bool {
        guard continuation == nil, repeatMode == .off, intent.sleep.state == nil, network != .offline,
              !serverAddress.isEmpty, PlayerAutoplay.setting(server: serverAddress, user: userID),
              let (_, store) = try? DeviceOffline.shared.account(serverAddress, userID) else { return false }
        return !store.options().offlineOnly
    }
    private func cancelSuggestions() {
        suggestionID = UUID(); suggestions.cancel(); waitingForSuggestions = false; suggestionProblem = nil
    }
    private func loadSuggestions() {
        guard allowsSuggestions, intent.canPlay, !suggestions.loading, suggestionProblem == nil,
              queue.indices.contains(index), queue.count - index <= 3, let last = queue.last?.key,
              let base = URL(string: serverAddress) else { return }
        let ticket = suggestionID
        suggestions.load(server: serverAddress, user: userID, token: token, tracks: queue.map(\.data)) { [weak self] outcome in
            guard let self, self.suggestionID == ticket, self.queue.last?.key == last, self.allowsSuggestions, self.intent.canPlay else { return }
            do {
                let rows = try outcome.get()
                let next = try rows.map { row -> Track in
                    let (saved, url) = try DeviceOffline.track(row, base)
                    return Track(data: row, url: url, saved: saved)
                }
                guard !next.isEmpty else { throw OfflineFiles.Failure("No similar library tracks are available.") }
                let restart = self.waitingForSuggestions || self.player.currentItem == nil
                func appendSuggestions(removing played: Int) throws {
                    let first = self.queue.count - played
                    let combined = Array(self.queue.dropFirst(played)) + next
                    let newIndex = restart ? first : self.index - played
                    var order = self.order
                    order.remove(Set(self.queue.prefix(played).map(\.key)))
                    let record = try self.prepareQueue(combined, index: newIndex, position: restart ? 0 : self.position,
                                                       order: order, continuation: nil, previous: self.previousQueue)
                    self.order = order; self.queue = combined; self.index -= played
                    self.waitingForSuggestions = false
                    if restart { self.move(to: first) } else { self.updateCurrentItem() }
                    self.saveQueue(record)
                }
                // Preserve normal queue history. Long-running radio can release consumed entries.
                let trim = self.queue.count + next.count > 2_000 ? max(0, self.index - LibraryContinuation.previousLimit) : 0
                do { try appendSuggestions(removing: trim) }
                catch let issue as OfflineFiles.Failure where issue.code == "QUEUE_TOO_LARGE" && trim < self.index {
                    try appendSuggestions(removing: self.index)
                }
            } catch {
                let waiting = self.waitingForSuggestions
                if waiting { self.pause() }
                self.suggestionProblem = error.localizedDescription
            }
        }
    }
    @objc func autoplaySetting(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let server = call.getString("serverUrl"), let user = call.getString("userId"), !user.isEmpty else {
                call.resolve(["enabled": false]); return
            }
            let enabled = PlayerAutoplay.setting(server: server, user: user, enabled: call.getBool("enabled"))
            if self.serverAddress == server && self.userID == user && call.getBool("enabled") != nil {
                if !enabled && self.waitingForSuggestions { self.pause() }
                self.cancelSuggestions(); self.loadSuggestions()
            }
            call.resolve(["enabled": enabled])
        }
    }
    private func updateReadAhead() {
        guard !serverAddress.isEmpty, queue.indices.contains(index) else { return }
        let next = intent.canPlay ? queue.dropFirst(index + 1).prefix(50).map(\.data) : []
        DeviceOffline.shared.cacheUpcoming(server: serverAddress, user: userID, token: token, tracks: next, network: network,
                                          profile: profiles.profile(network))
    }
    private func detachWindow() {
        pageID = UUID()
        pageLoad?.cancel(); pageLoad = nil
        continuation = nil; pageProblem = nil
        waitingForWindow = false
        seenLibraryIDs.removeAll(); seenCursors.removeAll()
    }
    private func attachWindow(_ state: LibraryContinuation?, tracks: [Track]) {
        detachWindow()
        continuation = state
        guard let state else { return }
        seenLibraryIDs = Set(tracks.filter { !order.extras.contains($0.key) }.compactMap { $0.data["id"] as? String })
        if let cursor = state.after { seenCursors.insert(cursor) }
    }
    private var hasNextPage: Bool { continuation?.after != nil || (continuation != nil && repeatMode == .all) }
    private var atLibraryBoundary: Bool { queue.indices.contains(index) && index == queue.count - 1 && hasNextPage }
    private func atWindowEnd() {
        guard hasNextPage else { return }
        waitingForWindow = true
        if pageProblem == nil && playbackAllowed() { loadWindow(force: true) }
    }
    private func loadWindow(force: Bool = false) {
        guard let state = continuation, pageLoad == nil,
              force || (playbackAllowed() && repeatMode != .one && pageProblem == nil && queue.count - index - 1 <= LibraryContinuation.refillAt) else { return }
        let restart = waitingForWindow && state.after == nil && repeatMode == .all
        guard restart || state.after != nil else { return }
        if network == .offline || (try? DeviceOffline.shared.account(serverAddress, userID).1.options().offlineOnly) == true {
            if force { pageProblem = "Reconnect or turn off offline-only playback to load more songs." }
            return
        }
        do {
            let req = try state.request(serverAddress, token: token, restart: restart)
            let id = UUID(); pageID = id; pageProblem = nil
            let load = LibraryPageLoad { [weak self] result in
                DispatchQueue.main.async {
                    guard let self, self.pageID == id else { return }
                    self.pageLoad = nil
                    do {
                        let page = try result.get()
                        let (next, tracks) = try state.accepting(page, existing: self.seenLibraryIDs, cursors: self.seenCursors, restart: restart)
                        try self.extendWindow(next, tracks: tracks, restart: restart)
                    } catch { self.pageProblem = error.localizedDescription }
                }
            }
            pageLoad = load; load.start(req)
        } catch { pageProblem = error.localizedDescription }
    }
    private func queueTrack(_ saved: OfflineFiles.Track, base: URL) throws -> Track {
        var data = try OfflineFiles.dictionary(saved)
        let (_, url) = try DeviceOffline.track(data, base)
        data["streamUrl"] = url.absoluteString
        if let art = saved.artworkUrl {
            data["artworkUrl"] = base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + art
        }
        return Track(data: data, url: url, saved: saved)
    }
    private func extendWindow(_ next: LibraryContinuation, tracks: [OfflineFiles.Track], restart: Bool) throws {
        guard let base = URL(string: serverAddress) else { throw OfflineFiles.Failure("Invalid DN server.") }
        let incoming = try tracks.map { try queueTrack($0, base: base) }
        let (remove, firstNew) = try LibraryContinuation.placement(current: index, count: queue.count, incoming: incoming.count, restart: restart)
        let extended = Array(queue.dropFirst(remove)) + incoming
        guard try JSONSerialization.data(withJSONObject: extended.map(\.data)).count <= 1_048_576 else {
            throw OfflineFiles.Failure("The next library page exceeds the mobile queue limit.")
        }
        if restart || seenCursors.count >= 16 { seenCursors.removeAll() }
        order.remove(Set(queue.prefix(remove).map(\.key)))
        seenLibraryIDs = Set(extended.filter { !order.extras.contains($0.key) }.compactMap { $0.data["id"] as? String })
        if let cursor = next.after { seenCursors.insert(cursor) }
        continuation = next; pageProblem = nil
        queue = extended
        if waitingForWindow {
            move(to: firstNew)
        } else {
            index -= remove; updateCurrentItem()
        }
        saveQueue()
    }
    private func attachArchive(_ address: String, _ user: String?) {
        guard let folder = try? DeviceOffline.directory("DNPlayback", address: address, user: user).1 else { archive = nil; return }
        archive = try? PlaybackArchive(folder: folder)
    }
    private func clearItems(keepingHistory: Bool = false) {
        loudness.clear(); sound.invalidate()
        cancelMix(); protectedIntro = nil; keepIntro = nil
        waveforms.stop()
        if keepingHistory { sampleHistory(pausedForReplacement: true); historyItem = nil }
        else { finishHistory() }
        cancelReconnect()
        itemStatus = nil; observedItem = nil
        clearArtwork()
        deferredPosition = nil; seekInFlight = false
        player.pause()
        player.removeAllItems()
        for (_, entry) in streams { entry.stream?.close() }
        streams.removeAll()
        error = nil
    }

    // A refill, edit or offline-source change may replace the item while playback remains suspended.
    private func move(to position: Int, from seconds: Double = 0, keepingHistory: Bool = false) {
        guard queue.indices.contains(position) else { return }
        let stayDeferred = !playbackAllowed() && player.currentItem == nil
        let occurrence = keepingHistory ? player.currentItem.flatMap { streams[ObjectIdentifier($0)]?.occurrence } ?? history.occurrence : nil
        clearItems(keepingHistory: occurrence != nil)
        index = position
        intent.sleep.moved(to: queue[position].key)
        waitingForWindow = false
        updateSleepBoundary()
        if stayDeferred { deferredPosition = seconds; checkpoint(); loadArtwork(); publishNowPlaying(); return }
        deferredPosition = seconds > 0 ? seconds : nil
        append(position, occurrence: occurrence ?? UUID())
        updateCurrentItem()
        applyFade()
        playWhenReady()
        checkpoint()
    }

    private func cancelReconnect() {
        reconnectWork?.cancel(); reconnectWork = nil; failedStream = nil; reconnectStart = nil; stalledAt = nil
    }

    private func itemFailed(_ item: AVPlayerItem, cause: Error?) {
        guard item === player.currentItem else { return }
        let stream = streams[ObjectIdentifier(item)]?.stream
        if deferredPosition == nil {
            let current = item.currentTime().seconds
            deferredPosition = current.isFinite && current > 0 ? current : lastItemPosition
        }
        if stream != nil && intent.requested && PlaybackReconnect.recoverable(stream?.failure ?? cause) {
            failedStream = item
            sampleHistory(pausedForReplacement: true)
            scheduleReconnectIfNeeded()
        } else {
            error = stream?.errorMessage ?? (stream == nil ? "The offline copy is unavailable or cannot be played by this device." : "This track could not be played.")
            pause()
        }
    }

    private func stalledOnOldRoute(_ route: Int) -> Bool {
        route != routeVersion && (player.timeControlStatus == .waitingToPlayAtSpecifiedRate ||
            stalledAt.map { abs(position - $0) <= 0.25 } == true)
    }

    // AVFoundation usually continues from its own buffer across a path change.
    // Reopen only a failed stream or one still waiting on its previous network.
    private func scheduleReconnectIfNeeded() {
        guard reconnectWork == nil, pathAvailable, playbackAllowed(), let item = player.currentItem,
              let entry = streams[ObjectIdentifier(item)], entry.source == .network,
              failedStream === item || stalledOnOldRoute(entry.route) else { return }
        let stalled = failedStream !== item
        guard let delay = reconnect.delay(for: entry.occurrence) else {
            deferredPosition = position
            error = "Could not reconnect to DroppedNeedle."; pause()
            return
        }
        let work = DispatchWorkItem { [weak self, weak item] in
            guard let self else { return }
            self.reconnectWork = nil
            guard let item, self.player.currentItem === item, self.pathAvailable, self.playbackAllowed(),
                  self.failedStream === item || self.stalledOnOldRoute(entry.route),
                  self.queue.indices.contains(self.index), self.queue[self.index].key == entry.key else { return }
            let at = self.deferredPosition ?? (item.currentTime().seconds.isFinite ? self.position : self.lastItemPosition)
            self.reconnect.started(entry.occurrence)
            self.move(to: self.index, from: at, keepingHistory: true)
            self.reconnectStart = at
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (stalled ? max(3, delay) : delay), execute: work)
    }

    private func offlineFilesChanged() {
        cancelMix()
        guard queue.indices.contains(index), let (_, store) = try? DeviceOffline.shared.account(serverAddress, userID) else { return }
        if store.options().offlineOnly {
            cancelSuggestions()
            if artworkPlan?.remote != nil { clearArtwork(); publishNowPlaying() }
            if pageLoad != nil {
                pageID = UUID()
                pageLoad?.cancel(); pageLoad = nil
                if waitingForWindow { pageProblem = "Reconnect or turn off offline-only playback to load more songs." }
            }
            if let item = player.currentItem, streams[ObjectIdentifier(item)]?.source == .network {
                let at = position
                if let id = queue[index].data["id"] as? String, case .saved = store.source(id) {
                    move(to: index, from: at, keepingHistory: true)
                } else {
                    intent.pause()
                    clearItems()
                    deferredPosition = at
                    error = "This track is not saved on this device."
                    checkpoint(); publishNowPlaying()
                }
                return
            }
        }
        if let next = player.items().dropFirst().first, let entry = streams[ObjectIdentifier(next)],
           let track = queue.first(where: { $0.key == entry.key }), let id = track.data["id"] as? String,
           store.source(id) != entry.source {
            player.remove(next)
            streams.removeValue(forKey: ObjectIdentifier(next))?.stream?.close()
        }
        updateCurrentItem()
    }

    private func append(_ index: Int, occurrence: UUID = UUID()) {
        let profile = profiles.profile(network)
        let track = queue[index]
        let library = try? DeviceOffline.shared.account(serverAddress, userID)
        let metadata = library.flatMap { try? DeviceOffline.track(track.data, $0.0).0 }
        var stream: LibraryStream?
        let item: AVPlayerItem
        let source = (track.data["id"] as? String).flatMap { library?.1.source($0, touch: true) }
            ?? (library?.1.options().offlineOnly == true ? .unavailable : .network)
        switch source {
        case let .saved(local):
            item = AVPlayerItem(url: local)
        case .unavailable:
            item = AVPlayerItem(url: FileManager.default.temporaryDirectory.appendingPathComponent("missing-" + UUID().uuidString))
        case .network:
            let capture = library.flatMap { entry in metadata.flatMap { OfflinePlaybackCapture(store: entry.1, track: $0) } }
            let remote = LibraryStream(url: track.url, token: token, profile: profile, capture: capture)
            stream = remote
            item = AVPlayerItem(asset: remote.asset)
        }
        applySound(to: item, track: track)
        streams[ObjectIdentifier(item)] = (queue[index].key, occurrence, profile, source, network, routeVersion, stream)
        player.insert(item, after: player.items().last)
    }

    private func updateCurrentItem() {
        let retained = Set(player.items().map { ObjectIdentifier($0) })
        for key in Array(streams.keys) where !retained.contains(key) {
            streams.removeValue(forKey: key)?.stream?.close()
        }
        guard let item = player.currentItem, let entry = streams[ObjectIdentifier(item)],
              let activeIndex = queue.firstIndex(where: { $0.key == entry.key }) else {
            loudness.clear()
            loadArtwork()
            if deferredPosition == nil && retained.isEmpty {
                if !atLibraryBoundary && !(allowsSuggestions && index == queue.count - 1 && intent.requested && suggestionProblem == nil) { intent.pause() }
                else if allowsSuggestions && intent.requested { waitingForSuggestions = true; loadSuggestions() }
            }
            publishNowPlaying()
            return
        }
        let advanced = index != activeIndex
        index = activeIndex
        if !order.priority.isEmpty {
            let consumed = queue.prefix(index + 1).compactMap { order.priority.contains($0.key) ? $0.key : nil }
            if !consumed.isEmpty { order.priority.subtract(consumed) }
        }
        if advanced { intent.sleep.moved(to: queue[index].key); checkpoint() }
        if observedItem !== item {
            protectedIntro = (keepIntro === item) ? item : nil
            if mix?.outgoing !== item { cancelMix() }
            // An automatic AVQueuePlayer advance must not carry the old item's pending seek into its successor.
            if itemStatus != nil { deferredPosition = nil; seekInFlight = false }
            cancelReconnect()
            lastItemPosition = deferredPosition ?? 0
            observedItem = item
            error = nil
            itemStatus = item.observe(\.status, options: [.initial, .new]) { [weak self, weak item] _, _ in
                DispatchQueue.main.async {
                    guard let self, let item, self.player.currentItem === item else { return }
                    if item.status == .readyToPlay {
                        if self.deferredPosition != nil { self.applyDeferredPosition(item) }
                        else { self.playWhenReady() }
                    }
                    if item.status == .failed {
                        self.itemFailed(item, cause: item.error)
                    }
                    self.publishNowPlaying()
                }
            }
        }
        loadArtwork()
        let following = intent.sleep.track == nil ? nextIndex(automatic: true) : nil
        if let prepared = player.items().dropFirst().first {
            let upcoming = streams[ObjectIdentifier(prepared)]
            if following.map({ queue[$0].key }) != upcoming?.key || profiles.profile(network) != upcoming?.profile {
                cancelMix()
                player.remove(prepared)
                streams.removeValue(forKey: ObjectIdentifier(prepared))?.stream?.close()
            }
        }
        if player.items().count == 1, let following { append(following) }
        updateLoudness()
        loadWindow(); loadSuggestions(); updateReadAhead()
        publishNowPlaying()
    }

    private func clearArtwork() {
        artworkAccess?.cancel()
        artworkAccess = nil
        artworkPlan = nil
        artwork = nil
    }
    private var artworkOccurrence: UUID? {
        guard queue.indices.contains(index) else { return nil }
        if let item = player.currentItem {
            guard let entry = streams[ObjectIdentifier(item)], entry.key == queue[index].key else { return nil }
            return entry.occurrence
        }
        // A signed-in paused restore can read its saved cover before the first Play.
        return deferredPosition != nil && error == nil ? queue[index].key : nil
    }
    private func loadArtwork() {
        guard let occurrence = artworkOccurrence else { clearArtwork(); return }
        let track = queue[index], id = track.data["id"] as? String
        let store = (try? DeviceOffline.shared.account(serverAddress, userID))?.1
        let onlineRevision = store?.onlineRevision()
        let legacy = userID == nil
        let allowed: @Sendable () -> Bool = {
            guard let store else { return legacy }
            return onlineRevision != nil && store.onlineRevision() == onlineRevision
        }
        var saved: URL?
        if let id, let store, case .saved(let local) = store.source(id) { saved = local }
        let url = (track.data["artworkUrl"] as? String).flatMap { URL(string: $0) }
        let online = player.currentItem != nil && network != .offline && allowed()
        let plan = PlaybackArtworkPlan(server: serverAddress, user: userID, occurrence: occurrence, remote: url,
                                       saved: saved, online: online, revision: onlineRevision)
        guard plan != artworkPlan else { return }
        clearArtwork()
        artworkPlan = plan
        guard plan.remote != nil || plan.saved != nil else { return }
        let credential = token
        let access = PlaybackArtworkAccess()
        artworkAccess = access
        PlaybackArtworkImage.load(plan, token: credential, access: access, allowed: allowed) { [weak self] cgImage, source in
            DispatchQueue.main.async { [weak self] in
                guard let self, self.artworkAccess === access, access.active, self.artworkPlan == plan,
                      self.serverAddress == plan.server, self.userID == plan.user, self.token == credential,
                      self.artworkOccurrence == occurrence else { return }
                if source == .dn && (!allowed() || self.network == .offline) {
                    self.loadArtwork(); self.publishNowPlaying(); return
                }
                if source == .embedded, let id, let local = plan.saved, store?.source(id) != .saved(local) {
                    self.loadArtwork(); self.publishNowPlaying(); return
                }
                let image = UIImage(cgImage: cgImage)
                self.artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
                self.publishNowPlaying()
            }
        }
    }

    private var position: Double {
        if let deferredPosition { return deferredPosition }
        let seconds = player.currentTime().seconds
        return seconds.isFinite ? max(0, seconds) : 0
    }

    private var duration: Double {
        if let seconds = player.currentItem?.duration.seconds, seconds.isFinite { return seconds }
        return queue.indices.contains(index) ? queue[index].data["duration"] as? Double ?? 0 : 0
    }

    private func publishNowPlaying() {
        let remote = MPRemoteCommandCenter.shared()
        remote.nextTrackCommand.isEnabled = nextIndex(automatic: false) != nil || continuation?.after != nil || (continuation != nil && repeatMode == .all)
        remote.previousTrackCommand.isEnabled = queue.indices.contains(index)
        remote.changePlaybackRateCommand.isEnabled = queue.indices.contains(index)
        remote.changeRepeatModeCommand.isEnabled = queue.indices.contains(index)
        remote.changeShuffleModeCommand.isEnabled = order.original != nil || queue.count - index > 2
        remote.changeShuffleModeCommand.currentShuffleType = order.original == nil ? .off : .items
        remote.changeRepeatModeCommand.currentRepeatType = repeatMode == .all ? .all : repeatMode == .one ? .one : .off
        guard queue.indices.contains(index) else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
        let track = queue[index].data
        widget.publish(server: serverAddress, user: userID, track: track, index: index, playing: intent.requested,
                       canNext: remote.nextTrackCommand.isEnabled, art: artwork)
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track["title"] as? String ?? "",
            MPMediaItemPropertyArtist: track["artist"] as? String ?? "",
            MPMediaItemPropertyAlbumTitle: track["album"] as? String ?? "",
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
            MPNowPlayingInfoPropertyPlaybackRate: player.rate
        ]
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func requestPlayback() throws {
        // An explicit Play may start a fresh session after an expired timer or an unpaired interruption.
        playbackAllowed()
        try activateAudio()
        intent.userActivated()
        reconnect = PlaybackReconnect()
    }
    private func resume() throws {
        guard queue.indices.contains(index) else { return }
        try requestPlayback()
        startRequestedPlayback()
    }
    private func startRequestedPlayback(afterInterruption: Bool = false) {
        guard playbackAllowed(), queue.indices.contains(index) else { return }
        updateSleepBoundary()
        if waitingForWindow || (player.currentItem == nil && deferredPosition == nil && repeatMode != .one && atLibraryBoundary) {
            waitingForWindow = true
            if !afterInterruption || pageProblem == nil { loadWindow(force: true) }
            return
        }
        if player.currentItem == nil || player.currentItem?.status == .failed || failedStream != nil || error != nil {
            move(to: index, from: deferredPosition ?? position, keepingHistory: true)
        } else if !afterInterruption && duration > 0 && position >= duration - 0.05 {
            move(to: nextIndex(automatic: false) ?? index)
        } else {
            if let item = player.currentItem, deferredPosition != nil { applyDeferredPosition(item) }
            else { playWhenReady() }
        }
    }

    private func pause() {
        // Keep the failed item's position for an explicit Play. A delayed retry must never override Pause.
        reconnectWork?.cancel(); reconnectWork = nil
        cancelSuggestions()
        intent.pause()
        updateReadAhead()
        silence()
    }
    private func silence() {
        cancelMix()
        player.pause()
        sampleHistory(); checkpoint(); publishNowPlaying()
    }

    private func toggle() throws {
        if intent.requested { pause() } else { try resume() }
    }

    private func nextIndex(automatic: Bool) -> Int? {
        guard queue.indices.contains(index) else { return nil }
        if automatic && repeatMode == .one { return index }
        if queue.indices.contains(index + 1) { return index + 1 }
        return repeatMode == .all && continuation == nil ? 0 : nil
    }

    private func select(_ target: Int) throws {
        guard queue.indices.contains(target) else { return }
        cancelSuggestions()
        try requestPlayback()
        move(to: target)
    }

    private func next() throws {
        if let target = nextIndex(automatic: false) { try select(target) }
        else if hasNextPage {
            try requestPlayback(); atWindowEnd()
        }
    }

    private func previous() throws {
        if position > 3 { seek(0) }
        else if index > 0 { try select(index - 1) }
        else if repeatMode == .all && continuation == nil { try select(queue.count - 1) }
        else { seek(0) }
    }

    private func clearQueue(eraseSaved: Bool = true, keepHistorySession: Bool = false) {
        generation += 1
        cancelSuggestions(); order = PlayerQueueOrder(); previousQueue = nil
        if !serverAddress.isEmpty { DeviceOffline.shared.cacheUpcoming(server: serverAddress, user: userID, token: token, tracks: [], network: network, profile: profiles.profile(network)) }
        detachWindow()
        if eraseSaved { widget.clear() }
        if eraseSaved, let archive { archiveWorker.sync { try? archive.erase() } }
        archive = nil
        intent = PlaybackIntent(); scheduleSleep()
        if !keepHistorySession { offlineHistory.authorize(nil); reports.permissionsChanged() }
        clearItems()
        if !keepHistorySession { historyOwner = nil }
        queue = []
        token = ""
        serverAddress = ""
        userID = nil
        profiles = StreamProfiles()
        repeatMode = .off
        index = -1
        publishNowPlaying()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func edit(_ action: String, from: Int, to: Int) {
        cancelMix()
        guard queue.indices.contains(index) else { return }
        let current = queue[index].key
        switch action {
        case "cycleRepeat": repeatMode = repeatMode == .off ? .all : repeatMode == .all ? .one : .off
        case "clearUpcoming":
            order.remove(Set(queue[(index + 1)...].map(\.key)))
            queue.removeSubrange((index + 1)..<queue.count)
        case "shuffleUpcoming":
            let rows = Dictionary(uniqueKeysWithValues: queue.map { ($0.key, $0) })
            let ids = rows.mapValues { $0.data["id"] as? String ?? "" }
            let normal = queue.dropFirst(index + 1).filter { !order.priority.contains($0.key) }
            let scope = ([serverAddress, userID ?? ""] + normal.map { ids[$0.key] ?? "" }.sorted())
            func hash(_ strings: [String]) -> String {
                SHA256.hash(data: (try? JSONEncoder().encode(strings)) ?? Data()).map { String(format: "%02x", $0) }.joined()
            }
            let membership = hash(scope)
            var recent = UserDefaults.standard.array(forKey: "dn.shuffle.orders") as? [[String: String]] ?? []
            let ranks = order.toggle(queue.map(\.key), current: index, ids: ids,
                                     excluded: recent.last(where: { $0["set"] == membership })?["order"], hash: hash)
            queue = ranks.compactMap { rows[$0] }
            if order.original != nil {
                let arranged = queue.dropFirst(index + 1).filter { !order.priority.contains($0.key) }
                recent.removeAll { $0["set"] == membership }
                recent.append(["set": membership, "order": hash(arranged.compactMap { ids[$0.key] })])
                UserDefaults.standard.set(Array(recent.suffix(128)), forKey: "dn.shuffle.orders")
            }
        case "prioritize":
            guard from > index && queue.indices.contains(from) else { return }
            let at = order.insertion("upNext", in: queue.map(\.key), current: index)
            let entry = queue.remove(at: from)
            queue.insert(entry, at: from < at ? at - 1 : at)
            order.priority.insert(entry.key)
        case "move":
            guard queue.indices.contains(from), queue.indices.contains(to), from != to else { return }
            let entry = queue[from]
            if to > index && order.priority.contains(queue[to].key) { order.priority.insert(entry.key) }
            else { order.priority.remove(entry.key) }
            queue.remove(at: from); queue.insert(entry, at: to)
            order.original = nil
        case "remove":
            guard queue.indices.contains(from) else { return }
            order.remove([queue.remove(at: from).key])
            if queue.isEmpty { clearQueue(keepHistorySession: true); return }
            if from == index {
                move(to: min(from, queue.count - 1))
                return
            }
        default: return
        }
        if let kept = queue.firstIndex(where: { $0.key == current }) { index = kept }
        updateCurrentItem()
    }

    private func seek(_ value: Double) {
        cancelMix()
        guard value.isFinite, queue.indices.contains(index) else { return }
        if observedItem !== player.currentItem { updateCurrentItem() }
        deferredPosition = min(max(0, value), duration > 0 ? duration : Double.greatestFiniteMagnitude)
        sampleHistory(heartbeat: true); checkpoint()
        if let item = player.currentItem { applyDeferredPosition(item) }
        publishNowPlaying()
    }
    private func applyDeferredPosition(_ item: AVPlayerItem) {
        guard item.status == .readyToPlay, failedStream !== item, let seconds = deferredPosition, !seekInFlight else { return }
        seekInFlight = true
        item.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self, weak item] completed in
            DispatchQueue.main.async {
                guard let self, let item, self.player.currentItem === item else { return }
                self.seekInFlight = false
                guard self.failedStream !== item, item.status != .failed, self.error == nil else { return }
                if self.deferredPosition != seconds { self.applyDeferredPosition(item); return }
                self.deferredPosition = nil
                if completed { self.playWhenReady() }
                self.sampleHistory(heartbeat: true); self.checkpoint(); self.publishNowPlaying()
            }
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.playbackAllowed(); call.resolve(self.snapshot(knownQueue: call.getString("knownQueue"))) }
    }

    @objc func waveform(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let request = call.getString("request"), !request.isEmpty, self.queue.indices.contains(self.index),
                  let id = self.queue[self.index].data["id"] as? String, id == call.getString("trackId"),
                  let asset = self.player.currentItem?.asset else { call.resolve(["peaks":[]]); return }
            if let file = (asset as? AVURLAsset)?.url, file.isFileURL,
               let (_, store) = try? DeviceOffline.shared.account(self.serverAddress, self.userID),
               let peaks = store.peaks(id, file: file) { call.resolve(["peaks": peaks]); return }
            self.waveforms.read(asset, duration: self.duration, request: request) { peaks in call.resolve(["peaks":peaks]) }
        }
    }
    @objc func cancelWaveform(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.waveforms.cancel(call.getString("request") ?? ""); call.resolve() }
    }

    private func bufferedRanges() -> [[String: Double]] {
        guard queue.indices.contains(index), let item = player.currentItem,
              let entry = streams[ObjectIdentifier(item)], entry.key == queue[index].key else { return [] }
        let length = duration
        guard length.isFinite, length > 0 else { return [] }
        let complete: URL?
        if case .saved(let url) = entry.source { complete = url }
        else { complete = entry.stream?.completeFile }
        if let complete, FileManager.default.fileExists(atPath: complete.path) {
            return [["start": 0, "end": length]]
        }
        return item.loadedTimeRanges.compactMap { value in
            let range = value.timeRangeValue
            let start = range.start.seconds, end = CMTimeRangeGetEnd(range).seconds
            guard start.isFinite, end.isFinite, min(length, end) > max(0, start) else { return nil }
            return ["start": max(0, start), "end": min(length, end)]
        }
    }

    private func snapshot(knownQueue: String? = nil) -> [String: Any] {
        // A pending Play keeps its Pause control during buffering and interruptions.
        var result: [String: Any] = ["sleepTimer": intent.sleep.state as Any? ?? NSNull(), "queueVersion": queueVersion, "repeat": repeatMode.rawValue, "index": index, "playing": intent.requested,
                "position": position, "duration": duration, "bufferedRanges": bufferedRanges(), "error": error as Any? ?? NSNull()]
        if knownQueue != queueVersion {
            result["tracks"] = queue.map(\.data)
            result["upNext"] = queue.indices.filter { $0 > index && order.priority.contains(queue[$0].key) }
        }
        result["shuffled"] = order.original != nil
        result["hasPreviousQueue"] = previousQueue != nil
        result["autoplay"] = PlayerAutoplay.setting(server: serverAddress, user: userID)
        if let suggestionProblem { result["autoplayProblem"] = suggestionProblem }
        if let delivery = delivery() { result["delivery"] = delivery }
        if let c = continuation {
            var window: [String: Any] = ["loaded": c.loaded, "total": c.total, "offset": c.loaded - (queue.count - order.extras.count), "more": c.after != nil]
            if knownQueue != queueVersion { window["extras"] = queue.indices.filter { order.extras.contains(queue[$0].key) } }
            if let pageProblem { window["problem"] = pageProblem }
            result["libraryWindow"] = window
        }
        if let quality = PlaybackWaveform.quality(player.currentItem) { result["quality"] = quality }
        return result
    }

    /// Restore metadata and cursor only. No AVPlayerItem or stream opens before Play.
    @objc func restore(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let address = call.getString("serverUrl"), let token = call.getString("token"), !token.isEmpty,
                  let base = URL(string: address), base.scheme == "https", base.user == nil, base.password == nil,
                  base.host != nil, base.query == nil, base.fragment == nil else { call.reject("Invalid DN server."); return }
            let user = call.getString("userId")
            if !self.queue.isEmpty && self.serverAddress == address && self.userID == user && self.token == token { call.resolve(self.snapshot()); return }
            self.widget.owner(server: address, user: user)
            self.checkpoint(); self.clearQueue(eraseSaved: false)
            self.serverAddress = address; self.userID = user; self.token = token
            self.identifyHistory()
            if let raw = call.getObject("profiles") { self.profiles = StreamProfiles(wifi: StreamProfile(raw["wifi"]), cellular: StreamProfile(raw["cellular"])) }
            self.attachArchive(address, user)
            guard let archive = self.archive else { call.resolve(self.snapshot()); return }
            let generation = self.generation
            self.archiveWorker.async {
                let record: PlaybackArchive.Record?
                do { record = try archive.load() }
                catch { record = nil }
                DispatchQueue.main.async {
                    guard generation == self.generation, let record else { call.resolve(self.snapshot()); return }
                    do {
                        let queue = try record.tracks.map { try self.queueTrack($0, base: base) }
                        self.order = PlayerQueueOrder(record.order, keys: queue.map(\.key), current: record.cursor.index)
                        self.previousQueue = record.previous
                        self.attachWindow(record.continuation, tracks: queue)
                        self.queue = queue; self.index = record.cursor.index
                        self.revision = record.cursor.revision; self.repeatMode = RepeatMode(rawValue: record.cursor.repeatMode) ?? .off
                        self.deferredPosition = record.cursor.position
                        self.loadArtwork()
                        self.publishNowPlaying()
                        call.resolve(self.snapshot())
                    } catch { self.clearQueue(keepHistorySession: true); call.resolve(self.snapshot()) }
                }
            }
        }
    }

    @objc func setQueue(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let tracks = call.getArray("tracks", [String: Any].self), let index = call.getInt("index"),
                  tracks.indices.contains(index), let token = call.getString("token"), !token.isEmpty,
                  let address = call.getString("serverUrl"), let base = URL(string: address),
                  base.scheme == "https", base.host != nil, base.user == nil, base.password == nil, base.query == nil, base.fragment == nil else {
                call.reject("Choose a track from a connected DroppedNeedle library.")
                return
            }
            let path = base.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let api = (path.isEmpty ? "" : "/" + path) + "/api/v3/"
            func allowed(_ string: String?, prefix: String) -> URL? {
                guard let string, let url = URL(string: string), url.scheme == "https",
                      url.host?.lowercased() == base.host?.lowercased(), (url.port ?? 443) == (base.port ?? 443),
                      url.user == nil, url.password == nil, url.standardized.path.hasPrefix(api + prefix) else { return nil }
                return url
            }
            var checked: [Track] = []
            for track in tracks {
                guard let stream = allowed(track["streamUrl"] as? String, prefix: "stream/local/") else {
                    call.reject("Invalid DroppedNeedle stream.")
                    return
                }
                if let art = track["artworkUrl"] as? String, allowed(art, prefix: "") == nil {
                    call.reject("Invalid DroppedNeedle artwork.")
                    return
                }
                let canonical = StreamProfile.canonical(stream)
                var data = track
                data["streamUrl"] = canonical.absoluteString
                guard let (saved, _) = try? DeviceOffline.track(data, base) else {
                    call.reject("Choose a song from this DroppedNeedle library."); return
                }
                checked.append(Track(data: data, url: canonical, saved: saved))
            }
            let attached: LibraryContinuation?
            do {
                if let value = call.getObject("continuation") {
                    let state = try JSONDecoder().decode(LibraryContinuation.self, from: JSONSerialization.data(withJSONObject: value))
                    try state.validate(window: checked.compactMap { $0.data["id"] as? String })
                    attached = state
                } else { attached = nil }
            } catch { call.reject("Invalid library queue cursor."); return }
            self.generation += 1
            let raw = call.getObject("profiles")
            let profiles = StreamProfiles(wifi: StreamProfile(raw?["wifi"]), cellular: StreamProfile(raw?["cellular"]))
            let userID = call.getString("userId")
            do {
                let record: PlaybackArchive.Prepared
                if let placement = call.getString("placement"), !self.queue.isEmpty {
                    guard self.token == token, self.serverAddress == address, self.userID == userID else {
                        call.reject("This queue belongs to a different session.")
                        return
                    }
                    self.updateCurrentItem()
                    let target = self.order.insertion(placement, in: self.queue.map(\.key), current: self.index)
                    var proposedOrder = self.order, proposedQueue = self.queue
                    proposedOrder.inserted(checked.map(\.key), after: target > 0 ? self.queue[target - 1].key : nil, placement: placement)
                    proposedQueue.insert(contentsOf: checked, at: target)
                    record = try self.prepareQueue(proposedQueue, index: self.index, position: self.position, order: proposedOrder,
                                                   continuation: self.continuation, previous: self.previousQueue)
                    self.cancelSuggestions()
                    if raw != nil { self.profiles = profiles }
                    self.order = proposedOrder; self.queue = proposedQueue
                    self.updateCurrentItem()
                } else {
                    let previous = self.serverAddress == address && self.userID == userID ? self.previousSnapshot() : nil
                    let start = call.getDouble("positionSeconds") ?? 0
                    guard start.isFinite, start >= 0 else { call.reject("Invalid playback position."); return }
                    record = try self.prepareQueue(checked, index: index, position: start, order: PlayerQueueOrder(),
                                                   continuation: attached, previous: previous)
                    self.cancelSuggestions()
                    if call.getBool("playing") ?? true { try self.requestPlayback() } else { self.pause() }
                    self.finishHistory(); self.clearItems()
                    self.previousQueue = record.keepsPrevious ? previous : nil; self.order = PlayerQueueOrder()
                    self.clearArtwork()
                    if self.serverAddress != address || self.userID != userID { self.intent.sleep.cancel(); self.scheduleSleep() }
                    self.attachArchive(address, userID)
                    self.attachWindow(attached, tracks: checked)
                    self.queue = checked
                    self.token = token
                    self.serverAddress = address
                    self.userID = userID
                    self.identifyHistory()
                    self.profiles = profiles
                    self.move(to: index, from: start)
                }
                self.saveQueue(record) { error in
                    if error != nil { call.reject("Could not save the queue on this iPhone.") }
                    else { call.resolve(self.snapshot()) }
                }
            } catch let issue as OfflineFiles.Failure { call.reject(issue.localizedDescription) }
            catch { call.reject("Audio playback is unavailable.") }
        }
    }

    @objc func command(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            do {
                let action = call.getString("action") ?? ""
                self.updateCurrentItem()
                switch action {
                case "clear": self.clearQueue()
                case "restorePreviousQueue":
                    self.cancelSuggestions(); try self.restorePrevious()
                case "setPlaying":
                    if call.getInt("value") == 1 { if !self.intent.requested { try self.resume() } }
                    else { self.pause() }
                case "setAutoplay", "retryAutoplay":
                    let retry = action == "retryAutoplay" && self.suggestionProblem != nil && self.index == self.queue.count - 1 && self.player.currentItem == nil
                    if action == "setAutoplay" {
                        _ = PlayerAutoplay.setting(server: self.serverAddress, user: self.userID, enabled: call.getInt("value") == 1)
                        if self.waitingForSuggestions && !self.allowsSuggestions { self.pause() }
                    }
                    self.cancelSuggestions()
                    if retry { try self.requestPlayback(); self.waitingForSuggestions = true }
                    self.loadSuggestions()
                case "cycleRepeat", "clearUpcoming", "shuffleUpcoming", "move", "prioritize", "remove":
                    self.cancelSuggestions()
                    if !["cycleRepeat", "prioritize"].contains(action) { self.detachWindow() }
                    self.edit(action, from: call.getInt("value") ?? -1, to: call.getInt("to") ?? -1)
                    self.saveQueue()
                case "retryLibraryWindow": if self.pageProblem != nil || self.waitingForWindow { self.loadWindow(force: true) }
                case "setSleepMinutes":
                    self.cancelSuggestions()
                    guard self.queue.indices.contains(self.index), let value = call.getDouble("value"), value.isFinite,
                          value.rounded() == value, (1...240).contains(value) else { call.reject("Choose a timer from 1 to 240 minutes while a track is queued."); return }
                    try self.intent.sleep.minutes(Int(value), now: self.wallTime, finishLast: call.getInt("to") == 1)
                    self.scheduleSleep(); self.updateSleepBoundary(); self.updateCurrentItem()
                case "sleepAfterTrack":
                    self.cancelSuggestions()
                    guard self.queue.indices.contains(self.index) else { call.reject("Choose a track first."); return }
                    let count = call.getInt("value") ?? 1
                    guard (1...99).contains(count) else { call.reject("Choose between 1 and 99 tracks."); return }
                    self.intent.sleep.after(self.queue[self.index].key, count: count); self.scheduleSleep(); self.updateSleepBoundary()
                case "cancelSleepTimer":
                    self.intent.sleep.cancel(); self.scheduleSleep(); self.updateSleepBoundary(); self.updateCurrentItem()
                case "toggle": try self.toggle()
                case "previous": try self.previous()
                case "next": try self.next()
                case "skipTo": try self.select(call.getInt("value") ?? -1)
                case "seek": self.seek(call.getDouble("value") ?? 0)
                default: call.reject("Unknown playback command."); return
                }
                call.resolve(self.snapshot())
            } catch { call.reject("Audio playback is unavailable.") }
        }
    }

    deinit {
        loudness.clear()
        cancelMix(); stopTransportObservers(); waveforms.stop()
        pathMonitor.cancel(); sleepWake?.cancel(); pageLoad?.cancel(); offlineHistory.authorize(nil); reports.close()
        player.pause()
        for (_, entry) in streams { entry.stream?.close() }
        artworkAccess?.cancel()
        for listener in listeners { NotificationCenter.default.removeObserver(listener) }
        for (command, target) in commands { command.removeTarget(target) }
    }
}
