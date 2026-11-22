# Security Notes

[简体中文](../../SECURITY.md) | **English**

## What Sensitive Data This Project Handles

| Data | Where It Is Stored | Notes |
|---|---|---|
| NetEase Cloud Music login state (`MUSIC_U`) | APK: app-private SharedPreferences; browser mode: `.ripple-cookie` | Already in `.gitignore`, **will never be committed** |
| `server.js` access token | `.ripple-token` (automatically generated when the server starts, **valid for 30 minutes**) | Used to validate `/ncm/*` requests, rotated on every page load |
| Locally imported audio | IndexedDB (browser) / app-private directory (APK) | Local only |
| Playback history, settings | localStorage / SharedPreferences | Local only |
| Runtime logs | `Download/Ripple-log.txt` | Contains playback and API call records, no passwords |

This project **has no proprietary server** and does not upload any data to third parties. All network requests are sent only to `music.163.com` and its CDN.

> **About "permission 0600"**: When `server.js` creates `.ripple-cookie` / `.ripple-token`, it attempts to
> `chmod 0600` and reads back the mode on startup for verification, printing a warning if it does not match. However, this project often runs in
> `/sdcard/DSHBox/ripple` (Android internal storage, a **fuseblk mount**). This mount does not implement POSIX
> permission bits, so `chmod` is a **no-op** here — in practice, `stat -c '%a' .ripple-cookie .ripple-token`
> returns `660` rather than `0600`. The real protection comes from "other apps cannot read this storage,"
> not from file permission bits. See [README.md](README_en.md#privacy) for a synchronized explanation.

## Reporting Security Issues

If you discover a security vulnerability, please **do not** open a public issue directly. Please contact us privately through either of the following methods:

1. Report privately on GitHub via [Security Advisories](../../security/advisories/new) (recommended)
2. Or in an issue, only say "there is a security issue and private communication is needed," and let the maintainers contact you

Please include as much of the following as possible:

- Scope of impact (for example: the API can be called without authorization from within the LAN)
- Reproduction steps
- Your suggested direction for a fix

We will confirm receipt within 7 days and acknowledge you in the release notes after the fix (unless you wish to remain anonymous).

## Protections Already in Place

These are here to give you peace of mind and to serve as a baseline for contributors' changes:

- **`/ncm/*` requires an access token**: This endpoint carries your NetEase Cloud Music login state. Without protection, any webpage on the same Wi-Fi could use your account to change favorites.
- **Tokens are short-lived, rotating, and bound to the source IP**: Tokens are issued by `/ripple-token.js` on every page load,
  expire after 30 minutes by default, with a maximum of 30 issued per IP per minute, and only recognize the source IP at the time of issuance.
  So even if a token leaks, the usable window is very short.
  Keeping the TTL from being shortened further is intentional: the frontend does not auto-renew on a 401, and this is a player that stays open for long stretches —
  a TTL shorter than the actual usage time would produce a wave of 401s. Shortening the TTL also cannot stop an attacker on the same machine (they can just issue another).
- **Multi-device coexistence limit is about 6 "devices + pages"**: the token table is global, and every page load evicts the oldest entry in the window;
  the server keeps "the current token + 5 previous ones" (`TOKEN_KEEP_PREV = 5`).
  So with up to about 6 devices/tabs refreshing alternately, the one opened first will not be squeezed out into a 401;
  beyond that you get "whoever refreshes works, everyone else gets 401" — a known limit, not a vulnerability.
  In that case either close unused tabs or give Ripple its own dedicated device.
  Note that what was increased is the **count**, not the **time**: each token's expiry is still governed by the TTL, so the security window is not widened.
  The issuing endpoint only accepts `GET` (issuing rotates the window, so HEAD/POST should not consume it).
- **Cross-site requests initiated by browsers are rejected**: `/ripple-token.js` validates the Host whitelist, `Sec-Fetch-Site`,
  `Sec-Fetch-Mode` / Origin / Referer, so requests initiated from other sites in a browser cannot obtain a token.
  **But this is not "all headless requests are 403"** — these request headers can be forged by clients; in practice,
  `curl -H 'Sec-Fetch-Site: same-origin' -H 'Sec-Fetch-Mode: no-cors'` **can obtain a token**.
  In other words: **other programs on the same machine can still access `/ripple-token.js` to obtain a token, but what they get is a short-lived token.**
  This project's threat model is "prevent webpages on the LAN / Internet from cross-site attacking your API," not "prevent programs on the same machine that already have equivalent permissions":
  the latter can read your cookie file, and likewise can read the token; a token cannot stop that. What actually works is TTL + IP binding + rotation.
  The specific token implementation (TTL length, whether to use a one-time nonce) may continue to be tightened; this paragraph describes **design intent**, not implementation details.
- **`/ncm/*` is rate-limited by IP**: 60 requests/minute; over the limit returns 429 + `Retry-After`, preventing others from using your login state to flood NetEase Cloud Music's risk control.
- **The upstream path whitelist is validated before concatenation**: Invalid user parameters are rejected directly; no "concatenate first, then use URL normalization" patch is used (`new URL()` normalizes away `..`, so post-validation cannot catch it).
- **The `/audio` proxy has been taken offline**: The frontend never used it, and it has been removed entirely to reduce the attack surface (its domain whitelist was only defense in depth).
- **`/ncm/*` request body limit is 256 KB**.
- **Malformed URLs will not crash the process**: `decodeURIComponent` / `new URL` are both wrapped in try/catch, and the entire request handling has an outer fallback.
- **Static directory prefix validation includes the separator**: `file === ROOT || file.startsWith(ROOT + sep)`, preventing sibling directories such as `app2/` from being incorrectly allowed.
- **WebView disables universal file access**: `setAllowUniversalAccessFromFileURLs(false)`, so `file://` pages cannot arbitrarily make cross-origin requests.
- **The login page prohibits off-site redirects**: preventing phishing pages from taking over the flow in the login WebView.
- **`file://` pages only load their own assets**.

## Known Limitations (Not Vulnerabilities, But You Should Know)

- **Debug-signed APK (known tradeoff, will not change)**: Release packages are signed with the fixed **debug keystore** in the repository.
  This is an intentional tradeoff — changing the signature would make existing users **unable to overwrite-upgrade** (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`),
  at the cost that the debug certificate's password is public (`android`), so **anyone can sign an APK with the same package name**.
  Therefore:
  - Please **install only from this repository's Releases**, and do not install APKs with the same package name from other sources;
  - If you distribute it yourself, you can switch to your own release keystore, but be aware that old users must uninstall and reinstall.
  - **It cannot be listed on app stores**: certificates with public passwords are not accepted by stores.
- **Cleartext (http) is denied by default; only loopback gets a debugging exception**: the manifest no longer declares `usesCleartextTraffic="true"`;
  it uses `network_security_config.xml` instead — `cleartextTrafficPermitted="false"` is the global default,
  and only `127.0.0.1` / `localhost` are allowed (for adb reverse and local proxy debugging; those are not network-reachable addresses).
  That is stricter than the old documentation's "cleartext open across the app": all online requests are https.
  If you configure an http private proxy at the system level, add a line for it in `network_security_config.xml`.
- **Status bar lyrics require overlay permission**: This is an Android mechanism limitation, not an extra request by this project.
- **`.ripple-cookie` is plaintext**: The NetEase Cloud Music login state is itself a cookie and cannot be stored encrypted.
  The server attempts `chmod 0600`, but it does not take effect on `/sdcard` (fuseblk); in practice it is `660` (see above).
- **Other programs on the same machine can obtain the access token themselves**: The token protects against cross-site webpages, not other processes on the same machine.
  If other apps on this machine can read your internal storage, move the project to an app-private directory before running it.