# Contributing to Ripple

[简体中文](../../CONTRIBUTING.md) | **English**

Thank you for taking the time. Ripple is a project deliberately kept "small but complete": the build process does not depend on Gradle, there is no AndroidX, and there is no frontend build chain. After reading this page, you will be able to get it running.

> **About Gradle**: `build-apk.sh` only uses `aapt2 / javac / d8 / zipalign / apksigner`,
> and it is the official build entry point. The repository keeps `android/build.gradle`, `android/settings.gradle`,
> `android/gradle.properties`, and `android/app/build.gradle` (AGP 8.4.2), but those are only optional configuration,
> not the official build entry point — they are mainly for IDE completion and to give people who want to use Gradle a starting point.
> Please do not rely on them to produce builds, and do not introduce a dependency tree for them.

## Things This Project Deliberately Does Not Use

Before submitting a PR, please confirm that your changes do not introduce the following. This is the prerequisite for the project to remain runnable with "just `node server.js`":

| Not introduced | Reason |
|---|---|
| Kotlin | Depends only on JDK + Android SDK, with `javac` producing output directly |
| AndroidX / AppCompat | Avoids a Gradle dependency tree; `build-apk.sh` only uses `aapt2 / javac / d8` |
| npm dependencies | `server.js` only uses Node built-in modules |
| Frontend build tools | The `app/` directory is the final output; after editing, refresh and it takes effect |
| Third-party UI frameworks | Hand-written CSS, with only one "liquid glass" look |

## Environment Setup

### 1. Run the Web Version (Fastest)

```bash
node server.js          # default 8080
```

Open `http://localhost:8080`. Edit any file under `app/` and refresh the browser.

### 2. Build the APK

Requires: JDK 17+, Android SDK (`build-tools` + `platforms/android-34`).

```bash
export ANDROID_HOME=/path/to/android-sdk
export JAVA_HOME=/path/to/jdk
bash android/build-apk.sh
```

The output is at `android/build-manual/Ripple-<version>-debug.apk`.

> **There is only one source for the version number**: `version.json` in the root directory.
> The script automatically syncs it to `build.gradle`, `CrashLog.java`, `RippleApp.java`,
> `app/js/version.js`, and the `CACHE` in `app/sw.js`.
> Do not edit these places manually; if you do, they will be overwritten on the next build.

### Version Sync Checklist (All Automatically Written by `android/sync-version.sh`; **Do Not Edit Manually**)

`build-apk.sh` calls `android/sync-version.sh` at the beginning; the Gradle path (`./gradlew assembleDebug`)
also calls the same script, so the version numbers of the two build paths will not diverge.

| File | What Is Written | Source |
|---|---|---|
| `android/app/build.gradle` | `versionCode $VC` / `versionName '$VN'` | `version.json` |
| `android/app/src/main/java/com/ripple/app/CrashLog.java` | Version number recorded in the crash log header | `version.json` |
| `android/app/src/main/java/com/ripple/app/RippleApp.java` | `version=$VN($VC)` in the startup log | `version.json` |
| `app/js/version.js` | `{ code: $VC, name: '$VN' }` (displayed in the "About" dialog) | `version.json` |
| `app/sw.js` | First line `const CACHE = 'ripple-$VC';` (note: **no `v` prefix**) | `versionCode` in `version.json` |

These replacements all include assertions: if the anchor cannot be found or does not match after replacement, the script reports an error and exits directly; it will not silently produce a package with an inconsistent version number. CI also verifies again and fails directly on mismatch.

### After Changing the Frontend...

**Do not manually edit the `CACHE` in `app/sw.js`.** Its cache name is automatically synced by `build-apk.sh` according to `versionCode` (`CACHE = 'ripple-<versionCode>'`). The only thing to do for a release is: change the `versionCode` in `version.json` and run `bash android/build-apk.sh` once.

If you release without bumping `versionCode`, users who already installed will continue running old code — this is the most common "why didn't my change take effect" in this project. Manually editing `CACHE` will conflict with the value written back by the script and will be overwritten on the next build.

### Two Pitfalls on aarch64 / ARM Machines

1. **`aapt2`**: `build-tools/35.0.0+` is x86_64 ELF and cannot run on ARM. Use `34.0.0` (you can replace it with a `qemu-x86_64` wrapper yourself); the script already points to it by default.
2. **`d8`**: R8 8.2.2 in `34.0.0` throws `NullPointerException` on JDK 21 + aarch64. Use `d8` from `build-tools/36.0.0`; the script already does this by default.

## Code Structure

```
app/                    ← Web version, also assets/www inside the APK
├── index.html
├── css/base.css        ← design tokens, themes, player page
├── css/layouts.css     ← page skeleton
├── css/components.css  ← components
├── js/version.js       ← generated at build time, do not edit manually
├── js/log.js           ← logs (including native forwarding)
├── js/lrc.js           ← LRC parsing and bilingual merging
├── js/netease.js       ← NetEase Cloud Music client (native / proxy dual channel)
├── js/store.js         ← state, local library, IndexedDB
├── js/player.js        ← playback engine (dual audio elements + WebAudio)
├── js/app.js           ← UI and business logic
└── sw.js               ← Service Worker

android/                ← Java shell
├── app/src/main/java/com/ripple/app/
│   ├── MainActivity.java    WebView, insets, login page
│   ├── HttpBridge.java      JS bridge
│   ├── NeteaseClient.java   weapi command table
│   ├── Weapi.java           encryption
│   ├── PlaybackService.java media notification (foreground service + MediaSession)
│   ├── LyricOverlay.java    status bar lyric floating window
│   ├── LogBridge.java       logs
│   ├── CrashLog.java        crash forensics
│   ├── PublicFile.java      write logs to the "Downloads" directory (MediaStore)
│   ├── RippleApp.java       Application
│   └── StrictModes.java     safeMode
└── build-apk.sh             official build entry point (see also sync-version.sh)

server.js               ← local service for browser mode (static + /ncm proxy)
version.json            ← single source of truth for the version number
```

## Self-Check Before Committing

```bash
# 1. Syntax
for f in app/js/*.js app/sw.js server.js; do node --check "$f" || echo "FAIL $f"; done

# 2. Unit tests (Node built-in test runner, no npm install required)
bash tests/run.sh

# 3. Do not include login state/tokens
git status --short        # should not contain .ripple-cookie / .ripple-token

# 4. Changed the frontend? Change versionCode in version.json and run the build again;
#    the CACHE in sw.js will be synced automatically; do not edit manually
```

If you change the frontend without bumping `versionCode`, users who already installed will continue running old code — this is the most common "why didn't my change take effect" in this project.

## Code Conventions

- **Comments should explain "why", not "what was done"**. Much of the code in this project exists to work around specific pitfalls; the pitfall is more important than the code itself.
- **Always wrap system calls in `try/catch`**. Some customized ROMs throw unexpected exceptions; the app should not crash because of a status bar setting.
- **Do not fail silently**. If a parameter cannot be obtained, fall back to a default value and explain the reason in the UI (for example, "The equalizer does not take effect for online streams"), so users do not think the switch is broken.
- **Use Chinese comments**, and UI copy is also in Chinese.

## About the NetEase Cloud Music API

- It uses the public weapi protocol (`music.163.com/weapi/*`), consistent with third-party clients.
- Login state is stored in `.ripple-cookie` (the server attempts `chmod 0600`, but it does not take effect on fuseblk mounts such as `/sdcard`; measured as `660`; it is already in `.gitignore`). **Never commit it**.
- The project **does not provide any music resources and does not bypass membership or copyright restrictions**. Changes involving these areas will not be merged.

## Filing an Issue

Please include:

1. Version number (available under "My → About")
2. Phone model + Android version
3. Logs: `Download/Ripple-log.txt` (or "My → View Logs" in the app)
4. Reproduction steps

If it crashed, there is also `Download/Ripple-crash-*.txt`.

## Submitting a PR

- One PR should do one thing; the title should clearly state "what was fixed" rather than "which file was changed".
- For changes involving the UI, please attach screenshots or screen recordings.
- Commit messages can be in Chinese or English, but please explain **why** the change is needed.