# Changelog

[简体中文](../../CHANGELOG.md) | **English**

The single source of truth for the version number is `version.json` in the root directory. The build script automatically syncs it to several places: Gradle / Java / web page / Service Worker cache name (`CACHE` in `app/sw.js`).

---

## 1.2.2 — Fifth Version

### 1. Rectification According to the Code Review Report from Hy4 Flash (Full Coverage of 32 Items)

A full review targeting 1.2.1, with a report of 328 lines and 32 items (0 blocker / 2 high / 9 medium / 14 low / 7 info). **All were processed**, of which 30 were actually modified and 2 were verified as not to be changed with reasons given.

The most important thing this round was **catching two "fake fixes" from the previous round** — the comments and CHANGELOG both claimed they were fixed, but the logic never actually took effect. Neither was covered by tests, so they stayed alive.

**The Two Fake Fixes**

- The resume "user has taken over" guard was a no-op: the sequence number increment was written *after* the online quality-resolution loop. During slow-network resolution the guard would "catch up" to itself, so old tracks overwrote new ones and the old progress was written into the new track's element. The registration now happens at the very start of the function, with checks before all 5 nodes that write to the player. (Second fix for E-08)
- Search "Load More" was guaranteed to throw `NotFoundError`: new rows were inserted with `insertBefore(row, more)`, but `more` is a **sibling** of the list container — per the DOM spec the reference node must be a child. So every click fell into `catch`, the button permanently showed "Load failed", and online search could only ever show the first 30 results. Changed to `appendChild` (new rows belong at the tail anyway), and the old-cache fallback path was rewritten as well. (Second fix for E-01)

**Player**

- Auto-playing on cold start: `Player.load(t, {autoplay:false})` passed an **object**, and objects are always truthy, so `if (autoplay)` always started playback. With no user gesture the WebView refuses and falls back to muted playback — the classic "progress bar is moving but there is no sound". The call site now passes a boolean, and `load()` normalizes both forms so future object-style calls stay silent too
- Roam continuation queue was neither deduplicated nor capped: now deduplicated by id with a 300-track cap, plus a fix for the current-track index offset when truncating from the head (otherwise it pointed at a different track)
- Equalizer preset whitelist, implementation, and panel all had different lists: "Bass" and "Night" were rejected by the whitelist on save and fell back to Off after restart; conversely `jazz`/`classical` were whitelisted but had no curves, so selecting them was just silence. Unified to match the implementation and panel; users who historically picked those two values are explicitly mapped to Off via `MIGRATE` with a log line — simply deleting them from the whitelist would silently wipe old user settings
- Existing logic for lyric-tap seeking, playback speed, and sleep timer is unaffected

**Interface and Interaction**

- Esc could not close any dialog: the branch referenced `closeAnySheet` and `[data-modal-cancel]`, neither of which exists anywhere in the repo (the former is a dead identifier, the latter should be `[data-cancel]`). So on hitting a dialog it neither closed it nor reached `closeNP()`, because of an unconditional `return`. Now it reuses the exact decision order of the back key `__rippleBack`: modal → sheet/mask → player page
- The "Albums" and "Artists" group rows in the library looked exactly like clickable track rows but did nothing when tapped. They are now genuinely clickable — tapping an album/artist filters to its tracks and switches back to the "Songs" tab, and the count heading becomes "Album name · N tracks" and clears the filter on tap. Group views use the unfiltered list, otherwise switching back to the "Albums" tab after drilling into one album would leave only that album
- Hero "Shuffle" was silently dropped when it collided with an in-flight request, yet still showed the old track name. It now queues (keeping only the last request), and the button shows "Switching, one moment" while busy. Also fixed the deterministic randomness in the force branch — the same track was always picked on the same day, making "Shuffle" a no-op
- "Refresh Profile" only cleared `_myPl`: the home page's daily recommendations / recommended playlists / charts caches were never invalidated, so on a weak network it did nothing. Now routed through `invalidateHomeCaches()` (including `_homeSig`, otherwise `renderHome` short-circuits)
- Slider tooltips in the playback settings panel showed bare numbers: the format table read the key from `data-set`, but the four sliders in that panel use `data-opt`, so "Volume" showed `0.85` (should be `85%`), speed `1.05` (should be `1.05×`), font size `12` (should be `12px`). Both attributes are now recognized
- Opening a playlist wrote the truncated result **back into the cached object**: the first open showed "first 300 of 500", and opening the same playlist again showed only 300 with the note gone. Now only the render copy is truncated
- Turning off "In-app notifications" also swallowed `check` success confirmations: "Added", "Logged in", "Restored defaults" carry the same "tell me it worked" duty as `warn`, and swallowing them produces the same "tapped and nothing happened". `check` is now an exception
- Light theme `.about-note` (10px explanatory body text) had a 3.56:1 contrast ratio, below WCAG AA: it now uses `--text2` alone → **4.87:1**. `--text3` itself is untouched — it is a deliberate hierarchy tradeoff, and raising it globally would collide with `--text2`

**Local Server**

- `.local` (mDNS hostnames) could open the page and get a token, but **every API returned 403**: the issuing side allowed `*.local`, while the auth side used a different exact-match set. Both are now unified in a new `server-security.js` module, with issuing and auth sharing the same `hostIsAllowed`; `hostMatches` additionally requires the Origin host to exactly match the request Host (stricter than before)
- Security decisions previously had **zero automated tests**: after extracting `server-security.js`, 22 cases were added in `tests/server-security.test.js`, covering the Host whitelist (including forged suffixes and empty Host), same-origin vs cross-origin, Sec-Fetch combinations, token lifetime and IP binding, and upstream path traversal (`../`, `%2e%2e`, `%2F`, `//`, absolute URLs). Total cases went 38 → **60**
- Startup log showed "valid for 0 minutes" under a short TTL: now displayed in seconds when under one minute
- Sec-Fetch headers can be forged: this layer blocks **blind** cross-site requests (web JS cannot set `Sec-Fetch-*`), but cannot stop forgery by a program able to run on the same machine. The overstated comments were corrected and the threat model documented in `SECURITY.md`/README. **The TTL stays at 30 minutes** — the frontend only fetches a token once at page load and does not auto-renew on 401, so for a player that stays open while listening, shortening the TTL would turn security anxiety into interface-wide failures; meanwhile the benefit against a same-machine attacker is ≈0 (they can just issue another one)

**Android Shell**

- Synchronous disk writes on the main thread during cold start: `CrashLog.step()` and `recordExitInfo()` need a MediaStore query plus a cross-process `openOutputStream`, and the first step always fires (the time window starts at 0). Moved to a background single thread (the crash path stays synchronous — the process is about to die and queued tasks may never run), with a lock around the actual disk I/O so background writes and crash writes cannot truncate the same file
- Runtime logs were lost on crash: `LogBridge`'s header comment promised "force flush on crash", but `flush()` was only ever called when the web page asked. Added a synchronous `forceWrite()` called from the crash handler — deliberately not reusing the asynchronous `flush()`, because after a crash the process is killed almost immediately and queued tasks never get a chance to run
- Bare `Long.parseLong` in `song_detail`: one bad id from upstream throws `NumberFormatException`, which bubbles up to the bridge and makes the whole batch return `code:-1` — the user sees "playlist won't open" when only one item was bad. Now caught per item and skipped
- The crash report version is now read from `PackageManager` at runtime (falling back to a constant only if that fails). Previously, building by hand or bypassing `build-apk.sh` would leave the reported version out of sync with the real APK. The fallback string shape was deliberately preserved so `sync-version.sh`'s sed anchors and the CI `grep -F` assertions are unaffected
- Removed the zero-call `CrashLog.recordRaw()`

**Documentation**

- The English link at the top of `CHANGELOG.md` pointed to `/sdcard/CHANGELOG_en.md` (nonexistent): changed to `./docs/en/CHANGELOG_en.md`. All language cross-links between the 5 Chinese and 5 English documents are now valid (10 links, 0 BAD)
- README said "dual `<audio>` element architecture", but there are actually three: one for direct online streaming, one for local WebAudio (equalizer-capable), and one for cross-origin direct links. The last deliberately omits `crossOrigin` (third-party audio does not return CORS headers, and mixing them up would be judged a load failure)
- README/SECURITY now document `.local` access and the same-machine threat model

**Code Cleanup**

- `hideSliderTip()` was defined but never called (tooltips actually collapse via `paintSlider(el,false)`), removed
- `.dock-inner::before` removed from the liquid-glass reflection selector group: it has `overflow:hidden`, so a negative z-index pseudo-element gets clipped along with the background and never shows. Since 1.2.1 the reflection has been done via multi-layer `background` gradients
- Comments referenced version numbers that do not exist (`1.2.22` / `1.2.23` / `1.2.4` / `1.3.x`): this repo's history is 1.0.0 → 1.1.0 → 1.2.0 → 1.2.1 → 1.2.2, with none of those. Rewritten as descriptive wording
- A `responsive.css` comment claimed "min-width:840 tablet breakpoint", but the actual breakpoint is 700. Corrected

### 2. Two Items Judged Not to Change

- **`manifest.webmanifest` theme color hardcoded dark**: the PWA standalone window title bar takes the static manifest value and does not follow the light theme. Providing two manifests per system light/dark would require `index.html` to dynamically inject a `<link>`; low benefit against a large blast radius, so it stays a known limitation
- **`info` toasts are still swallowed when "In-app notifications" is off**: this is the intent of that switch (`check`/`warn` have been made explicit exceptions). `info` is mostly progress chatter like "Resolving audio source…", exactly what a user turning notifications off wants suppressed

### 3. Regression Testing

- Test cases **38 → 60** (22 new for server security decisions)
- Both fake fixes were reproduced with minimal implementations following DOM/async semantics to confirm "fails before, passes after", rather than concluding from code reading alone

---

## 1.2.1 — Fourth Version

### 1. Home Page Changed to "Daily Recommendations / Recommended Playlists / Charts"

The original second block was "Charts" and the third block was "Recently Played". Now they are replaced with:

| Position | Before | Now |
|---|---|---|
| 01 | Daily Recommendations | Daily Recommendations (unchanged) |
| 02 | Charts | **Recommended Playlists** |
| 03 | Recently Played | **Charts** |

- **Recommended Playlists** uses the `personalized` endpoint (`Netease.personalizedPlaylists(10)`),
  and is cached independently from Charts — previously it was "only fall back to recommended playlists when the chart is empty,"
  so the two endpoints affected each other, and if Charts failed there was no content below. Now they are fetched separately and fail separately.
- The "More" on the right side of Recommended Playlists **expands into a 2-column grid within the home page** (no page jump),
  and tapping again collapses it. When expanded, the horizontal scrolling row is hidden to avoid the same batch of content appearing twice;
  the button text changes to "Collapse" accordingly, and carries an `aria-expanded` state.
- Removed the "Recently Played" block (including `#gridView` / `#listView`).
  **But the rendering code is kept and null checks were added** — old cached pages (the SW may still be serving old HTML)
  still have these two containers; directly assigning `.innerHTML` would throw and interrupt the entire `renderHome`.

### 2. Added "In-App Notifications" Toggle (Off by Default)

Settings → Notifications, first item:

- **Off by default**. When turned off, the toast that pops up at the top no longer appears.
- The interception point is placed at the **entry of the `toast()` function**, rather than modifying 106 call sites —
  the latter would inevitably miss some, and future newly added notifications would be forgotten again.
- **Two exceptions are unaffected**:
  - `warn` (failure/exception) types are still displayed. If "login incomplete" or "this song cannot be played"
    were also swallowed, users would only feel "nothing happened after I tapped," which is worse.
    The intent of turning off notifications is "don't disturb me," not "don't tell me even when something goes wrong."
  - The bottom `toastBottom` (operation confirmations such as "press again to exit") goes through another channel
    and does not pass through this toggle at all.
- Native system notifications are controlled separately by "Notifications do not interrupt playback" (`notifyQuiet`); the two do not interfere with each other.

### 3. Mini Player Adds the Liquid Glass Reflection Layer

The mini player (`.dock-inner`) was already in the liquid glass list, and its `backdrop-filter`
was **completely identical** to the notification above (`blur + saturate + brightness + url(#lg-warp)`).
But visually it was clearly "flatter." The root cause was:

- The notification above does not have `overflow:hidden`, while `.dock-inner` **does**
  (used to clip the 2px progress bar and rounded corners inside it)
- The reflection highlight layer is a `::before` with `z-index:-1`, and **pseudo-elements with negative z-index are also clipped by the parent's `overflow:hidden`** — the highlight could not be drawn at all

Fix: **overlay the reflection directly into the multi-layer gradients of `background`**.
`background` is already the layer that gets clipped, so no extra DOM or pseudo-element is needed.
Three layers from bottom to top: bottom ambient shadow → 128° diagonal sweep light (same curve as `::before`,
intensity scaled by `--glass-strength`) → the original `--glass` base color.
In addition, 3 inset edges were added (top bright line / bottom dark line / inner bright edge) to create a sense of glass thickness.

It does not take effect in low quality mode (`html.perf-low`), preserving the original solid-color appearance.

### 4. Default Lyric Font Size

Continues with 1.2.0's 11px (slider range 11–19px).

---

## 1.2.0 — Third Version

### 1. Rectification According to the Code Review Report from MimiMax M3.1 Flash (Full Coverage of 135 Items)

A full review targeting 1.1.0, with a report of 1058 lines and 135 items (16 high / 62 medium / 56 low / 1 info,
no blocker). **All were processed**, of which 132 were actually modified and 3 were verified as not to be changed with reasons given.

**Data Safety and Crashes (Highest Priority)**

- "Add from link" writing records without blobs would pollute IndexedDB, and on the next startup **the entire local music library would disappear**.
  Changed to per-item try/catch + a separate restoration path for linked tracks, so a single bad record no longer drags down everything
- The crash handler was installed twice: duplicate crash files, and the Activity leaked into a static field. Changed to install only once + idempotent
- `onRenderProcessGone` returned true but did not destroy/rebuild the WebView → the back key permanently stopped working. Changed to actually rebuild
- The safeMode counter was cleared as soon as the WebView was successfully created, so it permanently failed for "failures during page loading." Clearing was moved to after the page stabilizes
- `dbClear` / `dbAll` lacked `onabort`: when a transaction aborted, the Promise would never settle, and the home page could not load

**Search and Lists**

- Search "load more" inserted new songs into the "Playlist" list (the first `.list` in the container)
- `renderAll()` unconditionally reset the search page: tapping ♥ once made the entire search result block disappear
- Playlist details had no request sequence number; when switching quickly, an old request could overwrite the new playlist
- The playlist page header always showed "Loading…" (the success path did not clear it)
- Roam continuation queue was not deduplicated, so listening became more and more repetitive

**Player**

- While dragging the progress bar, the per-second ticker pulled the slider back to the playback position
- The bottom dock progress bar was permanently invisible due to inline `width:0`
- `restoreLast()` had no "user has taken over" guard → it would steal playback, jump progress, and lose control; and it bypassed
  `Player.load()`, causing speed / MediaSession / equalizer graph to not take effect
- The fade target volume was a constant: volume changes during fade-in were eaten by the curve
- The event callbacks of the three `<audio>` elements did not verify "the event comes from the current element," so `ended` would unconditionally advance the queue
- `load()` directly called `new URL()` on invalid direct links and threw, and at that point the track had already been changed
- `seek()` had no finiteness validation: MediaSession could write NaN into `currentTime`
- `_ensureGraph` half-success would cause permanent silence and repeated rebuilding
- Lyric tap-to-seek did not subtract `lyricOffset`; after setting an offset, tapping any line was misaligned

**Exit and Background**

- Exiting the app did not stop the foreground service: the notification bar left a "Now Playing" notification that could not be swiped away and whose buttons all failed
- After the background `startForegroundService` was rejected by the system, media notifications were silently abandoned; changed to log + retry + notify the web page
- The WebView was destroyed before being detached, so resource cleanup on the exit path was incomplete
- A pile of `Ripple-crash-*.txt` files accumulated in the download directory: changed to overwrite a fixed filename + keep the most recent 10

**Login and Network**

- `logout` cleared cookies before requesting upstream (server.js); in browser mode, "Log out" did not actually log out the session
- Cookie "read-modify-write" was not inside a lock, so concurrent requests overwrote each other's `Set-Cookie`
- There were three copies of login state, and logout only cleared two (missing `CookieManager`)
- `login()` tied "login successful" to `status()`: a status timeout would make the entire login report failure
- Home page online content was serially blocked by account queries, so on weak networks it stayed on the skeleton screen for a long time
- When selecting a song, it first `await ensureLyric` before producing sound; if the lyric API was slow, it could wait for more than ten seconds
- `comments` spliced the id directly into the URL path; changed to double validation with `^\d+$` + path character whitelist
- Deleted three bridge methods never called by the frontend (`httpGetAsync`/`exitApp`/`platform`), directly eliminating attack surface

**Security Hardening**

- `/ripple-token.js` only trusted `Sec-Fetch-Site`: changed to a **short-term token** (TTL + bound to source IP +
  rotated on each issuance, keeping only 2 grace entries), and also validates `Sec-Fetch-Mode`/`Origin`/`Referer`.
  The frontend protocol is unchanged; the old "forge one header and get a long-lived token" no longer holds
- `.ripple-cookie` non-atomic write + swallowed exceptions: changed to temporary file + `rename` atomic replacement, with mandatory warning on failure
- `usesCleartextTraffic="true"` allowed cleartext for the entire app: added `networkSecurityConfig`,
  allowing only `127.0.0.1` / `localhost`
- Deleted three never-used permissions (`ACCESS_NETWORK_STATE` / `WAKE_LOCK` / `WRITE_EXTERNAL_STORAGE`)
- Added `error` listener to static file `createReadStream`; `/ncm` request body limit changed to count by **bytes** (previously
  by UTF-16 code units, so Chinese could actually consume 3 times as much)
- `/ncm/*` restricted to `POST` (`GET` could also trigger logout/like/comment_add)
- Parameter validation errors return 400 instead of 502; `song_detail` adds ids validation
- Host whitelist changed to query network interfaces in real time (switching Wi-Fi / IP changes no longer causes the whole site to return 421), and the 421 response body includes the allowed list

**Performance and Image Quality**

- **Low-spec threshold raised from 2 million physical pixels to 4.5 million**: previously 1080p alone was 2.07 million,
  so almost all phones were judged low-spec, and liquid glass (the main selling point) never appeared
- "Reduce motion" no longer participates in low-spec detection (it is a preference, not a performance signal), avoiding the situation where a flagship phone with "Remove animations" enabled
  becomes a power-saving appearance without glass texture
- Frame rate measurement when offline/backgrounded was misjudged and permanently downgraded: changed to count only visible periods frame by frame
- Rebuilding the MediaStyle notification once per second during playback → changed to cache by content fingerprint, with progress interpolated by the system
- `HttpBridge` created a new thread on every call → fixed 5-thread pool + bounded queue, with explicit error when rejected
- `LogBridge` did MediaStore queries + 200KB full rewrite on the UI thread → single-thread executor + throttling
- Player page progress bar changed to `transform` (does not trigger layout)
- Settings are merged and persisted in `requestAnimationFrame`, but fall back to `setTimeout` when the page is hidden
  (previously after locking the screen, rAF paused and the sleep timer was never written)

**State and Settings**

- `settings` in localStorage did not undergo type coercion, so bad values took effect silently: added `coerceSettings()`,
  validating item by item according to `DEFAULTS` types + clamping + enum whitelist
- "List density" and "Show lyrics" settings did not take effect after restart (DOM side effects were only written when manually changing settings)
- "Restore default settings" did not roll back `Netease.base` and the already-set sleep timer
- The sleep timer wrote both `sleepUntil` and `sleepMin` to disk, and reset them to zero after triggering

**Accessibility (The Largest Part of This Round)**

- Core lists/cards/settings rows were all `div`s, and keyboard and screen readers **could not use them at all**:
  song rows, grid cards, playlist cards, playlist rows, and carousel cards were all changed to `role="button" tabindex="0"`
  + `aria-label` + Enter/Space activation; `span.more` changed to a real `<button>`
- Custom-drawn dialogs had no `dialog` semantics, did not take over focus, could not be closed with the back key/Esc, and would exit the app:
  added `role="dialog"` + `aria-modal` + `aria-labelledby` + focus takeover/trap,
  **the back key now preferentially closes the modal** instead of exiting the app
- Added `aria-label` to 15 icon-only buttons; changed 9 switches to `role="switch"` + `aria-checked`
  (written in both the click path and startup sync), and added `aria-label` to 6 sliders
- Secondary text contrast in the light theme was only 2.38:1: `--text3` light .38→.52 (3.56:1),
  dark .36→.50 (5.32:1), `--lyric-dim` light .55→.68 (5.95:1),
  and removed the extra `.8` transparency from `.about-note`
- The collapsed player page and six sheets were still focusable: `visibility:hidden` (with delay to ensure the animation completes)
  + `inert` double interception
- Touch targets smaller than 44px: added hot zones for `.gcard .pl`, `.c-card .c-play`, `.chip`, `.sw`, etc.
  (`.sw`'s `::after` is already occupied by the white dot, so the hot zone uses `::before`)
- Full lyrics "current line enlargement" was suppressed by inline `font-size`: changed to use the `--ln-size` variable + `calc(×1.12)`
- Added a live region to the bottom capsule hint; the space key no longer hijacks button activation

**Visual**

- When lyrics expanded, **the title first jumped down 125.6px and then flew up**: the root cause was that on the first frame of expansion
  `min-height` became zero, and the freed space was grabbed by the cover container's `flex-grow:1`. Changed to keep
  `min-height` in the expanded state; measured title displacement changed from "534.9 → 660.5 → 50" to monotonic "534.9 → 50"
- The expand/collapse easing curve was replaced with a 14-control-point `linear()` finalized by the author's tuning (fast start, slow end),
  with a fixed duration of 0.3s
- The development animation tuner shipped with the production package (long-press "About" to pop up a fullscreen panel): **removed from the production package**
- The fallback rule "if there is no cover, do not draw the blur layer" could never be hit (`coverOf()` always returns a URL):
  changed to use the `body.no-cover` class
- Format/VIP badges in lists were permanently `display:none`: changed to display normally, hiding only below <360px
- `manifest` locked portrait orientation, making `responsive.css` landscape layout dead code: unlocked

**Engineering Quality**

- Added `tests/lrc.test.js`: **38 test cases** covering LRC parsing (four timestamp formats mixed),
  same-timestamp deduplication (0.05s), original/translation 300ms nearest-neighbor merging, and fallback by line number when timelines are inconsistent
- Added `.eslintrc.json` + `.prettierrc`
- CI version consistency check changed to exact matching (`versionCode 11` no longer matches `110`),
  and added `sw.js` `CACHE` validation
- CI added a Java compilation gate (aapt2 compile → link to generate R.java → javac)
- CI artifacts only upload the final `Ripple-*.apk`, no longer including unsigned intermediate products
- The CI release step no longer fails when this section is missing from CHANGELOG (the original else branch did not create a file)
- The Gradle path was completed with `signingConfigs` (same signature as `build-apk.sh`),
  and version syncing was extracted into `android/sync-version.sh` shared by both paths
- `build-apk.sh` directly `exit 1` on version parse failure (previously silently fell back to 14 / 1.3.5)
- Manifest package injection in `build-apk.sh` changed to structured insertion + double assertion, and the build fails if the format changes
  (`--rename-manifest-package` is unavailable on aapt2: it requires the input manifest to already have `package`)
- `MediaStore` persistence logic was extracted from `CrashLog`/`LogBridge` into `PublicFile.write()`
- Notification small icon changed from the system `android.R.drawable.ic_media_play` to a custom 24dp monochrome vector
  (on some ROMs the system icon is tinted into a white block)
- Dead code/dead style cleanup: deleted about 10 classes such as `.brand`/`.tbspacer`/`.navtabs`/`.titleblock`,
  4 CSS variables that were declared but never read, and 5 zero-reference ids; removed the empty `prof()` wrapper
- Merged duplicate grid declarations for `.np-inner` in `responsive.css`

**Documentation**

- README's 7 screenshots were added (`docs/screenshots/`, PNG compressed to about 1.6 MB total),
  corrected "0.67 MB" to the actual APK size, Java class count, and the "no Gradle dependency" wording
- SECURITY.md's "cross-site, headless requests are all 403" was not true in practice, changed to accurate wording
  (browser cross-site requests are rejected; other programs on the same machine can still access, but tokens are short-lived)
- SECURITY.md / README added measured notes that chmod is ineffective on `/sdcard` (fuseblk)
- Installation instructions now state the debug signature and "install only from this repository's Releases"
- CONTRIBUTING's SW cache name modification method is outdated (automatically synced by the script; do not edit manually)
- All "review X.Y fixed" style comments were changed to explain "why it is done this way," and history was collected into this file

### 2. Default Value Changes in This Round

- **Default lyric font size 14px → 11px** (slider range 11–19px). More compact by default, leaving more space on the player page
  for the cover and the breathing room of three lines of lyrics; the font size can still be adjusted at any time in settings.

---

## 1.1.0 — Second Version

### 1. Rectification According to the Code Review Report from MimiMax M3.1 Flash

An external review of 751 lines listing 91 issues (9 blocker / 26 high / 32 medium / 24 low).
Rectification was completed in five batches:

**Blocker (9, all fixed)**

- Searching once permanently broke the search page (hot search/recommendation nodes were wiped by `innerHTML`, and subsequent rendering threw)
- Service Worker cache version was decoupled from the code version → the entire app froze on an old version
- `server.js` same-origin determination could be forged by the Host header → login state could be stolen
- Remote direct links from "Add from link" could never play (CORS routing error)
- Song switching/fade-in/fade-out used the mutable `this.el` throughout → it would fade out and pause the new song
- Equalizer presets did not take effect for the first local song (but the settings page showed it as enabled)
- When an IndexedDB transaction aborted, the Promise never settled → import permanently stuck
- In the light theme, the contrast of non-current lyric lines was only 1.43:1
- `prefers-reduced-motion` did not actually degrade

**High (26, all fixed)**

Experience: search results could only show 30 items (`offset` was never passed down), a playlist with tens of thousands of songs rendered tens of thousands of nodes at once,
`status` timeout caused "Not logged in to NetEase Cloud Music" to be incorrectly displayed, the exit confirmation window
and the prompt duration were inconsistent, "Clear playback history" had no secondary confirmation, and background timers were never cleaned up.

Visual/performance: `.page` ran transition and animation at the same time, causing a pull-back at the end,
the progress bar transitioned `width` and triggered layout, `will-change` permanently occupied GPU memory,
glass saturation mixed four levels, panels stacked 4 layers of `backdrop-filter`, 14 touch targets were smaller than 44px,
and the whole-screen dominant color jumped instantly during dynamic color extraction.

**Medium / Low**: see the sections below; key points were handled according to impact.

### 2. Liquid Glass (High Image Quality Exclusive)

Referencing iOS 26's Liquid Glass, four features:

- **Gaussian blur** — `backdrop-filter:blur()`
- **Refraction** — `backdrop-filter: url(#lg-warp)`, using SVG's `feTurbulence` +
  `feDisplacementMap` to make the content behind actually bend.
  This is the boundary between liquid glass and ordinary frosted glass: ordinary frosted glass is uniformly blurred and looks like frosted plastic;
  real glass has thickness, and its edges **bend and displace** the background.
  Measured confirmation: horizontal stripes became waves after passing through the glass, while the control group (blur only) had straight stripes.
- **Reflection** — top bright line + bottom weak reflection + `::before` laying a 128° diagonal sweep light
- **Dynamic response** — when pressed, blur ×1.18, saturation ×1.06, brightness raised

All are uniformly driven by the "Glass Strength" slider: 0–40px normalized into `--glass-strength` (0–1),
scaling refraction amplitude, reflection highlight, and press strength at the same time. Pulling it to 0 completely disables `backdrop-filter`.

Low quality mode remains as before (ordinary frosted glass + solid base).

### 3. Real-Device Feedback Fixes

A round of intensive user testing, each item tracing the root cause backward from the symptom:

| Symptom | Root Cause |
|---|---|
| Lyrics unavailable after re-entering the app | In the restoration flow, the UI rendered first and lyrics came back later; timing mismatch |
| Layout exploded in floating window (411×685) | Cover size used a "larger value" fallback, ignoring container height |
| 411×851 fullscreen height incorrect, status bar not covered | safeMode judged `streak >= 1`, so after one restart it permanently degraded |
| Comments did not follow when keyboard popped up | Native `getInsets()` missed `ime()` |
| Last row of the music library was blocked by bottom navigation | Page padding was hardcoded to 150px and did not include `--safe-b` |
| Bottom navigation went out of bounds to the right | Liquid glass's `position:relative` overrode the original `absolute` |
| The page could be dragged anywhere | `html` did not lock `overflow` |
| An extra panel inexplicably appeared at the bottom | The panel collapsed with `translateY(101%)`, which was not enough to move it out when content was small |
| Home page large card had no cover after re-entering | After recommendations returned, only the horizontal scrolling area was updated; the hero was never redrawn |
| The time in the upper-left corner stopped at the moment of startup | It was only written once at boot, with no periodic refresh |

### 4. Feature Changes

**Home Page Large Card Changed to "Infinite Roam" Entry**

- Data comes from `v1/discovery/simiSong` (similar songs), no longer the first Daily Recommendation
  (previously it was the same image as the first small card below, looking duplicated)
- Three-level seed fallback: currently playing online song → first song in "Liked" → random Daily Recommendation
- Tap the main button: fill the queue starting from the song on the card and play, switching mode to `roam`
- Tap the secondary button: change to another song for display, without replaying
- Results are stored in `localStorage`, so the first frame on cold start already has a cover

**Search Pagination**

Previously fixed at 30 items; the `offset` parameter was defined but never passed anywhere in the project, and the UI still displayed the total count.
Now there is "Load More" + automatic fetching when scrolling to the bottom; new results are appended rather than rebuilding the list.

**Other**

- In-flight request deduplication (tapping the same song repeatedly no longer sends multiple requests)
- Settings sliders merge disk writes (dragging no longer fully serializes localStorage every frame)
- Back key double-confirmation to exit; the judgment window and prompt duration are unified to 2500ms
- `:focus-visible` keyboard focus styles, `aria-live` prompt area
- Cover size changed to be driven by a single CSS variable; removed the entire measurement/freeze/compensation logic

---

## 1.0.0 — First Complete Version

### Player Page

- Cover absorbs the remaining height; bottom buttons are fixed to the bottom
- Tap lyrics to expand in place (the overall page layout shifts up, no separate overlay)
- Horizontal swipe on the cover to change songs (the next cover slides in)
- Pull down to close the player page
- Playback settings panel (top-right …), equalizer, playlist
- Restore the last played song and progress (online tracks re-resolve the audio source after restart)

### NetEase Cloud Music Integration

- weapi protocol (double AES-128-CBC + RSA)
- Login (phone number / QR code), Daily Recommendations, search, playlists, comments, likes, Heartbeat Mode
- Audio quality tier switching, VIP badge, trial prompt

### Native Shell

- edge-to-edge: status bar/navigation bar transparent, the web page handles insets itself, insets passed through CSS variables
- Foreground service + MediaSession: notification bar playback controls, lock screen controls, headset buttons
- Status bar lyric overlay (adjustable color, font size, position)
- Crash logs, software logs, safe mode

### Adaptation and Performance

- Breakpoints judged by width + aspect ratio (phone / large phone / tablet portrait and landscape / foldable / desktop)
- Tablet left vertical navigation, two-column player page
- Low-spec mode automatically degrades (ambient light, noise, glass blur, panel backdrop-filter)
- Cover grid `content-visibility`, page `contain:paint`

### Themes

- Dark / Light / Follow system
- Dynamic color extraction (extract dominant color from cover)
- Liquid glass appearance (upgraded to real refraction starting from 1.1.0)