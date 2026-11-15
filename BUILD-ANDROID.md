# Ripple · Android 编译说明

> 结论先说：**能编译。** 仓库里的 `dist/Ripple-1.0.0-debug.apk` 已经编译 + 签名完成，可以直接安装。
> 这份文档说明「要装什么、什么版本、跑什么命令」，以及三条可选路径。

## 实测记录（本机验证，非推测）

| 路径 | 环境 | 结果 |
|---|---|---|
| 路径 2（Gradle） | Gradle **8.7** + AGP **8.4.2** + **JDK 20** + SDK 34 / build-tools 34.0.0 | `BUILD SUCCESSFUL in 2m 15s`，34 个 task 全绿，产出 6.05 MB APK |
| 路径 3（SDK 工具链） | 同机，仅 aapt2 / javac / d8 / zipalign / apksigner，**零联网** | 成功，产出 6.04 MB 已签名 APK |

两条路径出来的 APK 都能通过 `apksigner verify`，`aapt2 dump badging` 显示 `package=com.ripple.app`、`sdkVersion 24`、`targetSdk 34`、28 个 `assets/www` 条目齐全。

整个工程是**纯 Java + WebView**，没有一行 Kotlin，没有 NDK，也没有任何第三方依赖（没有 AndroidX、没有 AppCompat）。所以编译链极短，出问题的地方基本只有版本对不上。

---

## 一、版本矩阵（照着装就不会错）

| 组件 | 版本 | 必需 | 说明 |
|---|---|---|---|
| **JDK** | **17**（实测 17 / 20 均可） | ✅ | AGP 8.x 要求 JDK 17 及以上。用 JDK 8/11 会直接报 `Unsupported class file major version` |
| **Gradle** | **8.7**（8.6+ 都可以） | ✅ | 与 AGP 8.4.2 官方配套；7.x 会因为 AGP 8 的 API 变更失败 |
| **Android Gradle Plugin (AGP)** | **8.4.2** | ✅ | 已写在根 `build.gradle` 里，Gradle 会自动下载 |
| **compileSdk** | **34** | ✅ | 即 `platforms;android-34` |
| **targetSdk** | **34** | ✅ | 已写入 manifest |
| **minSdk** | **24**（Android 7.0） | ✅ | 覆盖 98%+ 在用机型 |
| **build-tools** | **34.0.0** | ✅ | aapt2 / d8 / zipalign / apksigner 都在这里 |
| **Android SDK Platform-Tools** | 任意较新版本 | ⭕ | 只有 `adb install` 时需要 |
| **NDK** | — | ❌ | 不需要 |
| **Kotlin 插件** | — | ❌ | 不需要 |

---

## 二、装 SDK（如果机器上还没有）

用命令行工具（`cmdline-tools`）装，比下载整个 Android Studio 轻得多：

```bash
# 1. 下载 commandline-tools（约 130 MB）
#    https://developer.android.com/studio#command-line-tools-only
# 2. 解压到 $ANDROID_HOME/cmdline-tools/latest
export ANDROID_HOME=$HOME/android-sdk
mkdir -p $ANDROID_HOME/cmdline-tools
unzip commandlinetools-linux-*.zip -d $ANDROID_HOME/cmdline-tools
mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest

# 3. 接受许可 + 安装需要的包
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager \
    "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

然后在工程根目录建一个 `local.properties`（**不要提交到 git**）：

```properties
sdk.dir=/home/you/android-sdk
```

> 有 Android Studio 的话这一步可以跳过：直接用 Studio 打开 `android/` 目录，它会自己配 SDK 并下载缺的组件。

---

## 三、三条构建路径

### 路径 1：Android Studio（最省事）

1. `File → Open` 选 `android/` 目录
2. 等 Gradle Sync 完成（首次会下载 AGP 依赖，约 200–300 MB）
3. `Build → Build App Bundle(s) / APK(s) → Build APK(s)`
4. 产物：`android/app/build/outputs/apk/debug/app-debug.apk`

### 路径 2：命令行 Gradle

本仓库**没有附带 gradle-wrapper.jar**（二进制文件不适合塞进源码包）。两种做法：

```bash
cd android

# 做法 A：用系统里已装的 Gradle 生成 wrapper（只需一次）
gradle wrapper --gradle-version 8.7

# 做法 B：直接用系统 Gradle 构建
gradle assembleDebug
```

产物同样在 `app/build/outputs/apk/debug/app-debug.apk`。

装到手机：

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

### 路径 3：不装 Gradle，只用 SDK 工具链（离线可用）

仓库带了 `android/build-apk.sh`，它用 `aapt2 → javac → d8 → zipalign → apksigner` 手工走完整流程，**不需要联网、不需要 Gradle、不需要 AGP**：

```bash
cd android
ANDROID_HOME=/opt/android-sdk ./build-apk.sh
# 产物：build-manual/Ripple-1.0.0-debug.apk
```

它会自动完成三件容易忘的事：

1. 把 `../app/` 整份复制进 `app/src/main/assets/www/`（网页资源必须随包走）
2. 生成一份带 `package="com.ripple.app"` 的临时 manifest（aapt2 需要它，而 AGP 8 又禁止在源码里写）
3. 没有 keystore 时用 `keytool` 生成一个 debug keystore 并签名

脚本默认 `ANDROID_HOME=/opt/android-sdk`，换机器时改环境变量或用参数覆盖即可。

---

## 四、签名

**debug 包**：Gradle 和 `build-apk.sh` 都会自动用 debug keystore 签名，可以直接安装，但**不能上架**，且不同机器签出来的包签名不同（覆盖安装会报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，先卸载即可）。

**release 包**：

```bash
keytool -genkeypair -keystore ripple.jks -alias ripple \
        -keyalg RSA -keysize 2048 -validity 10000

# Gradle 方式：在 app/build.gradle 里配 signingConfigs，
# 或用 apksigner 对已构建的包二次签名：
zipalign -f -p 4 app-release-unsigned.apk app-aligned.apk
apksigner sign --ks ripple.jks --out Ripple-release.apk app-aligned.apk
apksigner verify --print-certs Ripple-release.apk
```

---

## 五、工程结构里两个容易踩的点

**1. `AndroidManifest.xml` 里为什么没有 `package` 属性？**

AGP 8.0 起，包名统一由 `app/build.gradle` 的 `namespace` 声明，manifest 里再写 `package` 会直接报错：

```
Namespace not specified / package="..." found in source AndroidManifest.xml
```

但 `aapt2` 命令行又必须要有 `package` 才能生成资源表。所以 `build-apk.sh` 在构建时用 `sed` 临时补一份副本到 `build-manual/AndroidManifest.xml`，源码保持干净——两条路径都能走。

**2. `assets/www/` 是构建产物，不是源码——但两条路径都会自动同步**

网页的源码在仓库根目录的 `app/`。`android/app/build.gradle` 里注册了 `syncWebAssets` 任务并挂在 `preBuild` 上，所以 `assembleDebug` 会把 `../app` 自动复制进 `assets/www`，改完前端直接构建就是最新的。`build-apk.sh` 也会做同样的事。

包里的 `android/app/src/main/assets/www` 是空的/被排除的，第一次构建时生成，属正常现象。

---

## 六、常见报错对照

| 报错 | 原因 | 解决 |
|---|---|---|
| `SDK location not found` | 缺 `local.properties` 或没设 `ANDROID_HOME` | 建 `local.properties` 写 `sdk.dir=...` |
| `Unsupported class file major version 61` | JDK 版本太低（<17） | 换 JDK 17 |
| `Failed to apply plugin 'com.android.application'` + `requires Gradle 8.x` | Gradle 太老 | 用 Gradle 8.7 |
| `Namespace not specified` | `app/build.gradle` 缺 `namespace` | 已配好；若自己改过记得保留 |
| `INSTALL_FAILED_UPDATE_INCOMPATIBLE` | 手机上是别的签名版本 | `adb uninstall com.ripple.app` 再装 |
| 装完打开白屏 | `assets/www/` 没同步 | 重跑 `build-apk.sh` 或手动 `cp` |
| 在线搜索转圈后失败 | 手机没网 / 接口风控 | 设置里「测试连接」看返回码 |
| 通知不弹 | Android 13+ 未授权通知 | 首次启动会申请；也可到系统设置里手动开 |

---

## 七、APK 里到底装了什么

```
AndroidManifest.xml      INTERNET / POST_NOTIFICATIONS / 前台服务声明
classes.dex              8 个类，约 64 KB（见下表）
assets/www/              整个 PWA（index.html / css / js / 图标，已不含示例音频）
res/mipmap-*/            启动图标（48/72/96/144/192）
```

**Java 侧 8 个类**

| 类 | 职责 |
|---|---|
| `MainActivity` | WebView 配置与生命周期、edge-to-edge + insets 注入、内嵌登录页、返回键 |
| `HttpBridge` | `@JavascriptInterface` 桥：`netease()`、日志、系统栏、登录、通知、`setPlaying()`、`safeMode()` |
| `NeteaseClient` | weapi 命令表（搜索 / 歌曲 / 播放地址 / 歌词 / 歌单 / 榜单 / 喜欢 / 心动 / 漫游 / 评论 / 登录），cookie 持久化 |
| `Weapi` | AES-128-CBC 双层加密 + textbook RSA，自实现 Base64（API 24 可用） |
| `LogBridge` | 200KB 环形缓冲日志，写 `files/ripple-log.txt` 与 `Download/Ripple-log.txt` |
| `CrashLog` | 崩溃与启动轨迹，写 `Ripple-crash-*.txt` / `Ripple-trace.txt` |
| `RippleApp` | Application：装崩溃日志、读 ApplicationExitInfo、连续异常进 safeMode |
| `StrictModes` | safeMode 标志位（关掉 edge-to-edge 与 cookie 初始化） |

- `MainActivity` 负责 WebView 配置：`setMediaPlaybackRequiresUserGesture(false)`（允许脚本起播）、`MIXED_CONTENT_ALWAYS_ALLOW`、不裁剪到刘海、返回键先收播放页。
- `HttpBridge` 的主要入口：`netease(cmd, params, cbId)` 走原生 weapi（绕开 CORS）、`notify(title, body, quiet)` 发通知（`quiet=false` 时走有提示音的通道）、`setPlaying(bool)` 让原生决定切后台是否停计时器、`safeMode()` 供页面提示降级状态。
- 网页侧通过 `window.RippleNative` 是否存在自动切换通道，同一个 `app/` 目录既能当 PWA 也能当 APK 内核。
- 版本号只有一个来源：项目根 `version.json`。`build-apk.sh` 会把它同步写进 `build.gradle`、`CrashLog.java`、`RippleApp.java` 和 `app/js/version.js`，所以 Gradle 与手工脚本产出的 versionCode 不会再打架。
