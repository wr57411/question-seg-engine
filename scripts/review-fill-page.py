#!/usr/bin/env python3
"""生成「补字候选判定」单页 HTML（人工判定用，可复跑）。

用法（需要 Pillow，本机在 paddle 的 uv 环境里已有）：
  /Users/john/.local/share/uv/tools/paddleocr-mcp/bin/python scripts/review-fill-page.py --doc "物理_教材基础练 电路"

输入：`data/out/<doc>/ocr-fill-jobs.json`（新路径候选 + 旧路径同洞文本）
      `data/out/<doc>/pages/page-XX.png`（页图）
输出：`data/out/<doc>/review-fill.html`（单文件、可离线打开；键盘 1/2/3/4/0 判定，
      判定存 localStorage，导出 JSON 回传）
"""
import argparse, base64, io, json, os

p = argparse.ArgumentParser()
p.add_argument("--doc", required=True)
a = p.parse_args()
doc = a.doc
from PIL import Image, ImageDraw

d = json.load(open(f"data/out/{doc}/ocr-fill-jobs.json", encoding="utf-8"))
rows = [r for r in d["rows"] if r.get("oldText") is not None]
cases = []
for i, r in enumerate(rows):
    img_path = f"data/out/{doc}/pages/page-{r['page']:02d}.png"
    if not os.path.exists(img_path):
        continue
    im = Image.open(img_path).convert("RGB")
    W, H = im.size
    x0, y0, x1, y1 = [r["bbox"][0]*W, r["bbox"][1]*H, r["bbox"][2]*W, r["bbox"][3]*H]
    cx0, cy0 = max(0, int(x0-60)), max(0, int(y0-46))
    cx1, cy1 = min(W, int(x1+60)), min(H, int(y1+46))
    crop = im.crop((cx0, cy0, cx1, cy1))
    dr = ImageDraw.Draw(crop)
    dr.rectangle([x0-cx0, y0-cy0, x1-cx0, y1-cy0], outline=(220,40,40), width=3)
    s = min(2.0, 760/crop.size[0])
    crop = crop.resize((int(crop.size[0]*s), int(crop.size[1]*s)), Image.LANCZOS)
    buf = io.BytesIO(); crop.save(buf, format="JPEG", quality=72)
    cases.append({"id": i, "page": r["page"], "kind": r["kind"], "new": r["text"],
                  "old": r["oldText"], "img": base64.b64encode(buf.getvalue()).decode()})

TPL = open(os.path.join(os.path.dirname(__file__), "review-fill.template.html"), encoding="utf-8").read()
out = f"data/out/{doc}/review-fill.html"
open(out, "w", encoding="utf-8").write(TPL.replace("__DOC__", doc).replace("__CASES__", json.dumps(cases, ensure_ascii=False)))
print(f"written {out}（{len(cases)} 例）")
