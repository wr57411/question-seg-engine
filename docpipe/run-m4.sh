#!/usr/bin/env bash
# M4 一条命令复跑入口（quark-doc 流水线）。
#
# 覆盖范围：仅 M4 交付阶段 —— 把 M1/M2/M3 的已核实结果组装成 questions.json、页级导览、
# 12 张原卷定位裁图、逐题审板记录、三栏对账。
#
# 明确不是 end-to-end：M1/M2/M3 的中间产物在 tmp/（gitignored），本脚本不重跑它们。
# 若 tmp/ 被清空，必须先按 docs/specs/2026-11-16-quark-doc-pipeline.workflow.ts
# 重新产出 tmp/docpipe-m1、tmp/review-m1、tmp/docpipe-m3，再跑本脚本。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TG="$ROOT/tmp/docpipe-m4"
PG="/Users/john/WorkBuddy/Worktrees/question-seg-engine/feature-oxr-6b3489a1/data/out/物理_教材基础练 电路/pages"
CROP="/Users/john/.workbuddy/skills/screenshot-evidence/scripts/crop.sh"

for f in \
  tmp/docpipe-m1/book_paras.json \
  tmp/docpipe-m1/verification.json \
  tmp/docpipe-m1/blindspots.json \
  tmp/docpipe-m3/ans_paras.json \
  tmp/docpipe-m3/match_result.json \
  tmp/review-m1/scan_result.json; do
  [ -f "$ROOT/$f" ] || { echo "缺少前置产物：$f —— 请先重跑 M1/M2/M3（见工作流脚本）" >&2; exit 1; }
done
[ -d "$PG" ] || { echo "缺少原卷页图目录：$PG" >&2; exit 2; }
[ -f "$CROP" ] || { echo "缺少裁图工具：$CROP" >&2; exit 3; }

mkdir -p "$TG/screenshots"

# 12 张原卷定位裁图。坐标来自人工亲眼看页图后的校准，见 tmp/docpipe-m4/review_record.json。
# 裁图工具 crop.sh 带尺寸校验；区域是否对，仍需人工看一眼（脚本无法代替）。
crop() { bash "$CROP" "$1" "$TG/screenshots/$2.png" "$3" >/dev/null; }
crop "$PG/page-01.png" 54-1 '390x500+15+845'
crop "$PG/page-01.png" 54-2 '400x540+380+825'
crop "$PG/page-02.png" 54-3 '400x545+12+40'
crop "$PG/page-02.png" 54-4 '390x540+15+535'
crop "$PG/page-02.png" 54-5 '390x450+400+45'
crop "$PG/page-02.png" 54-6 '390x610+400+470'
crop "$PG/page-03.png" 55-1 '430x390+12+65'
crop "$PG/page-03.png" 55-2 '430x430+12+375'
crop "$PG/page-03.png" 55-3 '430x430+12+720'
crop "$PG/page-03.png" 55-4 '430x355+12+1075'
crop "$PG/page-03.png" 55-5 '460x560+385+380'
crop "$PG/page-03.png" 55-6 '460x550+385+880'

python3 "$TG/build.py"
python3 "$TG/review_record.py"

echo "M4 完成：questions.json / 页级导览.md / review_record.json / checks.json / screenshots/"
