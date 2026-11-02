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
```

## 说明

- `build-manifest.ts` 用 `src/normalize.ts` 的 `normalizeLayout` 还原页内行级块；
  这是 `questions.json` 的 `source.blockIndexes` 能对上裁图框的前提。
- `run-jev.py` 用 `score_best_batch`，每批最多 8 块；会写 `jev-batches/`，
  支持断点续跑（已有 batch 文件不重复调用）。
- `ocr-align.py` 用 tesseract 回读裁图；`analyze-filtered.py` 只保留
  `ocrSim >= 0.25` 的文本 + 非《磁场》表格。
- 数据口径与限制见报告 §6.3；不要把本目录的合成错误集当真实 OCR 错误分布。
