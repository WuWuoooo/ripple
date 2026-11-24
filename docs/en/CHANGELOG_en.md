# Changelog

[简体中文](../../CHANGELOG.md) | **English**

The single source of truth for the version number is `version.json` in the root directory. The build script automatically syncs it to several places: Gradle / Java / web page / Service Worker cache name (`CACHE` in `app/sw.js`).

---

## 1.3.5 — Twelfth Version

> **Basis**: six experience issues reported by the user (UI languages / lyric line
> transition / gaussian blur on line change / theme quick toggle / glass intensity range).
> **Implementation and docs by**: Deepseek V4.1 Flash 1017.
>
> An experience release: five items are new behaviour or new feel, one is a
> behaviour correction. All three platforms (Android / Windows / Linux) ship together.

### 1. UI languages (Chinese / English, extensible)

**Why not the usual `t('settings.appearance.glass')` scheme**

This project has 660+ UI strings spread across 8,600 lines of `app.js` and 890 lines of
`index.html`, most of them one-off literals like `toast('已刷新', …)`. Switching to key
names means touching hundreds of call sites, and every one of them is a chance to break
something — a mistake shows up as *missing copy* or a *raw key on screen*, which is worse
than not translating at all.

So the dictionary is keyed by **the Chinese source string itself**: `T('玻璃强度')` →
`"Glass intensity"`. Two benefits:

- An untranslated entry **falls back to Chinese automatically** — never an empty string,
  never a bare key name.
- The key looks exactly like the code it replaces, so a reviewer can see at a glance
  whether a given line has a translation.

**Three translation paths (skip one and you get gaps)**

| Path | Coverage | How |
|---|---|---|
| Static HTML | 190 | Walk the whole DOM once at load |
| DOM inserted at runtime | 500+ | `MutationObserver` catches it — **no call site changes** |
| Templated strings | 20 | Explicit `TT('{n} 首', {n: 3})` in source |

**Details that had to be handled**

- **Fragment concatenation**: strings built as `n + ' 首'` do not match any dictionary
  entry as a whole. The engine also does prefix/suffix fragment replacement, so
  `30 分钟` → `30 min` and `3 首本机文件` → `3 local files` (longest fragment first,
  otherwise it would produce `3 songs本机文件`).
- **Entries containing HTML**: a whole string like
  `<div class="empty"><b>这里还没有音乐</b>…` never matches — the browser parses
  `innerHTML` into separate text nodes, so the engine only ever sees a short sentence.
  Registering a dictionary therefore splits such entries on tags and adds the
  **inner text segments** as entries too.
- **Single-character fragments over-match**: on a real device, `深` → `Dark` turned the
  hero headline 「深夜很长，歌会一首接一首」 into 「**Dark**夜很长，」. The cause: a
  fragment starting with a Chinese character was being used as a prefix match. Fragments
  must now start with a **non-Chinese** character (space or punctuation).
- **Remote data is never translated**: song titles, artists, albums, lyrics and comments
  are left alone. Beyond "the dictionary simply has no such entries", containers such as
  `.lyric`, `#npTitle`, `.r-tx` and `#cmtBody` are explicitly skipped — this avoids the
  rare but baffling case of a track actually titled 「全部」 turning into "All".
- **Logs are never translated**: strings in `Log.add` / `console.*` are for developers;
  translating them only makes grepping harder.

**English typography is a separate layer**

Swapping copy without adjusting layout always breaks something: `"Volume normalization"`
is far wider than 「音量归一化」, while a settings row gives up 30px to the icon and the
rest to a switch, leaving only 200–240px for the middle. Under `html.lang-en` the
following are tuned separately: settings row `min-height` 52→56px, small text +0.5px,
line-height 1.55, `overflow-wrap:break-word` to contain long words, and tab-bar labels
elided on one line instead of wrapping. **Chinese is unchanged down to the pixel** —
that side has already been tuned over several rounds for contrast and line height.

**The native layer has to follow**

Notification channel names, the three notification action buttons, the crash screen and
the "install unknown apps" guidance all live in Java, where the web layer cannot reach
them. A new `L10n.java` (two-argument `t(zh, en)`, deliberately no key table) covers 31
places, synced from the web layer via `RippleNative.setLang()`.

> **Known limitation**: once an Android notification channel has been created, the system
> does not allow renaming it — after switching language, an **already existing** channel
> only updates on reinstall or clear-data. That is platform behaviour, not an oversight.

**Adding a third language later**: create `app/js/lang/xx.js` calling
`I18n.register('xx', 'self-name', dict)`, add one `<script>` line in `index.html`, add one
entry to `SHELL` in `sw.js`, and add the code to `ENUMS.lang` in `store.js`. All four
places carry comments; `tests/i18n.test.js` asserts the last two agree with the first two.

### 2. Smooth transition between previous / next lyric lines

Line changes used to be **instantaneous**: `textContent` was rewritten and the browser
painted the new text on the next frame. Visually it snapped, and the direction —
previous line drifting up, next line arriving from below — was entirely lost.

**Why a transition on `.ln` alone does not work**: a line change replaces text content,
not a transitionable property. Fading `opacity` out would animate the **new** text, which
reads as a flash and is worse than no animation.

So two layers are stacked:

1. **Before** the line change, the current three lines are copied into a snapshot layer
   `#lyrGhost` (absolutely positioned, sized from the same `--lyr-lh`).
2. After the change, the snapshot drifts up and blurs out while the new three lines fade
   in from below, blurred.

The duration is its own token, `--lyr-roll: .26s`, not `--dur(.42s)` — lyrics change every
two or three seconds, and .42s would keep the whole block moving and blurry, while .22s is
too fast to read as direction.

Two kinds of line change deliberately get no animation: **changing track** (different
semantics; rolling in makes it look like the previous line was cut off) and **seeking**
(that is a jump, not a scroll), decided by `_lyricRollArmed` / `wentBack`.

### 3. Gaussian blur on line change (high quality only)

This is the `filter:blur(3px)` → `0` inside the transition above.

- **Enabled only under `html:not(.perf-low)`**: blurring a text layer every frame is pure
  cost on a low-end device, and since the transition lasts 260ms, dropping the blur still
  gives a smooth scroll with the semantics intact.
- **Respects `prefers-reduced-motion`**: if the system says no motion, the effect does not
  override that (with a backstop in `responsive.css`).

### 4. Lyric blur: lines blur more the further they are from the current one (new setting, high quality only)

In the expanded lyric view, **the further a line is from the current one, the blurrier it
gets** — not "one clear line, everything else equally blurred":

| Distance from current line | Blur radius |
|---|---|
| 0 (current) | none |
| 1 (one above / below) | 0.2px |
| 2 | 0.45px |
| 3 | 0.8px |
| 4 and beyond | 1.25px (capped) |

This holds the eye on the current line better than lowering opacity uniformly — the human
eye is far more sensitive to **structure** (whether strokes are still separable) than to
brightness. It follows the iOS Music idea of a sharp centre fading with distance.

**New setting "Lyric blur", on by default**, in two places:
- "Me → Lyrics → Lyric blur"
- Player top-right "…" → end of the lyrics group

Both appear **only on high quality**. It does nothing on low-end anyway (dozens of lines
with `filter` means dozens of offscreen layers), and a switch that has no effect is worse
than no switch at all.

**Three implementation trade-offs**:

1. **Per-line `filter:blur` rather than a container mask gradient.** `.lyric` already carries
   a top/bottom mask for the overall fade; stacking both makes the blur edge compute wrong
   and smears neighbouring lines together. Per-line filter keeps each line separate, which is
   exactly what produces the stepped look.
2. **Depth is a `data-lbd` attribute, not an inline filter.** Inline styles win over the
   stylesheet, so a leftover filter after turning the setting off would need a per-line
   `removeProperty`. Attribute plus a positive root class `html.lyr-blur` means switching off
   disables everything at once.
3. **Radii must be small, bounded by "text still readable"**. The numbers went through two
   rounds of real-device tuning: the first version `0.5 / 1.2 / 2.4 / 4` was reported as
   "too strong, can't read the text" (4px smears 14px text), and `0.2 / 0.6 / 1.2 / 2` was
   still heavy, so the final values are `0.2 / 0.45 / 0.8 / 1.25`.
   The adjacent line stays at 0.2px — that is already the threshold of perceptibility, and
   going lower would effectively disable the feature, so only the outer three are reduced,
   with a decreasing ratio (2.25× → 1.78× → 1.56×): fast near, slow far, keeping separation
   close in without a sudden cliff further out. An arithmetic series is indistinguishable
   between neighbouring lines and loses the hierarchy.

Depth is re-marked whenever the current line changes (only on `changed`, not every 100ms),
and again after the lyric DOM is rebuilt — otherwise the blur would wait for the next line
change to appear.

Under `prefers-reduced-motion` the **blur itself is kept** and only the transition is
dropped — blur is a static hierarchy, not motion, and removing it turns the whole lyric view
into a wall of equally weighted text. This differs deliberately from the line-change
animation.

### 5. Theme quick toggle: "auto" no longer looks like a no-op

**Before**: the top-bar button cycled `dark → light → auto`. Starting from `auto` the next
state was `dark` — so **if the system was already dark, the click changed nothing on
screen** (only the toast text). Users assumed the button was broken and clicked twice.

**After**: the button means "flip light/dark", not "cycle three modes".

- dark ⇄ light (unchanged)
- auto → jumps to the **opposite of what is currently displayed** and lands on that
  explicit mode
- once on an explicit mode, further clicks keep flipping between dark and light

Why auto lands on an explicit mode rather than staying on auto: staying on auto would make
every click require reading the screen to know the outcome, which is not how a quick-toggle
should feel. The way back to "follow system" is the three-way segmented control in
settings, whose semantics do not conflict.

Both theme states (`auto` resolving to dark and `auto` resolving to light) follow this rule.

### 6. Glass intensity is now a literal small value

| | Before | After |
|---|---|---|
| Range | 0 – 40 px | **0 – 4 px** |
| Default | 26 px | **2 px** |
| Step | 2 | **0.1** (40 stops, 20× finer) |

**Why**: 26px of blur is no longer glass — you can barely see what is behind it. Real-device
testing puts the best look at 2px; above 4px the content underneath is invisible, and glass
is supposed to be transparent. So the value is now taken literally, with no scaling.

**Three places must change together** (miss one and dragging to the maximum does almost
nothing):

1. `DEFAULTS.glassBlur` and `NUM_RANGE` in `store.js`
2. the **normalisation divisor** for `--glass-strength` in `app.js` (`/40` → `/4`) — the
   subtlest of the three: the blur itself looks fine, only refraction and highlight barely
   move
3. the first-paint fallback `--glass-blur` in `base.css`

**Migration for existing users (`schema` 5 → 6)**: old saves hold values in the old range.
Changing `DEFAULTS` alone would let `NUM_RANGE` **silently clamp** them to 4 — the glass
would jump to maximum thickness for no reason the user can see, unrelated to their own
choice. Values are therefore divided by 10 to preserve their relative position on the
slider; the old default 26 lands directly on the new default 2, otherwise people who never
touched the slider would see 2.6 while fresh installs see 2.0.

Also fixed `Number(null) === 0`: a saved `glassBlur: null` would convert to 0 (glass fully
off), even though `coerceSettings` treats it as invalid. The two now agree.

### 7. Tests and known limitations

New `tests/i18n.test.js` (16 cases, plus 11 migration cases); the full suite is
**197 / 197 passing**. The most valuable one asserts that the dictionary covers every
Chinese UI string in the source — a single missing entry silently falls back to Chinese,
and nobody is going to count 660 strings by hand, so only a machine can check it.

**Not done in this release**:

- Notification channel names do not follow the language (Android platform limitation, above).
- Text inside the lyric surfaces (status-bar overlay / desktop lyric window) is **not
  translated** — it renders lyric content itself, which is remote data.
- Lyric blur applies to the **expanded** view only. The collapsed three-line view has just
  three lines with the current one in the middle, so stepped blur shows no hierarchy there —
  it only makes the lines above and below harder to read, and those are exactly the
  "what's coming next" preview.
- On desktop only the window buttons are localised. Tauri runs a `decorations: false`
  window, so the title bar is drawn by the page and there is no native menu to translate.
- Chinese exception messages inside `ApkProvider` / `NeteaseClient` are not translated —
  they travel internal error paths and never reach the user.

---

## 1.3.4 — Eleventh Version

> **Basis**: the 1.3.3 code review report from Deepseek V4.1 Flash 1017 (Hy4 Flash).
> All 18 remaining items are done here (3 high / 7 medium / 8 low).
> **Implementation and docs by**: Deepseek V4.1 Flash 1017.
>
> No new features — this is a pure remediation release. The previous version got
> lyric colouring right; this one clears the debt the review report pointed out.

### 1. The three high items

**S-01 Logout race: a slow request resurrects the login**

`epochAtStart` used to be captured inside the `https.request` **response callback** —
that is when the response *headers* arrive, by which time the user may long since
have logged out (`cookieEpoch` already incremented). So the snapshot was taken from
the *new* generation, the later `epochAtStart !== cookieEpoch` comparison always
matched, and the generation guard did nothing. A slow request (`status` fires
vip/level/like, or a large playlist) could merge `MUSIC_U` back into `cookieJar`,
write it to disk, and **the next launch is logged in again**.

This was an incomplete fix of review item S-03 from 1.2.2 — the mechanism was right,
the sampling point was wrong. It now samples before the `https.request` call.

**D-01 The lyric window's "draggable when unlocked" was never implemented**

Tauri 2 finds drag regions via the `data-tauri-drag-region` attribute, and
`lyric.html` had none — dragging the window with the mouse did nothing (only the
window manager's Alt+drag worked), yet the README listed "draggable" as done.

Added `data-tauri-drag-region="deep"` to `<div id="wrap">` (the `deep` variant is
required: with the bare attribute, clicking the `<span id="t">` child fails because
`el !== composedPath[0]`).

**D-02 The desktop bridge lacked `setLyricTiming`, so background fill fell back to the broken path**

`app.js` branches on `typeof N.setLyricTiming === 'function'` to choose
"baseline + extrapolation" versus "per-frame push". The desktop bridge had no such
method, so it always took the second path. But the lyric window exists precisely
for **watching while you are in another program**, where the main window's rAF is
paused and its ticker cleared — the per-frame stream stops and it degrades into
"snaps full at the end of a line, jumps at the next one": exactly the symptom that
took eleven rounds to fix on Android in 1.3.3.

Completed across all three layers:
- `bridge.js` gains `setLyricTiming(p, lineDur, rate, playing)`
- Rust gains the `lyric_overlay_timing` command and four baseline fields on `LyricState`
- `lyric.html` extrapolates with `performance.now()` (no extra timer — that window
  stays visible, so its rAF keeps running)

### 2. The seven medium items

| ID | Problem | Fix |
|---|---|---|
| E-03 | The dark-fill guard ran *after* inversion, so the default purple inverted to `#4C5D00` (luminance 0.094) and was reverted — the "auto-invert in dark mode" switch could never work on the default colour | Guard runs before inversion and only inspects the user's own colour; when inversion is on it does not intervene at all |
| E-04 | A user's deliberately chosen dark fill was silently replaced with purple, contradicting the store v5 migration ("respect `#000000`") | Guard only recognises known-bad values (`#000000` / `#4C5D00`); anything else is left alone |
| E-06 | The v1→v2 migration unconditionally re-enabled `sbFill` for users who had turned it off | New `sbFillUserSet` flag written by the settings-change entry point; the migration skips when it is set |
| E-07 | `Store.set()`'s rAF batching lost the batch if the screen locked right after queueing | Re-check visibility on every `set`; if hidden and an rAF is pending, `cancelAnimationFrame` and flush via `setTimeout` |
| S-02 | The "token invalid after IP change" test was misnamed (`host` hardcoded to 127.0.0.1) and `tokenValid` had zero coverage | The helper now takes `localAddress`; the test really switches to 127.0.0.2 and asserts 401 |
| D-03 | Position units mismatched (physical pixels stored, restored as logical), so HiDPI screens drift further with every drag | `lyric_save_pos` divides by `scale_factor()` before storing |
| D-04 | "Reset to default position" did nothing for an existing window and never deleted `lyric-pos.json` | Detect x/y going from ≥0 to <0 → delete the file, clear state, and really `set_position` the live window |
| D-05 | Single-instance had no real O_EXCL and never removed the lock, so PID reuse could permanently refuse to start | Real `OpenOptions.create_new(true)` (`O_CREAT|O_EXCL`); on exit, verify the PID before removing the lock |
| D-06 | `can_draw_overlay` / `request_overlay_permission` were dead commands whose semantics contradicted the bridge | Both commands and their registrations removed; the JS bridge's hardcoded `true` was correct all along |

### 3. The eight low items

| ID | Fix |
|---|---|
| S-03 | workflow `paths`: `desktop.yml` → the real `desktop-build.yml` |
| S-04 | `server.js` comment "3 slots" now references the `TOKEN_PER_IP` constant |
| S-05 | `sw.js` comment "3" → "6 per IP (new + 5 old)" |
| S-06 | `lyricfill.test.js` count 21 → 31 |
| S-07 | README "11 classes" → 12 |
| D-07 | The whitelist test rewrote its own criteria, opposite to production → extracted `is_safe_upstream_path` and shared it |
| D-08 | Removed throwaway dead code in `netease.rs` |
| D-09 | capabilities split into `default.json` (main) and `lyric.json` (lyric window), least privilege |
| D-10 | `build-frontend.sh` now also syncs the Cargo.toml / Cargo.lock version (otherwise the installer and crash-log versions disagree) |
| D-11 | Desktop README "shipped with 1.3.0" → 1.3.4; "nothing unimplemented" → an honest list (media controls / notifications / macOS) |
| D-12 | A comment referenced a non-existent `lyric.rs` → now points at the comment block in `main.rs` |

### 4. Also fixed

- The desktop workflow header and the bundle job comment both claimed "macOS participates
  by default", while the actual `matrix` is Linux + Windows only — two self-contradictory
  stale comments, now consistent with reality (this project ships no macOS bundle:
  an unsigned one is blocked by Gatekeeper, a double-clickable one needs an Apple
  Developer account plus notarisation, and it cannot be verified on this machine)

### 5. Regression tests: 169 → 170

Six added or updated, each mapping to an item above:

| Change | Item |
|---|---|
| `S-13-e2e token` renamed + a real IP-switch assertion expecting 401 | S-02 |
| `E-06: a user who turned it off (flag set) is not re-enabled` (new) | E-06 |
| `E-06: old save (no flag) is enabled on upgrade` (renamed/rewritten) | E-06 |
| The "migrate then save then load" fixture now omits `sbFill` | E-06 |
| `R-13 status-bar fill…` asserts the known-bad-value criteria | E-03 / E-04 |
| Manifest consistency check bumped to 1.3.4 | version |

### 6. Check for updates (user request)

> User's words: "add a 'check for updates' under the settings, below the software log;
> clicking it sends a request to GitHub to see whether a newer version exists; check on
> every launch too; then the update button in the popup should be able to download the
> new installer directly, and then install it. Windows and Linux need it too."

**A rejected idea first**: the user originally suggested something bolder — hot-updating
only the HTML/CSS/JS and restarting at runtime. That is technically entirely feasible
(no Gradle, no bundler here, so `assets/www` is naturally replaceable, and `sw.js`
already carries a version cache).

But **the APK itself is only 0.6 MB**, so one download finishes it. Hot updating would
require a writable directory, manifest signing, atomic switching and automatic rollback —
far more complexity and risk than the 0.6 MB it saves. So the installer is shipped directly.

#### Android

A new "Check for updates" row in Settings → About, right below the software log:

| Capability | Implementation |
|---|---|
| Check | `UpdateChecker.check()` requests the GitHub Release API on a **background single thread** |
| Throttle | Automatic check at most once per 6 hours (timestamp in SharedPreferences); a manual tap is never throttled |
| Download | Into `cacheDir/update/`, with a progress bar |
| Verify | Compares against GitHub's `size`; deletes the file and reports an error on mismatch |
| Install | A hand-written `ApkProvider` (ContentProvider) plus the system installer |

**Why a hand-written ContentProvider**: this project's hard constraint is **no AndroidX**,
so `androidx.core.content.FileProvider` is unavailable — and since Android 7.0 a
`file://` URI cannot be passed across apps, so a `content://` URI is mandatory.
The implementation is deliberately narrow: it only serves `cacheDir/update`, is read-only,
rejects file names containing `/`, `\` or `..`, and additionally verifies the resolved
`getCanonicalPath()`. Once a ContentProvider is granted out, any component holding the URI
can read through it, so the exposed surface has to be minimal.

**Why it asks before installing**: launching the installer takes over the whole screen,
which is a strong interruption; the user may want to download now and install later.
So a "download complete → go install" confirmation appears first.

**The Android 8.0+ "install unknown apps" permission**: it is sensitive but **not a
runtime permission** — the system never prompts for it; the user toggles it per app in
Settings. The code checks `canRequestPackageInstalls()` and, when it is off, opens that
Settings page and shows a toast — otherwise the user concludes "the button does nothing".

#### Windows / Linux

The desktop client **only checks and opens the download page**; it never runs the
installer for the user: the three platforms differ too much (Windows runs `setup.exe`,
Linux swaps the AppImage or needs `dpkg` for the deb), and safely launching that from a
web page is not realistic.

- Check: when `app.js` finds the desktop bridge has no `checkUpdate`, it falls back to
  `fetch`ing the GitHub API directly (`csp` in `tauri.conf.json` is `null`, so cross-origin
  is allowed)
- Open page: a new Rust command `open_external` uses `xdg-open` / `cmd /C start` / `open`
  per platform, and **only accepts http(s) URLs** — every other scheme is rejected

#### CI support

The GitHub Release API **does not expose versionCode** (it exists only inside the APK),
while "which version is newer" must be compared as an integer — comparing version-name
strings gets `1.3.10` vs `1.3.9` wrong. So the workflow embeds
`<!-- ripple-version-code: 134 -->` in the release body; the app parses it and falls back
to name comparison when absent.

#### What this part did not do

- **No "download and install" on desktop**: the three platforms have no unified way to
  launch an installer; forcing it would need privilege escalation on Linux (`pkexec`) or
  yield a worse experience. It opens the download page instead
- **No incremental updates**: every update is the full APK (0.6 MB — a diff is not worth it)

### 7. What this version did not do

- **The desktop client still has not run on a real desktop environment** (this machine is
  aarch64 proot with no display server; its local cargo 1.75 offline cache is missing
  `adler2 v2.0.1`, so `cargo check --offline --locked` cannot run). The desktop changes
  here were verified only at `rustfmt --check` level plus line-by-line static review;
  **compilation and runtime behaviour still need CI / real-user verification.** This has
  to be stated plainly.
- Items the review report already marked fixed (A-01 threading, E-01/E-02/E-05) were not
  touched again in this version.

---

## 1.3.3 — Tenth Version

> **Basis**: a user request — "add lyric scrolling to all three platforms (status-bar lyric /
> the normal expanded view / the collapsed view), with the already-played part covered in
> colour in real time as playback progresses."
> **Implementation and docs by**: Deepseek V4.1 Flash 1017.
>
> This is a **feature release**: it makes "lyrics colouring along with the music" actually
> correct on all four lyric surfaces — the status-bar overlay, the expanded full lyric on the
> playback page, the collapsed three lines, and the desktop standalone lyric window.
>
> Regression tests went from 160 to **169** (`lyricfill.test.js` 21 → 31,
> `store-migrate.test.js` 18 → 22), and the three-platform manifest check passes.

### 1. What it looked like before (otherwise the change is invisible)

The "cover colour with progress" capability **nominally existed**, but all three places were
wrong:

1. **The fill ratio used the whole-song progress**, not the current line's.
   `pushSbProgress()` pushed `Player.time() / duration` — on a 4-minute song, 10 seconds in,
   the overlay tinted the current line by 4%. So the colour edge and the word actually being
   sung never lined up; worse, whole-song progress **never resets** at a line change, so a new
   line starts out pre-tinted.

2. **Long lyrics did not scroll in the status-bar overlay.**
   `TruncateAt.MARQUEE` only scrolls while the TextView is `selected`, but the overlay window
   carries `FLAG_NOT_FOCUSABLE` (and `FLAG_NOT_TOUCHABLE` when locked), so it never gets focus
   → never becomes selected. Long lines were truncated by `maxWidth` and **sat still**; the
   second half was never visible. This is the real cause of "the status-bar lyric only shows
   half a line".

3. **The expanded full lyric had no colouring at all** — only a static bright/dim split.

### 2. Extracted "how far into this line" into a pure, unit-tested module

New **`app/js/lyricfill.js`** (260 lines) — pure math, no DOM, no Store:

- `lineProgress(lines, idx, now, dur)` — 0..1 within the current line
- `estimateLineDur(...)` — duration estimate for the final line
- `toneFor(cur, rel, count)` — `done` / `now` / `todo` per row

**Why a separate module**: `app.js` is over 7000 lines and touches the DOM directly, so it cannot be
unit-tested in Node — and this conversion is exactly what most needs pinning down. Boundary,
line change, final line, offset: get any one wrong and the symptom is "colour out of sync with
the voice".

New **`tests/lyricfill.test.js` (21 cases)**:

| Case | Why it must exist |
|---|---|
| Exactly at the start time → 0 | One missing `=` and it tints before the line starts |
| Next line's start → previous line is exactly 1 | Otherwise a gap, or it never fills |
| Final line just begins → far below 1 | No next line as endpoint; most likely to jump to full |
| Final line after a while → near 1 | And it must not stay forever-partial |
| Estimate uses the median | Not dragged by 10s+ instrumental gaps (the mean is) |
| NaN / string timestamps | Dirty data must not crash the page |
| Monotonic within a line | A regression makes the edge jitter |

> Writing these tests **caught a real bug**: the first `toneFor` was "`abs < c` means done,
> else now"; with `rel=+1`, `abs = c+1` is neither below `c` nor out of range, so it fell into
> `now` — the next line and the current line tinted simultaneously, both moving. The test went
> red immediately.

### 3. The three surfaces

**① Status-bar overlay (Android)**
- `setLyricProgress(p)` changed from whole-song progress to **the current line's** progress
- **No Java interface change needed** — the native side already clips a gradient by ratio
- `LyricOverlay.setText()` resets `progress` on a line change: the front end pushes new text
  then new progress across two bridge calls with a frame in between; without the reset the new
  line renders once at the previous line's 0.99
- `hide()` resets it too (reopening no longer flashes "already half sung")
- **Added `view.setSelected(true)`** — fixes the "long line does not scroll" bug above
- `applyProgressFill()` short-circuits to a flat colour at `p <= 0`, avoiding a 1–2px bright
  edge that looks like a bite taken out of the text

**② Expanded full lyric**
- The current line is coloured word-by-word; finished lines get a flat `.done` colour
- **Translations are not hollowed out**: `background-clip:text` requires
  `-webkit-text-fill-color:transparent`, which is inherited by the `.tr` child — the
  translation has no gradient of its own, so without rescuing it the **entire translation
  vanishes**. CSS explicitly restores fill colour and clip box on `.tr`

**③ Collapsed three lines**
- Current line coloured word-by-word; previous line `.done`; next line force-cleared
- The three lines are **fixed DOM nodes** (`lyrPrev`/`lyrCur`/`lyrNext`), so on a line change
  the identities shift — the previous `--kp` travels with the node into "next line", hence the
  explicit clear every frame

**④ Desktop standalone lyric window**
- Borderless, always-on-top, skipped from the taskbar, draggable; mouse-transparent when locked
- Same six bridge methods with the same signatures as Android, so the front end needs no change

### 4. The colouring colours are **computed**, not picked

The "played" colour cannot be `--accent`: that is a decorative colour, not a carrier for
readable text. Measured against `#F1EEEA`:

| Colour | Contrast | Verdict |
|---|---|---|
| `--accent #b3a2ff` (light theme) | **1.91:1** | ✗ lyric text is body-level; needs 4.5:1 |
| `#5833ff` (same hue, darkened) | **5.45:1** | ✓ passes AA |

So a new pair of tokens, `--karaoke-played` / `--karaoke-togo`, per theme:
dark `#b3a2ff` (9.13:1), light `#5833ff` (5.45:1). Only lightness changes, not hue (251°), so
it stays the same colour family in the light theme.

### 5. Two switches (both genuinely turn it off)

Settings → Lyrics: **Karaoke colouring**, **Mark finished lines**.

> Turning it off cannot merely "stop updating" — at that moment the current line is usually
> half-coloured (`transparent` text plus a gradient background); stopping updates alone leaves
> it **permanently half-coloured** and looking truncated. CSS therefore forces the fill colour
> and clip box back via `html.no-karaoke`.

### 6. Fixed a **false red** test

The "token works" assertion in `server-http.test.js` was `=== 200`, but `/ncm/status` **really
calls the NetEase upstream** — a night-time network blip returns 502, and a re-run goes green.
That kind of false red is the hardest to diagnose (it looks like you broke something; it is the
external network).

Now it asserts "**not 401/403/421** (auth did not block it) and only 200 or 502 may appear":
the test cares about the token, not about NetEase being reachable.

### 7. Fixed a **real** gap: nothing owned `tauri.conf.json`'s version

The new `scripts/check-manifest-consistency.js` (added in 1.3.2) reported this directly:

```
✗ desktop/src-tauri/tauri.conf.json version 1.3.2 ≠ version.json 1.3.3
```

Because that file was written by `desktop/build-frontend.sh`, which only runs **during a
desktop build**. Along the release path "edit version.json → run build-apk.sh → dispatch both
workflows" it stayed on the previous version until someone manually ran a desktop build.

The symptom is subtle: the local APK and the web version are right, only the desktop installer
shows a stale version — and the CI version assertion then goes red in the desktop workflow,
which looks like the workflow itself broke.

`android/sync-version.sh` now syncs it too, with a read-back assertion.

### 8. Six issues reported after real testing (fixed in the same version)

> This section records what came back after the first 1.3.3 APK test round.
> Every item was traced to a **root cause** before changing anything —
> no cosmetic "looks fixed now" patches.

**① Repeat-one restart left the coloured progress uncleared**

Root cause: `syncLyric()` only recomputed the colouring when "the line index
changed". On a repeat-one restart from 0:00 the first line is still the first
line → index unchanged → treated as "no line change" → update skipped, so the new
pass continued from wherever the previous one had filled.

Fix: remember the previous playback position (`lyricLastT`); a **backward jump of
more than 0.5 s** forces a recompute. The 0.5 s threshold separates a "real jump"
from "100 ms sampling jitter" — using "any backward movement" would clear the
colouring on every timeupdate and turn it into flicker. This also fixed
"colouring not reset after seeking" and "not reset after tapping a lyric line".

**② Only the current line should be coloured in the expanded view**

Now only the current row carries colouring, and the previous round's node is
explicitly cleared (`_lyricFocusNode`). Finished lines use the static `.done`
highlight and keep no gradient — out of dozens of rows only one is moving, so the
eye is drawn there naturally.

**③ No fill animation in the status-bar lyric**

Not "the code did not run": **existing users' settings still held the old default.**
`sbFill` defaulted to `false` through 1.3.2; changing the default to `true` in
1.3.3 only affects fresh installs — everyone upgrading still had `false` stored.

Fix: a `schema` version number plus a one-shot migration (v1 → v2 sets
`sbFill=true`). This is the most valuable insight of the round: **changing a
default does nothing for existing users**, so every default change needs a
migration.

> The migration itself was caught by my own test: `schema` lives at the top level
> of the saved blob, while `coerceSettings` receives `saved.settings`, so
> `saved.schema` always read undefined → the migration ran on every launch → a
> switch the user had turned off came back on after every restart and could never
> be turned off. Now the whole blob is passed explicitly, with 8 tests
> (`tests/store-migrate.test.js`).

**④ Colouring colour must be customisable; currently it is the default colour**

New setting `karaokeColor` (empty string = follow the theme) plus a colour-picker
entry. The default is deliberately empty rather than a hard-coded hex: with two
themes the same colour has very different readability on each (`#b3a2ff` measures
1.91:1 on the light background and must be darkened to `#5833ff` for 5.45:1) —
hard-coding necessarily makes one theme wrong.

**⑤ New playback settings must also appear in the in-player panel**

The "Playback settings" sheet (`renderOptSheet`) gained three rows: Karaoke
colouring, Mark finished lines, Colouring colour. They use the same `karaoke*`
keys as Settings → Lyrics, so changing either place syncs both.

**⑥ Lyric progress lags, and the gap grows over time**

The most substantive bug of the round; the root cause is **timeline conversion**:

An LRC timestamp is "when the **next** line starts singing", and between that and
"when **this** line finishes singing" there can be a long intro / interlude /
instrumental section. The old logic used "time until the next line" as this line's
singing duration, so a line that takes 3 s to sing was spread over 15 s — the
colour crawled at 1/5 speed. And since interludes get denser later in a song, the
error **grows as the song goes on**.

Fix: `estimateLineDur()` now **prefers a character-count estimate** (Chinese
articulation is steady at ~4.6 chars/s), falling back through "median of adjacent
gaps" and "total duration / 12", clamped to [1.0, 9] s; and the gap to the next
line is capped at 1.6× the estimate so a long interlude cannot stretch it.

Measured (4 lines, a 15 s interlude after the third):

| Time | Old colouring | New colouring | What you hear |
|---|---|---|---|
| 9 s | 20% | **100%** | third line already sung |
| 21 s | 0% (switched early) | 0% (correct switch) | fourth just started |
| 23 s | 13% | **100%** | fourth already sung |

Five targeted tests added, including "two lines with the same character count must
estimate the same duration" (the exact opposite of "grows over time") and a
regression case for "an interlude must not slow the colouring down".

### 9. Status-bar lyrics "only fill when the line changes": the full eleven-round record

> This gets its own section because it is the longest and most mis-diagnosed
> investigation in this project. Recording every hypothesis and how each was
> falsified is more useful to a future reader than just the conclusion.

**The user's description never changed**: "it only fills when the line changes" /
"the line snaps to full at the end of a line, then jumps to the next one".

#### Five hypotheses that were falsified (all real bugs, none the root cause)

| Round | Hypothesis | Verdict |
|---|---|---|
| 1 | Progress used whole-song position instead of per-line | Real bug, fixed, not this one |
| 2 | Old users still had `sbFill=false` stored | Real bug, fixed (v1→v2 migration), not this one |
| 3 | Web timers stall in the background | Real bug, fixed (baseline + extrapolation), not this one |
| 4 | `invalidate()` gets merged by WMS | **Wrong**. Added a 3-tier drawMode ladder, no effect |
| 5 | Colour duration disagreed with native extrapolation | Real bug, fixed (exported `lineSpan`), not this one |
| 6 | No vsync in the background stalls extrapolation | Real bug (Choreographer really does stop), not this one |
| 7 | The compositor never picks up the frame | **Wrong**. Added a `translationX(0.01px)` nudge, no effect |

#### The actual root causes (both required to reproduce)

**① The frame callback was bound to the JavaBridge thread**
(decisive evidence: `Ripple-crash-*-lyric-redraw.txt`)

```
CalledFromWrongThreadException: Expected: main  Calling: JavaBridge
    at LyricOverlay.forceRedraw(LyricOverlay.java:643)
    at LyricOverlay.pushFrame(LyricOverlay.java:616)
    at Choreographer$FrameDisplayEventReceiver.run(...)
```

`Choreographer.getInstance()` is **thread-bound**. `setTiming` is a
`@JavascriptInterface`, so it runs on WebView's JavaBridge thread, and the
callback was bound there too — `view.requestLayout()` threw every frame and
the exception was swallowed by `catch (Throwable)`. Worse, `dTicks++` sat
*before* `forceRedraw`, so the log showed "frames are running (ticks up) but
nothing is drawn (draws flat)" — an illusion that sent two whole rounds of
investigation toward "WMS merging / compositor", both dead ends.

**② This overlay ignores changes to *how* it is drawn; only *content* changes land**

The comparison that finally located it:

| Draw path | API used | Visible to the user |
|---|---|---|
| `p<=0` flat colour | `setTextColor` | Yes |
| `0<p<1` gradient | `getPaint().setShader` | **No** |
| `p>=1` flat colour | `setTextColor` | **Yes (snaps to full)** |
| `0<p<1` clip + double draw | `canvas.clipRect` (inside TextView) | **No** |

A `TYPE_APPLICATION_OVERLAY` + `FLAG_NOT_FOCUSABLE` window has its Canvas
output cached as a "static window" on vivo OriginOS; only **content / layout**
changes invalidate it.

#### The fix

`FillTextView` moved from `TextView` to a **self-drawing `View`**, taking all
three concerns out of the layout system:

| Need | Implementation | Triggers layout? |
|---|---|---|
| Colouring | `canvas.clipRect` + second `drawText` | No |
| Long-line scrolling | draw-origin offset `offX` | No |
| Progress update | change one `float` + `invalidate` | No |

All three are pure draw parameters — measure/layout never participates, so the
jitter is impossible by construction. The colour boundary also moved from
"character" (the smallest unit of `ForegroundColorSpan`) to **pixel**,
advancing continuously every frame.

The two-round mis-diagnosis patch tower was removed with it: the `drawMode`
ladder, the `translationX` nudge, `probeDrawRate` and the `Choreographer`
branch are all gone. `forceRedraw()` went from thirty-odd lines to one `invalidate()`.

#### One lesson for whoever comes next

**Read the crash log before you read the counters.** The `draws` counter —
which *looked* informative — misled two rounds straight: it counts "how many
times the code ran", not "how many times the picture changed". The real
evidence was sitting in `/sdcard/Download/Ripple-crash-*-lyric-redraw.txt`
the whole time.

### 10. Release notes support expand / collapse

Once the notes get long (1.3.x has ~9 subsections per release, and the bilingual
body runs 400+ lines), the GitHub Release page means scrolling forever — and
scrolling back to find something again is easy to overshoot.

Now a three-layer structure built on GitHub's native `<details>` support:

1. **A permanent "What's in this release" block at the top** — every `###`
   subheading is extracted automatically and listed, never collapsed. Users see
   what the release covers without expanding anything;
2. **Chinese body** in `<details open>` (expanded by default — Chinese is the
   primary audience);
3. **English body** in `<details>` (collapsed by default — non-Chinese readers
   open it themselves).

Default page height drops from 400+ lines to a few dozen, putting
"Artifacts / SHA-256" within a screen or two. Nothing is deleted — expand to
review any detail.

### 11. What this version did not do

- **Desktop window behaviour is only code-level verified**, never run on a real desktop
  environment (this machine is aarch64 proot with no usable display server or compositor;
  `cargo check` / `cargo fmt` pass, but whether the window really goes transparent and
  always-on-top needs the user to test it)
- **No word-level karaoke** (that needs a format beyond `.lrc`, such as a per-word KRC
  timeline); this version is **per line**, linearly interpolated within the line
- **No horizontal auto-scroll to the current word**. Long lines in portrait fall back to
  ellipsis / marquee

---

## 1.3.2 — Ninth Version

> **Basis**: the "what this version did not do" list from 1.3.1 — that is, batch 3
> (next minor version) and batch 4 (tech debt) from the 1.3.0 review report. All done.
> **Review and remediation by**: Deepseek V4.1 Flash 1017.
>
> No new features; this version clears the debt the previous one honestly left behind.

### 1. Batch 3: interaction and accessibility

- **E-05 [medium] Dragging a slider in the playback-settings panel shows no value bubble**
  Open-then-close within one event: the `input` handler first calls
  `paintSlider(el, true)` to light up the bubble, then unconditionally calls
  `syncOptSheet()` which turns it off again — so the "bare number 0.85 / 1.05" fix that
  1.2.2 specifically made was **never once visible**. Fix: `syncOptSheet({ keepTip: true })`
  plus `paintSlider` accepting `null` (update fill/text only, leave bubble visibility
  alone); `change` (real release) and first render still hide the bubble by default.
- **E-06 [medium] "Shuffle one" picks the same track from the second click on**
  The old code was `use[(dayKey + (force ? 1 : 0)) % use.length]` — `dayKey` and
  `use.length` are both constant within a day, so **every** forced call computed the
  same index (two clicks in a row gave the same song, while the comment claimed it
  fixed exactly that). Replaced with a monotonic cursor, reset when the seed changes.
- **E-08 / E-09 [medium] Queue rows and settings rows were not keyboard accessible**
  1.2.3's accessibility pass gave list rows proper semantics, but the **queue template
  was not updated** and **all 37 `.set-row` settings rows were bare `div`s** — the net
  effect was "everything you can Tab to is a control, everything you can't is a row",
  excluding half the entry points from the accessibility tree.
  Fix: `.qitem` now has `role`/`tabindex`/`aria-label` (including "now playing" and the
  track number); each `.set-row` was individually classified and **17** got semantics
  (the other 2 contain a `<button role=switch>` and are **deliberately** left alone —
  adding a role would create "button wrapping a switch", read twice by screen readers
  and ambiguous for Enter); the keyboard delegation whitelist gained
  `.qitem[tabindex]` / `.set-row[tabindex]`.
  Measured: 37 rows → 17 tabbable, all 17 with aria-label.
- **E-16 [medium] When `localStorage` is full, settings silently never persist**
  Two empty `catch` blocks swallowed `QuotaExceededError`: "changed in memory, not on
  disk" could persist for the whole session, and the user only sees "I set it and it
  reverted", with nothing in the logs.
  Fix: on first failure, **slim the payload and retry once** (history 200→100,
  onlineCache 60→30, which usually recovers); if it still fails, log plus one toast
  (`_saveFailed` prevents spam). Progress-write failures only log, no toast.

### 2. Batch 3: layout details

- **U-14 [low] Tablet / punch-hole playback-page top and bottom pill positioning**
  - CSS-06: the wide tier's `.np-inner` top padding was hard-coded to `8px`, but that
    tier **also covers Android tablets / foldables** (edge-to-edge, `--safe-t` is
    24–32px) → the "collapse" button and title sat under the status bar.
    Changed to `calc(var(--safe-t) + 8px)`.
  - CSS-10: on phone-landscape punch-hole devices `.tabbar` used hard-coded
    `left/right:12px` while `.dock` respected the safe area → a **44px** gap measured
    (tabbar left=12 vs dock left=56). Both now use `calc(var(--safe-l/r) + 12px)`;
    measured 12 and 12 after the fix.
- **U-17 [low] Other layout details**
  - CSS-09: expanding lyrics transitioned `grid-template-rows` but columns changed
    instantly → measured at 1280×800, meta's `left` jumped from 680 to 44. Now both
    axes transition.
  - CSS-13: the three rail blocks' icons were not left-aligned (measured 8 / 16 / 17).
    Each of the three formulas was rewritten to the same "container padding + block
    offset + own padding" base and **measured to 16 / 16 / 16**. (Deliberately no shared
    variable: the three formulas differ, sharing would misalign them.)
  - CSS-15: two comments contradicted the code — `--rail-w` said "use 112" while it is
    138; the toast `bottom` was derived as 146 assuming dock at `+78`, but the wide tier
    had moved dock to `safe-b + 13` → measured toast bottom 146 vs dock top 73, a 73px
    gap. Introduced `--toast-dock-clear`, overridden to 81 in the wide tier.
- **U-13 [low] Dead CSS / dead config**
  - The whole `.login-opt` block (12 rules; login moved to a QR dialog, zero HTML/JS hits) → deleted
  - Dead `.row .r-al` rule → deleted
  - `--dock-bg`'s two values **never took effect** (fully overridden by the
    `background` shorthand in `html:not(.perf-low) .dock-inner`) → wired into the
    bottom of the background stack so the dark/light base colors finally apply
  - `--h`: JS called `setProperty('--h', …)` with a comment promising "bar heights
    follow", but `var(--h)` has **zero consumers** repo-wide (the EQ bars are actually
    drawn by a rotated native range input) → removed the unfulfilled promise and
    documented how the bars really work.

### 3. Batch 3: server

- **S-06 [medium] IPv6 Host validation contradicted its own message**
  The whitelist stored **bare** IPv6 while browsers always send bracketed Host →
  `hostKey` keeps the brackets, never equal to the bare entry → IPv6 access always 421
  in dual-stack, and the substitute addresses printed in the 421 body **also 421**,
  leaving the user unable to self-rescue.
  Fix: whitelist now holds both bare and `[addr]` forms; the 421 body deduplicates.
- **S-12 [low] Paths containing NUL returned 500**
  `decodeURIComponent('/a%00.js')` does not throw (`%00` is a legal escape), the string
  with `\0` reached `fs.statSync`, which throws TypeError → wrapped into 500. Semantically
  this is malformed client input (400), and a token-less GET could spam logs forever.
  Fix: reject null bytes immediately after decoding.
- **S-13 [medium] Zero tests for `server.js`'s HTTP behaviour**
  Root cause: `require('./server.js')` listened immediately, so a test grabbed the port
  on load. Fix: export `{ server, PORT, allowedHosts, tokenStats }` and **only listen when
  run directly** (`require.main === module`), behaviour unchanged for CLI use.
  Added `tests/server-http.test.js`, hitting a real instance with real HTTP requests
  (temporary port + isolated data-dir) across the six blind spots the review named:
  Host allow/421, token issuance and 401, `/ncm` POST-only, traversal + `%00` + malformed
  escapes, 300KB body → 413, cookie file empty after logout; plus invalid startup args.

### 4. Batch 3/4: Android native

- **AND-02 [high] Removed the completely dead WebView login chain (350 lines)**
  Since 1.3.0 all three platforms use QR login, and the embedded-login chain had **zero
  callers**: the frontend `Netease.login()` grep only hits its own definition; 10 methods
  (`openLogin` etc.), 9 `login*` fields and 3 `@JavascriptInterface` bridge methods were
  all unused. The cost was not merely dead lines: it layered a second WebView loading
  `music.163.com` onto the main Activity and exposed a JS interface (extra attack
  surface), and two comments contradicted each other (HttpBridge said it was in use,
  NeteaseClient said it was not), leaving no way to tell which was true.
  Fix: 350 lines of Java + frontend `login()`/`loginCancel()` + the three bridge methods
  removed together, with a note in place explaining why and that restoring it must bring
  the UI back too.
- **AND-03 [high] Registered `__rippleMediaUnavailable` on the frontend**
  When both `startForegroundService` and `startService` fail, Java calls this callback,
  yet `app/` had **zero hits** repo-wide — the call site is `&&`-guarded so nothing
  errored, meaning the entire "why can't I control playback from the notification"
  channel was dead. And this is **not** a corner case: the branch only runs when "the
  service is gone but the page is still playing", which almost always means the app is
  backgrounded, where targetSdk 34 makes background `startForegroundService` throw on
  Android 12+ — "both fail" is the main path.
  Fix: registered, showing at most one toast per 5 minutes (the contract explicitly says
  "may be called every second, the frontend must dedupe"), with a counted log entry.
- **AND-04 [medium] Error logs shared a quota with real crash reports**
  `recordAsync` has 35 call sites, all writing `crash-*.txt` and competing for the same
  10-file quota — during a fault storm dozens per second would fill it in seconds,
  **deleting the earliest genuine crash report**.
  Fix: error logs use an `err-` prefix with an independent quota of 20; the two quotas
  no longer interfere.
- **AND-05 [medium] Cold start read up to 5 process traces on the main thread**
  `getTraceInputStream()` read to EOF with **no length cap**, up to megabytes per trace,
  all in `Application.onCreate`. J-01/J-05 had only moved **writing** off the main
  thread — reading stayed and was heavier.
  Fix: moved to a background thread, capped at 256KB per trace (truncated with a note).

### 5. Batch 4: build and repository hygiene

- **"Manifest consistency" CI check (the highest-ROI item the report named)**
  Added `scripts/check-manifest-consistency.js` plus 5 regression tests, checking:
  A. the three platforms' command-name sets are equal (frontend → server.js → Java → Rust)
  B. the same command maps to the same upstream path on all three
  C. QR state codes have a single source (803 must be whitelisted, whitelist must be
     constant-driven)
  D. version numbers agree in four places (version.json / tauri.conf.json / Cargo.toml /
     Cargo.lock)
  E. home-cache invalidation has exactly one entry point
  Wired into CI (`build.yml`'s check job).
  **Verified it actually catches things**: injecting each of 1.3.0's four historical
  defects into a temp copy turned the checker red every time — a checker that cannot
  catch problems is worse than none, so that is covered by tests too.
- **U-05 [medium] CI version validation did not cover desktop**
  `build.yml`'s version check only covered the 5 Android-side spots; the three desktop
  copies are now checked too, giving cross-validation between the two workflows. Also
  added `version.json` to `desktop-build.yml`'s `pull_request.paths`.
- **D-07 [medium] Desktop exit did not guarantee cookie persistence / no single instance**
  - `RunEvent::Exit` previously had **only a comment and no code** (the comment said
    "just a backstop"). Now it actually takes the shared Client and writes to disk.
  - Single instance: this machine's cargo cache has no `tauri-plugin-single-instance`
    (builds run `--offline`), so a minimal implementation is used: hold a lock file in
    the config dir and check whether the recorded pid is alive. On Windows it is
    explicitly **not** done (without windows-sys a semantically correct version is not
    feasible — better to do it for real than to fake it).
- **U-11 [medium] Decision on eslint / prettier**
  Neither config was ever executed by CI or any script (the project deliberately has
  zero dependencies and no frontend build chain). Decision: **delete both** — keeping
  them only makes contributors believe a lint gate exists. This also removes the invalid
  `insertFinalNewline` key in `.prettierrc`.
- **U-19 remaining build hygiene**
  - Gradle wrapper: the repo genuinely has **no** `gradlew`, yet the docs told
    contributors to run `./gradlew assembleDebug` (reported as far back as the 1.1.0
    review). Decision: **do not add a wrapper** (consistent with the zero-build-chain
    stance); instead CONTRIBUTING now states plainly that there is no wrapper and that
    command will not work.
  - `ISSUE_TEMPLATE/config.yml`: `OWNER/REPO` placeholders → real repo; `master` → `main`
    (the security-advisory entry point was broken, which is especially bad).
  - `pull_request_template.md` told contributors to hand-edit `app/sw.js`'s `CACHE`,
    directly contradicting CONTRIBUTING's "do not hand-edit, it is script-synced" →
    now "ran `sync-version.sh`".
  - `.editorconfig` had an inline comment polluting the value
    (`trim_trailing_whitespace` literally became
    `"false   # 行尾两个空格是硬换行"`, so Markdown trailing double spaces were still
    trimmed) → the comment now sits on its own line.
  - `desktop-build.yml` relied on a preinstalled `7z` with no check → added
    `command -v` and a readable error.

### 6. Regression tests: 93 → 105 (12 new)

- `tests/server-http.test.js` (7): server HTTP e2e covering the six blind spots S-13 named.
- `tests/manifest-consistency.test.js` (5): regression for the checker itself — one
  asserts "the current repo passes", four inject historical defects (D-09 path drift /
  G-01 missing state code / G-01 whitelist bypass / D-02 version drift) and assert
  **each is caught**.

### 7. What this version did not do (said honestly)

- **Desktop tray / SMTC / MPRIS media control**: genuinely absent, still needs
  system-level integration.
- **Always-on-top lyric mini window**: genuinely absent.
- **Real single-instance on Windows**: as above, infeasible without the dependency, so
  it is left undone rather than faked.
- **Gradle wrapper**: deliberately not added (see above).
- **Splitting `server.js` into an injectable `createServer({dataDir, upstream})` factory**:
  this version made it **testable** (require no longer grabs the port, plus 12 e2e cases)
  but did **not** produce a full factory — global state (cookie jar / token table / data
  dir) is still module-scoped, so only one instance can exist per process. A full
  factory touches 1300 lines; the risk outweighs the benefit until same-process multiple
  instances are actually needed.

---

## 1.3.1 — Eighth Version

> **Basis for this round**: `docs/code_review_record/代码审查_1.3.0.md` (a full review of 1.3.0,
> 66 independent issues: 1 blocker / 18 high / 35 medium / 12 low).
> **Review and remediation by**: Deepseek V4.1 Flash 1017.
>
> This version adds no features — it only does what the review said must be fixed before shipping.

### 1. Rectification According to the Code Review Report from Deepseek V4.1 Flash 1017 (blocker + all high)

The report's fix roadmap had four batches. **Batch 1 (must-fix before release) and batch 2 (to ship in the same version) are both fully done**, plus a few very cheap batch-3 items.

#### 1.1 QR login finally works (G-01 blocker + G-02 high)

These two stack up to make 1.3.0's core new feature — unified QR login across all three platforms — 100% unusable.

- **G-01 [blocker] Success code `803` missing from the whitelist**: `netease.js`'s `codeOk` only allowed `200/800/801/802`, while `app.js`'s QR state machine waits for `code === 803`. That success branch was therefore **unreachable**, and control fell straight into `catch` where it was treated as network flakiness and kept polling — the user sees "confirmed on phone → spinner forever → QR expired", **but the account actually logged in** (cookies were already absorbed by the native layer). Restarting the app shows logged-in. Fix: promote the four state codes into a single `QR_STATES` constant exported from `netease.js`, shared by both the state machine and the `codeOk` whitelist — a root fix for this repo's number-one defect pattern, "the same list copied several times, then each copy drifts". The polling `catch` now distinguishes network failures from semantic ones: only network errors retry, semantic errors surface a diagnosable message immediately.
- **G-02 [high] QR versions 7–10 are unscannable**: the version-info block in `qrcode.js` wrote only the 12 bare version-number modules, while the spec (ISO/IEC 18004 §7.10) requires 18 bits = 6 version bits + 12 BCH(18,6) check bits. Worse, `set()` marks written positions as function patterns, so **the 12 unwritten positions got filled with data**. Real decoding with `zbarimg`: versions 1–6 fine, versions 7–10 **16/16 undecodable**. Fix: added BCH(18,6) (generator polynomial `0x1F25`) and write all 18 bits. After the fix: **723/723 combinations decode correctly, versions 1–10, all ECLs**.

#### 2. Playback chain

- **P-02 [high] Switching away and back to the same song resumes from where it left off**: `load()` only reset `src`, not `currentTime`. Since `_pickEl()` routes by source type (all online songs share one `<audio>`), "switch to a local song then tap back to that online song" lands on the same element and the browser keeps the position. Fix: reset `currentTime` explicitly in `load()`.
- **P-01 [high] "Gapless" only works when alternating online/local**: consecutive same-type tracks resolve to the same element which is currently playing, so it can't be touched — meaning in the **most common real shape** (a playlist of all-online songs) the switch never prefetches. Applied the report's recommended **honest downgrade**: the setting text now reads "preload the next track (effective when alternating online/local)" and the skip branch logs why. A switch that can be flipped but does almost nothing is worse than a documented limitation.

#### 3. Four "clicked and nothing happened" first-screen issues

- **E-01 [high] Recommended playlists / toplist give up permanently after one failure**: on failure the cache was set to `[]`, and an empty array is truthy, so `if (!App._recPlCache)` short-circuited forever — one offline launch and that section never hits the API again this session. Worse, the failure card said "pull down to retry", but **there is no pull-to-refresh anywhere in the repo** (`base.css` even sets `overscroll-behavior:none`), and logged-out users had zero recovery path. Fix: use `=== null` to mean "never succeeded"; keep `null` on failure so the next mount retries; the failure card is now a real clickable "tap to retry".
- **E-02 [high] Skeleton sticks forever when daily recommendations come back empty**: the success branch was entirely wrapped in `if (songs.length)`, so with an empty array the only call that clears the skeleton (`renderCarousel`) never ran — three grey skeleton cards stayed forever with the shimmer running, looking frozen. Fix: store the empty array too (it means "asked, nothing there") and clear the skeleton.
- **E-03 [high] Search page hot words did nothing at all**: hot words render into `#hotWords`, which is inside `#searchIntro`, while `#searchIntro` and `#searchBody` are **siblings**; the `[data-hot]` delegation was attached to `#searchBody`, which the bubble path never reaches. All six most prominent first-screen entries were dead. Fix: delegate on their common ancestor `.page[data-page="search"]`.
- **E-04 [high] Modals with an input field can't be closed with Esc**: the input short-circuit sat before the Escape check, and `modal()` auto-focuses the input — so "add from link", API address, the comment box and every settings slider swallowed Esc. Fix: move Escape ahead of the input short-circuit (Esc isn't text input; inside an input its only sensible meaning is "close this layer").

#### 4. Server-side

- **S-01 [high] One device can evict every other device's tokens without any token at all**: the token table was a **single global list** while issuance was rate-limited per IP, so any source could fill the whole table with 6 requests inside its own quota; the issuance endpoint requires no token (the only gate, `Sec-Fetch-*`, is free to forge). Measured: legitimate device gets a token → another source fires 6 requests → the legitimate device turns 401, and the frontend only fetches a token once at page load and never auto-renews, so an attacker can keep hammering. Fix: token table is now `Map<source IP, that source's token bucket>`, so A hammering only affects A; plus a per-IP cap. On-disk format stays "flat array with ip per entry" for backward compatibility.
- **S-02 [high] Requests never settle when upstream aborts mid-response**: `req.setTimeout` is a socket-idle timer, while "upstream half-closes after headers" only fires `aborted`/`error` on `res` — yet only `data`/`end` were wired, so the Promise neither resolved nor rejected. Measured: after 45s the client times out on its own, the server logs not a single line, and each hung request keeps its closure, accumulated string and socket in memory with no reclamation. Fix: handle `aborted`/`error`/`close` (using `res.complete` to detect early close) plus a 25s hard cap as backstop.
- **S-03 [high] In-flight requests resurrect the session after "log out"**: `closed` was only checked in the "write response" branch, while cookie merging/persistence happens inside the `ncmPost` closure, which cannot see it. The sequence: slow request in flight → user logs out and clears the jar → the slow request's Set-Cookie arrives → login state written back to disk. Measured: `MUSIC_U` reappears in `.ripple-cookie` 2.6 seconds later — directly contradicting the code comment that says it won't. Fix: a cookie generation counter, incremented on logout and compared before merging; anything from before the logout is dropped.

#### 5. Layout and contrast (the desktop layout 1.3.0 pushed)

- **U-01 [high] Breakpoint gap `ar ∈ [1.84, 1.85)`**: the wide tier used "≤1.84" and the phone-landscape tier "≥1.85", leaving 0.01 where **neither matched** and the page fell back to base styles (phone single column + bottom pill). This is **not a theoretical corner**: a decoration-less Tauri window maximized on 1080p gets a work area of exactly 1920×1040 (screen height minus taskbar), `ar = 1.8462`, **right in the gap** — the whole "collapsible left rail" layout fails. Fix: not just changing 184 to 185 (that makes both tiers match at the same point and lets source order decide, which is fragile), but **adding width as the primary discriminator**: `(min-width:700px) and (max-aspect-ratio:185/100), (min-width:1180px)` — anything ≥1180 wide is desktop regardless of aspect ratio. This also fixes "wide but short" desktop windows like 1366×728.
- **U-03 [medium] Squash a desktop window slightly and it turns into phone layout**: both "phone landscape" criteria looked only at aspect ratio / absolute height with no "is this a phone" constraint. At 1280×560 the rail disappeared, the bottom pill came back and `--pad-x` dropped from 34 to 14. Fix: add `max-width:1179px` to both, meeting the desktop tier with no gap.
- **U-02 [high] Accent ink picked by lightness threshold only; light theme defaults to 2.20:1**: `--accent-ink` was chosen with `l > 62`, but lightness is not a sufficient condition for contrast — at the same `l=62`, purple is 8.7:1 while yellow is only 1.24:1. The light theme was worse: `#fff` on `--accent:#b3a2ff` measures **2.20:1** (WCAG wants 4.5 for small text), while `:root`'s `#17102b` already gave **8.32:1** and the light block broke it. Fix: delete that light-block override; pick ink by **actual WCAG contrast** in JS (relative luminance + contrast ratio). Exhaustive h×s×l sweep: failure rate **40.5% → 1.5%** (dark) and **48.8% → 3.0%** (light).
- **U-04 [medium] Library group tabs never had any styling**: `.segline`'s four `<b>` elements have been 16px bold run-together text with identical selected/unselected colors since 1.0.0 (verified per-version with `git show` — all zero hits, so not a regression). Ironically 1.2.3's accessibility work already gave it `role`/`aria-selected`/roving tabindex — screen-reader users can perceive selection, sighted users cannot. Fix: added styling in `.segmini`'s visual language.

#### 6. Desktop

- **D-01 [high] `bridge.js`'s pending map never deletes on success**: frontend `cbId` increments monotonically, so every successful call left a permanent entry, and the map has no consumers at all. Measured: 100000 entries after 100k successful calls. The typical desktop usage is leaving it playing all day, so this is unbounded growth. Fix: delete on success too.
- **D-02 [high] Desktop version numbers live entirely outside the "single source" chain**: `Cargo.toml` was stuck at 1.2.3 (`tauri.conf.json` is synced by `build-frontend.sh` and does keep up, but nothing wrote `Cargo.toml`). Fix: `sync-version.sh` now also handles the two desktop files (`Cargo.toml`'s `[package] version` via `0,/re/s//x/` scoped to the first match so `[dependencies]` isn't touched; `Cargo.lock` via python matching the `[[package]]` block precisely), with post-replacement assertions.
- **D-03 [high] CI's "versions match" assertion was a tautology**: the frontend job ran the assembly script first and validated afterwards, but assembly's fourth stage **is** rewriting `tauri.conf.json`'s version — the checker first writes the file to the expected value, making the assertion impossible to fail regardless of input. Fix: move validation **before** assembly, add `Cargo.toml` / `Cargo.lock` to the chain, plus a backstop asserting assembly produces no diff in tracked files.
- **D-04 [high] Release job missing `mkdir -p release`**: the APK step writes into `release/`, but the directory was only created later in the "collect installers" step — `curl -o` doesn't create parents, so it returned rc=23, swallowed by the `else` branch into a misleading "no Android APK found" (the real cause was a missing directory, sending troubleshooting the wrong way entirely). Fix: `mkdir -p` up front and differentiate curl exit codes 22/23/6 with distinct messages.
- **D-09 [high] `personal_fm` upstream path wrong**: Rust used `personal/fm` while Java and `server.js` both use `v1/radio/get` → the desktop roam fallback chain was guaranteed 404. Control group: of 22 upstream endpoints only 3 returned 404; this was the only real error in the full three-way path set difference. Fix: `v1/radio/get`.
- **D-06 [medium] Desktop missed hiding the two "status bar lyrics" rows**: flipping the switch popped "overlay permission required", which Windows/Linux simply cannot grant. Fix: declarative `data-desktop-hide` markers read from the DOM, so adding such rows later only needs a marker.

#### 7. Documentation and test truthfulness (fake-fix audit)

- **D-11 [medium] The "9 fixed-vector tests" don't exist, and none is a real known-answer test**: actually 8, and all self-referential — `aes_is_deterministic` only asserts `f(x)==f(x)`, `rsa_output_is_fixed_length` only checks length, `constants_match_other_implementations` compares a constant against a literal declared once in the same file. Measured: change `PRESET_KEY` to any 16 bytes and change the literal in the test to match, and all 8 tests **still pass** while the real API only returns `{"code":400}`. These tests cannot catch the very class of error they claim to guard against. Fix: compute three known-answer vectors **independently** with `openssl` and Python's `pow()` (full weapi chain / song_url shape / complete form body) and add them as real KATs. Effectiveness check: tampering one character of `PRESET_KEY` makes 4 KATs fail immediately while the old self-referential tests all still pass.
- **U-06 [medium] Two `sed` calls in `sync-version.sh` had no anchor assertion**: `build.gradle` and `sw.js` only checked "did content change", but when `sed` doesn't match at all old and new are equal too → reported "already up to date, unchanged" and exited 0, silently producing a wrong-version build. Reproduced: change `versionCode 130` to AGP's recommended `versionCode = 130` form → old script said "already up to date" with exit code 0. Fix: post-replacement assertions that fail loudly. Verified the new assertions catch this exact format drift.
- **U-07 / U-08 / U-09 documentation drift**: README's "desktop not in public Release" (contradicting the shipped fact), CHANGELOG's "test cases 60 → 79" (actually 63; now **89**), and stale line counts / CI status in `desktop/README` — all corrected against measured values.
- **U-10 dead links in `docs/en/`**: fixed 5 links pointing at non-existent files.

#### 8. Two user-reported bugs (Android background playback)

Neither came from the review report — both were found by actually using the app, and both
share the same timing defect.

- **[Reported] After switching to the background, a track that finishes won't start the next one**
  Root cause: when a track ends naturally the browser sequence is "`ended` → `paused` becomes
  true (some kernels also fire `pause`) → we immediately `next(true)` to play the next track".
  That intermediate `pause` flips state to "paused" and reports it to the native side, where it
  triggers `WebView.pauseTimers()` in the background — **freezing the very timers** that drive
  progress, notification refresh and auto-advance. The next track still has to be resolved
  through the async native channel and bridge, so it simply never starts.
  Fix, two layers: (1) a JS-side "transition window" (`_advancing`) suppresses the temporary
  pause report during auto-advance (the audio was never paused by the user); (2) the native
  side now **delays the background freeze by 1500ms** and re-checks a token, so when state
  flips back to playing mid-track-change the freeze is automatically cancelled.
- **[Reported] Repeat-one: after a track ends the notification shows paused while audio keeps playing**
  Root cause: the `repeat === 'one'` branch only did `seek(0) + play()` and returned, but the
  "ended" already flipped the notification to paused; the `state true` right after restart then
  raced the native `pauseTimers` and the push was lost entirely → state never came back.
  Fix: after restart, **explicitly push the state again** (waiting for `play()` to actually
  resolve instead of betting on browser event ordering) and clear the transition window; also
  made the resume `pushMediaState` a forced push to bypass value-level idempotence — in the
  background it is the only signal that wakes the native side back up.

### 2. Docs: bilingual separation, fully fixed

- **Cross-language links no longer leak**: English docs used to cross-reference
  `SECURITY.md`, `CONTRIBUTING.md` and `desktop/README.md` — all of which are the
  **Chinese** versions, so English readers landed on Chinese pages. English docs now
  point at their own `_en.md` counterparts, with only the language-switch line at the
  top pointing at Chinese (and vice versa). Verified by a two-way static check:
  **zero cross-language references in either direction**.
- **`desktop/README` now has an English version**: added `desktop/README_en.md` (386 lines then, 415 since 1.3.3)
  matching the Chinese one section by section — architecture, bridge method mapping,
  feature comparison, three pitfalls, five CI pitfalls, artifact formats, and the
  ARM64 verification log.
- **Fixed stale claims in `desktop/README`**:
  - The header still said "validation phase / only on the feat branch / will decide about
    merging into main after testing", contradicting reality (shipped with 1.3.0, merged
    into `main`).
  - The entire **QR login** item under "Not implemented" was stale — since 1.3.0
    `chooseLoginMode` goes through the QR flow on all three platforms, and
    `login_qr_key` / `login_qr_check` are implemented on the Rust side, so clicking
    "Log in with NetEase" just works with zero UI changes. Replaced with "nothing is
    currently unimplemented" and demoted the manual `MUSIC_U` cookie to a fallback.
  - The `RippleNative.login` row in the bridge table went from "not yet" to
    "not needed (login uses QR)".
  - The "UI left for the next round" comment in `desktop/bridge.js` was equally stale and
    is fixed too — it now says plainly that not providing `login` is deliberate, not missing.
  - Kept as-is after verification: media control (tray / SMTC / MPRIS) and the
    always-on-top lyric window genuinely are not implemented, so those two "pending"
    notes are accurate and unchanged.

### 3. Release notes are now bilingual

At publish time the workflow extracts the same version's section from `CHANGELOG.md`
and `docs/en/CHANGELOG_en.md` **separately**, puts Chinese first and English after,
separated by a horizontal rule (Markdown `---`, rendered as a real `<hr>` by GitHub),
with a bilingual marker line at the top. The artifact table and signing notes go at the
end with one sentence in each language.

Two extraction bugs fixed along the way: (1) the `awk` used `next` to skip the heading
line, leaving the body without a title; (2) the trailing `---` and blank lines were
carried over, stacking up to three separators with the new one.

### 4. Regression tests: 63 → 93 (30 new, each mapping to an ID)

Added `tests/review-1.3.1.test.js` where each case is named after its review ID (`G-01` / `S-01` / `U-01`…) so the next review round can directly check "was this actually fixed". Their defining property: **they all fail before the fix**.

The `G-02` case is a **real decoding** test (feeding the generated bitmap to `zbarimg`), not a structural assertion — the CHANGELOG itself records the lesson "all structural tests pass but it still won't scan", which is exactly how this module slipped through. The `U-01` case recomputes six key viewports from the same criteria as the CSS, including the real 1920×1040 gap.

### 3. What this version did not do (said honestly)

- **Batch 3 and 4** (tech debt) are untouched: removing dead code, splitting `server.js` into a factory, the `localStorage`-full fallback, single-instance/tray, and accessibility leftovers beyond `.segline`, etc.
- The report's proposed "list consistency CI check" is a **structural safeguard** with the highest payoff, but needs separate design — deferred to the next version.
- The report's D-05 (the `v1.3.0` source tag pointing at a 1.2.3 commit) is fixed in this version (`git tag -f` re-point plus a CI precondition), but it's a repository-state repair rather than a code change, recorded here for reference.

---

## 1.3.0 — Seventh Version

The theme of this version is **"taking the desktop build from *runs* to *usable*"**, plus a batch of layout and capability defects that are **only visible once it actually runs on a real device**. In one sentence: the previous version proved that "the same frontend can be moved to the desktop"; this version is about whether every detail is actually *right* after the move.

### 1. New Desktop Build (Windows / Linux, Tauri 2)

The frontend in `app/` (over 7000 lines) is moved to the desktop as-is, with **not a single line of frontend logic changed**.

The approach is to reproduce Android's `@JavascriptInterface` bridge verbatim inside the page: the desktop `bridge.js` provides `window.RippleNative`, forwarding internally to Tauri's Rust commands. The frontend cannot tell the difference — it believes it is talking to Java.

- **weapi encryption on the Rust side**: double AES-128-CBC + textbook RSA, with constants character-for-character identical to the Java / Node sides, covered by 9 fixed-vector tests. Get one byte wrong here and NetEase just returns `{"code":400}`; on screen you cannot tell whether the padding was wrong or the base64 line wrapping differed
- **20 commands**, aligned one by one with Java / server.js (the frontend calls 20, and not one is missing)
- **Pure bash frontend assembly**: `build-frontend.sh` copies `app/` and injects the bridge layer; no npm / frontend build chain required
- **Artifact formats**: Linux produces `.deb` / `.AppImage` / `.tar.gz`; Windows produces an NSIS installer / `.zip` portable build. All three platforms ship in the same Release alongside the APK
- **macOS dropped**: this machine (aarch64 Ubuntu proot) absolutely cannot produce macOS artifacts, which need the Apple SDK and signing certificates. Rather than ship an untested package, it is explicitly not done

### 2. Three Defects That "Look Right but Do Not Work"

What these have in common: **the code reads fine; only running it and actually clicking exposes the problem**.

1. **Window buttons render, but clicking does nothing**
   In Tauri 2's permission system `core:default` grants only the **query-type** window permissions and does not include `allow-minimize` / `allow-close` / `allow-maximize` / `allow-toggle-maximize`. So the three buttons render fine and the handlers are bound, but the IPC is rejected by the permission layer — and it **fails silently**, with nothing in the console. Fixed in `capabilities/default.json`.

2. **Window dragging broken**
   Tauri's **bare** `data-tauri-drag-region` attribute only fires when the click lands **directly on that element** (see `isDragRegion` in `tauri/src/window/scripts/drag.js`: it requires `el === composedPath[0]`). A drag region inevitably contains child elements (text nodes), and clicking the text makes `target` that child, so the bare attribute is dead. It has to be `"deep"` for the whole subtree to drag.

3. **Comments reported "illegal upstream path"**
   The Rust-side path whitelist allowed only lowercase `a-z`, while the comments endpoint path is `v1/resource/comments/R_SO_4_<id>` — **the uppercase letters are part of the interface name**. After checking every backend: Java allows uppercase and Node's regex has `/i`, so **only the Rust side had this defect**. The whitelist was relaxed to `is_ascii_alphanumeric()` (still rejecting `..`).

### 3. Desktop QR Login (Unified Across All Three Platforms)

A new **zero-dependency QR encoder** `app/js/qrcode.js` (about 400 lines): ISO/IEC 18004 byte mode, versions 1–10, ECL L/M/Q/H, 8 masks selected by penalty score, GF(256) Reed-Solomon, BCH format information.

The login flow is now QR scanning on all three platforms: Android / desktop / browser all scan with the NetEase Cloud Music app on a phone. The state machine covers 801 (awaiting scan) / 802 (scanned, awaiting confirmation) / 803 (success) / 800 (expired).

**How this code was verified deserves its own note**: structural tests, BCH validation and module-count checks all passed, yet the QR code **would not scan**. It took a real `zbarimg` decode to find three bugs:

- The serpentine direction of the data fill was derived from the column number instead of the **column-pair index** — both odd and even columns were wrong half the time
- The bit order of the two format-information copies was reversed: the first copy bit14→bit0, the second should be bit0→bit14
- The dark module was written at `(size-8, size-8)`; the correct position is `(size-8, 8)`

The third one makes the point: **one pixel wrong and the entire code becomes unscannable**. No amount of "looks correct" self-checking gets past that; it has to be actually decoded.

### 4. Four Layout Problems on the Player Page

- **Lyrics overlapped the progress bar**: a grid item's `min-height` defaults to `auto`, so it is as tall as its content and **overflows** its track onto the progress bar below. Fixed with `min-height:0` + `align-self:stretch`
- **Controls not centred when lyrics expand**: `.np-ctl` was missing `margin:8px auto 0`, so the box was capped at 460 wide but still left-aligned, leaving "previous / play / next" stuck to the left
- **No transition when expanding / collapsing**: `grid-template-areas` itself cannot interpolate, but `grid-template-rows` tracks of numeric values can — used for a smooth 0.3s transition
- **Too empty when collapsed**: lyrics are now vertically centred, and the wide-screen line count went from 3 to 5

### 5. Window Titlebar No Longer Covers the Top of the Page

The previous version used "a 34px dark bar + `html{padding-top:34px}`". That padding pushes the entire page down 34px, so **whatever sits at the top of any page is permanently covered**, and a solid dark bar over a light page looks like a strip of tape — the opposite of "immersive".

It now follows the approach of mainstream desktop clients: **there is no such thing as a "titlebar"**, only three zero-height window buttons floating in the top-right corner, taking no layout space. The page's own header already has search / theme / settings on its right, and the window buttons line up to their right, visually forming a single row of controls.

Related adjustment: the buttons float on the very top layer, above the full-screen player layer (`z-index:60`) and custom modals (`z-index:120`) — otherwise, opening the player leaves no way to close or minimise the window.

### 6. Wide-Screen Information Architecture Consolidated

With the sidebar expanded, the search / theme / settings circular buttons in the header are **completely redundant** with the left navigation. On wide screens they are withdrawn and folded into the sidebar:

- Search → sidebar "Search"
- Settings → sidebar "Mine"
- Theme → the sidebar fold row, placed to the left of the expand/collapse arrow

**Mobile is unaffected**: the hiding rule lives in the media query where the sidebar is actually shown, and phones have no sidebar, so those three header buttons remain the only entries there.

### 7. Three Small Defects

- **Third lyric line left-aligned**: `.np-lyric .ln` was `display:block` and relied on the parent's `text-align:center`; the wide-screen rule `.ln:nth-child(3){display:flex}` turned it into a flex container, and `text-align` does not control inline content of flex items while the default main-axis alignment is `flex-start`. **Only line 3 was made flex, so only line 3 was crooked**. Measured centres: lines 1 and 2 at 852/870, line 3 at 717. Adding `justify-content:center` brings all three to 860
- **Logo misaligned when the sidebar is collapsed**: the collapsed state relies on a group of "only an icon left, so centre it" rules, but `.rail-brand` was missed. Every other icon centres at 83; only it and the home icon sat at 77
- **In-app notifications defaulted to off**: the top toast is the **only immediate feedback** for actions like changing track, liking, or network failures; defaulting it off leaves people unsure whether an action took effect. Now on by default

### 8. Mobile-Only Settings Hidden on Desktop

Four items in "Notifications & Background" — **notification playback controls / non-interrupting notifications / send test notification / request notification permission** — all depend on Android native capabilities (`PlaybackService`, `POST_NOTIFICATIONS`, `RippleNative.notify`). On desktop they either do nothing or permanently show "not authorised", so keeping them only makes it look broken.

The criterion is the explicit `platform: 'desktop'` from `bridge.js`, **not capability detection** — the desktop bridge reproduces every method with its exact signature (returning `false`) to keep "zero frontend changes", so probing would be fooled by those placeholders. Android has no such field, so it reads `undefined` and stays unchanged.

"In-app notifications" is a pure frontend toast and works fine on desktop, so it is **kept**.

### 9. CI

- Both the Android and the desktop matrices (Linux-x64 / Windows-x64) now pass
- Two GitHub Actions pitfalls hit along the way are recorded in `desktop/README.md`: a job-level `if` **cannot reference `matrix`** (which yields a workflow with 0 jobs and no error); `if: |` multi-line literals are illegal; and once a workflow is broken GitHub caches the bad parse, so **the filename must change** to force a re-parse

---

## 1.2.3 — Sixth Version

### 1. Rectification According to the Code Review Report from GLM-5.3 Flash (Full Coverage of 71 Items)

A full review targeting 1.2.2, with a report of 665 lines and 71 items (**0 blocker** / 5 high / 28 medium / 26 low / 12 info). **All were processed**, of which 65 were actually modified and 6 were verified as not to be changed with reasons given.

The dominant theme this round is "**one list copied into three, and then each one drifting its own way**" — the previous round unified the equaliser preset lists, but two structurally identical spots were missed, and the consequences are exactly the same.

**Three List Mismatches (half of this round's highs)**

- **Five quality tiers, only four recognised**: the data model is `standard/higher/exhigh/lossless/hires`, but the whitelist has four values and **is missing `hires`**, while the settings buttons are yet another set of four that **is missing `higher`**. Picking Hi-Res works for the session and silently falls back to "Extreme" after a restart; and `higher` has no UI entry at all, so the first step of the five-tier downgrade chain is dead. All three are now five tiers, with a "Higher" button added to settings.
- **Six play modes, only three persisted**: the mode button cycles through 6 states but the whitelist holds 4 values, so choosing "Repeat One / Play in Order / Shuffle" is discarded on save. Worse, the derived `shuffle` / `repeat` fields *are* whitelisted and survive — so after a restart **the UI says "List Loop" while playback is actually still repeat-one**. The choice is reset and the interface lies about it, which is worse than simply losing a setting.
- **`.local` hostnames were matched by an arbitrary-suffix wildcard**: the previous round correctly unified issuance and authentication onto one decision function, but that function itself matched `*.local` on any suffix, so `x.y.attacker.local` passed. mDNS only handles single-label names; multi-label ones fall through to unicast DNS, which lets an attacker pick a resolvable name pointing at this machine and bypass the whole same-origin defence. Tightened to the RFC 6762 single-label form, with rejection-direction tests added (the existing tests only pinned the allow direction, which is why the hole never went red).

**The foreground-service failure path really does crash**

- After `startForegroundService()` Android 8+ allows 5 seconds, but the retry schedule landed the third attempt at T+7.5s — the system kills the process with `ForegroundServiceDidNotStartInTimeException` before the retry even runs. On top of that, two exit paths called `stopSelf()` while the foreground state had never been established, which triggers the same class of system exception, and try-catch cannot catch it (the system decides asynchronously). The retry is now two attempts within 1 second and gives up on the third, and every exit path establishes the foreground state first.

**Token window and offline fallback**

- The token table was a global 3 slots, so a third device refreshing would evict the first one's token — the 30-minute TTL could never be used in practice. Widened to 6 slots, with the multi-device coexistence limit documented in SECURITY.
- The token issuance endpoint was entered **before** the method restriction, so `HEAD` / `POST` also issued tokens and rotated the window — prefetches and prerenders were quietly consuming it. Non-GET now returns 405.
- The Service Worker cached `/ripple-token.js`: the server sends `no-store`, but `Cache.put` ignores HTTP cache semantics and stored it anyway. On a weak network or during a server restart the fetch fails → falls back to the stale token script → the token has long been rotated out → a wave of 401s. Worse, that script is not in the precache list, so **opening the PWA offline for the first time** falls back to `index.html` — feeding HTML to a JS loader. The token script is now passed through uncached, and code requests no longer fall back to HTML.

**Places where the comments said more than the code did**

- A comment promised "tap 'I'm already logged in' to retry", and the bridge method existed, but no button called it — the control B-2 intended to give users was never wired up. By the same standard, 5 bridge methods with zero frontend callers were still present, while the header comment justified deleting three others precisely on "delete anything with zero callers".
- Java calls `window.__rippleMediaUnavailable` to let the page show "background playback restricted", but a repo-wide grep finds zero references — the channel is dead and the comment is an IOU.
- The `#i-order` icon was reported as dead code but **that was a false positive** (it is consumed via a dynamically concatenated play-mode name) and was kept. 4 false positives were disproven this round.

**Accessibility**

- The library grouping, theme, performance and quality segmented controls encoded their selected state only in a CSS class, so screen readers could not perceive it at all; `<b>` is not focusable by default, so keyboard users could not enter the group. They now have `role="tablist"/"tab"/"radiogroup"` with `aria-selected`/`aria-checked`, roving tabindex, and arrow-key / Home / End handling. The bottom capsule and the sidebar gained `aria-current="page"`.

**Visuals and contrast**

- The expanded-lyrics translation line was "`--text3` with an extra 0.7 opacity", measuring below WCAG AA in both themes (about 2.5:1 in light) — the same mistake as the `.about-note` fixed last round, just missed here.
- `.eq-note.warn` hardcoded `#e0a84f`, about 1.8:1 in the light theme: the floating-window permission warning is nearly invisible there, so the permission guidance flow simply breaks.
- The VIP gold `#F0C86A` measured about 1.4:1 in light at 8-9px, practically invisible.
- The bottom capsule toast ("press back again to exit") was positioned at 96px while the dock top edge sits at 138px — about 42px of overlap, covering most of the mini player for those 2.5 seconds.
- The `>=600px` breakpoint had lost the "+40px off-screen margin" of the sheet's collapse transform, so short sheets peeked at the top.
- The low-power tier re-added a 46px full-screen parent blur on the ambient light, while the reason it was removed was precisely that "parent-layer blur is the source of halved frame rates"; and since accent has a colour transition registered, every track change re-computed that whole layer.

### 2. Layout Alignment Fixes (Widescreen Single Column / Landscape Double Bar)

Once the left sidebar landed, the positioning baseline of the bottom bars (mini player, bottom capsule) changed, and three spots had to be fixed in a row:

- **Desktop mini player floated 78px above the bottom**: the `.dock` `bottom` still carried the `+78px` meant to make room for the bottom capsule, but on widescreen the capsule had been replaced by the sidebar and there is no capsule at the bottom any more — so the mini player hovered 78px up with a big empty band underneath. Reduced to `+13px` breathing room, flush with the bottom.
- **Landscape / short-wide windows: the mini player and the bottom capsule were not the same width**: `.dock`'s horizontal padding was written as `padding-left:var(--safe-l)`, wiping out the `14px` from `layouts.css`, so the dock stretched edge-to-edge (full width) while the capsule stayed at `left/right:12px` — two bars of similar width directly stacked, and a 2px difference is already obvious at that size. Unified to 12px so both share identical left and right edges.
- **Desktop mini player was 34px wider than the content area on each side**: the content area's horizontal padding is `max(--pad-x, (100% - --content-max) / 2)`, while the dock only had `max-width` plus `margin:auto`, centering within the "already minus sidebar" box — two different algorithms that inevitably disagree on widescreen. Using the exact same formula as `.page` makes all three alignment lines come from one source.

**The settings page's two columns no longer have a big blank gap**

After splitting settings into two columns on large screens, there was always a block of whitespace between "Interface" and "Playback". Measurement showed it was the grid stretching both cells in a row to equal height: "Playback" has 8 rows (557px) while "Interface" has 6 (424px), so the shorter side left 133px blank underneath. Adding `align-items:start` only stops the cell from stretching — the empty space still occupies a layout position, so it still reads as "a gap".

Replaced with two independent column containers (`.set-cols > .set-col`) that stack naturally with no alignment constraint; the two columns are now within 8px of each other and the hole is gone. On phones the column container degrades to `block`, where order equals DOM order, so the HTML has been reordered by reading priority (Interface → Playback → Lyrics → Notifications → NetEase → Storage).

Two alternatives were tried and rejected (reasons recorded in the comments): `columns` in a scrollable container slices content by inline width and lays it out as one long horizontal strip (measurements showed group `left` climbing to 3918px); `grid-auto-flow:dense` produces no backfill at all for equal-width cells.

### 3. New Collapsible Sidebar for Landscape / Desktop

Widescreen used to get a "vertical capsule": a floating 56px pill in the top-left with icons but no labels. That fit poorly on landscape and desktop — the 62px bottom capsule plus the 60px dock stack up to nearly a quarter of the screen height, while horizontal space is actually abundant.

Widescreen breakpoints now use a left sidebar instead:

- **Expanded**: brand mark, four main nav entries (icon + label), account summary card at the bottom
- **Collapsed**: icon strip only, content area yields the space automatically
- **State memory**: expanded/collapsed is written to `localStorage` and survives restarts; with no history the default depends on width (`>=1180` expands, narrower tablets collapse)
- **Keyboard**: `[` collapses/expands directly (not triggered while typing in a field)

Three deliberate trade-offs in the implementation:

- **Width converges on one variable**: `--rail-w` drives both the sidebar width and the `.app` `padding-left`, so "sidebar grows" and "content yields" are always the same layout pass with no chance of two sets of numbers drifting apart. The collapsed state just swaps in `--rail-mini`.
- **Both forms share one DOM and one `go()`**: the bottom capsule and the sidebar are two shells over the same navigation. Keeping a separate "current page" in each would eventually drift into "the highlight moved but the page did not".
- **The sidebar must disappear completely on phones**: the `data-rail` attribute persists across devices, so a collapse rule without a breakpoint would leave an empty strip on phones — that rule must live inside the media query.

The collapse button, brand name and account card are laid out on **three separate rows**. On one row, icon 30 + brand ~70 + button 28 plus three gaps does not fit in a 130px column, and the brand name gets truncated to "Ripp".

### 4. Two Items Judged Not to Change

- **Token TTL stays at 30 minutes**: a shorter TTL looks safer on paper, but the frontend only fetches a token once at page load and does not auto-renew on 401 — shortening it would trade a security worry for an availability bug (the page starts returning 401 after a while). And for the actual threat model of "an attacker on the same machine", a shorter TTL adds almost nothing. This judgement was made last round and the review raised it again; the conclusion stands.
- **`info` toasts stay hidden when "In-app notifications" is off**: that is the intent, with `check` / `warn` as exceptions.

### 5. Regression Testing

- Test cases **60 → 63** (new cases for multi-label `.local` rejection, Host/Origin consistency, token expiry and IP binding, upstream path traversal)
- Five-tier quality and six-tier play mode were verified round-trip in practice (select → persist → reload → still in effect)
- The sidebar was verified item by item at three viewports: 1280×800 (expand / collapse / memory after reload / nav highlight), 390×844 (must be hidden), and 844×390 phone landscape (must be hidden)

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