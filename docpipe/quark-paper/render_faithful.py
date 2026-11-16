#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""1:1 复刻渲染（无答案版）。

用户需求原话：「我需要第二种方案（逐行对齐）。做 1:1 复刻的时候，答案就不需要出现在里面，
否则没法做到跟原卷一样的 1:1 复刻。」

两种模式，按"有没有行级坐标"自动选：
  · **绝对定位模式**：该页有排版副本（全册 16 页，本册 107 页）⇒ 每行按原卷 (H,V) 定位，
    行级 1:1，可做到「纸上第 3 行 = 电子版第 3 行」。
  · **固定行高模式**：无副本（108/109 页）⇒ 两栏流式，行高锁定为原卷行距换算值，
    行数一致时纵向位置一致；断行差异处会 ±1 行。

比例：按整页映射 —— 原卷 1107×1584pt → A4 595×842pt ⇒ SCALE = 842/1584 = 0.5316
（此前用栏区宽算的 0.5724 会把整页纵向压短 7.7%，行位置对不上。）
"""
import base64
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "data", "out-doc", "教材基础练-电路")
M6 = os.path.join(ROOT, "tmp", "docpipe-m6")

PAGE_W, PAGE_H = 1107.0, 1584.0
SCALE = 842.0 / PAGE_H          # 0.5316
SHEET_W = PAGE_W * SCALE        # 588.5pt
SHEET_H = 842.0
FS = round(19 * SCALE, 2)       # 10.10pt ≈ 原卷 A4 等效 10.2pt
COL_W = 437 * SCALE             # 232.3pt
LINE_H = round(43.75 * SCALE, 1)  # 23.3pt ≈ 原卷行距换算


def b64(path):
    if not os.path.exists(path):
        return ""
    ext = os.path.splitext(path)[1].lower()
    mime = "image/jpeg" if ext in (".jpg", ".jpeg") else "image/png"
    return "data:%s;base64,%s" % (mime, base64.b64encode(open(path, "rb").read()).decode("ascii"))


def img_src(rid):
    return b64(os.path.join(OUT, "images", rid + ".jpeg"))


def abs_sheet(qs, copy_imgs, blanks):
    """一页（含多题）按真实坐标绝对定位；公式行用空文本框坐标补齐。"""
    parts, used_img, used_blank = [], set(), set()

    for q in qs:
        prev = None
        for it in q["items"]:
            if it["t"] != "ln":
                continue
            pos = it.get("pos")
            html = it["html"]
            for rid in re.findall(r"@@IMG:(\w+)@@", html):
                html = html.replace("@@IMG:%s@@" % rid, "")
                for crid, h, v, w, hh in copy_imgs:
                    if crid == rid and crid not in used_img:
                        used_img.add(crid)
                        parts.append('<img class="aimg" src="%s" style="left:%.1fpt;top:%.1fpt;width:%.1fpt;height:%.1fpt">'
                                     % (img_src(crid), h * SCALE, v * SCALE, w * SCALE, hh * SCALE))
            body = re.sub(r"<[^>]+>", "", html).strip()

            if pos is None:
                # 公式行（无文字坐标）：用同栏、纵向最接近的空文本框坐标。
                # 注意判据是「有 MathML」，不是「纯文本为空」——
                # MathML 去标签后仍有 "n1et" 这类字符，用空文本判会整行漏掉（实测踩过）。
                if "<math" in html and prev is not None:
                    cand = [(abs(bv - prev["v"]), i) for i, (bh, bv, bw, bhh) in enumerate(blanks)
                            if i not in used_blank and abs(bh - prev["h"]) < 130]
                    if cand:
                        _, bi = min(cand)
                        bh, bv, bw, bhh = blanks[bi]
                        used_blank.add(bi)
                        # 不设宽度：原卷公式框只有 67pt 宽，但公式本身要溢出框才正常显示，
                        # 限宽会把分式缩到看不清（实测）。
                        parts.append('<div class="aln mln" style="left:%.1fpt;top:%.1fpt">%s</div>'
                                     % (bh * SCALE, bv * SCALE, html))
                continue

            parts.append('<div class="aln" style="left:%.1fpt;top:%.1fpt;width:%.1fpt">%s</div>'
                         % (pos["h"] * SCALE, pos["v"] * SCALE, COL_W, html))
            prev = pos

    for rid in [r for q in qs for r in q.get("_img_rids", [])]:
        if rid in used_img:
            continue
        for crid, h, v, w, hh in copy_imgs:
            if crid == rid:
                used_img.add(crid)
                parts.append('<img class="aimg" src="%s" style="left:%.1fpt;top:%.1fpt;width:%.1fpt;height:%.1fpt">'
                             % (img_src(crid), h * SCALE, v * SCALE, w * SCALE, hh * SCALE))
    return '<section class="sheet abs">%s<div class="folio">%d</div></section>' % (
        "".join(parts), qs[0]["page"])


def flow_cols(qs, dims):
    """无坐标页：两栏流式，行高锁定。"""
    cols = [[], []]
    half = (len(qs) + 1) // 2
    for i, q in enumerate(qs):
        cols[0 if i < half else 1].append(q)

    def render_one(q):
        buf = []
        for it in q["items"]:
            if it["t"] == "tbl":
                rows = it["rows"]
                cw = [c.get("w") or 60 for c in (rows[0] if rows else [])]
                total = sum(cw) or 1
                cg = "".join('<col style="width:%.1f%%">' % (100.0 * w / total) for w in cw)
                body = "".join("<tr>" + "".join("<td>%s</td>" % c.get("html", "") for c in r) + "</tr>"
                               for r in rows)
                buf.append('<table class="tb"><colgroup>%s</colgroup><tbody>%s</tbody></table>' % (cg, body))
                continue
            html = it["html"]

            def rep(m):
                rid = m.group(1)
                d = dims.get(rid) or (150.0, 120.0)
                w, h = d[0] * SCALE, d[1] * SCALE
                cls = "fig-block" if w > COL_W * 0.6 else "fig"
                return '<img class="%s" src="%s" style="width:%.1fpt;height:%.1fpt">' % (cls, img_src(rid), w, h)

            html = re.sub(r"@@IMG:(\w+)@@", rep, html)
            buf.append('<div class="ln">%s</div>' % html)
        return "".join(buf)

    left = "".join(render_one(q) for q in cols[0])
    right = "".join(render_one(q) for q in cols[1])
    return ('<div class="fcol left">%s</div><div class="fcol right">%s</div>' % (left, right))


CSS = """
@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#eceae4}
body{font-family:"Songti SC","SimSun","Noto Serif CJK SC",serif;color:#111;
  font-size:__FS__pt;line-height:__LH__pt}
.wrap{padding:12px 0 40px}
.sheet{position:relative;width:__SW__pt;height:__SH__pt;background:#fff;margin:0 auto 14px;
  overflow:hidden}
.sheet.abs .aln{position:absolute;white-space:nowrap;line-height:16.4pt}
.sheet.abs .aimg{position:absolute}
.fcol{position:absolute;top:0;width:__CW__pt}
.fcol.left{left:__LM__pt}
.fcol.right{left:__RM__pt}
.fcol .ln{margin:0;line-height:__LH__pt}
.fig{float:right;margin:0.5pt 0 1pt 4pt;object-fit:contain}
.fig-block{display:block;margin:2pt auto;object-fit:contain}
.tb{border-collapse:collapse;width:62%;margin:2pt 0;font-size:__FS__pt}
.tb td{border:0.4pt solid #999;padding:0.3pt 2pt;text-align:center}
.folio{position:absolute;right:14pt;bottom:8pt;font-size:8pt;color:#888}
math{font-size:1em;vertical-align:middle}
.mx{color:#c00}
@media screen{.sheet{box-shadow:0 1px 4px rgba(0,0,0,.12)}}
"""
CSS = (CSS.replace("__FS__", "%.2f" % FS).replace("__LH__", "%.1f" % LINE_H)
          .replace("__SW__", "%.1f" % SHEET_W).replace("__SH__", "%.1f" % SHEET_H)
          .replace("__CW__", "%.1f" % COL_W)
          .replace("__LM__", "%.1f" % (39 * SCALE))
          .replace("__RM__", "%.1f" % (543 * SCALE)))


def main():
    data = json.load(open(os.path.join(M6, "lines.json"), encoding="utf-8"))
    qs = data["questions"]
    dims = {k: tuple(v) for k, v in data["imgDims"].items()}
    copy_imgs = {int(k): v for k, v in data["copyImages"].items()}
    blanks = {int(k): v for k, v in data.get("blanks", {}).items()}
    qjson = {q["id"].split(":")[-1]: q for q in
             json.load(open(os.path.join(OUT, "questions.json"), encoding="utf-8"))}
    for q in qs:
        q["_img_rids"] = [im["rid"] for im in qjson.get(q["key"], {}).get("images", [])]

    pages = sorted({q["page"] for q in qs})
    sheets = []
    mode_log = []
    for p in pages:
        pq = [q for q in qs if q["page"] == p]
        # 公式行天然没有文本坐标（走空文本框补齐），所以按「多数行有坐标」判定，
        # 不能用 all()——否则一有公式整页就降级成流式（实测发生过）。
        lines = [it for q in pq for it in q["items"] if it["t"] == "ln"]
        npos = sum(1 for it in lines if it.get("pos"))
        has_pos = bool(lines) and npos >= len(lines) * 0.7
        if has_pos:
            sheets.append(abs_sheet(pq, copy_imgs.get(p, []), blanks.get(p, [])))
            mode_log.append((p, "绝对定位（行级 1:1）", len(pq)))
        else:
            sheets.append('<section class="sheet">%s<div class="folio">%d</div></section>'
                          % (flow_cols(pq, dims), p))
            mode_log.append((p, "固定行高（流式）", len(pq)))

    doc = ("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
           "<title>1:1 复刻（无答案）</title><style>%s</style></head><body>"
           "<div class=\"wrap\">%s</div></body></html>" % (CSS, "".join(sheets)))
    p = os.path.join(OUT, "1对1复刻.html")
    open(p, "w", encoding="utf-8").write(doc)
    print("写出", p, "%.0f KB" % (os.path.getsize(p) / 1024))
    print("比例 SCALE=%.4f  字号 %.2fpt  行高 %.1fpt  页 %.1f×%.1fpt"
          % (SCALE, FS, LINE_H, SHEET_W, SHEET_H))
    for pg, mode, n in mode_log:
        print("  第%d页：%s，%d 题" % (pg, mode, n))


if __name__ == "__main__":
    main()
