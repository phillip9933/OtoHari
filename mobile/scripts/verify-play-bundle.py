#!/usr/bin/env python3
"""Check the unsigned Play bundle; final Play-generated split verification is separate."""

import argparse
from pathlib import Path
from zipfile import ZipFile


def require(condition, message):
    if not condition:
        raise SystemExit(message)


parser = argparse.ArgumentParser()
parser.add_argument("bundle", type=Path)
parser.add_argument("runtime_dependencies", type=Path)
args = parser.parse_args()

require("io.github.phillip9933:android-updater" not in args.runtime_dependencies.read_text(),
        "The release runtime classpath includes the direct updater.")
with ZipFile(args.bundle) as bundle:
    require(bundle.testzip() is None, "The bundle has invalid ZIP entries.")
    names = bundle.namelist()
    signed_entries = [name for name in names if
                      name.upper().startswith("META-INF/") and
                      name.upper().endswith((".SF", ".RSA", ".DSA", ".EC"))]
    require(not signed_entries, "The validation bundle unexpectedly contains a JAR signature.")
    native_libs = [name for name in names if "/lib/" in name and name.endswith(".so")]
    print(f"Unsigned validation ZIP contains {len(native_libs)} native shared libraries.")
    if native_libs:
        print("Check all native ELF segments and APK ZIP alignment on generated device splits.")
    marker = "base/assets/public/otohari-play-channel.txt"
    require(marker in bundle.namelist() and bundle.read(marker) == b"play\n",
            "The bundle does not contain Play-mode web assets.")
    manifest = bundle.read("base/manifest/AndroidManifest.xml")
    for forbidden in (b"REQUEST_INSTALL_PACKAGES", b"UpdateFileProvider", b".android-updates"):
        require(forbidden not in manifest, f"Install/update manifest entry present: {forbidden!r}")
    for required in (b"app.droppedneedle.mobile", b"com.google.android.gms.car.application", b"PlaybackService"):
        require(required in manifest, f"Package identity or media declaration missing: {required!r}")
    dex = [name for name in bundle.namelist() if name.startswith("base/dex/") and name.endswith(".dex")]
    require(dex, "No Android DEX found in the base module.")
    for name in dex:
        data = bundle.read(name)
        for forbidden in (b"DNUpdatesPlugin", b"DNUpdatesUnavailablePlugin", b"io/github/phillip9933/appupdater"):
            require(forbidden not in data, f"Updater class present in {name}: {forbidden!r}")

print("Play assets, application identity/media declarations, and absence of updater verified.")
