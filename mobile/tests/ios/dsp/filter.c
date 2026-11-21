#include "../../../ios/App/App/DNFilterBank.h"
#include <assert.h>
#include <stdio.h>

static double powerAt(DNBand *bands, double gain) {
    double power = 0;
    for (int n = 0; n < 12000; ++n) {
        const double in = 0.1 * sin(n * 2 * acos(-1) * 1000 / 48000);
        const float sample = DNFilterSample(bands, 0, in, gain);
        if (n >= 2400) power += sample * sample;
        assert(DNFilterSample(bands, 1, 0, gain) == 0); // Stereo channels retain independent state.
    }
    return power;
}
int main(void) {
    DNBand bands[DNBandCount];
    double levels[DNBandCount] = {0};
    DNPrepareBands(bands, levels, 48000);
    double baseline = powerAt(bands, 1);
    assert(fabs(powerAt(bands, 0.5) / baseline - 0.25) < 0.001);
    levels[5] = 600;
    DNPrepareBands(bands, levels, 48000);
    assert(fabs(10 * log10(powerAt(bands, 1) / baseline) - 6) < 0.01);
    DNPrepareBands(bands, levels, 48000);
    assert(DNFilterSample(bands, 2, 0.8, 4) == 1);
    puts("PCM gain, 1 kHz EQ response, stereo isolation and peak limiting passed.");
}
