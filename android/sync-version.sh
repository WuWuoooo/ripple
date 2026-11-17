#!/usr/bin/env bash
# ------------------------------------------------------------------
# Ripple · 版本号同步（唯一来源：项目根 version.json）
#
# 把 versionCode / versionName 同步到所有需要它的地方：
#   · android/app/build.gradle            （Gradle 构建路径）
#   · android/app/src/main/java/.../CrashLog.java  （崩溃报告头）
#   · android/app/src/main/java/.../RippleApp.java （启动日志）
#   · app/js/version.js                  （「关于」弹窗）
#   · app/sw.js                          （Service Worker 缓存名）
#
# 之所以单独抽成脚本（R-24）：以前这段逻辑只存在于 build-apk.sh，
# 而 Gradle 路径（./gradlew assembleDebug）绕过了它 —— 版本号不更新、
# SW 缓存名不跟着变，装上去还是旧壳。现在两边都调同一个脚本。
#
# 只在内容真的不同时才写回，避免每次构建都把 git status 弄脏。
#
# 用法：bash android/sync-version.sh
#       SKIP_VERSION_SYNC=1 bash android/sync-version.sh   # 什么都不做
# ------------------------------------------------------------------
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$ROOT/app"

if [ "${SKIP_VERSION_SYNC:-0}" = "1" ]; then
  echo "      SKIP_VERSION_SYNC=1 —— 跳过版本号同步，保持受控文件不动"
  exit 0
fi

# ---------- 读 version.json ----------
VER_FILE="$ROOT/version.json"
if [ ! -f "$VER_FILE" ]; then
  echo "❌ 找不到 $VER_FILE（版本号的唯一来源）" >&2
  exit 1
fi

# R-27：解析失败必须报错退出，不能静默回退到某个写死的旧版本。
# 以前是 VC="${VC:-14}" VN="${VN:-1.3.5}" —— 解析一失败就悄悄产出一个
# 版本号对不上的包，装上去还以为是新版。
VC="$(sed -n 's/.*"versionCode"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$VER_FILE" | head -1)"
VN="$(sed -n 's/.*"versionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VER_FILE" | head -1)"

if ! printf '%s' "$VC" | grep -qE '^[0-9]+$'; then
  echo "❌ version.json 里的 versionCode 解析失败（得到：'${VC:-空}'）" >&2
  echo "   期望形如：\"versionCode\": 110" >&2
  exit 1
fi
if ! printf '%s' "$VN" | grep -qE '^[0-9]+(\.[0-9]+)*$'; then
  echo "❌ version.json 里的 versionName 解析失败（得到：'${VN:-空}'）" >&2
  echo "   期望形如：\"versionName\": \"1.1.0\"" >&2
  exit 1
fi

echo "[version] $VN ($VC)"

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

# sed_file <文件> <sed 表达式> <期望出现的固定串> <描述>
# R-28 的思路：每次替换后都断言「期望的那一串真的在文件里」，
# 格式一变（sed 完全没命中）就报错退出，而不是静默产出一个版本号对不上的包。
# 用 grep -F 做固定串比较：这样「没变化」只有在「已经是对的」时才合法，
# 「没变化 + 期望串也不在」= sed 没命中 = 直接失败。
sed_file() {
  _f="$1"; _expr="$2"; _expect="$3"; _desc="$4"
  [ -f "$_f" ] || return 0
  if grep -qF -- "$_expect" "$_f"; then
    echo "      $(basename "$_f"): 已是最新，未改动"
    return 0
  fi
  _old="$(cat "$_f")"
  _new="$(printf '%s\n' "$_old" | sed "$_expr")"
  if [ "$_old" = "$_new" ]; then
    echo "❌ $(basename "$_f") 里找不到 $_desc 的锚点，版本号注入失败" >&2
    echo "   文件格式变了？请检查 android/sync-version.sh 里的 sed 表达式。" >&2
    exit 1
  fi
  printf '%s\n' "$_new" > "$_f"
  if ! grep -qF -- "$_expect" "$_f"; then
    echo "❌ $(basename "$_f") 替换后断言失败（$_desc 应含 '$_expect'）" >&2
    exit 1
  fi
  echo "      $(basename "$_f"): 已同步"
}

# ---------- Gradle ----------
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

# ---------- Java ----------
# CrashLog：这一行必须保持 "version: x.y.z (" + NNN + ")" 的形状
sed_file "$HERE/app/src/main/java/com/ripple/app/CrashLog.java" \
  's/version: [0-9.]\+ (" + [0-9]\+ + ")"/version: '"$VN"' (" + '"$VC"' + ")"/' \
  'version: '"$VN"' (" + '"$VC"' + ")' \
  'version: 行'

# RippleApp：启动日志里的 version=1.1.0(110)
sed_file "$HERE/app/src/main/java/com/ripple/app/RippleApp.java" \
  's/version=[0-9.]\+([0-9]\+)/version='"$VN"'('"$VC"')/' \
  'version='"$VN"'('"$VC"')' \
  'version= 行'

# ---------- 网页 ----------
# 注意：这里刻意沿用 build-apk.sh 原来的注释文案。
# app/ 是别人在并行改的目录，版本同步不该让它产生无意义的 diff ——
# 只有 versionCode/versionName 真的变了才写这一行。
sync_file "$APP/js/version.js" "/* 由 android/build-apk.sh 从项目根 version.json 自动生成，不要手改 */
(function (g) {
  g.RIPPLE_VERSION = { code: $VC, name: '$VN' };
})(window);"

# B-2：Service Worker 的缓存名必须跟着 versionCode 走。
# 以前它是手写的 'ripple-v20'，构建脚本从不改它 —— 而 activate 只删
# 「名字不等于 CACHE」的旧缓存，于是每次发版旧壳永久留存，
# 离线/网络抖动时回落到上一版的 index.html + 旧 js，
# 整个应用静默冻在旧版本（新版 app.js 调旧版 player.js 里不存在的 API 直接 boot 中断）。
if [ -f "$APP/sw.js" ]; then
  _old="$(cat "$APP/sw.js")"
  _new="$(printf '%s\n' "$_old" | sed "s|^const CACHE = .*|const CACHE = 'ripple-$VC';|")"
  if [ "$_old" = "$_new" ]; then
    echo "      sw.js: 已是最新，未改动"
  else
    printf '%s\n' "$_new" > "$APP/sw.js"
    echo "      sw.js: 已同步"
  fi
fi

exit 0
