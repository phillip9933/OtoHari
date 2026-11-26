# Prepare an OtoHari Play review demo

Use a disposable DroppedNeedle v3.1.0 server and a dedicated listener account with the ordinary **User** role (not Admin). Do not use a production library, admin credentials, or a personal identity-provider account. Nothing in this guide requires or makes a public deployment.

## Set up the demo

1. On the disposable server, add a review-only music library with these fixture tracks. The script synthesizes original tones locally; it fetches no media and uses no third-party album art. Use Python 3 and ffmpeg:
   ```sh
   cd mobile
   python3 scripts/create-play-review-fixtures.py /path/to/dedicated/demo-music
   ```
2. In the DroppedNeedle web UI, scan the demo library. Verify one album named **OtoHari Review Sounds**, with **Morning Bell**, **Soft Chime**, and **Night Pulse** by **OtoHari Review**. Add those tracks to a playlist named **OtoHari Review Playlist**. If the server's configured matching provider doesn't preserve fictional metadata, keep the source tags on the demo library and verify names and playback on that exact server.
3. Use a publicly reachable HTTPS URL with an ordinary trusted certificate and set up a reusable, least-privilege listener account. Do not require VPN, geo-unblocking, external signup, CAPTCHA, MFA, expiring access codes, or the owner's involvement. Keep the saved reviewer access usable at all times, including after launch. Do not enable any connected acquisition sources or use real music, cover art, profile data, or logs. Enter credentials only in App content → App access. If rotating credentials, create and test the replacement from an unrelated network, update App access with the tested pair, then retire the old pair. Do not leave inactive credentials saved in Play Console.
4. Verify the reviewer path from an unrelated network and a clean Android device against the exact Play build. Sign out, sign back in, then verify the library and playback. Rehearse the in-app **Save offline** action and offline playback with the non-admin demo account: caching a track through its stream is separate from the server's direct-download permission. Do not add direct-download or admin access just to make the rehearsal pass. Test Android Auto separately on a Play-distributed candidate with developer-only unknown apps disabled.

## Paste into App access after replacing the placeholders

```text
Testing OtoHari on Android

This app plays music from a DroppedNeedle v3 server. Use this restricted
test account; no purchase or personal account is needed.

Server URL: <reviewer demo HTTPS URL>
Username: <reviewer listener username>
Password: <reviewer listener password>

1. Open OtoHari, enter the server URL, then sign in with these credentials.
2. Open Library → Albums → OtoHari Review Sounds.
3. Play Morning Bell. Use the notification to pause and resume playback.
4. Open Library → Playlists → OtoHari Review Playlist to see all three tracks.
5. Save Morning Bell for offline playback. After the transfer completes,
   disable the network, open Offline music, and play the downloaded track.
6. To see the privacy policy, open Settings → About → Privacy policy.
```

Confirm all labels on the exact candidate; steps may vary with locale and configuration. For the foreground playback declaration video, show playback while OtoHari is in the background and show how to pause it. For Android Auto review, add the library and voice-search steps after verifying them on the actual demo and head unit.

[Google Play reviewer access](https://support.google.com/googleplay/android-developer/answer/15748846?hl=en) · [Android Auto review](https://developer.android.com/training/cars/distribute)
