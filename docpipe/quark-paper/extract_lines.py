#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按「原卷行」提取题目内容（不合并），供 1:1 逐行复刻使用。

与 extract_blocks.py 的区别：
  · extract_blocks 把同题连续行**合并成段落**，让浏览器重新折行 —— 观感自然但断点漂移；
  · 本脚本**保留原卷的行切分**（本册每个 w:p 就是原卷一行），逐行输出，
    配合固定行高即可做到逐行对齐（用户要「看着纸上第 3 行，在电子版找第 3 行」）。
  · **不含答案与解析** —— 原卷题目册没有这些，带上就不是 1:1。
"""
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "tmp", "docpipe-m6")
DOC = "/Users/john/.zcode/workspace/default/question-seg-engine/books/物理_教材基础练.docx"

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
EMU = 12700.0

sys.path.insert(0, os.path.join(ROOT, "docpipe", "quark-paper"))
from omml2mathml import Converter  # noqa: E402

conv = Converter()
import html as H

z = zipfile.ZipFile(DOC)
root = ET.fromstring(z.read("word/document.xml"))
body = root.find(W + "body")
parent = {c: p for p in root.iter() for c in p}

img_dims = {}
for d in body.iter(W + "drawing"):
    blip = d.find(".//" + A + "blip")
    ext = d.find(".//" + WP + "extent")
    if blip is not None and ext is not None:
        img_dims[blip.get(R + "embed")] = (round(int(ext.get("cx")) / EMU, 1),
                                           round(int(ext.get("cy")) / EMU, 1))


def anc(n, tag):
    cur = n
    while cur is not None:
        if cur.tag == tag:
            return True
        cur = parent.get(cur)
    return False


def anc_el(n, tag):
    cur = n
    while cur is not None:
        if cur.tag == tag:
            return cur
        cur = parent.get(cur)
    return None


paras = [p for p in body.iter(W + "p") if not anc(p, MC + "Fallback")]
para_index = {id(p): i + 1 for i, p in enumerate(paras)}


def run_html(p):
    buf = []
    for node in p.iter():
        if node.tag == M + "oMath":
            try:
                buf.append(conv.convert(node))
            except Exception:
                buf.append('<span class="mx">[?MATH]</span>')
        elif node.tag == W + "t":
            buf.append(H.escape(node.text or ""))
        elif node.tag == W + "tab":
            buf.append(" ")
        elif node.tag == A + "blip":
            buf.append("@@IMG:%s@@" % node.get(R + "embed"))
    return "".join(buf)


def table_rows(tbl):
    rows = []
    for tr in tbl.findall(W + "tr"):
        cells = []
        for tc in tr.findall(W + "tc"):
            tcw = tc.find(W + "tcPr/" + W + "tcW")
            wpt = (round(int(tcw.get(W + "w")) / 20.0, 1)
                   if (tcw is not None and (tcw.get(W + "w") or "").isdigit()) else None)
            txt = []
            for q in tc.findall(".//" + W + "p"):
                h = run_html(q).strip()
                if h:
                    txt.append(h)
            cells.append({"w": wpt, "html": "<br>".join(txt)})
        rows.append(cells)
    return rows


FOOTER = re.compile(r"^(上课认真听|下课练天星|上课认真听下课练天星)[\s\d]*$")
STRUCT = [re.compile(r"^变式\s*\d"), re.compile(r"^第\s*\d+\s*讲"),
          re.compile(r"^教材知识\s*\d+"), re.compile(r"^教材实验\s*\d+"),
          re.compile(r"^\d{1,3}$")]


def build_items(q, objs):
    """返回该题的原卷行序列；能给每行配上原卷 (H,V) 就带上。

    objs: 该题所在页的排版副本对象 [(文本, H, V)]，没有副本时为空列表。
    """
    s, e = q["paraRange"]
    items, seen = [], set()
    for n in range(s, e + 1):
        p = paras[n - 1]
        raw = "".join(t.text or "" for t in p.iter(W + "t")).strip()
        # 注意：公式段落没有 w:t（只有 OMML），raw 为空但**不能当空段跳过**，
        # 否则 C/D 选项的分式会静默消失（54-1 实测丢过一次）。
        has_math = p.find(".//" + M + "oMath") is not None
        if (not raw and not has_math) or (raw and (FOOTER.match(raw) or any(rx.match(raw) for rx in STRUCT))):
            continue
        tb = anc_el(p, W + "tbl")
        if tb is not None:
            if id(tb) in seen:
                continue
            seen.add(id(tb))
            items.append({"t": "tbl", "rows": table_rows(tb)})
            continue
        html = run_html(p).strip()
        if html:
            key_txt = re.sub(r"<[^>]+>", "", re.sub(r"@@IMG:\w+@@", "", html)).replace(" ", "")[:10]
            pos = None
            if key_txt:
                for t, hh, vv in objs:
                    if t.replace(" ", "")[:10] == key_txt:
                        pos = {"h": hh, "v": vv}
                        break
            items.append({"t": "ln", "html": html, "pos": pos})
    return items


def copy_pages():
    """排版副本页 → {页号: [(文本, H, V)]}，用于取题目的栏位与纵向起点。"""
    pages = {}
    for el in body:
        if el.tag != W + "p":
            continue
        draws = list(el.iter(W + "drawing"))
        if len(draws) < 20:
            continue
        objs, page_no, blanks = [], None, []
        for d in draws:
            h = d.find(".//" + WP + "positionH/" + WP + "posOffset")
            v = d.find(".//" + WP + "positionV/" + WP + "posOffset")
            ext = d.find(".//" + WP + "extent")
            blip = d.find(".//" + A + "blip")
            t = "".join(x.text or "" for x in d.iter(W + "t")).strip()
            if h is None or v is None:
                continue
            vv = int(v.text) / EMU
            if t and re.fullmatch(r"\d{1,3}", t) and vv > 1450:
                page_no = int(t)
            if t:
                objs.append((t, round(int(h.text) / EMU, 1), round(vv, 1)))
            elif blip is None and ext is not None:
                # 无文字、无图片却有尺寸 ⇒ 公式框（本册 C/D 选项的分式就在这种框里）
                ww, hh = int(ext.get("cx")) / EMU, int(ext.get("cy")) / EMU
                if hh > 20:      # 太扁的是装饰线
                    blanks.append((round(int(h.text) / EMU, 1), round(vv, 1),
                                   round(ww, 1), round(hh, 1)))
        if page_no is not None:
            pages[page_no] = {"objs": objs, "blanks": blanks}
    return pages


def copy_images():
    """排版副本页里的图片对象 → {页号: [(rid, H, V, w, h)]}。"""
    pages = {}
    for el in body:
        if el.tag != W + "p":
            continue
        draws = list(el.iter(W + "drawing"))
        if len(draws) < 20:
            continue
        imgs, page_no = [], None
        for d in draws:
            h = d.find(".//" + WP + "positionH/" + WP + "posOffset")
            v = d.find(".//" + WP + "positionV/" + WP + "posOffset")
            ext = d.find(".//" + WP + "extent")
            blip = d.find(".//" + A + "blip")
            t = "".join(x.text or "" for x in d.iter(W + "t")).strip()
            if h is not None and v is not None and t and re.fullmatch(r"\d{1,3}", t) and int(v.text) / EMU > 1450:
                page_no = int(t)
            if blip is not None and h is not None and v is not None and ext is not None:
                imgs.append((blip.get(R + "embed"), round(int(h.text) / EMU, 1),
                             round(int(v.text) / EMU, 1),
                             round(int(ext.get("cx")) / EMU, 1),
                             round(int(ext.get("cy")) / EMU, 1)))
        if page_no is not None:
            pages[page_no] = imgs
    return pages


def main():
    os.makedirs(OUT, exist_ok=True)
    qs = json.load(open(os.path.join(ROOT, "data", "out-doc", "教材基础练-电路", "questions.json"),
                        encoding="utf-8"))
    copies = copy_pages()
    copy_imgs = copy_images()
    out = []
    for q in qs:
        key = q["id"].split(":")[-1]
        items = build_items(q, copies.get(q["page"], {}).get("objs", []))
        head = ""
        for it in items:
            if it["t"] == "ln":
                head = re.sub(r"<[^>]+>", "", re.sub(r"@@IMG:\w+@@", "", it["html"])).strip()[:14]
                break
        pos = None
        for t, hh, vv in copies.get(q["page"], {}).get("objs", []):
            if head and t.replace(" ", "")[:14].startswith(head.replace(" ", "")):
                pos = {"h": hh, "v": vv}
                break
        out.append({"key": key, "page": q["page"], "answer": q["answer"],
                    "column": q["column"], "number": q["number"],
                    "items": items, "pos": pos})

    blanks_out = {str(k): v.get("blanks", []) for k, v in copies.items()}
    json.dump({"questions": out, "imgDims": img_dims, "blanks": blanks_out,
               "copyImages": {str(k): v for k, v in copy_imgs.items()}},
              open(os.path.join(OUT, "lines.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    print("写出 lines.json：%d 题" % len(out))
    for q in out:
        nl = sum(1 for i in q["items"] if i["t"] == "ln")
        nt = sum(1 for i in q["items"] if i["t"] == "tbl")
        npos = sum(1 for i in q["items"] if i["t"] == "ln" and i.get("pos"))
        print("  %-6s 页%-4d 行%-3d 表%d  行级坐标 %d/%d  pos=%s"
              % (q["key"], q["page"], nl, nt, npos, nl, q["pos"]))


if __name__ == "__main__":
    main()
