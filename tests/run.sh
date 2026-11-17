#!/usr/bin/env bash
#
# 跑 tests/ 下的全部单元测试。
#
# 为什么不让 CI 直接写 `node --test tests/`：
#   多数 Node 版本支持把目录传给 --test，但实测本机的 Node 24.22.1（arm64 构建）
#   会把目录当成模块去 import，报 ERR_UNSUPPORTED_DIR_IMPORT / MODULE_NOT_FOUND。
#   这里显式展开成文件列表再交给 --test，任何 Node 18+ 都能跑，CI 与本机行为一致。
#
# 跑法：bash tests/run.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

files=()
while IFS= read -r f; do
  files+=("$f")
done < <(find tests -type f -name '*.test.js' | sort)

if [ ${#files[@]} -eq 0 ]; then
  echo "tests/ 下没有找到 *.test.js" >&2
  exit 1
fi

echo "运行 ${#files[@]} 个测试文件："
printf '  %s\n' "${files[@]}"
echo

exec node --test "${files[@]}"
