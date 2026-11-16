#!/usr/bin/env bash
# 用 Chrome 无头模式截取对比页（真实渲染，能验证 MathML 公式与插图）
# 用法: bash docpipe/shot-compare.sh [题号...]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HTML="$ROOT/data/out-doc/教材基础练-电路/对比展示.html"
OUT="$ROOT/tmp/docpipe-m4/shots"
[ -x "$CHROME" ] || { echo "找不到 Chrome：$CHROME" >&2; exit 1; }
[ -f "$HTML" ] || { echo "找不到页面：$HTML（先跑 bash docpipe/run-m4.sh）" >&2; exit 2; }
mkdir -p "$OUT"
IDS=("$@"); [ ${#IDS[@]} -eq 0 ] && IDS=($(seq 1 12))
for i in "${IDS[@]}"; do
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-sandbox \
    --window-size=1400,1000 --virtual-time-budget=5000 \
    --screenshot="$OUT/q$i.png" "file://$HTML?q=$i&preview=1" >/dev/null 2>&1
done
echo "截图完成：$OUT/q<N>.png（共 ${#IDS[@]} 张）"
