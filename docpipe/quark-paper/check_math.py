#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""集中检出「源字层公式损坏」的题，输出待处理清单。

背景（2026-11-16）：54-5 的 A 选项源文本是 `电压为U3`、B 选项是 `电压大于⁽⁾/₍₎`。
          前者原卷是 U/3，后者原卷是 U/2 —— 分数线与分子分母在 DOCX 里已经丢了。
问题：脚本能发现多少？分三档给出，诚实标注「能自动判 / 只能可疑 / 完全判不出」。

用法：python3 docpipe/quark-paper/check_math.py
输出：tmp/docpipe-m5/math_issues.json（供批量人工核或替换）
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
M5 = os.path.join(ROOT, "tmp", "docpipe-m5")
OUTDOC = os.path.join(ROOT, "data", "out-doc", "教材基础练-电路")

# A 档：确定是坏数据（结构残片，正常内容不会出现）
CERTAIN = [
    (re.compile(r"[⁽₍⁾₎]"), "Unicode 上下标空壳（分式的分子/分母整块丢失）"),
    (re.compile(r"\u2044"), "分数斜线残片 U+2044"),
]
# B 档：高度可疑（字母紧贴数字，本应是分式，但源里成了平文本）
# 收紧到「中文语境 + 物理量字母单字」：变量 U/I/R/W/Q 后紧跟 1-2 位数字，
# （P 排除：本册 P56/P71/P82 全是页码，留着误报率高）
# 且左侧必须是中文（排除 "P71 图" 这类页码、"n1"/"R2" 这类下标、"rId441" 这类内部名）。
SUSPECT = [
    (re.compile(r"(?<=[\u4e00-\u9fa5，。、；：（）])[UIRWQ]\d{1,2}(?=[\u4e00-\u9fa5，。、；：\s]|$)"),
     "物理量字母紧贴数字（可能丢失分数线，如 U3 本应 U/3）"),
]
# C 档：结构可查（MathML 里分子或分母为空）
EMPTY_FRAC = re.compile(r"<mfrac>\s*<mrow>\s*</mrow>\s*<mrow>\s*</mrow>\s*</mfrac>")


def plain(html):
    # 先去掉内部图片占位符，避免 "rId441" 被当成「字母+数字」误报
    return re.sub(r"<[^>]+>", "", re.sub(r"@@IMG:\w+@@", "", html))


def main():
    data = json.load(open(os.path.join(M5, "blocks.json"), encoding="utf-8"))
    report = []
    for q in data["questions"]:
        hits = []
        for bi, b in enumerate(q["blocks"]):
            html = b.get("html", "") or ""
            txt = plain(html)
            for rx, why in CERTAIN:
                if rx.search(txt):
                    hits.append({"level": "确定损坏", "block": bi, "why": why,
                                 "text": txt[:90]})
            for rx, why in SUSPECT:
                m = rx.search(txt)
                if m:
                    frag = txt[max(0, m.start() - 12):m.end() + 8]
                    hits.append({"level": "可疑", "block": bi, "why": why,
                                 "text": frag, "token": m.group(0)})
            if EMPTY_FRAC.search(html):
                hits.append({"level": "确定损坏", "block": bi,
                             "why": "MathML 分式分子分母均为空", "text": html[:80]})
            if b.get("t") == "tbl":
                for ri, row in enumerate(b.get("rows", [])):
                    for ci, c in enumerate(row):
                        t = plain(c.get("html", ""))
                        for rx, why in CERTAIN:
                            if rx.search(t):
                                hits.append({"level": "确定损坏", "block": bi,
                                             "why": "表格单元格：" + why, "text": t[:60]})
        if hits:
            report.append({"key": q["key"], "page": q["page"], "hits": hits})

    out = {"total": len(data["questions"]), "flagged": len(report), "items": report}
    json.dump(out, open(os.path.join(M5, "math_issues.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    print("扫描 %d 题，命中 %d 题\n" % (out["total"], out["flagged"]))
    for it in report:
        print("· %s（第%s页）" % (it["key"], it["page"]))
        for h in it["hits"]:
            print("   [%s] %s" % (h["level"], h["why"]))
            print("         %s" % h["text"])
    print("\n清单：tmp/docpipe-m5/math_issues.json")


if __name__ == "__main__":
    main()
