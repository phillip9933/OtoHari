import AVFoundation

/// Reads PCM from the asset already selected by the player, including local offline copies.
final class PlaybackWaveform {
    private final class Job {
        let id: String
        private let lock = NSLock()
        private var stopped = false
        private var reader: AVAssetReader?
        private let deadline: TimeInterval?

        init(_ id: String, timeLimit: TimeInterval? = nil) {
            self.id = id; deadline = timeLimit.map { ProcessInfo.processInfo.systemUptime + $0 }
        }
        func use(_ reader: AVAssetReader) -> Bool {
            lock.lock(); defer { lock.unlock() }
            guard !stopped else { return false }
            self.reader = reader
            return true
        }
        var cancelled: Bool {
            lock.lock(); defer { lock.unlock() }; return stopped || (deadline.map { ProcessInfo.processInfo.systemUptime >= $0 } ?? false)
        }
        func cancel() {
            lock.lock(); stopped = true; let old = reader; lock.unlock()
            old?.cancelReading()
        }
    }
    private let worker = DispatchQueue(label: "app.droppedneedle.waveform", qos: .utility)
    private var active: Job?

    func cancel(_ id: String) { if active?.id == id { active?.cancel() } }
    func stop() { active?.cancel(); active = nil }
    func read(_ asset: AVAsset, duration: Double, request: String, complete: @escaping ([Float]) -> Void) {
        stop()
        let job = Job(request)
        active = job
        worker.async {
            let peaks = (try? self.measure(asset, duration: duration, job: job)) ?? []
            DispatchQueue.main.async { complete(job.cancelled ? [] : peaks) }
        }
    }
    static func prepare(file: URL, duration: Double) async -> [Float] {
        guard file.isFileURL else { return [] }
        let job = Job("download", timeLimit: 10), decoder = PlaybackWaveform()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                decoder.worker.async {
                    let peaks = try? decoder.measure(AVURLAsset(url: file), duration: duration, job: job)
                    continuation.resume(returning: job.cancelled ? [] : peaks ?? [])
                }
            }
        } onCancel: { job.cancel() }
    }
    private func measure(_ asset: AVAsset, duration fallback: Double, job: Job) throws -> [Float] {
        guard !job.cancelled, let track = asset.tracks(withMediaType: .audio).first else { return [] }
        let seconds = asset.duration.seconds
        let duration = seconds.isFinite && seconds > 0 ? seconds : fallback
        guard duration.isFinite, duration > 0 else { return [] }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output), job.use(reader) else { return [] }
        reader.add(output)
        guard !job.cancelled, reader.startReading() else { return [] }
        defer { if reader.status == .reading { reader.cancelReading() } }
        var peaks = [Float](repeating: 0, count: 112)
        var measured = false
        while !job.cancelled {
            // Release each decoded buffer before requesting the next one.
            let keepReading: Bool = autoreleasepool {
                guard let sample = output.copyNextSampleBuffer() else { return false }
                guard let format = CMSampleBufferGetFormatDescription(sample),
                      let stream = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
                      let block = CMSampleBufferGetDataBuffer(sample) else { return true }
                let offset = CMSampleBufferGetPresentationTimeStamp(sample).seconds, size = CMBlockBufferGetDataLength(block)
                let rate = stream.mSampleRate, channels = Int(stream.mChannelsPerFrame)
                guard offset.isFinite, rate > 0, channels > 0, size >= 2 else { return true }
                var bytes = [Int16](repeating: 0, count: size / 2)
                let status = bytes.withUnsafeMutableBytes { p in
                    CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: p.count, destination: p.baseAddress!)
                }
                guard status == noErr else { return true }
                measured = true
                for frame in 0..<(bytes.count / channels) {
                    let bin = max(0, min(peaks.count-1, Int((offset + Double(frame)/rate) * Double(peaks.count)/duration)))
                    for channel in 0..<channels {
                        peaks[bin] = max(peaks[bin], abs(Float(bytes[frame*channels+channel])) / 32768)
                    }
                }
                return true
            }
            if !keepReading { break }
        }
        return measured && reader.status == .completed ? peaks : []
    }

    // Analyze only the two edges. Missing or incomplete buffers must not be mistaken for silence.
    func overlap(_ outgoing: AVAsset, _ incoming: AVAsset, complete: @escaping (Double?) -> Void) {
        stop()
        let job = Job(UUID().uuidString)
        active = job
        worker.async {
            let result: Double?
            if let tail = try? self.rmsEdge(outgoing, tail: true, job: job),
               let head = try? self.rmsEdge(incoming, tail: false, job: job) {
                result = TrackFades.overlap(tail: tail.levels, head: head.levels, outgoing: tail.duration, incoming: head.duration)
            } else { result = nil }
            DispatchQueue.main.async { if !job.cancelled { complete(result) } }
        }
    }

    private func rmsEdge(_ asset: AVAsset, tail: Bool, job: Job) throws -> (levels: [Double], duration: Double)? {
        let duration = asset.duration.seconds
        guard !job.cancelled, duration.isFinite, duration > 0, let track = asset.tracks(withMediaType: .audio).first else { return nil }
        let bins = min(80, Int(min(duration, 8) * 10))
        guard bins > 0 else { return nil }
        let span = Double(bins) / 10, start = tail ? max(0, duration - span) : 0
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 48000),
                                       duration: CMTime(seconds: span, preferredTimescale: 48000))
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output), job.use(reader) else { return nil }
        reader.add(output)
        guard !job.cancelled, reader.startReading() else { return nil }
        defer { if reader.status == .reading { reader.cancelReading() } }
        var sums = [Double](repeating: 0, count: bins), counts = [Int](repeating: 0, count: bins)
        var expected = 0.0
        while !job.cancelled {
            let read: Bool = autoreleasepool {
                guard let sample = output.copyNextSampleBuffer() else { return false }
                guard let format = CMSampleBufferGetFormatDescription(sample),
                      let stream = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
                      let block = CMSampleBufferGetDataBuffer(sample) else { return true }
                let offset = CMSampleBufferGetPresentationTimeStamp(sample).seconds
                let rate = stream.mSampleRate, channels = Int(stream.mChannelsPerFrame)
                let size = CMBlockBufferGetDataLength(block)
                guard offset.isFinite, rate > 0, channels > 0, size >= 2 else { return true }
                var bytes = [Int16](repeating: 0, count: size / 2)
                let status = bytes.withUnsafeMutableBytes {
                    CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: $0.count, destination: $0.baseAddress!)
                }
                guard status == noErr else { return true }
                expected = rate * Double(channels) / 10
                for frame in 0..<(bytes.count / channels) {
                    let relative = (offset - start + Double(frame) / rate) * 10
                    guard relative >= 0, relative < Double(bins) else { continue }
                    let bin = Int(relative)
                    for channel in 0..<channels {
                        let value = Double(bytes[frame * channels + channel]) / 32768
                        sums[bin] += value * value
                    }
                    counts[bin] += channels
                }
                return true
            }
            if !read { break }
        }
        guard !job.cancelled, reader.status == .completed, expected > 0 else { return nil }
        guard counts.allSatisfy({ Double($0) >= expected * 0.9 }) else { return nil }
        let levels = zip(sums, counts).map { sqrt($0.0 / Double($0.1)) }
        return (tail ? Array(levels.reversed()) : levels, duration)
    }

    static func quality(_ item: AVPlayerItem?) -> [String: Any]? {
        guard let track = item?.tracks.first(where: { $0.isEnabled && $0.assetTrack?.mediaType == .audio })?.assetTrack,
              let raw = track.formatDescriptions.first else { return nil }
        let desc = raw as! CMAudioFormatDescription
        guard let audio = CMAudioFormatDescriptionGetStreamBasicDescription(desc)?.pointee else { return nil }
        let codec: String
        switch audio.mFormatID {
        case kAudioFormatLinearPCM: codec = "PCM"
        case kAudioFormatFLAC: codec = "FLAC"
        case kAudioFormatAppleLossless: codec = "ALAC"
        case kAudioFormatMPEGLayer3: codec = "MP3"
        case kAudioFormatOpus: codec = "Opus"
        case kAudioFormatMPEG4AAC, kAudioFormatMPEG4AAC_HE, kAudioFormatMPEG4AAC_HE_V2: codec = "AAC"
        default:
            let id = audio.mFormatID.bigEndian
            guard let name = withUnsafeBytes(of: id, { String(bytes: $0, encoding: .ascii) })?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !name.isEmpty else { return nil }
            codec = name
        }
        var result: [String:Any] = ["format": codec]
        if audio.mSampleRate > 0 { result["sampleRate"] = Int(audio.mSampleRate) }
        if audio.mBitsPerChannel > 0 { result["bitDepth"] = Int(audio.mBitsPerChannel) }
        if track.estimatedDataRate > 0 { result["bitrate"] = Int((track.estimatedDataRate/1000).rounded()) }
        return result
    }
}
