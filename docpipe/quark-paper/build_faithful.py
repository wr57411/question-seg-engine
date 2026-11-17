#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 docpipe 的 lines.json（原卷 1107×1584pt 行级坐标）转成 final/ 可读的
faithful.json（A4 588.44×842pt，schema 对齐 stages.json）。

- abs 页：每行按 (H,V) 落位，宽 = 栏宽 232.3pt，行盒高 16.4pt（与 1对1复刻 的 .aln 同口径）
- flow 页：无坐标，两栏流式；行高固定 23.3pt（由渲染内核按 fontPt/linePt 画）
- 文本块额外带 html（MathML 原样）与 fontPt=19（原卷字号，非同级的行距 43.75）

只读 lines.json / questions.json，输出 data/out-doc/<doc>/faithful.json。
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOC = "教材基础练-电路"
OUT = os.path.join(ROOT, "data", "out-doc", DOC)
LINES = os.path.join(ROOT, "tmp", "docpipe-m6", "lines.json")

PAGE_W, PAGE_H = 1107.0, 1584.0
SCALE = 842.0 / PAGE_H           # 0.53156
SHEET_W = round(PAGE_W * SCALE, 2)   # 588.44
SHEET_H = 842.0
COL_W = round(437 * SCALE, 2)        # 232.34
LINE_BOX = 16.4                  # 1对1复刻 .aln 的行盒高（pt，sheet 单位）
FLOW_LINE = round(43.75 * SCALE, 1)  # 23.3pt
FLOW_LEFT = round(39 * SCALE, 2)     # 20.73
FLOW_RIGHT = round(543 * SCALE, 2)   # 288.63
ORIG_FONT = 19                   # 原卷字号（pt，1107 宽的坐标系）


def r(v, n=2):
    return round(v, n)


def blocks_from_page(qs, pno, copy_imgs, blanks, qjson, img_dims=None):
    """abs 页：按行坐标 + 公式空框 + 题图 + 未渲染知识梳理表。

    108/109 页坐标来自 LibreOffice 渲染（lo_coords），与 DOCX 副本同坐标系。
    """
    blocks = []
    qdefs = []
    used_blank = set()
    used_img = set()

    for q in qs:
        idxs = []
        prev = None
        for it in q["items"]:
            if it["t"] == "tbl":
                # 55-6 的参数表：abs 页按插值坐标落位，宽=栏宽，高=行数×行距。
                if it.get("pos"):
                    rows = it["rows"]
                    cw = [c.get("w") or 60 for c in (rows[0] if rows else [])]
                    total = sum(cw) or 1
                    colgroup = "".join('<col style="width:%.1f%%">' % (100.0 * w / total) for w in cw)
                    body = "".join(
                        "<tr>" + "".join("<td>%s</td>" % c.get("html", "") for c in row) + "</tr>"
                        for row in rows)
                    thtml = ('<table class="faithful-table"><colgroup>%s</colgroup>'
                             '<tbody>%s</tbody></table>' % (colgroup, body))
                    nh = max(len(rows), 1) * LINE_BOX
                    idxs.append(len(blocks))
                    blocks.append({"kind": "table", "html": thtml,
                                   "bbox": [r(it["pos"]["h"] * SCALE), r(it["pos"]["v"] * SCALE),
                                            r((it["pos"]["h"] + COL_W) * SCALE),
                                            r((it["pos"]["v"] + nh) * SCALE)],
                                   "fontPt": ORIG_FONT})
                continue
            if it["t"] != "ln":
                continue
            html = it["html"]
            pos = it.get("pos")
            # 行内图片：浮动图（有 copyImages 位置）单独落位；内联图（rId444/448/449，
            # 无浮动位置）若一并删除会再次静默丢图（2026-11-16 教训）——
            # 改为在行自身位置落图块，宽高按 imgDims 原始 pt。
            inline_rids = re.findall(r"@@IMG:(\w+)@@", html)
            html = re.sub(r"@@IMG:\w+@@", "", html)
            for rid in inline_rids:
                if rid in used_img:
                    continue
                has_float = any(crid == rid for crid, _, _, _, _ in copy_imgs)
                used_img.add(rid)
                if has_float or not pos:
                    continue  # 浮动图走下面的 copyImages 落位；无坐标行不落
                dw, dh = (img_dims or {}).get(rid, (150.0, 120.0))
                idxs.append(len(blocks))
                blocks.append({"kind": "image", "img": rid + ".jpeg",
                               "bbox": [r(pos["h"] * SCALE), r(pos["v"] * SCALE),
                                        r((pos["h"] + dw) * SCALE),
                                        r((pos["v"] + dh) * SCALE)]})
            if pos is None:
                if "<math" in html and prev is not None:
                    # 同栏 + 代价 10·|Δv| + |Δh|（v 优先、同 v 时按 h）。
                    # v 必须先看：一行里可以并排两个公式（教材 54-2 的
                    # `Sa:Sb=1:2` 与 `5×10^18` 就在同一 v 上），只按 h 会整对错位。
                    mid = PAGE_W / 2
                    cand = [(10 * abs(bv - prev["v"]) + abs(bh - prev["h"]), i)
                            for i, (bh, bv, bw, bhh) in enumerate(blanks)
                            if i not in used_blank and (bh < mid) == (prev["h"] < mid)]
                    if cand:
                        _, bi = min(cand)
                        bh, bv, bw, bhh = blanks[bi]
                        used_blank.add(bi)
                        bbox = [r(bh * SCALE), r(bv * SCALE),
                                r((bh + bw) * SCALE), r((bv + bhh) * SCALE)]
                        idxs.append(len(blocks))
                        blocks.append({"kind": "text", "bbox": bbox, "html": html,
                                       "fontPt": ORIG_FONT, "linePt": LINE_BOX,
                                       "formula": True})
                continue
            bbox = [r(pos["h"] * SCALE), r(pos["v"] * SCALE),
                    r(pos["h"] * SCALE + COL_W), r(pos["v"] * SCALE + LINE_BOX)]
            idxs.append(len(blocks))
            blocks.append({"kind": "text", "bbox": bbox, "html": html,
                           "fontPt": ORIG_FONT, "linePt": LINE_BOX})
            prev = pos
        qdefs.append({"key": q["key"], "idxs": idxs})

    # 题图：questions.json 里该题命中的图，按 copyImages 的原卷位置落位
    for q, qd in zip(qs, qdefs):
        for im in (qjson.get(q["key"]) or {}).get("images", []):
            rid = im.get("rid")
            if rid in used_img:
                continue
            for crid, h, v, w, hh in copy_imgs:
                if crid == rid:
                    used_img.add(rid)
                    qd["idxs"].append(len(blocks))
                    blocks.append({"kind": "image", "img": rid + ".jpeg",
                                   "bbox": [r(h * SCALE), r(v * SCALE),
                                            r((h + w) * SCALE), r((v + hh) * SCALE)]})
                    break

    # 大面积未渲染区（知识梳理表）：虚线占位，保持版面比例（与 1对1复刻 同文案）
    topic_rids = {im.get("rid") for q in qs for im in (qjson.get(q["key"]) or {}).get("images", [])}
    for crid, h, v, w, hh in copy_imgs:
        if crid in used_img or crid in topic_rids:
            continue
        if w * SCALE > 300 and hh * SCALE > 150:
            blocks.append({"kind": "gap",
                           "bbox": [r(h * SCALE), r(v * SCALE),
                                    r((h + w) * SCALE), r((v + hh) * SCALE)],
                           "html": "原卷此处：知识梳理表（%d×%dpt）<br>本层未渲染" % (w, hh),
                           "fontPt": 15})
    return blocks, qdefs


def blocks_from_flow(qs, qjson, img_dims):
    """flow 页：两栏流式。按 1对1复刻 的口径：题数对半分栏。"""
    blocks, qdefs = [], []
    half = (len(qs) + 1) // 2
    for qi, q in enumerate(qs):
        idxs = []
        for it in q["items"]:
            if it["t"] == "tbl":
                rows = it["rows"]
                cw = [c.get("w") or 60 for c in (rows[0] if rows else [])]
                total = sum(cw) or 1
                colgroup = "".join('<col style="width:%.1f%%">' % (100.0 * w / total) for w in cw)
                body = "".join(
                    "<tr>" + "".join("<td>%s</td>" % c.get("html", "") for c in row) + "</tr>"
                    for row in rows)
                html = '<table class="faithful-table"><colgroup>%s</colgroup><tbody>%s</tbody></table>' % (
                    colgroup, body)
                idxs.append(len(blocks))
                blocks.append({"kind": "table", "html": html, "fontPt": ORIG_FONT})
                continue
            idxs.append(len(blocks))
            # 行内 @@IMG:rid@@ 原样保留：内核按 page.imgDims + doc 换成 <img>
            blocks.append({"kind": "text", "html": it["html"], "fontPt": ORIG_FONT})
        qdefs.append({"key": q["key"], "idxs": idxs, "col": 0 if qi < half else 1})
    return blocks, qdefs


def main():
    data = json.load(open(LINES, encoding="utf-8"))
    qs_all = data["questions"]
    img_dims = {k: list(v) for k, v in data["imgDims"].items()}
    copy_imgs = {int(k): v for k, v in data["copyImages"].items()}
    blanks = {int(k): v for k, v in data.get("blanks", {}).items()}
    qjson = {q["id"].split(":")[-1]: q for q in
             json.load(open(os.path.join(OUT, "questions.json"), encoding="utf-8"))}

    pages_src = sorted({q["page"] for q in qs_all})
    pages = []
    for arr_i, pno in enumerate(pages_src):
        pq = [q for q in qs_all if q["page"] == pno]
        lines = [it for q in pq for it in q["items"] if it["t"] == "ln"]
        npos = sum(1 for it in lines if it.get("pos"))
        has_pos = bool(lines) and npos >= len(lines) * 0.7
        if has_pos:
            blocks, qdefs = blocks_from_page(pq, pno, copy_imgs.get(pno, []),
                                             blanks.get(pno, []), qjson, img_dims)
            page = {"index": arr_i, "pageNo": pno, "width": SHEET_W, "height": SHEET_H,
                    "columns": 2, "mode": "abs", "originWidth": PAGE_W, "originHeight": PAGE_H,
                    "originScale": round(SCALE, 6), "blocks": blocks}
        else:
            blocks, qdefs = blocks_from_flow(pq, qjson, img_dims)
            page = {"index": arr_i, "pageNo": pno, "width": SHEET_W, "height": SHEET_H,
                    "columns": 2, "mode": "flow", "originWidth": PAGE_W, "originHeight": PAGE_H,
                    "originScale": round(SCALE, 6), "blocks": blocks,
                    "flow": {"left": FLOW_LEFT, "right": FLOW_RIGHT, "width": COL_W,
                             "linePt": FLOW_LINE},
                    "imgDims": {k: v for k, v in img_dims.items()
                                if any(k in (it.get("html") or "") for it in
                                       [x for q in pq for x in q["items"] if x["t"] == "ln"])}}

        qlist = []
        for q, qd in zip(pq, qdefs):
            meta = qjson.get(q["key"]) or {}
            item = {"id": meta.get("id") or "%s:%s" % (DOC, q["key"]),
                    "number": str(meta.get("number") or q["key"].split("-")[-1]),
                    "section": meta.get("column") or "",
                    "type": "choice" if meta.get("options") else "subjective",
                    "blocks": qd["idxs"], "startsHere": True}
            if "col" in qd:
                item["col"] = qd["col"]
            qlist.append(item)
        page["questions"] = qlist
        pages.append(page)

    snap = {"version": 1, "docId": DOC,
            "generatedAt": "2026-11-16",
            "source": "docpipe lines.json（tmp/docpipe-m6/lines.json）",
            "stats": {"pages": len(pages), "questions": len(qs_all)},
            "pages": pages}
    path = os.path.join(OUT, "faithful.json")
    json.dump(snap, open(path, "w", encoding="utf-8"), ensure_ascii=False)
    print("写出", path, "%.1f KB" % (os.path.getsize(path) / 1024))
    for p in pages:
        nf = sum(1 for b in p["blocks"] if b.get("formula"))
        print("  第%d页(index %d) mode=%-4s blocks=%d formulas=%d questions=%d" % (
            p["pageNo"], p["index"], p["mode"], len(p["blocks"]), nf, len(p["questions"])))


if __name__ == "__main__":
    main()
