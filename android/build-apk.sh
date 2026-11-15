#!/usr/bin/env bash
# ------------------------------------------------------------------
# Ripple · 不依赖 Gradle 的打包脚本
#
# 只用 Android SDK 自带工具（aapt2 / javac / d8 / zipalign / apksigner）出 APK。
# 适合「没网装 Gradle、只有 SDK」的场景；装了 Gradle 的话用 ./gradlew 也一样。
#
# 用法：
#   ANDROID_HOME=/path/to/android-sdk ./build-apk.sh
# 产物：
#   build-manual/Ripple-<versionName>-debug.apk
#
# 版本号只有一个来源：项目根目录的 version.json。
# 脚本会把 versionCode / versionName 同步写进
#   · Gradle 的 build.gradle（避免 gradle 构建出更低的 versionCode 装不上去）
#   · CrashLog.java / RippleApp.java（日志和崩溃报告里的版本）
#   · app/js/version.js（「关于」弹窗显示的版本）
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

echo "[0/7] 版本 $VN ($VC) → 同步到 Gradle / Java / 网页"
if [ -f "$HERE/app/build.gradle" ]; then
  sed -i "s/versionCode [0-9]\+/versionCode $VC/; s/versionName '[^']*'/versionName '$VN'/" \
    "$HERE/app/build.gradle"
fi
sed -i "s/version: [0-9.]\+ (\" + [0-9]\+ + \")\"/version: $VN (\" + $VC + \")\"/" \
  "$HERE/app/src/main/java/com/ripple/app/CrashLog.java" 2>/dev/null || true
sed -i "s/version=[0-9.]\+([0-9]\+)/version=$VN($VC)/" \
  "$HERE/app/src/main/java/com/ripple/app/RippleApp.java" 2>/dev/null || true
cat > "$APP/js/version.js" <<EOF
/* 由 android/build-apk.sh 从项目根 version.json 自动生成，不要手改 */
(function (g) {
  g.RIPPLE_VERSION = { code: $VC, name: '$VN' };
})(window);
EOF

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
KS="$HERE/debug.keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -dname "CN=Android Debug,O=Android,C=US" \
    -keyalg RSA -keysize 2048 -validity 10000 >/dev/null 2>&1
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey --out "Ripple-$VN-debug.apk" aligned.apk
"$BT/apksigner" verify --print-certs "Ripple-$VN-debug.apk" | head -3

echo
echo "✅ 完成：$OUT/Ripple-$VN-debug.apk  ($(du -h "Ripple-$VN-debug.apk" | cut -f1))"
