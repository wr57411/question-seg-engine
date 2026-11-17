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
    _match_at = [0]  # objs 里的单调游标（跨题共享列表，闭包可写）
    for n in range(s, e + 1):
        p = paras[n - 1]
        raw = "".join(t.text or "" for t in p.iter(W + "t")).strip()
        # 注意：公式段落没有 w:t（只有 OMML），raw 为空但**不能当空段跳过**，
        # 否则 C/D 选项的分式会静默消失（54-1 实测丢过一次）。
        # 同理：内联图独占一个 w:p（54-4/55-3/55-4 实测），raw 空且无公式，
        # 跳过会把题目配图静默丢掉 —— 判据必须加 blip（DOC 真值 diff 抓到）。
        has_math = p.find(".//" + M + "oMath") is not None
        has_img = p.find(".//" + A + "blip") is not None
        if (not raw and not has_math and not has_img) or (raw and (FOOTER.match(raw) or any(rx.match(raw) for rx in STRUCT))):
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
            # 匹配口径：两边去全部空白（含 \t——文本内的制表符 replace(" ") 清不掉）
            # + 包含匹配（LO 渲染会给题号加前缀，如 "–42024广西卷…"，前缀等值会失配）
            # + 单调推进。注意：_match_at 是题级游标，跨题会重置——同页跨题的
            # 重复行（短选项行）存在错配到前一题的风险；重启 LO_COORDS 前必须
            # 把游标提升到页级（独立评审 2026-11-17 WARN2）。
            key_txt = re.sub(r"\s+", "", re.sub(r"<[^>]+>", "",
                             re.sub(r"@@IMG:\w+@@", "", html)))[:10]
            pos = None
            if key_txt:
                for i in range(_match_at[0], len(objs)):
                    t, hh, vv = objs[i]
                    if key_txt in re.sub(r"\s+", "", t):
                        pos = {"h": hh, "v": vv}
                        _match_at[0] = i + 1
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


LO_LINE = 43.75  # 原卷行距（pt）：插值用，与 build-faithful 的 LINE_BOX 同源


def interpolate_pos(items):
    """给没匹配到坐标的行插值：沿用同栏上一行的 (H, V+行距·间隔)。

    题目行在原卷是等行距节奏（43.75pt），前一行有坐标时直接外推；
    没有前行就借后面最近的同行行（V - 行距·间隔）。仍无则放弃（保持 None，
    调用方按缺坐标页处理，不许静默给个假坐标）。
    """
    prev = None
    for i, it in enumerate(items):
        if it.get("pos"):
            prev = it["pos"]
            continue
        nxt = None
        for it2 in items[i + 1:]:
            if it2.get("pos"):
                nxt = it2["pos"]
                break
        if prev is not None:
            it["pos"] = {"h": prev["h"], "v": round(prev["v"] + LO_LINE, 1)}
        elif nxt is not None:
            it["pos"] = {"h": nxt["h"], "v": round(nxt["v"] - LO_LINE, 1)}
        else:
            continue
        prev = it["pos"]


def main():
    os.makedirs(OUT, exist_ok=True)
    qs = json.load(open(os.path.join(ROOT, "data", "out-doc", "教材基础练-电路", "questions.json"),
                        encoding="utf-8"))
    copies = copy_pages()
    copy_imgs = copy_images()
    # LO 渲染坐标：DOCX 排版副本没覆盖的页（108/109）用它补行级坐标。
    # 坐标系同为 1107×1584pt；副本页的坐标权威度更高，只在副本缺失时回退。
    # LO 渲染坐标默认关闭：它是「LO 绕排片段」的坐标，而成品行是「原卷整行」——
    # 绕图排版的片段起点 + 整行 nowrap 渲染 = 文字压图/跨栏叠印（2026-11-17 实测，
    # 截图用户点名）。要启用需先解决「整行按可用宽度绕图重排」，见 diff-report §六。
    lo_path = os.path.join(OUT, "lo_coords.json")
    lo_coords = (json.load(open(lo_path, encoding="utf-8"))
                 if os.environ.get("LO_COORDS") == "1" and os.path.exists(lo_path) else {})
    out = []
    for q in qs:
        key = q["id"].split(":")[-1]
        objs = copies.get(q["page"], {}).get("objs") or lo_coords.get(str(q["page"]), [])
        items = build_items(q, objs)
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
        # LO 坐标页：没匹配上的行（公式行/断行差异）按等行距外推补坐标。
        # 副本页不动（107 页的 DOCX 坐标 + 公式空框机制是原口径）。
        if not copies.get(q["page"], {}).get("objs"):
            interpolate_pos(items)
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
