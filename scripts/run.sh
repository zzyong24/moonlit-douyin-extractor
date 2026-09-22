#!/usr/bin/env bash
# 月明·抖音萃取 · 一键运行
#
# 自动处理 node_modules 没装的情况（首次运行装一次）。
# 所有参数透传给 src/extract.mjs。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 依赖：Node ≥ 22
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node（需要 Node ≥ 22）" >&2
  exit 1
fi
NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [[ "$NODE_MAJOR" -lt 22 ]]; then
  echo "✗ Node ≥ 22 才支持原生 ESM + top-level await（当前 v$(node --version)）" >&2
  exit 1
fi

# 首次运行自动装依赖
if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  echo "[run.sh] 首次运行，安装依赖（playwright）..."
  cd "$SCRIPT_DIR"
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --silent
  else
    npm install --silent
  fi
fi

# 转发所有参数
exec node "$SCRIPT_DIR/src/extract.mjs" "$@"