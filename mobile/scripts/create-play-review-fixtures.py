#!/usr/bin/env python3
"""Create local, original audio fixtures for a disposable OtoHari reviewer library."""

import argparse
import math
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import wave


RATE = 22050
TRACKS = (
    ("Morning Bell", (523.25, 659.25, 784.00)),
    ("Soft Chime", (392.00, 493.88, 587.33)),
    ("Night Pulse", (293.66, 369.99, 440.00)),
)


def create_wav(path, frequencies):
    frames = bytearray()
    for i in range(RATE * 18):
        beat = i % (RATE * 2)
        frequency = frequencies[(i // (RATE * 2)) % len(frequencies)]
        t = beat / RATE
        envelope = min(1.0, t / 0.12, (2.0 - t) / 0.20)
        sample = int(4300 * envelope * math.sin(math.tau * frequency * t))
        frames.extend(struct.pack("<h", sample))
    with wave.open(str(path), "wb") as wav:
        wav.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        wav.writeframes(frames)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("library", type=Path, help="A dedicated disposable music folder.")
    args = parser.parse_args()
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        parser.error("ffmpeg is required to write tagged FLAC fixtures.")
    album = args.library / "OtoHari Review" / "OtoHari Review Sounds"
    targets = [album / f"{i:02d} - {title}.flac" for i, (title, _) in enumerate(TRACKS, 1)]
    if any(target.exists() for target in targets):
        parser.error("A fixture already exists. Use a new dedicated directory.")
    album.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as work:
        source = Path(work) / "tone.wav"
        for i, ((title, frequencies), target) in enumerate(zip(TRACKS, targets), 1):
            create_wav(source, frequencies)
            subprocess.run([
                ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
                "-i", str(source), "-map_metadata", "-1", "-c:a", "flac",
                "-metadata", f"title={title}",
                "-metadata", "artist=OtoHari Review",
                "-metadata", "album_artist=OtoHari Review",
                "-metadata", "album=OtoHari Review Sounds",
                "-metadata", f"track={i}/{len(TRACKS)}",
                str(target),
            ], check=True)
            print(target)


if __name__ == "__main__":
    main()
