# Ripple

[简体中文](../../README.md) | **English**

> A breathing music player. A single "liquid glass" visual language, dark / light dual themes, and automatic cover art color extraction.
> Online content uses the real NetEase Cloud Music API (weapi encryption), and supports logging in to your own account, Daily Recommendations, Heartbeat Mode, and Infinite Roam.

<p align="center">
  <b>PWA + native shell</b> · <b>approx. 0.5 MB (APK)</b> · <b>build does not depend on Gradle</b> · <b>no AndroidX</b> · <b>MIT</b>
</p>

**Platforms:** Android (APK) · browser / PWA (`node server.js`) · desktop (Windows / Linux, Tauri 2)

> The desktop client reuses **the same `app/` frontend with not a single line of logic changed**; a bridge layer reproduces Android's `@JavascriptInterface` verbatim. See [desktop/README.md](../../desktop/README.md).
>
> All three platforms ship in the same Release. macOS is not built — it needs the Apple SDK and signing
> certificates, which this machine can neither produce nor verify; better to be explicit than to ship a package nobody tested.

---

## What It Looks Like

> **Screenshots are in `docs/screenshots/` and will be added by the maintainers before release.**
> Until the screenshots are added, the images below will appear as broken images on GitHub; this does not affect any functionality.

| Home | Player |
|:---:|:---:|
| <img src="docs/screenshots/home.png" alt="Ripple Home" width="300"> | <img src="docs/screenshots/player.png" alt="Ripple Player" width="300"> |

| Full Lyrics | Playback Settings |
|:---:|:---:|
| <img src="docs/screenshots/lyrics.png" alt="Ripple Full Lyrics Page" width="300"> | <img src="docs/screenshots/options.png" alt="Ripple Playback Settings Panel" width="300"> |

| Equalizer | Status Bar Lyrics |
|:---:|:---:|
| <img src="docs/screenshots/eq.png" alt="Ripple Equalizer" width="300"> | <img src="docs/screenshots/sblyric.png" alt="Ripple Status Bar Lyrics" width="300"> |

<img src="docs/screenshots/notification.png" alt="Ripple Notification Playback Controls" width="640">

> Real-device screenshot: vivo V2425A / Android 17. Notifications and Atomic Island are rendered by the system according to MediaSession.

## Features

**Playback**

- Dual `<audio>` element architecture: online streams are decoded directly (avoiding CORS tainting), while local imports go through WebAudio (can connect to the equalizer)
- Multi-size adaptation: separate layouts for small phones / regular phones / large phones / foldables / tablets / desktop, with support for floating windows and split-screen
- Fade in/out, playback speed, sleep timer (restored across restarts), seamless preloading, volume normalization
- Resume playback: after exiting and re-entering, the last song and progress are automatically restored, **and the lyrics are restored as well**

**Interface**

- A single "liquid glass" look. No multiple skins — one set done thoroughly
- Edge-to-edge fullscreen: status bar / navigation bar are transparent, and colors follow the page background and the cover's dominant color
- Three-line lyrics on the player page (tap to open full lyrics), dynamic cover color extraction, VIP badge
- The "…" in the top-right corner is the entry point for all playback-related settings; no need to go back to "My"
- Comment loading skeleton screens, with no flashing or jumping

**Equalizer**

- 5 bands (60 / 230 / 910 / 3.6k / 14k Hz), 6 presets + custom (±12 dB)
- In preset mode, the vertical bars are grayed out and cannot be moved; switch to "Custom" to drag them

> The equalizer only takes effect for **locally imported** songs. Online streams use direct decoding (the NetEase Cloud Music audio CDN does not return CORS headers; forcing them into WebAudio will be marked as tainted and muted). When playing online songs, the panel will clearly indicate this and will not pretend to respond.

**Notifications and Status Bar**

- Foreground service + MediaSession: persistent notification that cannot be swiped away; controllable from the lock screen and via headset buttons
- Status bar lyrics floating window: color (including a custom color picker), font size, opacity, bold, stroke,
  **fill following playback progress**
- **In the locked state it does not intercept touches at all**, so it does not affect normal phone use; the position can only be dragged after unlocking

> These depend on Android's window and media systems; browsers and desktop have no equivalent.
> The desktop client therefore **automatically hides** those four phone-only switches under
> "Settings → Notifications & Background" (notification playback controls / non-interrupting notifications /
> send test notification / request notification permission), so no switch is shown that can be toggled
> yet does nothing. "In-app notifications" is a pure frontend toast and works on desktop, so it stays.

**NetEase Cloud Music**

- Real weapi protocol (double-layer AES-128-CBC + textbook RSA, consistent with mainstream third-party clients)
- Built-in login page (QR code / account password), with persistent login state
- Search, song details, lyrics (including translations), automatic fallback for playback URLs, charts, playlists,
  Daily Recommendations, Liked Songs, Heartbeat Mode, Infinite Roam, comments

## What It Doesn't Do

To avoid trouble, it does not do the following:

- **Does not bundle any music resources** and does not provide a download site
- **Does not bypass membership, payment, or regional restrictions**. If no audio source can be obtained, it will clearly tell you so
- Does not promise that the notification bar looks like a particular app — its appearance is rendered by the system according to MediaSession, and the manufacturer's theme has the final say

## Installation

### Install the APK (Recommended)

Go to [Releases](../../releases) to download the latest `Ripple-x.y.z.apk`, transfer it to your phone, and install it (you need to allow "Install unknown apps").

**There is only one universal package; ABI splits are unnecessary.** Ripple is a pure Java + WebView app with
no `.so` files or `lib/` directory in the APK (`aapt2 dump badging` reports no `native-code` either), so
x86 / x86_64 / arm64 all use the same package — ABI only matters for apps shipping native libraries.

- Minimum Android 7.0 (API 24)
- Ready to use after installation; **no need to start a separate service or configure an API address**

> **The installation source is important**: This app uses a public **debug signature** (the debug keystore is public with the repository; the password is the industry-standard `android`, and anyone can use it to sign an APK with the same package name). Therefore, please **install only from this repository's Releases**, and do not install APKs with the same package name from other sources — otherwise you are giving others the permission to overwrite and upgrade your Ripple. See [SECURITY.md](SECURITY.md) for details.

### Desktop (Windows / Linux)

Download the format you need from [Releases](../../releases) (same Release as the APK):

| Platform | Format | Notes |
|---|---|---|
| Linux | `.deb` | Double-click to install on Debian / Ubuntu |
| Linux | `.AppImage` | No install; `chmod +x` and run |
| Linux | `.tar.gz` | Portable, unpack and run |
| Windows | NSIS `-setup.exe` | Installer |
| Windows | `.zip` | Portable, unpack and run |

The packages are unsigned, so the first run is blocked by the OS (Windows SmartScreen; no effect on Linux).
See [desktop/README.md](../../desktop/README.md) for the workaround.

### Run the Web Version / PWA

```bash
node server.js          # default 8080
```

The terminal will print the LAN address. After your phone connects to the same Wi-Fi, visit `http://<your-IP>:8080`, and use "Add to Home Screen" in the browser menu to run it fullscreen.

> When hosted by `server.js`, the page automatically uses the same-origin `/ncm/*` proxy; **no need to manually enter an API address**.
> Only when you want to connect to another self-hosted API do you need to fill it in under "My → NetEase Cloud Music API Address".

### Build from Source

```bash
export ANDROID_HOME=/path/to/android-sdk
export JAVA_HOME=/path/to/jdk17+
bash android/build-apk.sh
```

Output: `android/build-manual/Ripple-<version>-debug.apk`.
For detailed environment requirements and pitfalls on ARM machines, see [CONTRIBUTING.md](CONTRIBUTING.md#2-打包-apk).

The build process does not depend on Gradle (`build-apk.sh` only uses `aapt2 / javac / d8`; see
[android/build-apk.sh](android/build-apk.sh)); the repository keeps optional Gradle configuration
(`android/build.gradle`, `android/settings.gradle`, `android/gradle.properties`,
`android/app/build.gradle`), but it is **not** the official build entry point. It is only used for IDE completion and as a starting point for those who want to use Gradle.

## Project Structure

```
app/                    ← Web version, also assets/www inside the APK
├── index.html
├── css/                ← base (tokens/themes/player page) / layouts / components
├── js/
│   ├── version.js      ← generated at build time, do not edit manually
│   ├── log.js          ← logs (including native integration)
│   ├── lrc.js          ← LRC parsing and bilingual merging
│   ├── netease.js      ← NetEase Cloud Music client (native / proxy dual channel)
│   ├── store.js        ← state, local music library, IndexedDB
│   ├── player.js       ← playback engine
│   └── app.js          ← UI and business logic
└── sw.js               ← Service Worker

android/                ← Java shell (11 classes; see "Code Structure" in CONTRIBUTING.md)
server.js               ← local service for browser mode (static + /ncm proxy)
version.json            ← single source of truth for version number
tests/                  ← Node built-in tests (bash tests/run.sh), currently covering LRC parsing
```

## Privacy

**No proprietary server; no data is uploaded to third parties.** All network requests are sent only to `music.163.com` and its CDN.

| Data | Where it is stored |
|---|---|
| NetEase Cloud Music login state | APK: app-private configuration; browser mode: `.ripple-cookie` (the server runs `chmod 0600`, but Android external storage does not implement POSIX permission bits, so it is actually `660`; see below) |
| Locally imported audio | IndexedDB / app-private directory |
| Playback history, settings | localStorage / SharedPreferences |
| Runtime logs | `Download/Ripple-log.txt` (does not contain passwords) |

`.ripple-cookie` and `.ripple-token` are both in `.gitignore` and will not be committed.

> **Note about 0600**: This project often runs in `/sdcard/DSHBox/ripple` (Android internal storage,
> fuseblk mount). This mount does not implement POSIX permission bits, so `chmod 0600` is a no-op —
> in practice, `stat -c '%a' .ripple-cookie .ripple-token` returns `660`, not `0600`.
> On startup, the service reads back the file mode for verification and prints a conspicuous warning if it does not match (so you will see this warning; it is accurate).
> If other apps on this machine can read your internal storage, move the project to an app-private directory before running it.

For security-related matters, please read [SECURITY.md](SECURITY.md).

## Contributing

Issues and PRs are welcome. Before you start, please read [CONTRIBUTING.md](CONTRIBUTING.md).
**Android / web** deliberately introduce no Kotlin / AndroidX / npm dependencies / frontend build chain —
that is the prerequisite for keeping it runnable with just `node server.js`.

**The desktop client** (`desktop/`, in validation) breaks that rule: it needs cargo and a Rust dependency tree.
That is the unavoidable cost of native desktop capabilities, so it is isolated in its own directory with its own CI,
**leaving the zero-dependency builds of the other two platforms untouched**. The trade-off is documented in [desktop/README.md](../../desktop/README.md).

Run tests: `bash tests/run.sh` (Node built-in test runner, no `npm install` required).

## License

[MIT](LICENSE)

## Contributors

**Coding:** Deepseek V4.1 Flash 1017  
**Main review:** MiniMax M3.1 Flash, Hy4 Flash, GLM-5.3 Flash

---

**Disclaimer**: This project is a third-party client and is not affiliated with the official NetEase Cloud Music. It does not provide any music resources and does not bypass membership or copyright restrictions.
The copyright of online content belongs to NetEase Cloud Music and the rights holders. Please listen only to content you have the right to access.