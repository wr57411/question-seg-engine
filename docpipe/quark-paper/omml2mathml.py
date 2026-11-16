#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OMML → MathML 转换器。

为什么要转：OMML 是 Office 私有公式格式，只有 Word/WPS 认识；浏览器不认识。
要放进网页/JSON，必须换成浏览器能渲染的表示。MathML 是 W3C 标准、现代浏览器原生支持，
且与 OMML 结构几乎一一对应（f→mfrac、rad→msqrt、sSub→msub…），比转 LaTeX 更保真，
也不依赖任何外部库或 CDN。

用法：
    import omml2mathml; m = Converter().convert(oMathElement)  # 返回 <math> 字符串
"""
import xml.etree.ElementTree as ET

M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def token_class(ch):
    """按字符判断该用 mi / mn / mo / mtext。"""
    if ch is None or ch == "":
        return "mi"
    if all(c.isdigit() or c == "." for c in ch):
        return "mn"
    if any("\u4e00" <= c <= "\u9fff" for c in ch):
        return "mtext"
    if all(c.isalpha() for c in ch):
        return "mi"
    return "mo"


class Converter:
    def __init__(self):
        self.unknown = []

    # ---------- 通用 ----------
    def children(self, node):
        return list(node)

    def conv_children(self, node):
        out = []
        for ch in node:
            s = self.conv_node(ch)
            if s:
                out.append(s)
        return "".join(out)

    def run_text(self, node):
        """m:r 内取 m:t 文本。"""
        return "".join(t.text or "" for t in node.iter(M + "t"))

    def wrap_run(self, node):
        txt = self.run_text(node)
        if not txt:
            return ""
        cls = token_class(txt)
        return f"<{cls}>{esc(txt)}</{cls}>"

    # ---------- 结构节点 ----------
    def conv_f(self, node):
        num = node.find(M + "num")
        den = node.find(M + "den")
        n = self.conv_children(num) if num is not None else ""
        d = self.conv_children(den) if den is not None else ""
        return f"<mfrac><mrow>{n}</mrow><mrow>{d}</mrow></mfrac>"

    def conv_rad(self, node):
        deg = node.find(M + "deg")
        e = node.find(M + "e")
        inner = self.conv_children(e) if e is not None else ""
        deg_nodes = [c for c in deg] if deg is not None else []
        has_deg = any(c.tag == M + "r" and self.run_text(c).strip() for c in deg_nodes)
        if has_deg:
            d = self.conv_children(deg)
            return f"<mroot><mrow>{inner}</mrow><mrow>{d}</mrow></mroot>"
        return f"<msqrt><mrow>{inner}</mrow></msqrt>"

    def _sub_sup(self, node, want_sub, want_sup):
        base = node.find(M + "e")
        b = self.conv_children(base) if base is not None else ""
        if want_sub and want_sup:
            sub = node.find(M + "sub")
            sup = node.find(M + "sup")
            s1 = self.conv_children(sub) if sub is not None else ""
            s2 = self.conv_children(sup) if sup is not None else ""
            return f"<msubsup><mrow>{b}</mrow><mrow>{s1}</mrow><mrow>{s2}</mrow></msubsup>"
        if want_sub:
            sub = node.find(M + "sub")
            s1 = self.conv_children(sub) if sub is not None else ""
            return f"<msub><mrow>{b}</mrow><mrow>{s1}</mrow></msub>"
        sup = node.find(M + "sup")
        s2 = self.conv_children(sup) if sup is not None else ""
        return f"<msup><mrow>{b}</mrow><mrow>{s2}</mrow></msup>"

    def conv_d(self, node):
        """定界符。关键坑：begChr/endChr 省略时 OOXML 默认是圆括号。"""
        pr = node.find(M + "dPr")
        beg, end = "(", ")"
        if pr is not None:
            b = pr.find(M + "begChr")
            e = pr.find(M + "endChr")
            if b is not None:
                beg = b.get(M + "val", "(")
            if e is not None:
                end = e.get(M + "val", ")")
        inner = self.conv_children(node.find(M + "e")) if node.find(M + "e") is not None else ""
        return (f"<mrow><mo stretchy=\"true\">{esc(beg)}</mo>{inner}"
                f"<mo stretchy=\"true\">{esc(end)}</mo></mrow>")

    def conv_acc(self, node):
        pr = node.find(M + "accPr")
        chr_ = "^"
        if pr is not None:
            c = pr.find(M + "chr")
            if c is not None:
                chr_ = c.get(M + "val", "^")
        e = node.find(M + "e")
        inner = self.conv_children(e) if e is not None else ""
        if chr_ in ("\u0305", "\u203e", "\u2015", "\u00af"):
            return f"<mover accent=\"true\"><mrow>{inner}</mrow><mo>\u00af</mo></mover>"
        if chr_ == "\u20d7":
            return f"<mover accent=\"true\"><mrow>{inner}</mrow><mo>\u2192</mo></mover>"
        if chr_ == "\u0302":
            return f"<mover accent=\"true\"><mrow>{inner}</mrow><mo>^</mo></mover>"
        return f"<mover accent=\"true\"><mrow>{inner}</mrow><mo>{esc(chr_)}</mo></mover>"

    def conv_limupp(self, node):
        lim = node.find(M + "lim")
        e = node.find(M + "e")
        l = self.conv_children(lim) if lim is not None else ""
        inner = self.conv_children(e) if e is not None else ""
        return f"<mover><mrow>{inner}</mrow><mrow>{l}</mrow></mover>"

    def conv_eqarr(self, node):
        rows = []
        for e in node.findall(M + "e"):
            rows.append(f"<mtr><mtd>{self.conv_children(e)}</mtd></mtr>")
        return f"<mtable>{''.join(rows)}</mtable>"

    def conv_node(self, node):
        tag = node.tag
        if tag == M + "oMath" or tag == M + "oMathPara":
            return self.conv_children(node)
        if tag == M + "r":
            return self.wrap_run(node)
        if tag == M + "t":
            return esc(node.text or "")
        if tag == M + "f":
            return self.conv_f(node)
        if tag == M + "rad":
            return self.conv_rad(node)
        if tag == M + "sSub":
            return self._sub_sup(node, True, False)
        if tag == M + "sSup":
            return self._sub_sup(node, False, True)
        if tag == M + "sSubSup":
            return self._sub_sup(node, True, True)
        if tag == M + "d":
            return self.conv_d(node)
        if tag == M + "acc":
            return self.conv_acc(node)
        if tag == M + "limUpp":
            return self.conv_limupp(node)
        if tag == M + "eqArr":
            return self.conv_eqarr(node)
        if tag in (M + "e", M + "num", M + "den", M + "sub", M + "sup", M + "deg", M + "lim"):
            return self.conv_children(node)
        if tag.endswith("Pr"):
            return ""
        # 未识别节点：显式标记，绝不静默丢弃
        self.unknown.append(tag.split("}")[-1])
        return f'<mtext>[?{esc(tag.split("}")[-1])}]</mtext>'

    def convert(self, omath):
        inner = self.conv_children(omath)
        return ('<math xmlns="http://www.w3.org/1998/Math/MathML" display="inline">'
                f"<mrow>{inner}</mrow></math>")
