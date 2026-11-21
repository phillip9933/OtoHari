#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN
/// Millibels in the DN equalizer's ten increasing frequency bands.
AVAudioMix * _Nullable DNProcessingMix(AVAssetTrack *track, NSArray<NSNumber *> *levels, double gain);
NS_ASSUME_NONNULL_END
