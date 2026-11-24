<h1 align="center">Ripple Desktop (Tauri)</h1>

<p align="center">
  <a href="./README.md">简体中文</a> | <b>English</b>
</p>

The desktop client for Ripple. It **reuses the entire 8200-line `app/` frontend
without changing a single line**, adding only a native bridge and a NetEase client
on the Rust side.

> **Status: shipped with 1.3.0**
>
> Desktop artifacts (`.deb` / `.AppImage` / `.tar.gz` / `-setup.exe` / `.zip`)
> are published **in the same public Release** as the Android APK; CI also uploads
> Artifacts for troubleshooting. The code is merged into `main`.

---

## Getting it running

### Prerequisites

- Rust 1.77+
- On Linux additionally: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`
- **No Node / npm / frontend build chain required** — this is deliberate

### Build

```bash
bash desktop/build-frontend.sh      # assemble frontend (app/ + bridge.js -> desktop/dist/)
cd desktop/src-tauri
cargo tauri build                   # artifacts land in target/release/bundle/
```

`cargo tauri` comes from `cargo install tauri-cli --version "^2"`.

### Live development

```bash
bash desktop/build-frontend.sh
cd desktop/src-tauri && cargo tauri dev
```

---

## Architecture: why the frontend can be reused as-is

`app/` was written for the Android WebView and calls native capabilities through
`window.RippleNative`, an `@JavascriptInterface` object. Desktop has no such object,
so the frontend would fall back to the browser path (online features simply unavailable).

The approach is to **build an identical `RippleNative` inside the page** that forwards
to Tauri's Rust commands:

```
app/js/netease.js
      |  window.RippleNative.netease(cmd, json, cbId)
desktop/bridge.js          <- these 377 lines are the entire adaptation cost
      |  __TAURI__.core.invoke('netease', {...})
desktop/src-tauri/src/main.rs
      |
desktop/src-tauri/src/netease.rs  ->  weapi.rs  ->  music.163.com
```

The frontend cannot tell the difference — it believes it is talking to Java.

### The callback shape must match Android exactly

Android uses "synchronous call + asynchronous callback":

```js
N.netease(cmd, paramsJson, cbId)   // returns immediately
// later: window.__rippleNativeResult(cbId, text)
```

Desktop **must** keep the same shape, because the frontend's `nativeCall()` is built
on that pending table plus a timeout. Switching to Promises would mean touching
`netease.js`, and "zero frontend changes" is the core constraint of this approach.

### Bridge method mapping

| Frontend call | Android | Desktop |
|---|---|---|
| `RippleNative.netease(cmd,json,id)` | Java weapi | Yes, Rust weapi |
| `RippleNative.notify(title,body)` | Notification bar | No, always false (degrades) |
| `RippleNative.mediaState(json)` | MediaSession | No, always false |
| `RippleNative.canDrawOverlay()` | Overlay permission | Yes, always true (no permission needed for an app-owned window) |
| `RippleNative.showLyricOverlay(...)` | Status-bar overlay window | Yes — standalone always-on-top mini window (below) |
| `RippleNative.updateLyricOverlay` | Change the current line | Yes |
| `RippleNative.setLyricProgress` | Per-line progress 0..1 | Yes |
| `RippleNative.hideLyricOverlay` | Hide the overlay | Yes |
| `RippleNative.login(mode,id)` | Embedded login page | Not needed (login uses QR, see below) |

Every native call site in the frontend is guarded with
`if (window.RippleNative && typeof N.xxx === 'function')`, so a missing method
degrades automatically — which is exactly what lets desktop implement only the
essential `netease` and leave the rest empty.

---

## Feature comparison: what desktop has and doesn't

### Fully working

Playback engine (three-`<audio>` architecture), equalizer (WebAudio), lyrics
(including translations), **per-line karaoke colouring**, **standalone always-on-top
lyric window**, playlists, daily recommendations, heart mode, infinite roam,
comments, search, local import, liquid-glass visuals, dark/light themes,
cover-based color extraction, responsive layout at multiple sizes.

### Different shape

| Feature | Android | Desktop |
|---|---|---|
| Media control | Notification + MediaSession + headset keys | None (tray / SMTC / MPRIS pending) |
| Lyric overlay | Status-bar overlay window | **Standalone borderless always-on-top mini window** (since 1.3.3) |
| edge-to-edge | Transparent status bar | Not applicable |

### Lyric overlay: how the desktop does it

Android exposes no public API for "write into the status bar", so a status-bar lyric is
really a system-level overlay window covering the status-bar area — hence the
"display over other apps" permission. Desktop has no such concept, so it uses a
**standalone borderless always-on-top mini window** (`desktop/lyric.html` plus the
`lyric_overlay_*` commands in `main.rs`):

| Behaviour | Android | Desktop |
|---|---|---|
| Carrier | `TYPE_APPLICATION_OVERLAY` window | Standalone `WebviewWindow` (lazy-created) |
| Always on top | System overlay is inherently on top | `always_on_top` + `skip_taskbar` |
| Locked | `FLAG_NOT_TOUCHABLE` (click-through) | `set_ignore_cursor_events(true)` |
| Unlocked | Draggable; tap calls back to the web UI | `data-tauri-drag-region` drag |
| Position persistence | `settings.sbX / sbY` | `lyric-pos.json` in the config dir |
| Progress | `setProgress(0..1)` | Same 0..1, **meaning "the current line"** |

The six bridge methods are **same-named and same-shaped** as the Java side, so not a
single line of the `app/` front end had to change — it still believes it is talking to
Android.

> **Known limitation**: on Linux a transparent window needs a desktop compositor.
> Without one it degrades to an opaque background (the text stays readable); if window
> creation fails, `showLyricOverlay` returns `false` and the front end keeps the switch
> on and retries next launch — rather than forcing it off (which would make the user
> think the feature vanished).

### Not implemented

Nothing at present that "should exist but doesn't".

> **QR login works** (since 1.3.0): `chooseLoginMode` goes through the QR flow on all
> three platforms, and `login_qr_key` / `login_qr_check` are implemented on the Rust
> side — just click "Log in with NetEase" in the UI and scan. No manual cookie needed.

**Fallback login** (if QR is unavailable): write NetEase's `MUSIC_U` cookie into
`netease-cookie` in the config directory:

```bash
# Linux
echo 'MUSIC_U=your-cookie' > ~/.config/ripple/netease-cookie
# Windows (PowerShell)
'MUSIC_U=your-cookie' | Out-File "$env:APPDATA\ripple\netease-cookie" -Encoding utf8
```

Get the cookie after logging into music.163.com in a browser:
DevTools -> Application -> Cookies.

---

## Opening unsigned packages

The artifacts are **not code-signed** (that needs a paid certificate, see below),
so the system blocks the first launch:

**Windows**: SmartScreen says "Windows protected your PC"
-> click "More info" -> "Run anyway"

**Linux**: `chmod +x` then run; for deb use `sudo dpkg -i`; AppImage needs `--no-sandbox`

**Why not sign**: A Windows code-signing certificate costs several hundred to a few
thousand yuan a year; macOS needs an Apple Developer account ($99/year) plus
notarization. This is a personal project, so telling users honestly how to bypass
the warning beats pretending it is safe.

---

## Three real pitfalls we hit (read before changing code)

### 1. Cookies split under concurrency

The original `netease` command was "take the Client out of shared state -> request
-> put it back". During the request the shared state holds `None`, so a second
command arriving mid-flight would **create a new Client** and the two `cookie_jar`s
would overwrite each other — login state randomly lost.

The home page really does run concurrent requests (daily recommendations +
recommended playlists + toplist at once), so this was a genuine defect. It now
shares one instance via `Arc<Mutex<Client>>`, with the lock held only around the
actual client access.

### 2. A module cannot be declared in both files

Writing `mod netease;` in both `main.rs` and `lib.rs` compiles the same code twice,
producing two unrelated types (`main::netease::Client` != `lib::netease::Client`).
The correct approach is `pub mod` in lib and `use ripple_desktop::netease` in main.

### 3. Command parameter shapes must match the other two platforms byte for byte

All three platforms (Java / Node / Rust) implement the same 22 commands (the front end calls 20 of them); any drift
shows up as hard-to-diagnose differences like "plays in the APK but not on desktop".
Easy ones to get wrong:

| Command | Easy mistake | Correct |
|---|---|---|
| `song_detail` | `ids` parameter | `c: '[{"id":1},{"id":2}]'` |
| `like` | `radio/like` | `song/like` + `trackId`/`userid`/`like` |
| `heart_mode` | `id` | `songId` / `type:fromPlayOne` / `startMusicId` |
| `simi_song` | `id` | `songId` |
| `comments` | static path | `v1/resource/comments/R_SO_4_<numeric id>` |

Each branch in `netease.rs` notes the corresponding Java / server.js line number;
changing one means changing all three.

---

## Tests

```bash
cd desktop/src-tauri
cargo test --lib          # weapi known-answer vectors + command parameter shapes
cargo fmt --all -- --check
```

### Why encryption needs unit tests

If weapi is off by a single byte, NetEase only returns `{"code":400}`, and the UI
gives no hint whether the AES padding is wrong or the base64 line-wrapping differs.
So `weapi.rs` carries known-answer vectors: the same input must always produce the
same output, and the length/character set must satisfy the protocol.

**CI cannot test "does it actually work when you open it"** — GUI interaction,
login and playback must be clicked by a human on a real desktop. Artifacts ship with
the Release and are also uploaded as CI Artifacts for troubleshooting.

---

## Relationship to the main project

| Path | Ownership |
|---|---|
| `app/` | Frontend shared by all three platforms, **changes here affect all three** |
| `desktop/bridge.js` | Desktop-only adaptation layer |
| `desktop/src-tauri/` | Desktop-only Rust code |
| `desktop/dist/` | Build output (gitignored, do not edit by hand) |

Change the frontend only in `app/`, then re-run `build-frontend.sh`.
**Never edit `desktop/dist/`** — it is a copy and the next build overwrites it.

---

## CI pitfall log (read before touching the workflow)

Getting the three-platform CI working surfaced five pitfalls, each presenting as
"completely no error message":

### 1. `matrix` cannot be used in a job-level `if`

```yaml
# Wrong: the whole workflow fails to parse
if: matrix.os != 'macos-latest'
```

It reports `Unrecognized named-value: 'matrix'`. `matrix` only exists at step level
**after** strategy expansion. Worse, this failure happens at parse time: **the run
is created but no job runs**, the log API returns 404, and the Actions page gives
no clue.

Correct approach: use `matrix.exclude` to drop the entry you don't want.

### 2. `if: |` multi-line literals are illegal

`if` accepts only **single-line** expressions. Writing `if: |` with the condition on
the next line also invalidates the entire workflow.

### 3. GitHub does not re-parse a workflow after fixing it

This is the nastiest one: the file content is corrected, yet the workflow's `name`
in the `runs` list still shows the file path (instead of the `name:` field) and every
run has 0 jobs. **You must rename the file** (e.g. `desktop.yml` -> `desktop-build.yml`)
to trigger a rescan.

### 4. Python on Windows outputs cp1252 by default

Any Chinese text printed by the inline Python in `build-frontend.sh` throws:

```
UnicodeEncodeError: 'charmap' codec can't encode characters
```

Impossible to reproduce on Linux. Fix: `sys.stdout.reconfigure(encoding='utf-8')`
in the script.

### 5. Tauri 2's `AppHandle` has no `eval`

```
error[E0599]: no method named `eval` found for struct `AppHandle<R>`
```

Tauri 1's `AppHandle::eval` moved to `WebviewWindow` in Tauri 2:

```rust
if let Some(win) = app.get_webview_window("main") {
    let _ = win.eval(&js);
}
```

---

## Debugging trick: use `workflow_dispatch` as a validator

GitHub has no "validate workflow syntax" API, but a **manual dispatch** is the best
validator — it returns the concrete error at parse time:

```bash
curl -X POST -H "Authorization: token $GH_TOKEN" \
  "https://api.github.com/repos/OWNER/REPO/actions/workflows/desktop-build.yml/dispatches" \
  -d '{"ref":"feat/desktop-tauri"}'
```

- `HTTP 204` -> workflow is valid
- `HTTP 422` + `failed to parse workflow: (Line: N, Col: M): ...` -> precise line/column error

Far faster than push-and-pray.

---

## Artifact formats

| Platform | Format | Notes |
|---|---|---|
| Linux | `.deb` | Debian / Ubuntu, `sudo dpkg -i` |
| Linux | `.tar.gz` | **Most universal**: unpack and run, no distro or package manager needed |
| Linux | `.AppImage` | Single file, chmod +x and run |
| Windows | `.zip` | Contains `Ripple.exe`, unpack and run |
| Windows | `.exe` (NSIS) | Installer wizard |

`tar.gz` / `zip` are not native Tauri formats; CI generates them after bundling.
They contain only the executable plus a README, **with no runtime bundled**
(WebView comes from the system). The reason is that "unpack and run" is a much lower
barrier than "install a package manager dependency first".

### Why no macOS

CI can compile it, but **nobody can test it** — an unsigned package is blocked
outright by Gatekeeper ("is damaged and can't be opened"), and being double-clickable
requires an Apple Developer account ($99/year) plus notarization. An artifact that
"builds but won't open and was never verified" is worse than not shipping it.

When there is a way to verify it, add it back: one line `macos-latest` in
`matrix.include`.

## Current CI status (verified working)

| Gate | Content | Result |
|---|---|---|
| Rust unit tests | Linux + Windows matrix, weapi known-answer vectors | Pass |
| Frontend assembly | bridge.js injection point, sw.js exclusion, syntax check | Pass |
| Bundling | Linux-x64 (deb/appimage/tar.gz) + Windows-x64 (nsis/zip) | Pass |

---

## Local verification log (ARM64 Linux)

CI only proves "it compiles"; this records one run that **actually ran**.

### Environment

Ubuntu 24.04 proot on an Android phone, `aarch64`, Xvfb + VNC.

### Two unavoidable pitfalls

**1. `/sdcard` is noexec, so building always fails**

```
could not execute process `.../build_script_build` (never executed)
Caused by: Permission denied (os error 13)
```

Android's `/sdcard` is a bind mount with `noexec` — cargo has to execute the build
script it just generated and gets permission denied.

**Conclusion: for any Rust/compiled project on an Android phone, the build directory
must not live on `/sdcard`.** Moving it to `/root` (or any exec-capable location) fixes it.

**2. Even under `/root`, cargo's generated build scripts are 0600**

Under proot the executables cargo writes lack the execute bit (`-rw-------`) and
report the same `Permission denied`. A manual `chmod +x` works, so the build needs a
parallel permission-fixing loop:

```bash
( cargo build --release ) &
for i in $(seq 1 60); do
  sleep 3
  find target -type f -name 'build_script_*' ! -perm -u+x -exec chmod +x {} \;
done
```

It took **9 minutes 44 seconds** (ARM + phone, much slower than x86); the artifact is 4.9 MB.

### Result

```
Process starts          pid 6190
Window created          1180x743
UI fully rendered       left rail / hero / daily recs / mini player / account card
Interaction works       clicks trigger UI changes (screenshot byte size changes)
```

**Rendering difference (important)**: `backdrop-filter` blur strength on WebKitGTK is
noticeably weaker than on Chromium, so the glass looks "thinner". Functionality and
layout are correct, but the look does not exactly match Android/Chromium — consistent
with prior expectations for the WebKit family.
