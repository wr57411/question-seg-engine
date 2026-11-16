#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按原卷版式渲染 12 题（A4 双栏 / 原字号比例 / 表格 / 图片原尺寸）。

版式参数来源（实测，非估计）：
  · 页面 1107x1584pt（pgSz 22140x31680 twips），是 A4 的 1.86 倍
  · 栏区 H 39..980pt，左栏宽 437pt，栏间距 67pt（由浮动副本 53 个对象的 H 分布得出）
  · 正文字号 sz=38 半磅 = 19pt（对应 A4 等效约 10.2pt）
  · 表格列宽 2300/2320 dxa = 115/116pt
  · 图片以 wp:extent 原始 pt 尺寸为准，不压缩
目标：打印内容宽 190mm（538.6pt）⇒ SCALE = 538.6 / 941 = 0.5725
"""
import base64
import html as H
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "data", "out-doc", "教材基础练-电路")
M5 = os.path.join(ROOT, "tmp", "docpipe-m5")

PAGE_W = 941.0          # 原卷栏区宽（pt）
TARGET_W = 538.6        # A4 190mm
SCALE = TARGET_W / PAGE_W
FS = round(19 * SCALE, 2)          # 正文字号
COL_GAP = round(67 * SCALE, 1)     # 栏间距
COL_W = round(437 * SCALE, 1)      # 栏宽


def b64(path):
    if not os.path.exists(path):
        return ""
    ext = os.path.splitext(path)[1].lower()
    mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png"
    return "data:%s;base64,%s" % (mime, base64.b64encode(open(path, "rb").read()).decode("ascii"))


# 图片按 wp:extent 的原始 pt 尺寸输出（原卷就是这么排的）。
# 教训：曾用 max-height / 46% 上限压缩，把 441x172pt 的电路图压到 115pt，
# 相当于砍掉 3/4，"看不清"就是这么来的。
COL_W_PT = 250.1
MAX_IMG_W = COL_W_PT * 0.98      # 只约束不超栏宽
BLOCK_IMG_MIN = COL_W_PT * 0.60  # 超过栏宽 60% 的图独占一行（原卷也是居中整行）


def img_tag(rid, dims, scale=1.0, cls=None):
    src = os.path.join(OUT, "images", rid + ".jpeg")
    b = b64(src)
    if not b:
        return ""
    w, h = dims
    ww = round(w * SCALE * scale, 1)
    hh = round(h * SCALE * scale, 1)
    if ww > MAX_IMG_W:
        hh = round(hh * MAX_IMG_W / ww, 1)
        ww = round(MAX_IMG_W, 1)
    if cls is None:
        cls = "fig-block" if ww > BLOCK_IMG_MIN else "fig"
    return ('<img class="%s" src="%s" style="width:%.1fpt;height:%.1fpt" alt="%s" />'
            % (cls, b, ww, hh, rid))


BROKEN_MATH = re.compile(r"[⁽₍⁾₎\u2044]")


def broken_math_in(blocks):
    """检出源字层已损坏的公式（只剩 Unicode 上下标壳或分数线残片）。
    这类不是渲染问题：DOCX 里就没有分子分母，任何转换都补不回来 → 只能标人工核。
    """
    return [b["html"] for b in blocks if b["t"] == "p" and BROKEN_MATH.search(b["html"])]


def merge_blocks(blocks):
    """把「题号+来源」块与其后的正文块合并成同一段（原卷是接排）。"""
    out = []
    i = 0
    while i < len(blocks):
        b = blocks[i]
        if b["t"] == "p" and b.get("cls") == "qnum":
            html = b["html"]
            i += 1
            while i < len(blocks) and blocks[i]["t"] == "p" and blocks[i].get("cls") == "body":
                html += blocks[i]["html"]
                i += 1
            out.append({"t": "p", "cls": "body", "html": html})
            continue
        out.append(b)
        i += 1
    return out


OPT_LEN_MAX = 13  # 选项文本不超过此字数 → 允许并排（原卷短选项确实横排）


def render_q(q, imgs_dims):
    blocks = merge_blocks(q["blocks"])
    parts = []
    opt_parts = []

    def flush_opts():
        if not opt_parts:
            return
        plain = [re.sub(r"<[^>]+>", "", o) for o in opt_parts]
        has_math = any("<math" in o for o in opt_parts)
        short = all(len(p) <= OPT_LEN_MAX for p in plain) and not has_math
        if short and len(opt_parts) <= 4:
            parts.append('<p class="opts-inline">%s</p>' % "　".join(opt_parts))
        else:
            parts.append('<p class="opts-block">%s</p>' % "<br>".join(opt_parts))
        opt_parts.clear()

    for b in blocks:
        if b["t"] == "tbl":
            flush_opts()
            rows = b["rows"]
            cols = rows[0] if rows else []
            cw = [c.get("w") or 60 for c in cols]
            total = sum(cw) or 1
            colgroup = "".join('<col style="width:%.1f%%">' % (100.0 * w / total) for w in cw)
            body = ""
            for r in rows:
                body += "<tr>" + "".join("<td>%s</td>" % c.get("html", "") for c in r) + "</tr>"
            parts.append('<table class="tb"><colgroup>%s</colgroup><tbody>%s</tbody></table>' % (colgroup, body))
            continue
        if b["t"] != "p":
            continue
        if b.get("cls") == "opt":
            oh = re.sub(r"@@IMG:([\w]+)@@", lambda m: img_tag(m.group(1), imgs_dims.get(m.group(1)) or (150.0, 120.0)), b["html"])
            opt_parts.append(oh)
            continue
        flush_opts()
        h = b["html"]
        # 图片占位符 → 按原始尺寸 float 到文字右侧（原卷即文字绕排）
        def rep(m):
            rid = m.group(1)
            d = imgs_dims.get(rid) or (150.0, 120.0)
            return img_tag(rid, d)
        h = re.sub(r"@@IMG:([\w]+)@@", rep, h)
        parts.append('<p class="stem">%s</p>' % h)
    flush_opts()

    bad = broken_math_in(q["blocks"])
    warn = ('<span class="warn">公式源数据不完整（分数线与分子分母在 DOCX 中已丢失），需对照原卷核</span>'
            if bad else "")
    return ('<article class="q">'
            '<div class="qt"><span class="qn">%s</span><span class="pg">第%s页</span></div>'
            '%s'
            '<div class="ans">答案 <b>%s</b>%s</div>'
            '</article>'
            % (H.escape(q["key"]), q["page"], "".join(parts), H.escape(str(q["answer"])), warn))


CSS = """
@page{size:A4;margin:10mm 10mm 10mm 10mm}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#fff}
body{font-family:"Songti SC","SimSun","Noto Serif CJK SC",serif;font-size:%.2fpt;
     line-height:1.44;color:#1a1a1a;-webkit-font-smoothing:antialiased}
.paper{width:%.1fpt;margin:0 auto;column-count:2;column-gap:%.1fpt;
       column-rule:0.3pt solid #e2e2e2;column-fill:auto}
.q{break-inside:avoid;page-break-inside:avoid;margin:0 0 2.2pt;padding:0 0 1pt}
.qt{margin:0 0 1pt;line-height:1.25}
.qn{font-weight:700;color:#b02525;font-size:%.2fpt;margin-right:2pt}
.pg{color:#999;font-size:%.2fpt}
.stem{margin:0;text-align:justify;text-justify:inter-ideograph}
p{margin:0}
.opts-inline{margin:0.5pt 0 0;text-align:left}
.opts-block{margin:0.5pt 0 0;line-height:1.36}
.fig{float:right;margin:0.5pt 0 2pt 5pt;object-fit:contain}
.fig-block{display:block;margin:2pt auto;object-fit:contain}
.ans{margin:0.8pt 0 0;color:#185fa5;font-size:%.2fpt}
.ans b{font-size:%.2fpt}
.tb{border-collapse:collapse;width:60%%;margin:1.5pt 0;font-size:%.2fpt}
.tb td{border:0.4pt solid #b9b9b9;padding:0.3pt 2pt;text-align:center}
math{font-size:1em;vertical-align:middle}
.warn{display:block;color:#b02525;font-size:8.9pt;margin-top:0.6pt}
.mx{color:#c00}
@media screen{body{padding:8mm 0}}
""" % (FS, TARGET_W, COL_GAP, FS * 0.92, FS * 0.78, FS * 0.88, FS, FS * 0.95)


def main():
    data = json.load(open(os.path.join(M5, "blocks.json"), encoding="utf-8"))
    dims = {k: tuple(v) for k, v in data["imgDims"].items()}
    body = "".join(render_q(q, dims) for q in data["questions"])
    doc = ("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
           "<title>教材基础练 电路 · 原卷版式</title><style>%s</style></head>"
           "<body><main class=\"paper\">%s</main></body></html>" % (CSS, body))
    p = os.path.join(OUT, "原卷版式.html")
    open(p, "w", encoding="utf-8").write(doc)
    print("写出", p, round(os.path.getsize(p) / 1024), "KB")
    print("参数：正文 %.2fpt / 栏宽 %.1fpt / 栏间距 %.1fpt / SCALE %.4f" % (FS, COL_W, COL_GAP, SCALE))


if __name__ == "__main__":
    main()
