#!/usr/bin/env bash
# ------------------------------------------------------------------
# Ripple · 不依赖 Gradle 的打包脚本
#
# 只用 Android SDK 自带工具（aapt2 / javac / d8 / zipalign / apksigner）出 APK。
# 适合「没网装 Gradle、只有 SDK」的场景；装了 Gradle 的话用 ./gradlew 也一样。
#
# 用法：
#   ANDROID_HOME=/path/to/android-sdk ./build-apk.sh
#   SKIP_VERSION_SYNC=1 ./build-apk.sh    # 不同步版本号，受控文件保持不动
# 产物：
#   build-manual/Ripple-<versionName>-debug.apk
#
# 版本号只有一个来源：项目根目录的 version.json。
# 脚本会把 versionCode / versionName 同步写进
#   · Gradle 的 build.gradle（避免 gradle 构建出更低的 versionCode 装不上去）
#   · CrashLog.java / RippleApp.java（日志和崩溃报告里的版本）
#   · app/js/version.js（「关于」弹窗显示的版本）
# 同步只在内容真的不同时才写回，避免每次构建都把 git status 弄脏。
# ------------------------------------------------------------------
set -euo pipefail

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/android-sdk}}"
# aapt2 在 aarch64 上必须用 34.0.0（本机已换成 qemu-x86_64 包装器）；
# d8 相反：34.0.0 的 R8 8.2.2 在 JDK21 + aarch64 会 NPE，用新版 36.0.0 的 jar。
BT="${AAPT2_BT:-$SDK/build-tools/34.0.0}"
D8BT="${D8_BT:-$SDK/build-tools/36.0.0}"
[ -x "$D8BT/d8" ] || D8BT="$BT"
JAR="$SDK/platforms/android-34/android.jar"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
OUT="$HERE/build-manual"
APP="$HERE/../app"

[ -x "$BT/aapt2" ] || { echo "找不到 $BT/aapt2，请先安装 build-tools;34.0.0"; exit 1; }
[ -f "$JAR" ] || { echo "找不到 $JAR，请先安装 platforms;android-34"; exit 1; }

# ---------- 版本号：读 version.json，同步到所有副本 ----------
VER_FILE="$ROOT/version.json"
if [ -f "$VER_FILE" ]; then
  VC="$(sed -n 's/.*"versionCode"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$VER_FILE" | head -1)"
  VN="$(sed -n 's/.*"versionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VER_FILE" | head -1)"
fi
VC="${VC:-14}"; VN="${VN:-1.3.5}"

# 只在内容真的变化时才写回：这些文件都在版本控制里，
# 无脑 sed -i / cat > 会让每次本地构建后 git status 都变脏（即使版本号没动）。
echo "[0/7] 版本 $VN ($VC) → 同步到 Gradle / Java / 网页"
if [ "${SKIP_VERSION_SYNC:-0}" = "1" ]; then
  echo "      SKIP_VERSION_SYNC=1 —— 跳过版本号同步，保持受控文件不动"
else
  # sync_text <文件> <新内容>  内容相同则不写
  sync_file() {
    _f="$1"; _new="$2"
    [ -f "$_f" ] || return 0
    if [ "$(cat "$_f")" = "$_new" ]; then
      echo "      $(basename "$_f"): 已是最新，未改动"
    else
      printf '%s\n' "$_new" > "$_f"
      echo "      $(basename "$_f"): 已同步"
    fi
  }

  if [ -f "$HERE/app/build.gradle" ]; then
    _old="$(cat "$HERE/app/build.gradle")"
    _new="$(printf '%s\n' "$_old" \
      | sed "s/versionCode [0-9]\+/versionCode $VC/; s/versionName '[^']*'/versionName '$VN'/")"
    if [ "$_old" = "$_new" ]; then
      echo "      build.gradle: 已是最新，未改动"
    else
      printf '%s\n' "$_new" > "$HERE/app/build.gradle"
      echo "      build.gradle: 已同步"
    fi
  fi

  _java_ver="$HERE/app/src/main/java/com/ripple/app/CrashLog.java"
  if [ -f "$_java_ver" ]; then
    _old="$(cat "$_java_ver")"
    _new="$(printf '%s\n' "$_old" \
      | sed "s/version: [0-9.]\+ (\" + [0-9]\+ + \")\"/version: $VN (\" + $VC + \")\"/")"
    if [ "$_old" = "$_new" ]; then
      echo "      CrashLog.java: 已是最新，未改动"
    else
      printf '%s\n' "$_new" > "$_java_ver"
      echo "      CrashLog.java: 已同步"
    fi
  fi

  _app_ver="$HERE/app/src/main/java/com/ripple/app/RippleApp.java"
  if [ -f "$_app_ver" ]; then
    _old="$(cat "$_app_ver")"
    _new="$(printf '%s\n' "$_old" | sed "s/version=[0-9.]\+([0-9]\+)/version=$VN($VC)/")"
    if [ "$_old" = "$_new" ]; then
      echo "      RippleApp.java: 已是最新，未改动"
    else
      printf '%s\n' "$_new" > "$_app_ver"
      echo "      RippleApp.java: 已同步"
    fi
  fi

  sync_file "$APP/js/version.js" "/* 由 android/build-apk.sh 从项目根 version.json 自动生成，不要手改 */
(function (g) {
  g.RIPPLE_VERSION = { code: $VC, name: '$VN' };
})(window);"

  # B-2：Service Worker 的缓存名必须跟着 versionCode 走。
  # 以前它是手写的 'ripple-v20'，构建脚本从不改它 —— 而 activate 只删
  # 「名字不等于 CACHE」的旧缓存，于是每次发版旧壳永久留存，
  # 离线/网络抖动时回落到上一版的 index.html + 旧 js，
  # 整个应用静默冻在旧版本（新版 app.js 调旧版 player.js 里不存在的 API 直接 boot 中断）。
  sync_file "$APP/sw.js" "$(sed "s|^const CACHE = .*|const CACHE = 'ripple-$VC';|" "$APP/sw.js")"
fi

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/gen" "$HERE/app/src/main/assets"

echo "[1/7] 同步网页资源 → assets/www"
rm -rf "$HERE/app/src/main/assets/www"
cp -r "$APP" "$HERE/app/src/main/assets/www"

echo "[2/7] aapt2 compile"
"$BT/aapt2" compile --dir "$HERE/app/src/main/res" -o "$OUT/res.zip"

# AGP 8 禁止在源码 manifest 里写 package，但 aapt2 又需要它 → 构建副本
echo "[3/7] aapt2 link"
sed 's|<manifest xmlns:android="http://schemas.android.com/apk/res/android">|<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.ripple.app">|' \
  "$HERE/app/src/main/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" \
  --manifest "$OUT/AndroidManifest.xml" -A "$HERE/app/src/main/assets" \
  --java "$OUT/gen" --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VC" --version-name "$VN" "$OUT/res.zip"

echo "[4/7] javac"
javac -encoding UTF-8 -nowarn -source 17 -target 17 -classpath "$JAR" -d "$OUT/classes" \
  $(find "$HERE/app/src/main/java" "$OUT/gen" -name '*.java')

echo "[5/7] d8"
"$D8BT/d8" --lib "$JAR" --min-api 24 --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "[6/7] 合并 dex + zipalign"
cd "$OUT"
cp base.apk unaligned.apk
(cd dex && zip -q ../unaligned.apk classes.dex)
"$BT/zipalign" -f -p 4 unaligned.apk aligned.apk

echo "[7/7] 签名"
# 关键：keystore 必须放在 $OUT 之外并长期保留。
# 以前放在 build-manual/ 里，每次构建 rm -rf 后重新生成 → 每次签名都变 →
# 覆盖安装会 INSTALL_FAILED_UPDATE_INCOMPATIBLE（装不上/装了个旧的）。
#
# 所以 debug.keystore 是**入库文件**（它只是公开密码 android 的调试证书，
# 不是秘密），这里不再「缺了就生成」：缺了直接报错退出，
# 免得悄悄产出一把新密钥、签出一个跟上一版无法覆盖升级的包。
KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  {
    echo "❌ 找不到 $KS"
    echo "   这个文件必须随仓库提供（CI 每次全新 checkout 也要有）。"
    echo "   缺了就会生成新密钥，签名每版不同，用户升级时报 INSTALL_FAILED_UPDATE_INCOMPATIBLE。"
    echo "   请从仓库恢复：git checkout -- android/debug.keystore"
    echo "   （确实需要全新的调试证书时，删掉旧文件后手工 keytool -genkeypair 一次并提交。）"
  } >&2
  exit 1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey --out "Ripple-$VN-debug.apk" aligned.apk
"$BT/apksigner" verify --print-certs "Ripple-$VN-debug.apk" | head -3

echo
echo "✅ 完成：$OUT/Ripple-$VN-debug.apk  ($(du -h "Ripple-$VN-debug.apk" | cut -f1))"
