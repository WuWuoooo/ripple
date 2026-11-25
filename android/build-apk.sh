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
# 版本解析 + 同步逻辑整段抽到了 android/sync-version.sh：
#   · Gradle 路径（./gradlew assembleDebug）现在也调同一个脚本，不再有两份实现
#   · 解析失败直接退出，不再静默回退到写死的旧版本号（R-27）
# 这里仍然自己读一遍，因为本次构建要用 VC/VN 去 aapt2 传参。
VER_FILE="$ROOT/version.json"
if [ ! -f "$VER_FILE" ]; then
  echo "❌ 找不到 $VER_FILE（版本号的唯一来源）" >&2
  exit 1
fi
VC="$(sed -n 's/.*"versionCode"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$VER_FILE" | head -1)"
VN="$(sed -n 's/.*"versionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VER_FILE" | head -1)"
if ! printf '%s' "$VC" | grep -qE '^[0-9]+$'; then
  echo "❌ version.json 里的 versionCode 解析失败（得到：'${VC:-空}'）" >&2
  exit 1
fi
if ! printf '%s' "$VN" | grep -qE '^[0-9]+(\.[0-9]+)*$'; then
  echo "❌ version.json 里的 versionName 解析失败（得到：'${VN:-空}'）" >&2
  exit 1
fi

echo "[0/7] 版本 $VN ($VC) → 同步到 Gradle / Java / 网页"
bash "$HERE/sync-version.sh"

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex" "$OUT/gen" "$HERE/app/src/main/assets"

echo "[1/7] 同步网页资源 → assets/www"
rm -rf "$HERE/app/src/main/assets/www"
cp -r "$APP" "$HERE/app/src/main/assets/www"

echo "[2/7] aapt2 compile"
"$BT/aapt2" compile --dir "$HERE/app/src/main/res" -o "$OUT/res.zip"

# AGP 8 禁止在源码 manifest 里写 package（改用 namespace），而 aapt2 又必须要有它。
# R-28：以前是一条「整行完全匹配」的 sed ——
#   sed 's|<manifest xmlns:android="...">|<manifest ... package="...">|'
# 只要 <manifest> 写法的属性顺序、换行、多一个属性变了，sed 就静默不命中，
# 于是打出一个没有 package 的包（直到最后签名都没人发现）。
# 现在改成「结构化插入 + 断言」：
#   · 在 **第一个 <manifest** 后面插属性（不依赖整行写法）
#   · 插完 grep 确认真的存在，不存在就立即失败
#   · link 完再用 aapt2 dump packagename 复核产物
echo "[3/7] aapt2 link"
PKG="com.ripple.app"
SRC_MANIFEST="$HERE/app/src/main/AndroidManifest.xml"
if grep -q 'package="'"$PKG"'"' "$SRC_MANIFEST"; then
  cp "$SRC_MANIFEST" "$OUT/AndroidManifest.xml"
else
  sed '0,/<manifest /s//<manifest package="'"$PKG"'" /' \
    "$SRC_MANIFEST" > "$OUT/AndroidManifest.xml"
fi
if ! grep -q 'package="'"$PKG"'"' "$OUT/AndroidManifest.xml"; then
  echo "❌ 向 AndroidManifest.xml 注入 package 失败（可能是根标签不再是 <manifest ...>）" >&2
  exit 1
fi
"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" \
  --manifest "$OUT/AndroidManifest.xml" -A "$HERE/app/src/main/assets" \
  --java "$OUT/gen" --min-sdk-version 24 --target-sdk-version 34 \
  --version-code "$VC" --version-name "$VN" "$OUT/res.zip"

# 复核产物：base.apk 里的 package 必须真的是我们的
if ! "$BT/aapt2" dump packagename "$OUT/base.apk" 2>/dev/null | grep -q "$PKG"; then
  echo "❌ aapt2 link 之后 base.apk 的 package 不是 $PKG" >&2
  exit 1
fi

echo "[4/7] javac"
# L-8：用 mapfile 读成数组再展开，不用裸露的 $(find ...)。
#
# 裸命令替换会做 word splitting + glob 展开，路径里只要有空格（Windows 上
# "C:\\Program Files\\..." 很常见）就会被拆成多个参数，编译报一堆
# "file not found"。当前仓库路径没空格所以不触发，但这是一枚埋着的雷 ——
# 而踩到它的人会在完全无关的报错里迷路。
# -print0 + read -d '' 是 bash 里唯一对任意文件名都安全的写法。
mapfile -d '' JAVA_SRCS < <(find "$HERE/app/src/main/java" "$OUT/gen" -name '*.java' -print0)
javac -encoding UTF-8 -nowarn -source 17 -target 17 -classpath "$JAR" -d "$OUT/classes" \
  "${JAVA_SRCS[@]}"

echo "[5/7] d8"
mapfile -d '' CLASS_FILES < <(find "$OUT/classes" -name '*.class' -print0)
"$D8BT/d8" --lib "$JAR" --min-api 24 --output "$OUT/dex" \
  "${CLASS_FILES[@]}"

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

# ---------- M-3：校验产物里的版本号 == version.json ----------
#
# 为什么必须查：aapt2 link 是拿 --version-code/--version-name 传进去的，
# 正常情况下当然一致。但这里以前**从不回读产物**，于是任何一处参数传错、
# 或者将来加了混淆/多 ABI 分包之类的改动，产物版本号错了 CI 也全绿。
# 用户装上去的后果是 INSTALL_FAILED_UPDATE_INCOMPATIBLE（versionCode 变低）
# 或者「装了但没更新」——两种都极难从现象倒推。
#
# 这是「断言与写入共用同一判据」的又一处：链接参数是我们传的，
# 所以必须从**产物**里读回来比，而不是相信我们传对了。
BADGING="$("$BT/aapt2" dump badging "Ripple-$VN-debug.apk" 2>/dev/null | head -1)"
if ! printf '%s' "$BADGING" | grep -q "versionCode='$VC'"; then
  echo "❌ 产物 versionCode 不是 $VC（实际：$BADGING）" >&2
  exit 1
fi
if ! printf '%s' "$BADGING" | grep -q "versionName='$VN'"; then
  echo "❌ 产物 versionName 不是 $VN（实际：$BADGING）" >&2
  exit 1
fi
echo "[ok] 产物版本校验通过：versionCode=$VC versionName=$VN"

echo
echo "✅ 完成：$OUT/Ripple-$VN-debug.apk  ($(du -h "Ripple-$VN-debug.apk" | cut -f1))"
