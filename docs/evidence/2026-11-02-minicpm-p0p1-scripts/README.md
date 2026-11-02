# MiniCPM-OCR P0/P1 探针脚本

> 2026-11-02。用于复现
> [`../2026-11-02-minicpm-p0p1.md`](../2026-11-02-minicpm-p0p1.md)。
> 从**仓库根目录**执行；输出默认写 `tmp/minicpm-p0p1/`（探针目录，可能被清理）。

## 前置

- Node + `tsx`（仓库已有）
- `pdftoppm`（页图已由 `stages:export` 生成，脚本只读 `data/out/<book>/pages/`）
- `tesseract` 且安装 `chi_sim`（裁图对齐校验）
- `MiniCPM_API_KEY`（`~/.zshrc` 或环境变量；脚本不落盘）

## 顺序

```bash
# P0
node --import tsx docs/evidence/2026-11-02-minicpm-p0p1-scripts/build-manifest.ts
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/prepare-cases.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/run-jev.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/ocr-align.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/analyze-filtered.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/summarize.py

# P1
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/p1-parse.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/p1-compare.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/p1-fidelity.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/p1-summary.py

# P0-2：真实错误（corrections/*.json）——先建 169 个候选，再两轮 OCR 对齐
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/build-real-cases.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/ocr-align-real.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/ocr-align-real2.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/run-jev-real-v2.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/summarize-real.py

# P1-2：22 页扩页对照
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/p1-parse-extra.py
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/p1-compare-all.py

# P2：只读路由原型（不改生产线）
python3 docs/evidence/2026-11-02-minicpm-p0p1-scripts/p2-readonly.py
```

> 真实错误脚本会读 `corrections/*.json`；`run-jev-real-v2.py` 对内容策略 400 的单条会跳过并记录。
> `p1-compare-all.py` 会对 22 页跑 tesseract 整页 OCR，耗时约 1–2 分钟。

## 说明

- `build-manifest.ts` 用 `src/normalize.ts` 的 `normalizeLayout` 还原页内行级块；
  这是 `questions.json` 的 `source.blockIndexes` 能对上裁图框的前提。
- `run-jev.py` 用 `score_best_batch`，每批最多 8 块；会写 `jev-batches/`，
  支持断点续跑（已有 batch 文件不重复调用）。
- `ocr-align.py` 用 tesseract 回读裁图；`analyze-filtered.py` 只保留
  `ocrSim >= 0.25` 的文本 + 非《磁场》表格。
- 数据口径与限制见报告 §6.3；不要把本目录的合成错误集当真实 OCR 错误分布。
