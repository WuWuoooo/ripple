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

# 3. 在 index.html 里注入 <script src="bridge.js">
#    位置：所有业务脚本之前（version.js 之后，因为 version.js 只是常量）
#    用 python 而不是 sed：要处理「找不到锚点就报错」这件事，
#    sed 静默失配会让构建出一个「看起来成功但桥没注入」的包。
python3 - "$DIST/index.html" <<'PY'
import sys, re

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

echo "[desktop] 完成：$(find "$DIST" -type f | wc -l) 个文件"
