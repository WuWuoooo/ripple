# 参与 Ripple 的开发

**简体中文** | [English](./docs/en/CONTRIBUTING_en.md)

感谢你愿意花时间。Ripple 是一个刻意保持「小而完整」的项目：构建流程不依赖 Gradle、没有 AndroidX、没有前端构建链。读完这一页你就能跑起来。

> **关于 Gradle**：`build-apk.sh` 只用 `aapt2 / javac / d8 / zipalign / apksigner`，
> 官方构建入口是它。仓库里保留了 `android/build.gradle`、`android/settings.gradle`、
> `android/gradle.properties`、`android/app/build.gradle`（AGP 8.4.2），那只是可选配置，
> 不是官方构建入口 —— 它主要给 IDE 补全用，也让想用 Gradle 的人有个起点。
> 请不要依赖它出包，也不要为了它引入依赖树。
>
> ⚠️ **仓库里没有 Gradle wrapper**（没有 `gradlew`、没有 `gradle/wrapper/`），
> 所以在克隆下来的仓库里直接跑 `./gradlew assembleDebug` 是**跑不了的**。
> 本机要装 Gradle 8.x + AGP 8.4.2 之后用 `gradle assembleDebug`；这只是可选的旁路，
> 官方出包始终是 `bash android/build-apk.sh`。

## 这个项目刻意不使用的东西

在提 PR 之前请先确认你的改动没有引入下面这些，这是项目能保持「一个 `node server.js` 就能跑」的前提：

| 不引入 | 原因 |
|---|---|
| Kotlin | 只依赖 JDK + Android SDK，`javac` 直出 |
| AndroidX / AppCompat | 避免 Gradle 依赖树，`build-apk.sh` 只用 `aapt2 / javac / d8` |
| npm 依赖 | `server.js` 只用 Node 内置模块 |
| 前端构建工具 | `app/` 目录就是最终产物，改完刷新即生效 |
| 第三方 UI 框架 | 手写 CSS，只有一套「液态玻璃」观感 |

## 环境准备

### 1. 跑网页版（最快）

```bash
node server.js          # 默认 8080
```

打开 `http://localhost:8080`。改 `app/` 下任何文件，刷新浏览器即可。

### 2. 打包 APK

需要：JDK 17+、Android SDK（`build-tools` + `platforms/android-34`）。

```bash
export ANDROID_HOME=/path/to/android-sdk
export JAVA_HOME=/path/to/jdk
bash android/build-apk.sh
```

产物在 `android/build-manual/Ripple-<版本>-debug.apk`。

> **版本号只有一个来源**：根目录 `version.json`。
> 脚本会自动把它同步到 `build.gradle`、`CrashLog.java`、`RippleApp.java`、
> `app/js/version.js` 和 `app/sw.js` 的 `CACHE`。
> 不要手改这些地方，改了下次构建会被覆盖。

### 版本同步清单（全部由 `android/sync-version.sh` 自动写，**不要手改**）

`build-apk.sh` 开头会调用 `android/sync-version.sh`；Gradle 路径（`gradle assembleDebug`，
注意本仓库不带 wrapper）也调同一个脚本，所以两条构建路径的版本号不会分叉。

| 文件 | 被写的内容 | 来源 |
|---|---|---|
| `android/app/build.gradle` | `versionCode $VC` / `versionName '$VN'` | `version.json` |
| `android/app/src/main/java/com/ripple/app/CrashLog.java` | 崩溃日志头部记的版本号 | `version.json` |
| `android/app/src/main/java/com/ripple/app/RippleApp.java` | 启动日志里的 `version=$VN($VC)` | `version.json` |
| `app/js/version.js` | `{ code: $VC, name: '$VN' }`（「关于」弹窗显示） | `version.json` |
| `app/sw.js` | 第一行 `const CACHE = 'ripple-$VC';`（注意**没有 v 前缀**） | `version.json` 的 `versionCode` |

这些替换都带断言：锚点找不到或替换后对不上就直接报错退出，不会静默产出一个
版本号不一致的包。CI 也会再校验一遍，不一致直接失败。

### 改了前端之后...

**不要手改 `app/sw.js` 的 `CACHE`。** 它的缓存名由 `build-apk.sh` 按 `versionCode`
自动同步（`CACHE = 'ripple-<versionCode>'`）。发版要做的只有一件事：改 `version.json`
里的 `versionCode` 然后跑一次 `bash android/build-apk.sh`。

不提升 `versionCode` 就发版，已经装过的用户会继续跑旧代码 —— 这是本项目最常见的
「我改了怎么没生效」。而手改 `CACHE` 会跟脚本写回的值打架，下次构建就被覆盖。

### aarch64 / ARM 机器上的两个坑

1. **`aapt2`**：`build-tools/35.0.0+` 是 x86_64 ELF，ARM 上跑不了。用 `34.0.0`（可自行换成 `qemu-x86_64` 包装器），脚本已默认指向它。
2. **`d8`**：`34.0.0` 里的 R8 8.2.2 在 JDK 21 + aarch64 上会抛 `NullPointerException`。用 `build-tools/36.0.0` 的 `d8`，脚本已默认这样做。

## 代码结构

```
app/                    ← 网页版，也是 APK 里的 assets/www
├── index.html
├── css/base.css        ← 设计令牌、主题、播放页
├── css/layouts.css     ← 页面骨架
├── css/components.css  ← 组件
├── js/version.js       ← 构建时生成，勿手改
├── js/log.js           ← 日志（含 native 转发）
├── js/lrc.js           ← LRC 解析与双语合并
├── js/netease.js       ← 网易云客户端（native / proxy 双通道）
├── js/store.js         ← 状态、本地库、IndexedDB
├── js/player.js        ← 播放引擎（双 audio 元素 + WebAudio）
├── js/app.js           ← 界面与业务
└── sw.js               ← Service Worker

android/                ← Java 外壳
├── app/src/main/java/com/ripple/app/
│   ├── MainActivity.java     WebView、insets、登录页
│   ├── HttpBridge.java       JS 桥
│   ├── NeteaseClient.java    weapi 命令表
│   ├── Weapi.java            加密
│   ├── PlaybackService.java  媒体通知（前台服务 + MediaSession）
│   ├── LyricOverlay.java     状态栏歌词悬浮窗
│   ├── LogBridge.java        日志
│   ├── CrashLog.java         崩溃取证
│   ├── PublicFile.java       往「下载」目录写日志（MediaStore）
│   ├── RippleApp.java        Application
│   └── StrictModes.java      safeMode
└── build-apk.sh              官方构建入口（另见 sync-version.sh）

server.js               ← 浏览器模式的本地服务（静态 + /ncm 代理）
version.json            ← 版本号唯一来源
```

## 提交前自查

```bash
# 1. 语法
for f in app/js/*.js app/sw.js server.js; do node --check "$f" || echo "FAIL $f"; done

# 2. 单元测试（Node 内置 test runner，不需要 npm install）
bash tests/run.sh

# 3. 别把登录态/令牌带上
git status --short        # 不应该出现 .ripple-cookie / .ripple-token

# 4. 改了前端？改 version.json 的 versionCode 再跑一次构建，
#    sw.js 的 CACHE 会被自动同步，不要手改
```

改了前端之后如果不提升 `versionCode`，已经装过的用户会继续跑旧代码——这是本项目最常见的「我改了怎么没生效」。

## 代码约定

- **注释写「为什么」，不写「做了什么」**。这个项目里很多代码是为了绕开特定坑，那段坑比代码本身重要。
- **系统调用一律包 `try/catch`**。部分定制 ROM 会抛意料之外的异常，App 不该因为一个状态栏设置而闪退。
- **不要静默失败**。取不到的参数就退回兜底值，并在界面上说明原因（例如「均衡器对在线流不生效」），别让用户以为开关坏了。
- **中文注释**，界面文案也用中文。

## 关于网易云接口

- 走的是公开的 weapi 协议（`music.163.com/weapi/*`），与第三方客户端一致。
- 登录态存在 `.ripple-cookie`（服务端会尝试 `chmod 0600`，但在 `/sdcard` 这类 fuseblk
  挂载上不生效、实测为 `660`；已在 `.gitignore` 里），**永远不要提交**。
- 项目**不提供任何音乐资源，不绕过会员与版权限制**。涉及这方面的改动不会被合并。

## 提 Issue

请带上：

1. 版本号（「我的 → 关于」里有）
2. 手机型号 + Android 版本
3. 日志：`Download/Ripple-log.txt`（或 App 内「我的 → 查看日志」）
4. 复现步骤

崩溃的话还有 `Download/Ripple-crash-*.txt`。

## 提 PR

- 一个 PR 做一件事，标题说清「修了什么」而不是「改了哪个文件」。
- 涉及界面改动的，请附截图或录屏。
- 提交信息用中文或英文都行，但请说明**为什么**要改。
