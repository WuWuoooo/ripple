# Ripple 桌面端（Tauri）

Ripple 的桌面客户端。**复用 `app/` 那 13000 行前端，一行不改**，
只补一个 Rust 侧的原生桥和网易云客户端。

> ⚠️ **当前状态：验证阶段**
>
> 本目录在 `feat/desktop-tauri` 分支上开发。构建产物**只上传为 GitHub Actions
> Artifacts**（需登录、14 天过期），**不进公开 Release**。
> 等维护者在真实桌面环境实测通过之后，再决定是否并入 `main` 并正式发布。

---

## 怎么跑起来

### 先决条件

- Rust 1.77+
- Linux 额外需要：`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`
- **不需要 Node / npm / 任何前端构建链** —— 这是刻意的

### 构建

```bash
bash desktop/build-frontend.sh      # 组装前端（app/ + bridge.js → desktop/dist/）
cd desktop/src-tauri
cargo tauri build                   # 产物在 target/release/bundle/
```

`cargo tauri` 来自 `cargo install tauri-cli --version "^2"`。

### 开发时热看

```bash
bash desktop/build-frontend.sh
cd desktop/src-tauri && cargo tauri dev
```

---

## 架构：为什么前端能原样复用

`app/` 是为 Android WebView 写的，它通过 `window.RippleNative` 这个
`@JavascriptInterface` 对象调用原生能力。桌面端没有这个对象，前端就会走
浏览器降级路径（在线功能直接不可用）。

做法是在页面里**照原样造一个** `RippleNative`，内部转发给 Tauri 的 Rust 命令：

```
app/js/netease.js
      ↓  window.RippleNative.netease(cmd, json, cbId)
desktop/bridge.js          ← 这 86 行就是全部适配成本
      ↓  __TAURI__.core.invoke('netease', {...})
desktop/src-tauri/src/main.rs
      ↓
desktop/src-tauri/src/netease.rs  →  weapi.rs  →  music.163.com
```

前端完全感知不到差别 —— 它以为自己在跟 Java 说话。

### 回调形状必须与 Android 一致

Android 侧是「同步调用 + 异步回调」：

```js
N.netease(cmd, paramsJson, cbId)   // 立刻返回
// 稍后：window.__rippleNativeResult(cbId, text)
```

桌面端**必须**保持同一个形状，因为前端 `nativeCall()` 是按这套 pending 表 +
超时实现的。改成 Promise 就要动 `netease.js`，而「前端零改动」是这个方案的核心
约束。

### 桥接方法对照

| 前端调用 | Android | 桌面端 |
|---|---|---|
| `RippleNative.netease(cmd,json,id)` | Java weapi | ✅ Rust weapi |
| `RippleNative.notify(title,body)` | 通知栏 | ❌ 恒 false（走降级） |
| `RippleNative.mediaState(json)` | MediaSession | ❌ 恒 false |
| `RippleNative.canDrawOverlay()` | 悬浮窗权限 | ❌ 恒 false |
| `RippleNative.login(mode,id)` | 内嵌登录页 | ❌ 待补（见下） |

前端所有原生调用点都写成 `if (window.RippleNative && typeof N.xxx === 'function')`，
所以某个方法不给时会自动降级 —— 这也是桌面端能只实现最重要的 `netease` 一条、
其余留空的前提。

---

## 功能对照：桌面端有什么、没有什么

### ✅ 完整可用

播放引擎（三个 `<audio>` 架构）、均衡器（WebAudio）、歌词（含翻译）、
歌单、每日推荐、心动模式、无限漫游、评论、搜索、本地导入、
液态玻璃观感、深色浅色双主题、封面取色、多尺寸响应式布局

### ⚠️ 形态不同

| 功能 | Android | 桌面端 |
|---|---|---|
| 媒体控制 | 通知栏 + MediaSession + 耳机键 | 无（待做系统托盘 / SMTC / MPRIS） |
| 歌词浮层 | 状态栏悬浮窗 | 无（待做置顶小窗） |
| edge-to-edge | 状态栏透明 | 无此概念 |

### ❌ 未实现

- **扫码登录**：底层命令（`login_qr_key` / `login_qr_check`）已备好，
  但 UI 要改 `app/js/app.js` 的登录弹窗 —— 那是「前端零改动」的第一次破例，
  留作单独决策

**当前怎么登录**：把网易云的 `MUSIC_U` cookie 写进配置目录的 `netease-cookie`：

```bash
# Linux
echo 'MUSIC_U=你的cookie' > ~/.config/ripple/netease-cookie
# Windows (PowerShell)
'MUSIC_U=你的cookie' | Out-File "$env:APPDATA\ripple\netease-cookie" -Encoding utf8
```

cookie 从浏览器登录 music.163.com 后，开发者工具 → Application → Cookies 里取。

---

## 未签名包怎么打开

构建产物**没有代码签名**（需要付费证书，见下），所以首次运行会被系统拦：

**Windows**：SmartScreen 提示「Windows 已保护你的电脑」
→ 点「更多信息」→「仍要运行」

**Linux**：`chmod +x` 后直接运行；deb 用 `sudo dpkg -i`，AppImage 需要 `--no-sandbox`

**为什么不做签名**：Windows 代码签名证书每年几百到几千元；macOS 需要
Apple Developer（$99/年）+ 公证流程。本项目是个人项目，这笔钱不划算，
所以选择「如实告知用户绕过方法」而不是假装安全。

---

## 三个真实踩过的坑（改代码前先看）

### 1. 并发时 cookie 会分裂

最初 `netease` 命令的写法是「从共享状态取出 Client → 请求 → 放回」。
请求期间共享状态里是 `None`，此时若第二条命令进来会**新建一个 Client**，
两个 `cookie_jar` 互相覆盖 —— 登录态随机丢失。

前端首页确实会并发（每日推荐 + 推荐歌单 + 排行榜同时拉），所以这是真实缺陷。
现在用 `Arc<Mutex<Client>>` 共享同一个实例，锁只包住真正访问 client 的那一段。

### 2. 模块不能两边都声明

`main.rs` 和 `lib.rs` 都写 `mod netease;` 会让同一份代码被编译两次，
变成两个互不相干的类型（`main::netease::Client` ≠ `lib::netease::Client`）。
正确做法是 lib 里 `pub mod`，main 里 `use ripple_desktop::netease`。

### 3. 命令参数口径必须与另两端逐字一致

三端（Java / Node / Rust）各实现一份 20 个命令，任何一端参数漂了就表现为
「APK 能播、桌面端播不了」这类难查的差异。几个容易写错的：

| 命令 | 容易写错 | 正确 |
|---|---|---|
| `song_detail` | `ids` 参数 | `c: '[{"id":1},{"id":2}]'` |
| `like` | `radio/like` | `song/like` + `trackId`/`userid`/`like` |
| `heart_mode` | `id` | `songId` / `type:fromPlayOne` / `startMusicId` |
| `simi_song` | `id` | `songId` |
| `comments` | 静态路径 | `v1/resource/comments/R_SO_4_<纯数字id>` |

`netease.rs` 每个分支都标了对应的 Java / server.js 行号，改一处必须三处同改。

---

## 测试

```bash
cd desktop/src-tauri
cargo test --lib          # weapi 加密的固定向量 + 命令参数口径
cargo fmt --all -- --check
```

### 为什么加密要靠单元测试守

weapi 只要错一个字节，网易云就只回 `{"code":400}`，界面上完全看不出是
AES 填充错了还是 base64 换行不同。所以 `weapi.rs` 带了一组固定向量测试：
同样的输入必须永远得到同样的输出，且长度/字符集必须符合协议要求。

**CI 里没法测「点开能不能用」** —— GUI 交互、登录、播放必须人在真实桌面上点。
所以产物先进 Artifacts 让人验，验过了再考虑发 Release。

---

## 与主项目的关系

| 路径 | 归属 |
|---|---|
| `app/` | 三端共享的前端，**改这里三端同时生效** |
| `desktop/bridge.js` | 桌面端独有的适配层 |
| `desktop/src-tauri/` | 桌面端独有的 Rust 代码 |
| `desktop/dist/` | 构建产物（gitignore，不要手改） |

改前端只改 `app/`，然后重跑 `build-frontend.sh`。
**不要改 `desktop/dist/`** —— 它是复制出来的，下次构建就被覆盖。
