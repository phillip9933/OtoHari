#!/usr/bin/env bash
# Run the iPhone player's portable Swift tests on macOS or Linux.
set -euo pipefail
cd "$(dirname "$0")/.."
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
run() {
  local name=$1
  shift
  local sources=()
  for source in "$@"; do sources+=("ios/App/App/$source.swift"); done
  "${SWIFTC:-swiftc}" -module-cache-path "$scratch/modules" "${sources[@]}" "tests/ios/$name/main.swift" -o "$scratch/$name"
  (cd .. && "$scratch/$name")
}
run offline OfflineFiles
run library OfflineFiles LibraryContinuation PlayerQueueOrder PlaybackArchive
run loudness OfflineFiles LibraryContinuation PlayerLoudness
run playback OfflineFiles LibraryContinuation PlayerQueueOrder PlaybackArchive
run history PlaybackHistory PlaybackReportSender OfflineListenJournal OfflineListenReplay
run artwork OfflineFiles PlaybackArtwork
run export PlaylistExports
run reads DNReadPlugin
run fades TrackFades
run autoplay OfflineFiles LibraryContinuation PlayerAutoplay
run widget PlayerWidgetSnapshot
"${CC:-cc}" -std=c11 -Wall -Wextra -Werror tests/ios/dsp/filter.c -lm -o "$scratch/dsp"
"$scratch/dsp"
