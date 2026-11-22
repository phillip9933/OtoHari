# DroppedNeedle Mobile

The Android and iOS apps connect to your DroppedNeedle v3 server. Play music from your DN library, manage your queue and playlists, and request albums or songs from the same server. Both apps bundle the same Svelte interface, including the player layout editor, themes and library screens. Android has been tested on a Pixel.

## Connect your phone

1. Enter the HTTPS address that opens DroppedNeedle. Include the path if your server uses one.
2. Choose **Continue in browser** if your server offers it. Sign in to DroppedNeedle as usual and select **Connect this phone**. If the browser stays open, select **Return to the app**.
3. If your server offers OIDC but still needs the mobile pairing page, **Open web player** takes you to its existing browser player. To use the native player on that server, you can also use an existing DN v3 device session token or a server password if your account has one.

For OIDC, including authentik, enter the public DroppedNeedle address served by your reverse proxy. The browser uses the provider and callback already configured in DroppedNeedle. After you approve the phone, the app verifies its own device session with your server. If the connection drops during that step, reopen the app or select **Retry connection** within ten minutes. A temporary proxy denial during verification also supports retry. Signing out closes the local session immediately. If DN is unreachable the app securely retains the pending revocation and retries when you reconnect or reopen it. You can revoke phone access from **Profile > Sessions** in the web app.

Server administrators can add browser sign-in by building the DN web frontend with the `feat/mobile-browser-pairing` change. It provides `/connect/mobile` and `/mobile-pairing.json`. The marker should return JSON containing `"droppedneedle_mobile_pairing": 1`. The phone must be able to reach the DN API and media endpoints using its DN device session. A proxy that requires a separate browser session on those routes needs a compatible access policy.

## Update the Android app

On Android 8 or later, open **Settings → App → App updates**. You can also open Settings from the sign-in screen. Choose **Check for updates** to check the Android releases on GitHub. This works independently of your DroppedNeedle account.

The app checks the stable channel about once a day by default. Choose **Beta** to include prereleases, or enable **Download automatically on Wi-Fi** to have the APK ready for later. Open **App updates** to read the release notes, download the APK and install it. If Android asks for permission, allow installs from DroppedNeedle, return to the app and tap **Install update**. Android asks you to confirm the installation.

## Find a setting or change language

Use **Search settings** below the navigation shortcuts. Search in English or Japanese for a feature such as “fade”, “キューの先読み” or “EQ”. Selecting a result opens its settings section. Administrator controls appear for administrators.

Under **Settings → App → App language**, choose **Device language**, **English** or **日本語**. Android 13 and newer also offer this choice in the system’s per-app language settings. Your library’s titles, artist names and lyrics keep their original spelling.

The Settings menu opens with navigation shortcuts. Below them, search for a control such as **Wi-Fi stream quality**, **Playback speed** or **Offline mode**. Each result shows its location. Searching for **Sign out** takes you to the account’s sign-out button before you choose whether to use it.

## Customize your screens

Open **Settings → Appearance & layout** and choose Home, Library, Discover, or Now Playing. Each screen has its own saved layout. **Restore default layout** loads a fresh draft, **Save layout** applies it, and **Cancel** discards it.

By default, Home opens after sign-in and Offline music opens when the phone is disconnected or set to offline-only playback. On Home, combine Library and Discover sections, such as recently added albums, recently played songs, Top picks for you, or genres. In a screen’s editor, add or remove a section and use the arrows to reorder it. The sliders beside a section control its preview and display.

Each section can show its contents directly on the screen. Choose **List** or **Grid** and set **Columns** from one to six. Items divide the available width evenly, including on phones. **Row density** sets the spacing and **Preview rows** sets how many rows appear inline. For example, Top picks can show two rows of six covers while Recently played uses one song per row. Tap an item to open it, or tap the section heading to browse the full collection with its filters and actions. Recently added and Recently played keep the preview visible while the full list refreshes. Going back restores your place in the feed.

Library shelves also work with music saved on this device. Add **Library genres** to Home or Library for a genre shelf. Saved song filters use local track details, and album or artist rules use matches DN has already confirmed. Recently added uses DN’s addition dates when available. Recently played and Discover recommendations need a connection.

Under **Radio stations**, tap a station to see its albums and tracks. **Play station** builds a playable queue from the music in your DN library.

Open **Discover → Mix Builder** to build a mix from up to eight artists or up to eight albums. Give it a name to save the recipe and play a fresh selection from your DN library. Use **Pin to Home** on a mix, station, playlist, smart playlist, genre, artist, album or track. On Home, **Arrange pins** changes their order or removes one. Pins belong to the signed-in account on this device. You can play the tracks available on the phone when offline. Android Auto also shows supported Home pins in the same order.

Open **Library** for Playlists, Artists, Albums, Tracks and Genres. Albums and playlists start as two-column grids, artists as three-column portraits, and tracks and genres as lists. Use the toolbar to sort, filter, search, select items, or switch views. **Collection options** controls the number of columns and spacing for that category. More items load as you scroll. Opening a detail and going back keeps your place. **Library sections** opens your custom shelves.

Search results can use a list or artwork grid. Use the display control beside the results to set the layout, grid columns and row spacing for each search category. The same choices apply to music saved on your device.

Album artwork fills the top of the album page. Shuffle or play from the action row, or tap a numbered track to start there. The **⋮** to the left of Shuffle opens album actions. On an artist page, **⋮** also holds the Home shortcuts for opening the artist and starting their radio station.

Under an artist’s **Songs**, the popularity sort orders matching recordings by ListenBrainz listens from DN. Unranked songs follow in title order. Open an artist in Library or Discover to filter their discography to albums, EPs or singles. In Library, the artist’s releases use the same list or grid, columns and row density as Albums. You can also change how each of the five Library categories looks from **Settings → Appearance & layout → Library layout**. The Library view lets you find other release types and records for which DN has no release type.

Use **Library → Library sections → New filtered section**, or set filters while browsing and choose **Save filters as section**. For a five-star songs shelf, choose Songs, set the minimum rating to five and give it a name. Add the saved section to Home or Library in either screen’s layout editor. The two placements share the saved criteria and can use different row counts and display styles.

Hold a library item to select it. While selecting, hold another item and drag through a range to add it. Starting on a selected item removes that range. Keep holding at the top or bottom edge to scroll faster. With a keyboard, use Shift+Space on a focused item to start selecting. Choose **Cancel selection** to finish. The actions at the top let you play your choices, play them next, add them to the queue or a playlist, or save them on the device. **Select loaded** selects the items displayed so far. Album and artist actions resolve their full track lists.

### Arrange the expanded player

Open **Settings → Appearance & layout → Now Playing layout** or **More actions → Edit player layout** from the player. The editor shows a sample album, song, queue and lyrics. You can edit with an empty queue or while your own music plays. Tap **Preview** to see the current draft at player size. **Back to editing** returns to the same spot with your edits in place. Android Back leaves the preview, then closes the open item editor or picker before exiting the editor. Saving or canceling returns you to Now Playing. If the app restarts while you’re editing, reopen the editor to recover your unfinished layout. The live player changes when you choose **Save layout**. **Cancel** or Android Back from the main editor discards the draft.

The editor uses a 30-column, 40-row grid. Saved layouts from the 15-by-20 grid open at the same proportions. Tap an item to highlight it, then choose **Edit item** to see its options. Hold and drag the tile to move it, or drag its highlighted corner to resize. Pinch the editor canvas or use the zoom buttons for a closer view, up to 300%. Pan to reach another part of the grid. Tap the percentage to fit the full layout again. Choose **Add item** to fill free space. To put two items in the same column, select the first one and choose **Place another item underneath**. The rest of the layout stays in place.

The starter layout puts the cover above the title and artist, with a heart and **More actions** beside the title. The timeline, rating, playback controls, lyrics, audio output and queue sit below. To try it with an existing layout, choose **Restore default layout**, then **Preview**.

The item editor lets you set position and size in cells, padding in pixels, and alignment. Icons can fill their tile or use a fixed size. Actions can show a custom label above or below the icon. Track title, artist and album have separate line limits. Custom text accepts values such as `{artist} · {album}` or `{position}/{count}`.

**Undo** and **Redo** step through the open draft. **Share player layout** lets you save a JSON file or copy its text. Importing a file shows its contents before you load it into the editor. Older row-based layouts open on the grid and keep playing in their original form until you save. File sharing works offline.

Set the playback bar to a standard line, animated wave or the song’s measured waveform. Elapsed time, track length and time remaining can each be shown independently. On both phones the waveform uses saved audio when available. Choosing that style for streaming music can read an additional stream using your Wi-Fi or cellular profile. The seek bar stays available if a waveform cannot be read. Add **Audio quality** to show the playing format and any reported sample rate, bit depth or bitrate. If only the library format is known, the readout identifies it as the source.

Tap the quality badge or choose **More actions → Signal path** to trace the current song from its library file through streaming or device storage, decoding, sound processing and output. Android shows the quality requested for the connection and the format the player actually received. A receiver or DAC can leave parts of its output path unreported.

When a synced lyric line contains word timestamps, the player highlights the current word and clears the highlight during a marked pause. Seeking the song updates the highlight in both the artwork view and the full-screen lyrics view. A line-timed lyric still follows the current line, and untimed lyrics can be read at any position.

Layouts are stored on the phone for each DN server and account. **Settings → Account → Account-wide content visibility** controls the account-wide visibility of DN’s Home and Discover content. Administrators can also configure sidebar visibility there. DN reports when a section depends on an unavailable integration.

### iPhone Home Screen and Lock Screen widget

In the widget-enabled iPhone build, add **DroppedNeedle → Now Playing** from the widget gallery. The small Home Screen widget and rectangular Lock Screen widget show the current track and open the player. The medium Home Screen widget adds previous, play or pause, and next. Tapping a control opens the app and acts on the displayed queue entry. The widget uses the current album thumbnail and clears its display when you sign out. iOS controls when the widget redraws.

To build this version on a Mac with Xcode, run the following from `mobile/` after installing dependencies. Supply your iPhone app’s bundle identifier as the final argument.

```sh
pnpm build
pnpm exec cap sync ios
node scripts/prepare-iphone-widget.mjs com.example.droppedneedle
open ios/App/AppWidgets.xcodeproj
```

Choose the **App** scheme. For device installation, use the same Apple development team for the app and its **NowPlayingWidget** extension. Register and enable the shared App Group for both identifiers. In this example the app group is `group.com.example.droppedneedle` and the extension identifier is `com.example.droppedneedle.NowPlayingWidget`. The extension supports iOS 16.4 and later. Run the generator again after changes to the base Xcode project. The standard iPhone build uses `App.xcodeproj` and can be signed independently of the widget.

## Listening and library coverage

| Area | On the phone |
| --- | --- |
| Library | Browse playlists, artists, albums, tracks and genres. Filter by device availability, rating, favorites or format where applicable. Open an artist for albums, guest appearances and credited songs. |
| Now Playing | Swipe down to minimize, up to open the queue, and down again from the queue to return. Tap the track title for details or the album or artist to open it in your library. Tap a star to rate a track. Tap the same star again to clear it. The Lyrics button switches the artwork to lyrics and back. Its layout setting can open full-screen lyrics instead. **More actions** opens favorites, ratings, playlists, downloads and other actions for the song. Open **Sleep timer** to choose 1–240 minutes or 1–99 tracks. **Finish last track** lets the playing song end after the countdown. Android media controls also work with the screen locked. |
| Queue | Play next, append, move or remove individual entries, shuffle or clear upcoming tracks without interrupting the current song, and repeat a song or the queue. Both platforms restore the last queue paused at its saved position for the signed-in account. |
| Playlists | Create, rename and delete playlists, or import an M3U, M3U8 or CSV file and review which tracks DN matched. Add a song or album, reorder tracks, remove one occurrence of a repeated song, and share with viewers or editors. Under **New playlist**, enter a name and create an empty playlist to fill by hand, or choose **Smart playlist** to filter your tracks, preview matches, set the sort order and choose a track limit. The smart rules are stored on this device. Its contents update whenever you open or play it. |
| Search and requests | Choose Top results, Artists, Albums, Songs, Genres or Playlists below the search box. Switching category keeps the query. Choose an album edition or request an individual recording. View active requests and history, withdraw eligible requests, and manage server downloads. The download queue groups activity by stage and shows status text, icons, progress and file counts when DN supplies them. Administrators can approve or reject requests. |
| Discover | Browse recommendations, genres, popular albums, trending artists and personal charts. Open an artist for releases and top songs. Follow artists to see new releases and concerts. Library radio builds a queue from DN files related to an artist, album or genre. |
| Account | In **Settings → Account → Account on DroppedNeedle**, change your display name, username, email, listening visibility, scrobble preferences and personal-mix settings. Inspect linked services or sign out another device. |

Open a DN playlist and choose **Export playlist** to save an M3U8 or CSV file. This also works for playlists shared with you as a viewer. For M3U8 you can set the path prefix to match the music folder on the receiving device. The app remembers it for this DN account. Android opens its document picker and iPhone opens Files so you can choose the destination. DN reports how many unavailable entries it skipped.

In **Requests**, switch between **Activity**, **Downloads**, and, for administrators, **Approvals**. Tap an album in Activity to open it, or use the three dots on a row for actions. Expand **Wanted watches** to see what DN is monitoring. You can filter and sort request history in place.

**Downloads** puts items needing a decision first, followed by in-progress transfers, queued work, scheduled retries, and download history. Tap a row marked **Review matches** or **Review held files** to open it. Match review groups candidates by how well they fit your download settings. Tap a candidate to inspect its files before choosing it.

**Review held files** opens files from that task inside the app. **Review all held files** opens the entries available to your account. Listen to the opening audio, inspect why a file was held, and select the files to act on. DN supplies the eligible actions. You can confirm a replacement or discard, and trusted listeners and administrators can match files to an album or check an edition. Edition review compares editions against the library, then retries the selected held files. Bulk imports, quality upgrades and advanced server administration are available under **App → Open in DN web app**.

A download in **Requests → Downloads** brings music into the DN server library. **Save offline** keeps a copy on the phone. Android and iPhone report playback to DN for listening history and linked scrobbling services when the server is reachable.

**Settings → Library → Library statistics** shows collection size, formats and favorites. Administrators can run library scans, view server diagnostics and manage release types. In **Edition preferences**, search for release statuses, formats and countries, then put them in priority order. In **Open in DN web app**, tap a group to reveal its links or search across the pages available to your role. Clearing the search restores the groups you had open. Account security, linking services, backups, plugins, matching, duplicates and bulk edits use the server’s browser interface. Album, artist and playlist details also link directly to their DN web pages.

The phone uses the device volume controls. On Android, **Settings → Playback → Sound → Equalizer** uses DN’s playback audio session. Available bands depend on the device. The mobile queue plays tracks regardless of their rating. Use rating filters in Library to choose what goes into a new queue.

On the Tracks page, **Play all** and **Shuffle all** can continue through the entire filtered collection. For a large library, the player loads the next 100 tracks as you listen and keeps up to 50 earlier tracks at each refill. Queue shows where you are in the whole collection. Saving the loaded queue to a playlist or editing its order uses the tracks currently on the phone. Android restores its place in the collection after you reopen the app.

In **Edit queue** or **Edit playlist**, drag a track by its grip, or tap the grip to enter an exact position. With a keyboard, use the arrow keys on the grip. Moving an entry keeps the current song playing, even when a playlist contains two copies.

On Android, pressing Play on a headset can resume your saved queue after the playback service has stopped. This works with the screen locked after the first device unlock. Open the signed-in app once after upgrading to make an older queue available to your headset.

## Playback and storage

Use **Shuffle playlist** to start a fresh order, including after closing and reopening the app. The phone remembers the last shuffle for recent selections on your DN account. If the same songs come up in the same order, it draws again whenever another order is possible. A song you added twice still plays twice. **Play** follows the saved playlist order.

In **Play queue**, shuffle the upcoming songs and tap the shuffle control again to restore their order. The playing song stays at its current position. **Restore previous queue** brings back the queue you replaced. Under **Settings → Playback**, enable **Autoplay when the queue ends** to continue a finished queue with related songs from DN. You can also change this while viewing the queue.

**Play next** inserts a song immediately after the playing one. **Add to Up Next** puts it after your other picks, and **Add to queue** appends it to the end. The queue shows your picks under **Up Next** and the original album, playlist or library order below. You can choose a song twice, shuffle the underlying queue, or reopen the app and keep your picks in order. Choose **Similar tracks** in the queue to pick individual suggestions from DN.

**Playback speed** is available in **Playback → Sound** and in **More actions** on the player. On Android, **Volume normalization** applies track or album ReplayGain to local audio. Album mode uses track gain when the album tag is missing. Untagged songs keep their original level. Under **Settings → Playback → Sound → Equalizer**, enable a separate preset for the connected output to recall its curve when you reconnect.

To move music between Android and the web, enable **Player handoff** in mobile Settings and in the web player's Profile on the same DN account. **Move queue there** and **Continue here** preserve the song, position, order and paused state for fully loaded queues of up to 2,000 local tracks. You can also pause, play or skip on the other device. Keep both players open and connected. This requires the matching DN server and web build.

**Settings → Playback → Streaming quality** has separate Wi-Fi and cellular profiles on this device for the signed-in DN account. Each can use the original file or request MP3 or Opus from 64 to 320 kbps. New accounts start with original audio on both connections. An earlier single quality setting becomes the starting point for both profiles. Each new track download checks the connection, including tracks already in the queue. A track that is buffering or playing keeps the representation it started with for seeking and retries. Ethernet uses the Wi-Fi profile. An unknown transport uses the cellular profile.

DN’s web player has its own preference in **Settings → Personalize → Playback**. On iOS, AVFoundation uses MP3 at the requested bitrate if the device cannot play Ogg Opus. Converted tracks are staged privately for seeking.

The server’s **Settings → Connect Apps → On-the-fly transcoding** switch, ffmpeg and bitrate ceiling govern conversion for all clients. If DN falls back to an original, that file plays at its source bitrate. In **Playback → Track fades**, set **Fade in** and **Fade out** independently to Off, 0.5, 2, 4 or 8 seconds. Both start off on a new installation. Upgrading copies your previous fade length to both controls.

Under **Settings → Playback → Track fades**, **Smart fades** is optional and works with either manual fade turned off. The device measures the last and first eight seconds of adjacent songs in 100 ms windows. It compares the quiet ending and intro to choose an equal-power overlap of up to eight seconds, capped at half the length of either song. When both tracks have a clear, similarly spaced beat, it can align their pulses at the original tempo. Other loud transitions and consecutive numbered tracks on the same album keep their natural boundary. With Smart fades on, **Fade in** and **Fade out** appear under **Fallback fades** and stay editable. Their lengths apply at the start and end of a queue and when the device cannot prepare the transition. Remote Cast and AirPlay receivers manage their own transitions.

On Android or iPhone, choose **Save offline** on an album, track or selection to keep the music on the phone. **Library → Availability** switches between all library music and tracks available offline on this device. You can also change it inside any category under **Collection filters**. The choice follows you across all five categories and is saved for this DN account on this device. Album and playlist details show how many tracks are playable in DN and how many are on this device. **Track availability** filters playback and selection. Offline music shows which files were downloaded, automatically saved or cached. Playlist editing uses the full order, including repeated tracks. After a restart, a saved album can show the last playable-track count DN reported and the date it was observed. If the phone has never seen a reliable total, or now has more tracks than DN last reported, it shows how many tracks are on the device. A regular playlist is available offline after its membership has been opened and at least one track saved. Use **Library → Offline music** to manage the files.

On iPhone, **Save offline** keeps a persistent queue. Downloads can use the time iOS grants when you leave the app. If iOS suspends the transfer, unfinished tracks resume when you reopen DN with the same account.

On Android, **Save offline** queues the selected songs on the device. Downloads continue when you leave the app. The queue waits for an allowed network and pauses for offline-only playback. Tap the download notification or open **Library → Offline music** to see the current song, check which files failed, retry them, or cancel the remaining downloads. Completed songs stay on the device. If Android stops the queue, you can retry it here. **Settings → Downloads & storage → Download preferences → Download notifications** shows whether Android allows progress notifications and opens the system control.

In **Settings → Downloads & storage → Download preferences**, choose **Keep a collection offline** to keep several playlists, artists, saved library filters, recent additions or favorites on Android. The app checks on return and Android schedules another check about every six hours on allowed networks. You can also update immediately. Songs shared across collections take one copy. Manual downloads stay on the device when you unpin a collection. A failed membership check preserves existing copies.

**Download quality** lets you keep originals or request MP3 or Opus at a chosen bitrate for new manual and automatic downloads. You can stream originals on Wi-Fi, stream at a different rate on cellular, and still keep compact downloads for travel. Existing complete downloads keep their format until removed and downloaded again.

Under **Downloads & storage**, choose **Offline mode and playback cache** to play only saved music or set the playback cache limit. **Download preferences** controls download quality and automatic collections. Manual downloads stay until you remove them. Playback cache keeps completed files under its own size limit. The player prefers a complete copy on the device.

In **Settings → Downloads & storage → Offline mode and playback cache → Cache upcoming songs**, choose how many upcoming tracks to cache and a transfer speed for Wi-Fi and cellular separately. Both start off. Read-ahead uses the playback cache budget and the streaming quality for the current network. Enabling cellular read-ahead allows it to use mobile data while ordinary downloads remain restricted to unmetered connections.

**Include artwork, lyrics & waveforms** saves available cover art and lyrics alongside manual and automatic downloads. Waveforms can also be prepared from the downloaded audio. **Downloads & storage → Device storage → Refresh saved music** updates details from DN while preserving pending edits and the saved audio. To inspect the device’s status, open **Settings → App → Troubleshooting → Review report**. The preview contains app and OS versions, connection type, storage totals and pending activity counts. You choose whether to save the file or share it.

Cover artwork and lyrics you have opened have separate device caches. Under **Cover artwork**, choose up to 4 GiB or tap **Sync artist artwork** to refresh library portraits and available album-art mosaics from DN. Keep this screen open during a sync. It uses your selected cache limit and requires an online connection. Images that DN is still preparing are retried when viewed. **Downloads & storage → Device storage** shows usage and lets you change the limits or clear each cache for this account. Android’s lock screen and media notification can show a cover embedded in the saved song, even without a connection. Timed lyrics keep their seek controls offline. The browser preview uses IndexedDB for media and keeps sign-in in memory.

Timed lyrics follow the playing line inside the lyrics panel. Scroll to read ahead, then tap **Follow current line** to catch up. Tapping a timed line seeks to it and follows the song from there.

You can favorite or rate a saved song while offline. Library and device smart playlists use the change immediately. The app sends it back to the same DN account after it reconnects and you turn off offline-only playback. Offline music shows pending changes and lets you retry a failed sync.

On Android or iPhone, **Settings → Account → Offline listening history** shows how many listens are waiting for DN. Turn off **Record offline listens** to pause recording and submission, or discard the pending listens. DN accepts offline listens for up to 14 days. If the phone sends a listen and loses the reply, it skips resending that listen to avoid counting it twice. That listen may be missing from your history.

Search also works without a connection. Its Songs, Artists, Albums, Genres and Playlists selectors use the completed music on this device. Opening a result keeps your search and place in the list. If DN stops responding while you’re on Wi-Fi, Search offers device results and a way to retry the server.

Use **More actions → Save offline** to keep the playing song. If it is already cached or automatically saved, keeping it makes it a manual download using the file on the phone. Tap **Downloaded** to manage that copy. To put the same button elsewhere, add the **Offline download** field in the Now Playing editor.

Use the cast icon in Now Playing or **Settings → Playback → Cast and audio output**. On Android, choose a Google Cast device, or use **Find network speakers** for a DLNA/UPnP receiver on the same local network. Google Cast uses Google Play services on the phone. Sonos and other compatible DLNA/UPnP speakers can use **Find network speakers** directly. Keep the phone connected during playback. The receiver reads the current song from the phone, and the phone authenticates to DN. Stopping the cast returns the queue to the phone paused. Android also offers display mirroring. On iPhone, the output button opens the system AirPlay picker, including compatible Sonos speakers. Direct Chromecast, DLNA discovery and Sonos group controls are available in the Android app. A custom CarPlay library interface requires Apple’s [audio entitlement](https://developer.apple.com/documentation/carplay/requesting-carplay-entitlements).

## Android Auto, speakers and library shortcuts

Android Auto can browse your DN library, playlists, favorites and saved music, and find songs by voice. Add the DroppedNeedle widget from the Android launcher for playback controls. On Android, tapping the system media card or the widget title opens Now Playing and keeps the current playback state. Open a DN playlist in the app to pin a shortcut that returns to it under your account.

In **Cast and audio output → Find network speakers**, Sonos rooms show their groups. Select a room to adjust its volume, join another group or leave a group. Playback goes through the group coordinator.

Search remembers queries on this device for each DN account and offers suggestions as you type. The alphabetical rail in Artists and Albums also works with saved music. Smart playlist rules can combine rating, genre, year, number of plays and days since the last play. Listening-history rules require per-account play statistics from the matching DN server.

## Change the appearance

Open **Settings → Appearance & layout → Themes** to choose DN’s **Dark**, **Light**, **Midnight** or **System**. The mobile build reads the web theme definitions. Dark and Midnight share a near-black background and lime accent. Dark uses a cream track list on album pages. Midnight uses a deep green track list with light lettering. The strip at the foot of each palette sample shows its album track-list color. System follows the phone’s appearance. Use **Use account theme on this device** or **Save device theme to account** to copy a built-in theme in either direction.

**Album artwork colors** follows the current cover in Now Playing and the queue, or across the entire app. It starts off. If a cover is missing or unreadable, the device theme supplies the colors.

Under **Settings → Appearance & layout → Button style and transitions**, choose **Solid Theme Color** for opaque buttons and panels, **Glass** for a clear tint and reflective edge, or **Blur** for a frosted background with adjustable strength. Open **Navigation bar and start screen** to dock or float the navigation bar and pin up to five destinations, including individual Library categories and Settings. The menu icon on Home opens **Navigation**. Tap a destination there, or use the **Settings** groups below it. Choice menus open over the page, above or below the field according to the space available. Select an option to apply it, or tap the field again or press Back to close it. Pinning Settings to the bar moves Home’s shortcut there. **Screen transitions** sets the speed of page fades and player slides. Choose **Quick**, **Gentle** or **Off**. A drag still follows your finger with animations off or reduced motion enabled.

Tap the mini-player title or drag up from anywhere on the mini-player to open Now Playing. On Home you can also pull up from the heading or the end of the feed. Pull up on Now Playing to see the queue or down to return to browsing. Pull down from the top of the queue to return to the player. A vertical drag can start on a player button. A tap still uses the button and a horizontal swipe across the artwork or mini-player skips tracks.

During a slide, hold your finger still to pause it or move back to reverse it. After you let go, you can touch the moving screen to catch it again. Bottom sheets work the same way. Drag down on the handle, or on the sheet contents when they're scrolled to the top, to dismiss.

Under **Settings → Appearance & layout → Mini-player**, choose whether to show the cover and a track progress line. The second line can show the artist, album, both, or be hidden. The two positions beside Play/Pause can each hold Previous, Next or Queue, or be left empty. Opening Queue here and pressing Back takes you to the same place in your library. These choices are saved for this DN account on this device.

The seek bar shows available audio ahead of the playhead as a lighter track. In the animated style, the played portion tapers into the flat rail at the current position. Now Playing uses plain icons across all three surface styles. Active controls such as Lyrics and Repeat use the theme accent. The floating navigation bar and mini-player use a soft shadow over the content.

Choose **Start screen** under **Navigation bar and start screen** to open Home, Library or Now Playing when the app launches. **Now Playing** opens the restored song at its saved position and takes you to Library when the queue is empty. **Automatic** opens Home when connected and Offline music when offline. Each listener can choose a start screen for their DN server on this device.

Use **Import colors from a web style** to preview compatible colors and corner radius from your current account CSS or a saved version. Choose the palette and select **Apply palette to this device**. The preview lists web rules that the phone does not support. Under **Edit or share theme**, copy or paste a custom theme as JSON and select **Apply theme**. Existing custom themes and the original Studio and Paper presets remain available. Custom JSON applies on this device. DN’s web CSS editor is available under **Settings → App → Open in DN web app → Custom CSS and saved styles**.

| Field | Values |
| --- | --- |
| `version` and `name` | Use version `1` and a name of 1 to 40 characters. |
| `colors` | Set `bg`, `surface`, `raised`, `text`, `muted`, `accent`, `on-accent`, and `line` to six-digit hex colors. |
| `corners` | A radius from 0 to 24 pixels. |
| `spacing` | A gap from 8 to 24 pixels. |
| `typeface` | Use `sans`, `system`, or `serif`. |

## Build and test

On a fresh checkout, install the dependencies in `frontend/` first. Its prepare script generates the TypeScript configuration for the shared sign-in code. From `mobile/`, use the Node.js and pnpm versions in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm format:check
pnpm exec playwright install chromium
pnpm test:journey
pnpm sync
```

For Android, install JDK 21 and Android SDK Platform 36. Run `./gradlew assembleDebug` from `android/`. The APK is at `android/app/build/outputs/apk/debug/app-debug.apk`. For iOS, open the project with `pnpm exec cap open ios` on a Mac with Xcode and select a simulator or device. Run `pnpm sync` after you change the Svelte app. The native build reads the copied bundle.

### Build and test the iPhone app

The app targets iOS 16.4 or later for the WebKit features used by the shared player and themes. Use the frontend’s pinned pnpm version for `frontend/` and the mobile package’s pinned version for `mobile/`. From `mobile/` run `pnpm build && pnpm exec cap sync ios`, then open `ios/App/App.xcodeproj` in Xcode 26 or later. Choose an iPhone simulator and run **App**. For installation on a real iPhone, select your Apple development team in **Signing & Capabilities**. [Capacitor iOS setup](https://capacitorjs.com/docs/ios)

The **iPhone simulator** GitHub workflow uses the committed Swift package versions, launches the unsigned simulator app, checks the DN sign-in form and verifies the app privacy manifest in an unsigned Release archive. Run `scripts/test-iphone.sh` from `mobile/` on a Mac or Linux with Swift and a C compiler to exercise the queue archive, library paging, radio selection, audio processing, downloads, artwork, listening history and file export. Use an iPhone for audio-route changes, background playback, the lock screen and AirPlay.

The iPhone uses the same OIDC pairing page as Android. Now Playing supports Up Next, playback handoff, output-specific equalizer settings, ReplayGain, speed, separate fades and smart fades. Open **Cast and audio output** for AirPlay. To pin a playlist, open its menu and choose the shortcut option, then press and hold the app icon on the Home Screen. iPhone updates use Apple distribution channels. The current queue takes priority when its saved data and the previous queue would exceed the 3 MiB restore limit. The app reports queue edits that exceed the limit before applying them. Playlist exports support up to 64 MiB per file and reserve 32 MiB of free space on the device.

### Send the iPhone app to TestFlight

The development branch runs the simulator checks on GitHub’s macOS runners. The distribution job uses the standard app project and starts only for an `ios-v<version>-build.<build>` tag. The widget-enabled project requires its own App Group and extension provisioning.

**One-time setup**

1. In your paid Apple Developer account, register the explicit bundle ID `app.droppedneedle.mobile` if available. In **App Store Connect → Apps → + → New App**, select iOS and that bundle ID, enter a unique SKU of your choice, and choose an available name that identifies this as an unofficial client. If the identifier is unavailable, choose one you own and update the Xcode target and simulator launch identifier before releasing. [Create an app record](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app/)
2. Create an **Apple Distribution** certificate and an **App Store Connect** provisioning profile for the app and certificate. Keep the certificate’s private key safe. Export the certificate and private key together as a password-protected PKCS#12 file. These steps can be done from Linux using an OpenSSL certificate signing request and Apple’s developer portal. [App Store Connect provisioning profile](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile/)
3. In **App Store Connect → Users and Access → Integrations**, create a team API key with permission to upload builds (Developer or App Manager). Keep the downloaded `.p8` private. Record the key ID and issuer ID. [App Store Connect API keys](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api/)
4. In your fork’s **Settings → Environments**, create `testflight`. Restrict deployment to your release tags and configure reviewer approval if appropriate for your team. Add the following **environment** settings. Keep private credentials out of the repository and release notes.

| Type | Name | Value |
| --- | --- | --- |
| Secret | `IOS_DISTRIBUTION_P12_BASE64` | Base64-encoded password-protected distribution PKCS#12 |
| Secret | `IOS_DISTRIBUTION_P12_PASSWORD` | Password for that file |
| Secret | `IOS_APPSTORE_PROFILE_BASE64` | Base64-encoded App Store Connect provisioning profile |
| Secret | `ASC_PRIVATE_KEY` | Full contents of the API key’s `.p8` file, including the PEM header and footer |
| Variable | `ASC_KEY_ID` | App Store Connect API key ID |
| Variable | `ASC_ISSUER_ID` | App Store Connect issuer ID |

**Each beta**

Choose the iOS version and a fresh build number in the **App** target (`MARKETING_VERSION` and `CURRENT_PROJECT_VERSION`). Commit them on `feat/mobile-iphone`, push that commit, then push its matching tag. For example, version `0.7.0`, build `31`, uses tag `ios-v0.7.0-build.31`. The workflow tests the commit, checks the version inside the archive, signs it, and uploads it to App Store Connect. A subsequent build for the same version needs a higher build number.

After Apple processes the upload, open **App Store Connect → your app → TestFlight** and complete any compliance prompts. Add the build to an external testing group, fill in beta review information (including a working reviewer login for this server-based app), and submit it for beta review. Once approved, invite testers by email; they install it through TestFlight on their iPhone. [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)

### Prepare an Android GitHub release

Set the mobile package version and Android `versionName` to the same version, and increase the Android `versionCode` for every release, including betas. After `pnpm sync`, generate a signed, standalone **release APK** in Android Studio using the same signing identity as the builds distributed to users. Android requires that identity for an in-place upgrade. Ordinary `assembleDebug` builds are for USB testing.

From `mobile/`, set `ANDROID_HOME` to your SDK directory. Set `DN_ANDROID_RELEASE_CERT_SHA256` to the trusted public distribution certificate’s SHA-256 fingerprint from your release configuration. The stable and beta channels use the same signing identity. Then run the following with the signed APK and an output directory of your choice.

```sh
pnpm android:prepare-update /path/to/signed.apk /path/to/release-assets
```

The command verifies the signing fingerprint, package, version and release build type. It reads the mobile fork’s public release history and downloads the most recently published Android APK, including betas, to check its actual version code. The new code must match the Gradle build and exceed that published code. After these checks it copies the APK under the filename the app expects. Create a release on the mobile fork using the tag it prints and attach that file. For example, version `0.23.0` uses tag `android-v0.23.0` and asset `droppedneedle-android-0.23.0.apk`. For `0.23.0-beta.1`, use `android-v0.23.0-beta.1` and mark the GitHub release as a prerelease. The Android app only reads published releases. [Mobile fork releases](https://github.com/phillip9933/DroppedNeedle/releases)

## How the clients fit together

The mobile app is a separate Svelte entry point. It shares the v3 contract, browser pairing format, theme colors, EQ preset curves, artwork and player handoff controls with the web frontend. The mobile build bundles its UI on the device. Browser pairing uses the DN web sign-in page. Handoff uses two account-scoped v3 routes on the matching Rust server. Recent-play smart rules and server-provided ReplayGain tags use new optional catalog fields. An existing server can still provide library browsing and streaming.

Android uses a Media3 playback service. iOS uses AVQueuePlayer and a resource loader for authenticated byte-range requests. The native player owns the track queue. The Svelte view reads its current state when the user reopens the app. Native API and audio requests authenticate to the selected server. Native session credentials use Keychain or Android Keystore-backed storage. The web preview holds credentials in memory and fetches each track before play.

To check the native player, play a two-track album, lock the screen, and wait for track two. Pause from the lock screen, reopen the app, and check the title and play state. Also test seeking, a headset disconnect, a call interruption, and session revocation on the target OS.
