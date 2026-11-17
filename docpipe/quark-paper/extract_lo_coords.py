#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从 LibreOffice 渲染的 DOC PDF 提取行级 (text, H, V) 坐标。

为什么：108/109 页在 DOCX 里没有排版副本（copyPages 只覆盖 16 页，本册 107），
此前只能流式渲染。LO 渲染页尺寸 1107×1584pt 与 DOCX 版面一致，
pdftotext -bbox 的词级坐标可直接当行坐标用（同一坐标系）。

输出 tmp/docpipe-m6/lo_coords.json：{"108": [[text, h, v], ...], ...}
印刷页 → 渲染页的映射按题干文本命中自动定位。
"""
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "tmp", "docpipe-m6")
PDF = os.path.join(ROOT, "tmp", "doc-diff", "doc-render", "物理_教材基础练.pdf")
QS = os.path.join(ROOT, "data", "out-doc", "教材基础练-电路", "questions.json")

NS = "{http://www.w3.org/1999/xhtml}"


def page_text(pdf, n):
    r = subprocess.run(["pdftotext", "-f", str(n), "-l", str(n), pdf, "-"],
                       capture_output=True, text=True)
    return r.stdout


def total_pages(pdf):
    r = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True)
    m = re.search(r"Pages:\s+(\d+)", r.stdout)
    return int(m.group(1))


def find_render_pages(pdf, pages_src):
    """每个印刷页用它第一题题干的独特片段定位渲染页号。

    PDF 抽出来的文本有空白伪影（如 P55 变成 P55 S T），所以两边都去全部空白；
    键从 12 字逐步缩到 6 字；命中多个时用「印刷页序 ↑ ⇒ 渲染页序 ↑」约束收窄。
    """
    qs = json.load(open(QS))
    n = total_pages(pdf)
    raw = {i: page_text(pdf, i) for i in range(1, n + 1)}
    texts = {i: re.sub(r"\s+", "", t) for i, t in raw.items()}
    mapping = {}
    last = 0
    for pno in pages_src:
        pq = [q for q in qs if q["page"] == pno]
        stem = re.sub(r"\s+", "", pq[0]["stem"])
        hits = []
        for L in (12, 9, 6):
            key = stem[1:1 + L]
            hits = [i for i, t in texts.items() if key in t and i > last]
            if len(hits) == 1:
                break
        if len(hits) != 1:
            raise SystemExit(f"印刷页{pno} 题干 {stem[:12]!r} 命中 {hits}（应唯一），拒绝瞎猜")
        mapping[pno] = hits[0]
        last = hits[0]
    return mapping


def lines_from_bbox(xml_path):
    """词 → 行：yMin 聚类（±4pt），再按栏（x<553 左栏 / ≥553 右栏）拆分。

    只按 y 聚类会把左右栏同一 y 的词串成一行（108 页「变式2…欧姆」实测串过），
    双栏版面必须先分栏再拼行。返回 [(text, h, v)]，按 v、h 排序。
    """
    root = ET.parse(xml_path).getroot()
    words = []
    for w in root.iter(NS + "word"):
        words.append((float(w.get("yMin")), float(w.get("xMin")),
                      float(w.get("xMax")), w.text or ""))
    words.sort()
    MID = 553.0
    lines = []
    for y, x0, x1, t in words:
        col = 0 if x0 < MID else 1
        hit = None
        for ln in reversed(lines[-6:]):
            if ln["col"] == col and abs(ln["y"] - y) <= 1.5:
                hit = ln
                break
        if hit is not None:
            hit["text"] += t
            hit["x0"] = min(hit["x0"], x0)  # 杂散词（如游离的连字符）不能带偏行起点
            hit["x1"] = max(hit["x1"], x1)
        else:
            lines.append({"y": y, "x0": x0, "x1": x1, "text": t, "col": col})
    return [[ln["text"], round(ln["x0"], 1), round(ln["y"], 1), round(ln["x1"], 1)]
            for ln in sorted(lines, key=lambda l: (l["y"], l["x0"]))]


def main():
    qs = json.load(open(QS))
    pages_src = sorted({q["page"] for q in qs})
    mapping = find_render_pages(PDF, pages_src)
    print("印刷页→渲染页:", mapping)
    out = {}
    for pno, rn in mapping.items():
        xml = os.path.join(OUT, f"bbox-{rn}.xml")
        subprocess.run(["pdftotext", "-bbox", "-f", str(rn), "-l", str(rn),
                        PDF, xml], check=True)
        out[str(pno)] = lines_from_bbox(xml)
        print(f"印刷页{pno}(渲染{rn}): {len(out[str(pno)])} 行")
    dst = os.path.join(OUT, "lo_coords.json")
    json.dump(out, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print("写出", dst)


if __name__ == "__main__":
    main()
