#import "DNPlayerDSP.h"
#import "DNFilterBank.h"
#import <MediaToolbox/MediaToolbox.h>

// The tap owns immutable settings and one set of filter delays per channel.
// The render callback does not allocate or call into Foundation.
typedef struct {
    double levels[DNBandCount], gain;
    DNBand bands[DNBandCount];
    bool usable;
} DNProcessor;

static void tapInit(MTAudioProcessingTapRef tap, void *clientInfo, void **storageOut) {
    *storageOut = clientInfo;
}
static void tapFinalize(MTAudioProcessingTapRef tap) {
    free(MTAudioProcessingTapGetStorage(tap));
}
static void tapPrepare(MTAudioProcessingTapRef tap, CMItemCount frames, const AudioStreamBasicDescription *desc) {
    DNProcessor *state = MTAudioProcessingTapGetStorage(tap);
    state->usable = desc->mFormatID == kAudioFormatLinearPCM && (desc->mFormatFlags & kAudioFormatFlagIsFloat)
        && !(desc->mFormatFlags & kAudioFormatFlagIsBigEndian) && desc->mBitsPerChannel == 32
        && desc->mChannelsPerFrame <= DNMaxChannels && desc->mSampleRate > 0;
    if (state->usable) DNPrepareBands(state->bands, state->levels, desc->mSampleRate);
}
static void tapUnprepare(MTAudioProcessingTapRef tap) {}
static void tapProcess(MTAudioProcessingTapRef tap, CMItemCount requested, MTAudioProcessingTapFlags flags,
                       AudioBufferList *buffers, CMItemCount *frames, MTAudioProcessingTapFlags *flagsOut) {
    if (MTAudioProcessingTapGetSourceAudio(tap, requested, buffers, flagsOut, NULL, frames) != noErr) {
        *frames = 0;
        return;
    }
    DNProcessor *state = MTAudioProcessingTapGetStorage(tap);
    if (!state->usable) return;
    if (*flagsOut & kMTAudioProcessingTapFlag_StartOfStream) {
        for (int i = 0; i < DNBandCount; ++i) {
            memset(state->bands[i].z1, 0, sizeof(state->bands[i].z1));
            memset(state->bands[i].z2, 0, sizeof(state->bands[i].z2));
        }
    }
    UInt32 first = 0;
    for (UInt32 i = 0; i < buffers->mNumberBuffers; ++i) {
        AudioBuffer *buffer = &buffers->mBuffers[i];
        UInt32 channels = buffer->mNumberChannels;
        if (!channels || first + channels > DNMaxChannels || !buffer->mData) return;
        float *samples = buffer->mData;
        size_t available = buffer->mDataByteSize / sizeof(float) / channels;
        for (size_t f = 0; f < available && f < (size_t)*frames; ++f)
            for (UInt32 ch = 0; ch < channels; ++ch) {
                size_t at = f * channels + ch;
                samples[at] = DNFilterSample(state->bands, first + ch, samples[at], state->gain);
            }
        first += channels;
    }
}
AVAudioMix *DNProcessingMix(AVAssetTrack *track, NSArray<NSNumber *> *levels, double gain) {
    if (levels.count != DNBandCount || !isfinite(gain) || gain < 0) return nil;
    DNProcessor *state = calloc(1, sizeof(DNProcessor));
    if (!state) return nil;
    state->gain = gain;
    for (int i = 0; i < DNBandCount; ++i) state->levels[i] = levels[i].doubleValue;
    MTAudioProcessingTapCallbacks callbacks = {
        kMTAudioProcessingTapCallbacksVersion_0, state, tapInit, tapFinalize, tapPrepare, tapUnprepare, tapProcess
    };
    MTAudioProcessingTapRef tap = NULL;
    if (MTAudioProcessingTapCreate(kCFAllocatorDefault, &callbacks, kMTAudioProcessingTapCreationFlag_PreEffects, &tap) != noErr) {
        free(state);
        return nil;
    }
    AVMutableAudioMixInputParameters *parameters = [AVMutableAudioMixInputParameters audioMixInputParametersWithTrack:track];
    parameters.audioTapProcessor = tap;
    CFRelease(tap);
    AVMutableAudioMix *mix = [AVMutableAudioMix audioMix];
    mix.inputParameters = @[parameters];
    return mix;
}
