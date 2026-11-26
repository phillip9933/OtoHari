# OtoHari Android: prepare for Google Play

This checklist applies only to the Android Play build. It does not authorize changes to an app listing, a tag, signing keys, GitHub releases, TestFlight, or Google Play.

## Build

From `mobile`, use the pinned Node/pnpm and JDK 21 with Android SDK 36:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build --mode play
pnpm exec cap sync android
cd android
./gradlew -Potohari.play=true :app:bundleRelease :app:testReleaseUnitTest :app:lintRelease
./gradlew -Potohari.play=true :app:dependencies --configuration releaseRuntimeClasspath > play-dependencies.txt
python3 ../scripts/verify-play-bundle.py app/build/outputs/bundle/release/app-release.aab play-dependencies.txt
```

The current candidate is **OtoHari 0.9.2**. The public Android 0.9.2 GitHub APK uses version code 36; the unsigned validation bundle also uses code 36 unless a Play code is explicitly supplied. To make the Play release newer than existing code 36, code 37 is the first candidate only if it exceeds all previously published sideload and uploaded Play codes.

This is an unsigned validation bundle. Preserve package ID `app.droppedneedle.mobile` and coordinate version codes with direct releases and the highest used Play code. After checking Console history, add `-Potohari.playVersionCode=<unused higher code>` and sign the final bundle using the registered **upload** key outside Git. Compare Play’s **app signing** certificate to the current direct APK signer if migration without uninstall is intended. Before publication run bundletool validation, verify Play-generated APKs and 16 KB compatibility, and smoke-test on a clean device plus a disposable-data same-signature upgrade where applicable. Verify direct mode separately; it must still build and keep its established updater and feed.

## Reviewer access and listing draft

- **Name:** OtoHari. **Short description:** Stream and save music from your own DroppedNeedle server.
- **Description:** OtoHari is an independent music player for your own compatible DroppedNeedle server. Browse your library, play albums and playlists, arrange your queue, and save available music for offline listening. You need a server and account. OtoHari does not include a music catalogue or service. Use music you have permission to access. It is not an official DroppedNeedle app.
- Supply a disposable, publicly reachable HTTPS demo server with a restricted test account and replaceable credentials; no personal library, production tokens, MFA, VPN, or private certificate. Seed it only with original or public-domain recordings, cover art, and playlist names. Enter the server address, log in, browse Library, play a track, save it offline, and test offline playback. Do not post the demo credentials in Git. Use [the reviewer setup and copy-paste instructions](PLAY-REVIEWER.md).
- Show the actual Play build in screenshots and use rights-cleared media. Supply the 512×512 icon, 1024×500 feature graphic and phone screenshots. Verify contact email, countries, content rating, target audience, ads and other Console declarations rather than inventing them.
- The Play build hides the Requests tab and request buttons and stops its JSON client from calling server acquisition routes. Keep personal-library downloads, playback, playlists and personal mixes distinct. Manually check catalog screens, external song-link resolution, deep links, and Android Auto for dead or misleading paths to server acquisition on the exact candidate.
- The Play build includes [this policy draft](PRIVACY-PLAY.md) in Settings → About → Privacy policy, available offline and before sign-in. The in-app online link and intended Console URL are [the rendered policy on the default branch](https://github.com/phillip9933/OtoHari/blob/main/mobile/PRIVACY-PLAY.md). That URL becomes valid when the draft is merged. Before submitting, verify it while signed out and paste it into App content → Privacy Policy. The in-app copy remains available offline, independently of the URL. Verify the actual bundle’s SDK disclosures (including Google Cast), server and identity-provider transfers, optional scrobbling and whether the app or any linked creation flow permits creating an account. Complete Data safety from these observed behaviors, not from a “no tracking” assumption.
- In App content, declare the foreground media playback service and review whether the included platform user-initiated transfer/background functionality needs any additional disclosure. Prepare a video showing playback continuing after putting the app in the background, and reviewer steps for stopping it.

## Android Auto

Keep the phone app’s existing Android Auto media service and manifest descriptor. Android Auto is not Android Automotive OS. If Android Auto is part of this launch, opt in through the existing app's form-factor settings and get a Play-distributed build reviewed for car quality. Verify Android Auto visibility with developer-only unknown apps disabled, real browsing, media controls and voice search using the Desktop Head Unit and a compatible car. Check online/offline states, artwork, account prompts on the phone, notification actions and distraction-safe controls. A phone build or sideload is not proof that this works after Play review.

[App access and declarations](https://support.google.com/googleplay/android-developer/answer/9859455) · [Data safety](https://support.google.com/googleplay/android-developer/answer/10787469) · [App signing](https://developer.android.com/studio/publish/app-signing) · [16 KB support](https://developer.android.com/guide/practices/page-sizes) · [Android for Cars distribution](https://developer.android.com/training/cars/distribute)
