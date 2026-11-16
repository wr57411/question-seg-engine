#!/usr/bin/env bash
# 一条命令：DOCX → 结构块 → 原卷版式 HTML → 打印 PDF → 数页数 → 逐页截图
# 用法: bash docpipe/quark-paper/run-paper.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$ROOT/data/out-doc/教材基础练-电路"
LOG="$ROOT/tmp/docpipe-m5"

mkdir -p "$LOG"
echo "[1/4] 提取结构块（行合并 / 表格 / 图片原始尺寸）"
python3 "$ROOT/docpipe/quark-paper/extract_blocks.py"

echo "[2/4] 渲染原卷版式"
python3 "$ROOT/docpipe/quark-paper/render_paper.py"

echo "[3/4] 打印 PDF"
[ -x "$CHROME" ] || { echo "找不到 Chrome" >&2; exit 1; }
"$CHROME" --headless=new --disable-gpu --no-sandbox \
  --print-to-pdf="$LOG/paper.pdf" --no-pdf-header-footer \
  --virtual-time-budget=9000 "file://$OUT/原卷版式.html" >/dev/null 2>&1

rm -f "$LOG"/pg-*.png
pdftoppm -png -r 120 "$LOG/paper.pdf" "$LOG/pg" >/dev/null 2>&1
N=$(ls "$LOG"/pg-*.png 2>/dev/null | wc -l | tr -d ' ')
echo "[4/4] 页数：$N （原卷 107-109 共 3 页）"
echo "产物：$OUT/原卷版式.html"
echo "截图：$LOG/pg-1.png … pg-$N.png"
