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

# ---------- 版本副本清单（单一来源的「同步侧声明」）----------
#
# 审查 1.3.5 的 H-5 / M-6：checker 查 4 处、本脚本写 8 处 ——
# 「检查器与被检查对象之间的名单漂移」本身就是本仓库头号缺陷模式的一种。
#
# 现在这份清单在三个地方必须一致：
#   ① 这里（同步侧：真正被写的是哪些文件）
#   ② scripts/version-facts.js 的 COPIES（检查侧：真正被解析的是哪些文件）
#   ③ CONTRIBUTING.md 的「版本同步清单」表格（文档侧：人看到的是哪些文件）
# scripts/check-manifest-consistency.js 的 [G] 项逐一比对这三方，
# 任何一处漂移都直接红 —— 不靠「下次记得同步改」。
#
# 加新副本时：本数组加一行 + version-facts.js 的 COPIES 加一条 + 文档表格加一行。
# 只改这里的后果是 checker 报「检查了却没人同步」；只改 facts 的后果是反过来。
SYNC_TARGETS=(
  'android/app/build.gradle'
  'android/app/src/main/java/com/ripple/app/CrashLog.java'
  'android/app/src/main/java/com/ripple/app/RippleApp.java'
  'app/js/version.js'
  'app/sw.js'
  'desktop/src-tauri/tauri.conf.json'
  'desktop/src-tauri/Cargo.toml'
  'desktop/src-tauri/Cargo.lock'
)

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
  #
  # 审查 U-06：这里必须做**替换后断言**，不能只看「内容变了没有」。
  #
  # 以前是 `if [ "$_old" = "$_new" ] then "已是最新"` —— 而 sed 完全没命中时
  # _old 也等于 _new，于是「格式变了（比如 AGP 官方推荐的 = 写法
  # versionCode = 130）」会被报成「已是最新，未改动」并 exit 0，
  # 静默产出一个版本号错掉的包。
  #
  # 现在改成：替换后必须能 grep 到期望值，否则直接失败。
  #
  GB="$HERE/app/build.gradle"
  _old="$(cat "$GB")"
  _new="$(printf '%s\n' "$_old" \
    | sed "s/versionCode [0-9]\+/versionCode $VC/; s/versionName '[^']*'/versionName '$VN'/")"
  if ! printf '%s\n' "$_new" | grep -qE "versionCode[[:space:]]*=?[[:space:]]*$VC\b"; then
    echo "❌ build.gradle: versionCode 注入失败（期望 $VC），sed 表达式可能已失配" >&2
    echo "   文件格式变了？请检查 android/sync-version.sh。" >&2
    exit 1
  fi
  if ! printf '%s\n' "$_new" | grep -qF "versionName '$VN'"; then
    echo "❌ build.gradle: versionName 注入失败（期望 '$VN'）" >&2
    exit 1
  fi
  if [ "$_old" = "$_new" ]; then
    echo "      build.gradle: 已是最新，未改动"
  else
    printf '%s\n' "$_new" > "$GB"
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
  # U-06：同样要有替换后断言 —— SW 缓存名不跟着变会导致旧壳永久留存
  if ! printf '%s\n' "$_new" | grep -qF "const CACHE = 'ripple-$VC';"; then
    echo "❌ sw.js: CACHE 名注入失败（期望 ripple-$VC），sed 表达式可能已失配" >&2
    echo "   文件格式变了？请检查 android/sync-version.sh。" >&2
    exit 1
  fi
  if [ "$_old" = "$_new" ]; then
    echo "      sw.js: 已是最新，未改动"
  else
    printf '%s\n' "$_new" > "$APP/sw.js"
    echo "      sw.js: 已同步"
  fi
fi


# ---------- 桌面端（Tauri / Rust）----------
#
# 审查 D-02：1.3.0 引入桌面端后，版本号多出**两个**副本 ——
# tauri.conf.json 的 version（desktop/build-frontend.sh 会写，没问题）
# 和 Cargo.toml 的 [package] version（**没有任何脚本写它**，停在 1.2.3）。
#
# ⚠️ 上面那句「build-frontend.sh 会写，没问题」是**错的**，1.3.3 实测抓到：
#   build-frontend.sh 只在**桌面端构建**时运行（desktop-build.yml），
#   而 Android 构建只跑本脚本。于是发版流程是「先改 version.json →
#   跑 build-apk.sh → 再 dispatch 两个 workflow」时，tauri.conf.json
#   会一直停在上一版，直到有人手动跑一次桌面端构建。
#   症状很隐蔽：本地 APK 是对的、网页版是对的，只有桌面安装包
#   的「关于」里版本号是旧的；而 CI 的版本断言（D-03）会因此在
#   桌面端 workflow 里报红 —— 也就是「改完版本号，Android 绿、
#   桌面红」，看起来像桌面端 workflow 本身坏了。
#   现在这里一并同步，让三个构建入口（Android / Gradle / 桌面）
#   都以 version.json 为唯一来源。
TauriConf="$ROOT/desktop/src-tauri/tauri.conf.json"
if [ -f "$TauriConf" ]; then
  python3 -c "
import json, sys
path, ver = sys.argv[1], sys.argv[2]
raw = open(path, encoding='utf-8').read()
try:
    data = json.loads(raw)
except Exception as e:
    print('PARSE_ERROR: %s' % e)
    sys.exit(1)
if data.get('version') == ver:
    print('      tauri.conf.json: 已是最新，未改动')
    sys.exit(0)
data['version'] = ver
# 保留 2 空格缩进和 UTF-8，与手写格式一致
open(path, 'w', encoding='utf-8').write(
    json.dumps(data, ensure_ascii=False, indent=2) + '\n')
print('      tauri.conf.json: 已同步')
" "$TauriConf" "$VN"
  # 替换后断言：读回来必须真的等于 $VN（防 json 结构变动导致写丢了）
  _tv="$(python3 -c "
import json,sys
print(json.load(open(sys.argv[1],encoding='utf-8')).get('version',''))
" "$TauriConf")"
  if [ "$_tv" != "$VN" ]; then
    echo "❌ tauri.conf.json 的 version 同步失败（得到 '${_tv:-空}'，期望 '$VN'）" >&2
    exit 1
  fi
fi

if [ -f "$ROOT/desktop/src-tauri/Cargo.toml" ]; then
  CT="$ROOT/desktop/src-tauri/Cargo.toml"
  _old="$(cat "$CT")"
  _new="$(printf '%s\n' "$_old" | sed "0,/^version = \"[0-9.]*\"/s//version = \"$VN\"/")"
  if [ "$_old" = "$_new" ]; then
    echo "      Cargo.toml: 已是最新，未改动"
  else
    printf '%s\n' "$_new" > "$CT"
    echo "      Cargo.toml: 已同步"
  fi
  # 断言：[package] 段的 version 必须真的等于 $VN，否则说明格式变了、sed 没命中
  _cv="$(sed -n 's/^version = "\([0-9.]*\)"/\1/p' "$CT" | head -1)"
  if [ "$_cv" != "$VN" ]; then
    echo "❌ Cargo.toml 的 [package] version 同步失败（得到 '${_cv:-空}'，期望 '$VN'）" >&2
    echo "   文件格式变了？请检查 android/sync-version.sh 里的 sed 表达式。" >&2
    exit 1
  fi
fi

# Cargo.lock 里 ripple-desktop 这一段的 version 也要跟上。
# 用 python 精确匹配 [[package]] 块，避免误改依赖项的同名 version 行。
CARGOLOCK="$ROOT/desktop/src-tauri/Cargo.lock"
if [ -f "$CARGOLOCK" ]; then
  python3 -c "
import re, sys
path, ver = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()
pat = re.compile(r'(\[\[package\]\]\nname = \"ripple-desktop\"\nversion = \")[0-9.]+(\")')
new, n = pat.subn(lambda m: m.group(1) + ver + m.group(2), src)
if n == 0:
    print('NO_RIPPLE_PACKAGE')
    sys.exit(1)
if new == src:
    print('      Cargo.lock: 已是最新，未改动')
else:
    open(path, 'w', encoding='utf-8').write(new)
    print('      Cargo.lock: 已同步')
" "$CARGOLOCK" "$VN" || {
    echo "❌ Cargo.lock 里找不到 ripple-desktop 的 [[package]] 块" >&2
    exit 1
  }
fi

# ---------- 收尾：用唯一解析器复核一遍 ----------
#
# 为什么写完还要再查一次：本脚本的每个分支都内联了自己的断言，
# 而那些断言与「写」共用同一个判据 —— 一旦判据本身就错了（B-1 就是这种），
# 写完+自检会一起报绿。scripts/version-facts.js 是**独立实现**
# （尤其 Cargo.toml 走段内定位），用它复核才是真正的外部校验。
if [ -f "$ROOT/scripts/version-facts.js" ] && command -v node >/dev/null 2>&1; then
  if ! node "$ROOT/scripts/version-facts.js" --assert; then
    echo "❌ 版本副本复核失败（scripts/version-facts.js --assert）" >&2
    exit 1
  fi
fi
exit 0
