#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成「原卷页图 ⇄ 复刻版式」逐页对照展示层。

目的（用户原话）：在纸质版上做笔记时，能在结构化电子版里**在相同位置**做数据录入。
因此对照页必须满足两点：
  1. 左右**同页**（左 page-01.png = 印刷页 107 = 右第 1 屏）；
  2. 右页按原卷版式排（双栏 / 同字号 / 同栏宽 / 图右浮 / 表格）。

与 `原卷版式.html` 的区别：那个是连续流（2 页，省纸）；本文件按**原卷印刷页**分页（3 屏），
用于对照录入，不追求省纸。
"""
import base64
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "docpipe", "quark-paper"))
import render_paper as RP  # noqa: E402

OUT = RP.OUT
M5 = os.path.join(ROOT, "tmp", "docpipe-m5")
PAGES = "/Users/john/WorkBuddy/Worktrees/question-seg-engine/feature-oxr-6b3489a1/data/out/物理_教材基础练 电路/pages"

# 原卷页图文件名 ↔ 印刷页码（实测 page-01=107, page-07=113, page-13=119）
PAGE_IMG = {107: "page-01.png", 108: "page-02.png", 109: "page-03.png"}


def b64png(path):
    if not os.path.exists(path):
        return ""
    return "data:image/png;base64," + base64.b64encode(open(path, "rb").read()).decode("ascii")


PAGE_H_PT = 1584.0      # 原卷页高（pgSz h=31680 twips）
COL_SPLIT = 504.0       # 左栏/右栏分界（H），实测左栏 H 39~470、右栏 543~980
SHEET_H = 785.0         # A4 内容高（297-20mm）


def split_columns(qs):
    """把一页的题分到左右栏，并算出各自的顶部偏移。

    有坐标（107 页有排版副本）→ 按真实 H/V 放，位置与原卷一致；
    无坐标（其余页）→ 按顺序前后半分、顶部起排（原卷这些页也是顶部起排）。
    """
    left, right = [], []
    for q in qs:
        pos = q.get("pos")
        if pos:
            (left if pos["h"] < COL_SPLIT else right).append(q)
        else:
            (left if len(left) * 2 <= len(qs) - 1 else right).append(q)
    # 未分配均匀时兜底：按索引前后半
    if not left or not right:
        half = (len(qs) + 1) // 2
        left, right = qs[:half], qs[half:]
    offs = []
    for col in (left, right):
        vs = [c["pos"]["v"] for c in col if c.get("pos")]
        offs.append(round(min(vs) / PAGE_H_PT * SHEET_H, 1) if vs else 0.0)
    return left, right, offs


def sheet_html(qs, dims, page):
    left, right, offs = split_columns(qs)
    body = ('<div class="col left" style="padding-top:%.1fpt">%s</div>'
            '<div class="col right" style="padding-top:%.1fpt">%s</div>'
            % (offs[0], "".join(RP.render_q(q, dims) for q in left),
               offs[1], "".join(RP.render_q(q, dims) for q in right)))
    note = ""
    if offs[0] > 40:
        note = ('<div class="note">上方空白对应原卷的「知识梳理 / 章节标题」区，本页只排题目 —— '
                '题目纵向位置与原卷一致，便于按纸上位置录入。</div>')
    return ('<section class="sheet" data-page="%d">%s%s'
            '<div class="folio">%d</div></section>' % (page, note, body, page))


CSS = """
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#f2f0ea;
  font-family:system-ui,-apple-system,"PingFang SC",sans-serif;color:#2c2c2a}
header.top{position:sticky;top:0;z-index:20;background:#fff;border-bottom:1px solid #ddd;
  padding:8px 16px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header.top h1{font-size:14px;font-weight:500;margin:0;color:#a83232}
header.top .meta{font-size:12px;color:#777}
header.top .spacer{flex:1}
header.top .nav{display:flex;gap:6px}
header.top .nav button{border:1px solid #ccc;background:#fff;border-radius:4px;
  padding:3px 9px;font-size:12px;cursor:pointer;color:#333}
header.top .nav button:hover{background:#f7f5f0}
header.top label{font-size:12px;color:#555;display:flex;align-items:center;gap:6px}
input[type=range]{width:140px}
main{padding:16px 12px 60px}
.row{display:flex;gap:14px;max-width:1640px;margin:0 auto 22px;align-items:flex-start}
.row .side{flex:1;min-width:0}
.row .side .cap{font-size:11px;color:#777;margin:0 0 5px 2px;display:flex;gap:8px}
.row .side .cap b{color:#a83232;font-weight:500}
.row .side.orig img{width:100%;display:block;border:1px solid #d8d5cc;background:#fff}
.row .side.mine{background:#fff;border:1px solid #d8d5cc}
.sheet{padding:6mm 5mm;overflow:visible}
.sheet{position:relative;min-height:790pt}
.col{position:absolute;top:0;width:48%;overflow-wrap:break-word}
.col.left{left:0}
.col.right{right:0}
.col.left{padding-right:2%}
.col.right{padding-left:2%}
.note{position:absolute;left:0;right:0;top:2pt;font-size:7.4pt;color:#b9b2a2;
  text-align:center;padding:0 6pt;line-height:1.3}
.paper{column-count:1;
  font-family:"Songti SC","SimSun","Noto Serif CJK SC",serif}
.folio{text-align:right;color:#aaa;font-size:9pt;margin-top:4pt}
.q{break-inside:avoid;page-break-inside:avoid;margin:0 0 2.2pt;padding:0 0 1pt}
.qt{margin:0 0 1pt;line-height:1.25}
.qn{font-weight:700;color:#b02525;font-size:{{QN}}pt;margin-right:2pt}
.pg{color:#999;font-size:{{PG}}pt}
.stem{margin:0;text-align:justify;text-justify:inter-ideograph}
p{margin:0}
.opts-inline{margin:0.5pt 0 0;text-align:left}
.opts-block{margin:0.5pt 0 0;line-height:1.36}
.fig{float:right;margin:0.5pt 0 2pt 5pt;object-fit:contain}
.fig-block{display:block;margin:2pt auto;object-fit:contain}
.ans{margin:0.8pt 0 0;color:#185fa5;font-size:{{ANS}}pt}
.ans b{font-size:{{B}}pt}
.warn{display:block;color:#b02525;font-size:8.9pt;margin-top:0.6pt}
.tb{border-collapse:collapse;width:60%;margin:1.5pt 0;font-size:{{TB}}pt}
.tb td{border:0.4pt solid #b9b9b9;padding:0.3pt 2pt;text-align:center}
math{font-size:1em;vertical-align:middle}
@media(max-width:1100px){.row{flex-direction:column}}
"""
CSS = (CSS.replace("{{GAP}}", "%.1f" % RP.COL_GAP)
          .replace("{{QN}}", "%.2f" % (RP.FS * 0.92))
          .replace("{{PG}}", "%.2f" % (RP.FS * 0.78))
          .replace("{{ANS}}", "%.2f" % (RP.FS * 0.88))
          .replace("{{B}}", "%.2f" % RP.FS)
          .replace("{{TB}}", "%.2f" % (RP.FS * 0.95)))

JS = """
const sheets = [...document.querySelectorAll('.mine')];
let userZoom = 1;
function fit(){
  sheets.forEach(el => {
    const w = el.clientWidth - 2;
    const z = (w / (538.6 * 1.3333)) * userZoom;
    const s = el.querySelector('.sheet');
    s.style.zoom = z;
  });
}
window.addEventListener('resize', fit);
window.addEventListener('load', fit);
document.getElementById('zoom').addEventListener('input', e => {
  userZoom = parseFloat(e.target.value); fit();
});
document.querySelectorAll('.nav button').forEach(b => {
  b.onclick = () => {
    const t = document.getElementById('p' + b.dataset.page);
    if (t) t.scrollIntoView({behavior:'smooth', block:'start'});
  };
});
"""


def main():
    data = json.load(open(os.path.join(M5, "blocks.json"), encoding="utf-8"))
    dims = {k: tuple(v) for k, v in data["imgDims"].items()}
    qs = data["questions"]
    pages = sorted({q["page"] for q in qs})

    rows = []
    nav = []
    for p in pages:
        pq = [q for q in qs if q["page"] == p]
        img = b64png(os.path.join(PAGES, PAGE_IMG.get(p, "")))
        nav.append('<button data-page="%d">第 %d 页</button>' % (p, p))
        rows.append(
            '<div class="row" id="p%d">'
            '<div class="side orig"><div class="cap"><b>原卷印刷第 %d 页</b><span>（PDF 页图，%d 题）</span></div>'
            '<img src="%s" alt="原卷第%d页"></div>'
            '<div class="side mine"><div class="cap"><b>复刻版式</b><span>（同一页码、同一版式，用于按位置录入）</span></div>'
            '%s</div>'
            '</div>' % (p, p, len(pq), img, p, sheet_html(pq, dims, p)))

    doc = """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>原卷 ⇄ 复刻版式 对照</title><style>%s</style></head><body>
<header class="top">
  <h1>原卷 ⇄ 复刻版式</h1>
  <span class="meta">教材基础练·电路 · 12 题 · 印刷页 107–109</span>
  <span class="spacer"></span>
  <div class="nav">%s</div>
  <label>缩放 <input type="range" id="zoom" min="0.6" max="1.8" step="0.05" value="1"></label>
</header>
<main>%s</main>
<script>%s</script>
</body></html>""" % (CSS, "".join(nav), "".join(rows), JS)

    p = os.path.join(OUT, "对照版.html")
    open(p, "w", encoding="utf-8").write(doc)
    print("写出", p, round(os.path.getsize(p) / 1024), "KB")
    print("对照页数：%d（页码 %s）" % (len(pages), pages))


if __name__ == "__main__":
    main()
