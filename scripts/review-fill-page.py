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
p.add_argument("--sample", type=int, default=0, help="抽 N 条（按页分散）；0=全部重叠例")
a = p.parse_args()
doc = a.doc
from PIL import Image, ImageDraw

d = json.load(open(f"data/out/{doc}/ocr-fill-jobs.json", encoding="utf-8"))
rows = [r for r in d["rows"] if r.get("oldText") is not None]
if a.sample:
    # 过滤后的候选里按页分散抽 N 条（不与旧路径重叠也要，问题改成"新对/新错/不该补"）
    allrows = sorted(d["rows"], key=lambda r: (r["page"], r["bbox"][0]))
    if a.sample < len(allrows):
        step = len(allrows) / a.sample
        rows = [allrows[min(len(allrows)-1, int(i*step))] for i in range(a.sample)]
    else:
        rows = allrows
cases = []
for i, r in enumerate(rows):
    img_path = f"data/out/{doc}/pages/page-{r['page']:02d}.png"
    if not os.path.exists(img_path):
        continue
    im = Image.open(img_path).convert("RGB")
    W, H = im.size
    x0, y0, x1, y1 = [r["bbox"][0]*W, r["bbox"][1]*H, r["bbox"][2]*W, r["bbox"][3]*H]
    # 上下文留足：横向 ±110、纵向 ±70（洞常是 2–7px 薄片，只画框看不出来）
    cx0, cy0 = max(0, int(x0-110)), max(0, int(y0-70))
    cx1, cy1 = min(W, int(x1+110)), min(H, int(y1+70))
    crop = im.crop((cx0, cy0, cx1, cy1)).convert("RGBA")
    overlay = Image.new("RGBA", crop.size, (0,0,0,0))
    od = ImageDraw.Draw(overlay)
    box = [x0-cx0-2, y0-cy0-2, x1-cx0+2, y1-cy0+2]   # 外扩 2px，避免被字覆盖
    od.rectangle(box, fill=(220,40,40,70), outline=(200,20,20,255), width=2)
    crop = Image.alpha_composite(crop, overlay).convert("RGB")
    dr = ImageDraw.Draw(crop)
    dr.rectangle(box, outline=(200,20,20), width=2)
    s = min(2.0, 760/crop.size[0])
    crop = crop.resize((int(crop.size[0]*s), int(crop.size[1]*s)), Image.LANCZOS)
    buf = io.BytesIO(); crop.save(buf, format="JPEG", quality=72)
    cases.append({"id": i, "page": r["page"], "kind": r["kind"], "new": r["text"], "old": r.get("oldText"),
                  "w": round(x1-x0), "h": round(y1-y0), "img": base64.b64encode(buf.getvalue()).decode()})

TPL = open(os.path.join(os.path.dirname(__file__), "review-fill.template.html"), encoding="utf-8").read()
out = f"data/out/{doc}/review-fill.html"
open(out, "w", encoding="utf-8").write(TPL.replace("__DOC__", doc).replace("__CASES__", json.dumps(cases, ensure_ascii=False)))
print(f"written {out}（{len(cases)} 例）")
