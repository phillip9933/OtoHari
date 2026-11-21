#ifndef DN_FILTER_BANK_H
#define DN_FILTER_BANK_H
#include <math.h>
#include <string.h>

enum { DNBandCount = 10, DNMaxChannels = 8 };
typedef struct {
    double b0, b1, b2, a1, a2;
    double z1[DNMaxChannels], z2[DNMaxChannels];
    int active;
} DNBand;

static inline void DNPrepareBands(DNBand *bands, const double *levels, double rate) {
    static const double frequencies[DNBandCount] = {31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000};
    memset(bands, 0, sizeof(DNBand) * DNBandCount);
    for (int i = 0; i < DNBandCount; ++i) {
        if (levels[i] == 0 || frequencies[i] >= rate / 2) continue;
        const double omega = 2 * acos(-1) * frequencies[i] / rate;
        // Peaking EQ for logarithmically spaced, one-octave bands.
        const double A = pow(10, levels[i] / 4000), alpha = sin(omega) / (2 * sqrt(2.0));
        const double a0 = 1 + alpha / A;
        DNBand *b = &bands[i];
        b->b0 = (1 + alpha * A) / a0;
        b->b1 = b->a1 = -2 * cos(omega) / a0;
        b->b2 = (1 - alpha * A) / a0;
        b->a2 = (1 - alpha / A) / a0;
        b->active = 1;
    }
}
static inline float DNFilterSample(DNBand *bands, int channel, double value, double gain) {
    for (int i = 0; i < DNBandCount; ++i) {
        DNBand *b = &bands[i];
        if (!b->active) continue;
        double out = b->b0 * value + b->z1[channel];
        b->z1[channel] = b->b1 * value - b->a1 * out + b->z2[channel];
        b->z2[channel] = b->b2 * value - b->a2 * out;
        value = out;
    }
    return (float)fmax(-1, fmin(1, value * gain));
}
#endif
