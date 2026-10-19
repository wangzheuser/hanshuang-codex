#!/usr/bin/env bash
#
# 寒霜破甲工具 · 桌面版快捷启动（macOS / Linux）
#
# 用法：./run.sh [--rebuild | --help]
#

set -euo pipefail

cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
寒霜破甲工具 · 桌面版快捷启动

  ./run.sh            需要时自动装依赖、构建，然后启动
  ./run.sh --rebuild  强制重新构建前端再启动
  ./run.sh --help     显示这段帮助
EOF
}

# 从 Finder 双击时 PATH 往往不含 Homebrew / nvm 的 node，先补几个常见位置
if ! command -v node >/dev/null 2>&1; then
  for d in /opt/homebrew/bin /usr/local/bin "$HOME"/.nvm/versions/node/*/bin; do
    [ -d "$d" ] && PATH="$d:$PATH"
  done
  export PATH
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js —— 请先安装 Node 18+（https://nodejs.org 或 brew install node）" >&2
  exit 1
fi

# 这个变量会让 Electron 退化成纯 Node 运行，表现为
# "TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')"
unset ELECTRON_RUN_AS_NODE

REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      # 注意用 ${arg}：变量后面紧跟全角括号时，bash 会把括号当成变量名的一部分
      echo "未知参数：${arg}（用 --help 查看用法）" >&2
      exit 2
      ;;
  esac
done

# 依赖：node_modules 缺失，或 electron 的二进制没下载成功，就装一次
if [ ! -f node_modules/electron/package.json ] || [ ! -d node_modules/electron/dist ]; then
  echo "==> 安装依赖（首次运行需要几分钟）"
  npm install --no-audit --no-fund
fi

# 构建：产物缺失，或前端源码比产物新，就重新构建
need_build=$REBUILD
if [ ! -f dist/index.html ]; then
  need_build=1
fi
if [ "$need_build" -eq 0 ]; then
  # head -1 让管道状态恒为 0，避免 find 对不存在的路径报错时触发 set -e
  newer=$(find src index.html vite.config.ts -newer dist/index.html 2>/dev/null | head -1 || true)
  if [ -n "$newer" ]; then
    need_build=1
  fi
fi

if [ "$need_build" -eq 1 ]; then
  echo "==> 构建前端"
  npm run build
fi

echo "==> 启动寒霜破甲工具"
exec ./node_modules/.bin/electron .
