#!/usr/bin/env bash
#
# 组装桌面端前端包：app/ + desktop/bridge.js → desktop/dist/
#
# 为什么不直接把 tauri.conf.json 的 frontendDist 指向 app/：
#   桌面端需要在那 13000 行前端**之前**注入一个 RippleNative 适配层
#   （见 desktop/bridge.js 的注释）。往源码 app/index.html 里加脚本标签
#   会污染 Android/浏览器两条已有路径，所以改成「构建时复制一份再注入」。
#
# 这个脚本没有 npm 依赖，纯 bash + sed，和 android/build-apk.sh 风格一致
# —— 保持「一个 node server.js 就跑起来」的那部分精神不变。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
APP="$ROOT/app"
DIST="$HERE/dist"

echo "[desktop] 组装前端包 → $DIST"

rm -rf "$DIST"
mkdir -p "$DIST"

# 1. 复制整个前端（不含 sw.js —— 桌面端不注册 Service Worker，
#    带上它反而会让 Tauri 的 custom-protocol 加载路径多一层缓存）
cp -r "$APP"/* "$DIST"/
rm -f "$DIST/sw.js"

# 2. 把适配层复制进去
cp "$HERE/bridge.js" "$DIST/bridge.js"

# 2b. 歌词窗页面。
#     它不在 app/ 里（app/ 是三端共享的前端，那边只有播放页内的歌词），
#     而是桌面端独有的一层「独立小窗口」页面，所以上面那行 cp -r 不会带上它。
#     忘了这一行的话，构建出的包能通过编译、但运行到第一次显示歌词时
#     会去加载一个不存在的 lyric.html —— 表现为歌词窗一片空白，
#     而控制台里什么错都没有（Tauri 对 App 协议的 404 处理是静默的）。
if [ ! -f "$HERE/lyric.html" ]; then
  echo "[desktop] ❌ 找不到 desktop/lyric.html（歌词窗页面）" >&2
  exit 1
fi
cp "$HERE/lyric.html" "$DIST/lyric.html"

# 3. 在 index.html 里注入 <script src="bridge.js">
#    位置：所有业务脚本之前（version.js 之后，因为 version.js 只是常量）
#    用 python 而不是 sed：要处理「找不到锚点就报错」这件事，
#    sed 静默失配会让构建出一个「看起来成功但桥没注入」的包。
python3 - "$DIST/index.html" <<'PY'
# Windows 的 Python 默认用系统代码页（cp1252）输出，中文会直接抛
# UnicodeEncodeError: 'charmap' codec can't encode characters。
# 这在 Linux 上永远复现不了，只有 CI 的 windows-latest 会红。
# 强制把 stdout/stderr 切成 UTF-8 是跨平台最省事的解法。
import sys, re
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

path = sys.argv[1]
html = open(path, encoding='utf-8').read()

ANCHOR = '<script src="js/version.js"></script>'
if ANCHOR not in html:
    sys.exit('注入失败：index.html 里找不到 ' + ANCHOR + '（前端结构变了？）')

TAG = (
    '<!-- 桌面端原生桥适配层：由 desktop/build-frontend.sh 注入，源码不含此行 -->\n'
    '<script src="bridge.js"></script>\n'
)

if 'src="bridge.js"' in html:
    print('bridge.js 已存在，跳过注入')
else:
    html = html.replace(ANCHOR, TAG + ANCHOR, 1)
    open(path, 'w', encoding='utf-8').write(html)
    print('已注入 bridge.js（在 version.js 之前）')
PY

# 4. 版本号同步：桌面的版本从 version.json 读，保证与 APK / 网页一致
VCODE=$(sed -n 's/.*"versionCode"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$ROOT/version.json" | head -1)
VNAME=$(sed -n 's/.*"versionName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/version.json" | head -1)
echo "[desktop] 版本 $VNAME ($VCODE)"

python3 - "$HERE/src-tauri/tauri.conf.json" "$VNAME" <<'PY'
import json, sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
path, ver = sys.argv[1], sys.argv[2]
conf = json.load(open(path, encoding='utf-8'))
if conf.get('version') != ver:
    conf['version'] = ver
    json.dump(conf, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    open(path, 'a', encoding='utf-8').write('\n')
    print(f'tauri.conf.json 版本 → {ver}')
else:
    print(f'tauri.conf.json 版本已是 {ver}')
PY

# 5. D-10（审查报告，1.3.4）：Cargo.toml / Cargo.lock 的版本也要同步。
#
# 以前这里只同步 tauri.conf.json，而 Tauri 打包时用的是 Cargo.toml 的 version ——
# 于是发版后可能出现「安装包是 1.3.4、崩溃日志里写的却是 1.3.3」，
# 排查问题时版本对不上，非常误导。
#
# 只改 [package] 段里的 version（不碰依赖的 version），
# 并顺手更新 Cargo.lock 里本包那一条 —— 否则 cargo 会认为 lock 过期。
python3 - "$HERE/src-tauri/Cargo.toml" "$HERE/src-tauri/Cargo.lock" "$VNAME" <<'PY'
import re, sys

# ⚠️ Windows 的 Python 默认 stdout 编码是 cp1252，输出任何中文都会抛
#    UnicodeEncodeError: 'charmap' codec can't encode ...
#    1.3.4 的 CI 就栽在这上面（Windows 打包 job 直接失败）。
#
# 两道保险一起上：
#   ① 显式把 stdout/stderr 重设为 utf-8（Python 3.7+ 支持 reconfigure）；
#   ② 所有提示文字一律写成纯 ASCII —— 即使 ① 在某个老 Python 上不生效，
#      也不会因为一条日志把整个构建搞崩。
# 构建脚本的日志本来就不该依赖终端能显示什么字符。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

toml, lock, ver = sys.argv[1], sys.argv[2], sys.argv[3]


def sync_toml():
    src = open(toml, encoding='utf-8').read()
    m = re.search(r'^\[package\]([\s\S]*?)(?=^\[)', src, re.M)
    if not m:
        print('Cargo.toml: no [package] section, skipped')
        return
    seg = m.group(1)
    new_seg, n = re.subn(r'(?m)^(version\s*=\s*)"[^"]*"', r'\1"%s"' % ver, seg, count=1)
    if n and new_seg != seg:
        src = src[:m.start(1)] + new_seg + src[m.end(1):]
        open(toml, 'w', encoding='utf-8').write(src)
        print('Cargo.toml version -> %s' % ver)
    else:
        print('Cargo.toml version already %s' % ver)


def sync_lock():
    try:
        src = open(lock, encoding='utf-8').read()
    except OSError:
        return
    pat = re.compile(r'(\[\[package\]\]\nname\s*=\s*"ripple-desktop"\nversion\s*=\s*)"[^"]*"')
    new, n = pat.subn(r'\1"%s"' % ver, src, count=1)
    if n and new != src:
        open(lock, 'w', encoding='utf-8').write(new)
        print('Cargo.lock version -> %s' % ver)
    else:
        print('Cargo.lock unchanged (entry not found or already current)')


sync_toml()
sync_lock()
PY

echo "[desktop] 完成：$(find "$DIST" -type f | wc -l) 个文件"
