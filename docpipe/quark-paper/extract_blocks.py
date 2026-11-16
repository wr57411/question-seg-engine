#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 DOCX 提取 12 题的结构块（段落/表格/图片），供 "原卷版式复刻" 渲染。

为什么要重做提取：
  M4 的 build.py 把每个 w:p 当成独立一行（<br> 连接），但本册 DOCX 的 w:p
  其实是**原卷的每一行**（软换行被夸克切成段落）。于是：
    · 文字被切成碎行 → 行距累加 → 太散、太占地方
    · 参数表 w:tbl 被压平成 12 个段落 → 竖排占半页
    · 图片只取 a:blip 段落、不取 extent → 尺寸被 CSS 压缩 → 看不清
  本脚本按"块"重建：连续的行合并回段落，表格保留行列与列宽，图片按原始 pt 尺寸。
"""
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "tmp", "docpipe-m5")
DOC = "/Users/john/.zcode/workspace/default/question-seg-engine/books/物理_教材基础练.docx"

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
EMU = 12700.0

# 转换器优先用同目录副本，便于独立运行；回退到 tmp 里的开发版
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
if not os.path.exists(os.path.join(_HERE, "omml2mathml.py")):
    sys.path.insert(0, os.path.join(ROOT, "tmp", "docpipe-m4"))
from omml2mathml import Converter  # noqa: E402

conv = Converter()

import html as H

z = zipfile.ZipFile(DOC)
root = ET.fromstring(z.read("word/document.xml"))
body = root.find(W + "body")
parent = {c: p for p in root.iter() for c in p}

rels = dict(re.findall(r'Id="([^"]+)"[^>]*Target="([^"]*media[^"]*)"',
                       z.read("word/_rels/document.xml.rels").decode("utf8")))


# 图片原始尺寸索引：rid -> (w_pt, h_pt)，取自 wp:extent（EMU）。
# 为什么必须用原始尺寸：M4 的 CSS 用 max-height 压缩过，导致 113x139pt 的图
# 被压到几十像素，"看不清"的用户反馈即源于此。
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


# 统一段号口径：排除 mc:Fallback 的全部 w:p（与 M1/M3 一致，共 7979 段）
paras = [p for p in body.iter(W + "p") if not anc(p, MC + "Fallback")]
para_index = {id(p): i + 1 for i, p in enumerate(paras)}

# 顶层块（body 的直接子元素），用于按块序列输出
top_blocks = []
for el in body:
    if el.tag == W + "p":
        n = para_index.get(id(el))
        if n is not None:
            top_blocks.append({"kind": "p", "el": el, "from": n, "to": n})
    elif el.tag == W + "tbl":
        ps = el.findall(".//" + W + "p")
        idx = [para_index[id(q)] for q in ps if id(q) in para_index]
        if idx:
            top_blocks.append({"kind": "tbl", "el": el, "from": min(idx), "to": max(idx)})


def run_html(p):
    """段落内容 HTML：w:t 转义、w:tab 空格、OMML→MathML、a:blip→img 占位。"""
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
            rid = node.get(R + "embed")
            buf.append("@@IMG:%s@@" % rid)
    return "".join(buf)


def para_images(p):
    out = []
    for d in p.iter(W + "drawing"):
        blip = d.find(".//" + A + "blip")
        if blip is None:
            continue
        ext = d.find(".//" + WP + "extent")
        out.append({
            "rid": blip.get(R + "embed"),
            "w": round(int(ext.get("cx")) / EMU, 1) if ext is not None else None,
            "h": round(int(ext.get("cy")) / EMU, 1) if ext is not None else None,
            "inline": d.find(".//" + WP + "inline") is not None,
        })
    return out


def table_block(tbl):
    rows = []
    for tr in tbl.findall(W + "tr"):
        cells = []
        for tc in tr.findall(W + "tc"):
            tcw = tc.find(W + "tcPr/" + W + "tcW")
            wpt = round(int(tcw.get(W + "w")) / 20.0, 1) if (tcw is not None and tcw.get(W + "w") and tcw.get(W + "w").isdigit()) else None
            txt = []
            for q in tc.findall(".//" + W + "p"):
                h = run_html(q).strip()
                if h:
                    txt.append(h)
            cells.append({"w": wpt, "html": "<br>".join(txt)})
        rows.append(cells)
    return {"t": "tbl", "rows": rows}


STRUCT = [
    (re.compile(r"^变式\s*\d"), "变式标题"),
    (re.compile(r"^第\s*\d+\s*讲"), "讲次标题"),
    (re.compile(r"^教材知识\s*\d+"), "知识点标题"),
    (re.compile(r"^教材实验\s*\d+"), "实验标题"),
    (re.compile(r"^\d{1,3}$"), "页码"),
]
FOOTER = re.compile(r"^(上课认真听|下课练天星|上课认真听下课练天星)[\s\d]*$")
QNUM = re.compile(r"^\s*(\d{1,2})\s*[\[\.．、]")
OPT = re.compile(r"^\s*([A-D])\s*[.．、]\s*")


def plain_of(html):
    return re.sub(r"<[^>]+>", "", html)


def build_blocks(q):
    s, e = q["paraRange"]
    blocks = []
    cur = None  # 当前段落块
    seen_tbl = set()
    stopped = False

    def flush():
        nonlocal cur
        if cur and cur["html"].strip():
            blocks.append({"t": "p", "cls": cur["cls"], "html": cur["html"].strip()})
        cur = None

    for n in range(s, e + 1):
        p = paras[n - 1]
        raw = "".join(t.text or "" for t in p.iter(W + "t")).strip()

        # 页脚噪声与结构性标题：终止
        if FOOTER.match(raw):
            continue
        if STRUCT[0][0].match(raw) or STRUCT[1][0].match(raw) or STRUCT[2][0].match(raw) \
                or STRUCT[3][0].match(raw) or STRUCT[4][0].match(raw):
            flush()
            stopped = True
            continue

        # 表格：整表输出一次
        tb = anc_el(p, W + "tbl")
        if tb is not None:
            if id(tb) in seen_tbl:
                continue
            seen_tbl.add(id(tb))
            flush()
            blocks.append(table_block(tb))
            continue

        h = run_html(p).strip()
        if not h:
            continue

        ptext = plain_of(h)
        m_opt = OPT.match(ptext)
        m_q = QNUM.match(ptext)

        if m_q and not m_opt:
            flush()
            cur = {"cls": "qnum", "html": h}
        elif m_opt:
            flush()
            # 原卷有「A.2:3\tB.2:1\tC.5:3\tD.1:3」压一行的版式：按 A-D 标记拆成 4 个选项块
            pieces = re.split(r"\t+|(?=[A-D]\s*[.．]\s)", ptext)
            pieces = [x.strip() for x in pieces if x.strip()]
            if len(pieces) > 1 and all(re.match(r"^[A-D]\s*[.．]", x) for x in pieces):
                h_parts = re.split(r"\t+|(?=[A-D]\s*[.．]\s)", h)
                h_parts = [x.strip() for x in h_parts if x.strip()]
                for hp in h_parts:
                    if re.match(r"^\s*[A-D]\s*[.．]", plain_of(hp)):
                        blocks.append({"t": "p", "cls": "opt", "html": hp})
                cur = None
                continue
            cur = {"cls": "opt", "html": h}
        else:
            if cur is None:
                cur = {"cls": "body", "html": h}
            else:
                # 软换行折行：直接拼接（中文无需空格；两侧都是拉丁字母/数字时补空格）
                if cur["html"] and re.search(r"[A-Za-z0-9)]$", plain_of(cur["html"])) and re.match(r"^[A-Za-z0-9(]", ptext):
                    cur["html"] += " "
                cur["html"] += h
            continue


    flush()
    return blocks


def main():
    os.makedirs(OUT, exist_ok=True)
    qs = json.load(open(os.path.join(ROOT, "data", "out-doc", "教材基础练-电路", "questions.json"), encoding="utf-8"))

    out = []
    for q in qs:
        key = q["id"].split(":")[-1]
        blocks = build_blocks(q)
        # 题目自带图片（questions.json 由 match_images 写入，已含浮动层配图）
        imgs = q.get("images") or []
        has_inline = any("@@IMG:" in b.get("html", "") for b in blocks if b["t"] == "p")
        if imgs and not has_inline:
            rid = imgs[0]["rid"]
            # 优先挂到「题号+来源」块的开头：该块与题干合并后是一段，float 会落在题干右侧
            for b in blocks:
                if b.get("cls") == "qnum":
                    b["html"] = "@@IMG:%s@@" % rid + b["html"]
                    break
            else:
                for b in blocks:
                    if b.get("cls") == "body":
                        b["html"] = "@@IMG:%s@@" % rid + b["html"]
                        break
        out.append({
            "key": key, "id": q["id"], "page": q["page"], "answer": q["answer"],
            "column": q["column"], "number": q["number"], "blocks": blocks,
        })

    json.dump({"questions": out, "imgDims": img_dims},
              open(os.path.join(OUT, "blocks.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("写出 blocks.json：%d 题" % len(out))
    for q in out:
        kinds = [b["t"] for b in q["blocks"]]
        print(f'  {q["key"]:8s} 段落{sum(1 for k in kinds if k=="p"):2d} 表{sum(1 for k in kinds if k=="tbl")} '
              f'内联图{sum(b.get("html","").count("@@IMG:") for b in q["blocks"] if b["t"]=="p")}')


if __name__ == "__main__":
    main()
