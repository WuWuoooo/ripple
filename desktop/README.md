# Ripple 桌面端（Tauri）

**简体中文** | [English](./README_en.md)

Ripple 的桌面客户端。**复用 `app/` 那 8200 行前端，一行不改**，
只补一个 Rust 侧的原生桥和网易云客户端。

> **当前状态：已随 1.3.0 正式发布**
>
> 桌面端产物（`.deb` / `.AppImage` / `.tar.gz` / `-setup.exe` / `.zip`）
> 与 Android APK **一起发布在同一个公开 Release** 里；CI 另传 Artifacts 便于排查。
> 代码已并入 `main`。

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
desktop/bridge.js          ← 这 377 行就是全部适配成本
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
| `RippleNative.canDrawOverlay()` | 悬浮窗权限 | ✅ 恒 true（建置顶窗无需授权） |
| `RippleNative.showLyricOverlay(...)` | 状态栏悬浮窗 | ✅ 独立置顶小窗（见下） |
| `RippleNative.updateLyricOverlay` | 换一句词 | ✅ |
| `RippleNative.setLyricProgress` | 句内进度 0..1 | ✅ |
| `RippleNative.hideLyricOverlay` | 隐藏浮层 | ✅ |
| `RippleNative.login(mode,id)` | 内嵌登录页 | 不需要（登录走扫码，见下） |

前端所有原生调用点都写成 `if (window.RippleNative && typeof N.xxx === 'function')`，
所以某个方法不给时会自动降级 —— 这也是桌面端能只实现最重要的 `netease` 一条、
其余留空的前提。

---

## 功能对照：桌面端有什么、没有什么

### ✅ 完整可用

播放引擎（三个 `<audio>` 架构）、均衡器（WebAudio）、歌词（含翻译）、
**卡拉OK逐句染色**、**独立置顶歌词小窗**、歌单、每日推荐、心动模式、无限漫游、
评论、搜索、本地导入、液态玻璃观感、深色浅色双主题、封面取色、多尺寸响应式布局

### ⚠️ 形态不同

| 功能 | Android | 桌面端 |
|---|---|---|
| 媒体控制 | 通知栏 + MediaSession + 耳机键 | 无（待做系统托盘 / SMTC / MPRIS） |
| 歌词浮层 | 盖在系统状态栏上的悬浮窗 | **独立无边框置顶小窗**（1.3.3 起） |
| edge-to-edge | 状态栏透明 | 无此概念 |

### 歌词浮层：桌面端是怎么做的

Android 没有公开的「往状态栏里写东西」接口，所谓状态栏歌词都是用系统级
悬浮窗盖在状态栏区域上，所以要「显示在其他应用上层」权限。桌面端没有
系统状态栏这个概念，因此换成一个**独立的无边框置顶小窗口**
（`desktop/lyric.html` + `main.rs` 里的 `lyric_overlay_*` 系列命令）：

| 行为 | Android | 桌面端 |
|---|---|---|
| 载体 | `TYPE_APPLICATION_OVERLAY` 浮层 | 独立 `WebviewWindow`（懒创建） |
| 置顶 | 系统级悬浮窗天然在最上 | `always_on_top` + `skip_taskbar` |
| 锁定 | `FLAG_NOT_TOUCHABLE`（点击穿透） | `set_ignore_cursor_events(true)` |
| 未锁定 | 可拖动，点一下回调网页弹面板 | `data-tauri-drag-region` 拖动 |
| 位置持久化 | `settings.sbX / sbY` | 配置目录下 `lyric-pos.json` |
| 进度 | `setProgress(0..1)` | 同一个 0..1，**语义是「当前这一句」** |

六个桥方法与 Java 侧**同名同签名**，所以 `app/` 前端一行都不用改 ——
它仍然以为自己在跟 Android 说话。

> **已知限制**：Linux 下透明窗口依赖桌面合成器。没有合成器时会退化成
> 不透明背景（文字仍可读），窗口创建失败时 `showLyricOverlay` 返回 `false`，
> 前端会保持开关打开并在下次启动再试 —— 而不是把开关强制关掉
> （那样用户会以为功能消失了）。

### ❌ 未实现

目前没有「本该有但没做」的功能项。

> **扫码登录已可用**（1.3.0 起）：`chooseLoginMode` 三端统一走扫码，
> 底层 `login_qr_key` / `login_qr_check` 在 Rust 侧已实现，直接点界面上的
> 「登录网易云」就能扫码。此处不再需要手写 cookie。

**备用登录方式**（扫码不可用时）：把网易云的 `MUSIC_U` cookie 写进配置目录的
`netease-cookie`：

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

三端（Java / Node / Rust）各实现 22 条命令（前端实际调用 20 个），任何一端参数漂了就表现为
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
产物会随 Release 一起发布，同时上传 Artifacts 方便 CI 内排查。

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

---

## CI 踩坑记录（改 workflow 前必读）

这一轮把三平台 CI 真正跑通，踩了五个坑，每个都表现为「完全没有错误信息」：

### 1. job 级 `if` 里不能用 `matrix`

```yaml
# ✗ 整个 workflow 解析失败
if: matrix.os != 'macos-latest'
```

报 `Unrecognized named-value: 'matrix'`。`matrix` 只在 strategy 展开**之后**的
step 级才有。而且这个失败发生在解析阶段：**run 会被创建、却一个 job 都不跑**，
日志接口直接 404，从 Actions 页面完全看不出原因。

正确做法：用 `matrix.exclude` 剔掉不想要的那一项。

### 2. `if: |` 多行字面量非法

`if` 只接受**单行**表达式。写成 `if: |` 换行写条件，同样是整个 workflow 判无效。

### 3. 改对 workflow 后，GitHub 不会重新解析

这个最坑：文件内容改对了，`runs` 列表里那个 workflow 的 `name` 仍然显示成
文件路径（而不是 `name:` 字段的值），所有 run 依旧 0 job。
**必须改文件名**（如 `desktop.yml` → `desktop-build.yml`）才触发重扫。

### 4. Windows 的 Python 默认用 cp1252 输出

`build-frontend.sh` 里的内联 Python 只要 print 中文就抛：

```
UnicodeEncodeError: 'charmap' codec can't encode characters
```

Linux 上永远复现不了。解法是脚本里给 `sys.stdout.reconfigure(encoding='utf-8')`。

### 5. Tauri 2 的 `AppHandle` 没有 `eval`

```
error[E0599]: no method named `eval` found for struct `AppHandle<R>`
```

Tauri 1 的 `AppHandle::eval` 在 Tauri 2 里挪到了 `WebviewWindow` 上：

```rust
if let Some(win) = app.get_webview_window("main") {
    let _ = win.eval(&js);
}
```

---

## 排查手段：用 `workflow_dispatch` 当校验器

GitHub 没有「校验 workflow 语法」的 API，但**手动触发**就是最好的校验器 ——
它会在解析阶段返回具体错误：

```bash
curl -X POST -H "Authorization: token $GH_TOKEN" \
  "https://api.github.com/repos/OWNER/REPO/actions/workflows/desktop-build.yml/dispatches" \
  -d '{"ref":"feat/desktop-tauri"}'
```

- `HTTP 204` → workflow 合法
- `HTTP 422` + `failed to parse workflow: (Line: N, Col: M): ...` → 精确到行列的错误

比反复 push 试错快得多。

---

## 产物格式

| 平台 | 格式 | 说明 |
|---|---|---|
| Linux | `.deb` | Debian / Ubuntu 系，`sudo dpkg -i` 安装 |
| Linux | `.tar.gz` | **最通用**：解压即用，不挑发行版，也不需要包管理器 |
| Linux | `.AppImage` | 单文件，chmod +x 直接跑 |
| Windows | `.zip` | 内含 `Ripple.exe`，解压即用 |
| Windows | `.exe` (NSIS) | 安装向导 |

`tar.gz` / `zip` 不是 Tauri 原生格式，由 CI 在打包后额外生成：
里面只有可执行文件 + 一份说明，**不带任何运行时**（WebView 用系统自带的）。
这样做的理由是「解压即用」比「先装包管理器依赖」低得多。

### 为什么没有 macOS

CI 能编译，但**没人能测** —— 未签名包会被 Gatekeeper 直接拦掉
（「已损坏，无法打开」），要真正能双击需要 Apple Developer（$99/年）+ 公证流程。
一个「能编出来但打不开、也没人验证过」的产物，不如不发布。

等有条件验证时再加回来：`matrix.include` 里补一行 `macos-latest` 即可。

## 当前 CI 状态（已验证可用）

| 关卡 | 内容 | 结果 |
|---|---|---|
| Rust 单测 | Linux + Windows 矩阵，weapi 固定向量 | ✅ |
| 前端组装 | bridge.js 注入位置、sw.js 排除、语法检查 | ✅ |
| 打包 | Linux-x64（deb/appimage/tar.gz）+ Windows-x64（nsis/zip） | ✅ |

---

## 本机实测记录（ARM64 Linux）

CI 只证明「能编译」，这里记录一次**真跑起来**的验证。

### 环境

Android 手机上的 Ubuntu 24.04 proot，`aarch64`，Xvfb + VNC。

### 两个必踩的坑

**1. `/sdcard` 是 noexec，编译必然失败**

```
could not execute process `.../build_script_build` (never executed)
Caused by: Permission denied (os error 13)
```

Android 的 `/sdcard` 是 bind 挂载且带 `noexec` —— cargo 编译过程中要执行
自己刚生成的 build script，直接报权限拒绝。

**结论：在任何 Android 手机上做 Rust/编译类项目，构建目录都不能放在 `/sdcard`。**
挪到 `/root`（或其他支持 exec 的位置）就好。

**2. 就算在 `/root`，cargo 生成的 build script 也是 0600**

proot 环境下 cargo 落盘的可执行文件没有执行位（`-rw-------`），
报同样的 `Permission denied`。`chmod +x` 手工试过是有效的，所以编译时
需要并行跑一个补权限的循环：

```bash
( cargo build --release ) &
for i in $(seq 1 60); do
  sleep 3
  find target -type f -name 'build_script_*' ! -perm -u+x -exec chmod +x {} \;
done
```

一共编了 **9 分 44 秒**（ARM + 手机，比 x86 慢得多），产物 4.9 MB。

### 结果

```
✅ 进程启动       pid 6190
✅ 窗口创建       1180×743
✅ 界面完整渲染   左侧栏 / hero / 每日推荐 / 迷你播放器 / 账号卡
✅ 交互可用       点击能触发界面变化（截图字节数变化）
```

**渲染差异（重点）**：WebKitGTK 上 `backdrop-filter` 的模糊强度明显弱于
Chromium，玻璃质感偏「薄」。功能和布局都正确，但观感与 Android/Chromium
不完全一致 —— 这与事先对 WebKit 系的判断相符。

如果在意这个差异，后续可以给 `html[data-webkit]` 加一档更重的
`--glass-blur` 补偿（不改结构，只调令牌）。
