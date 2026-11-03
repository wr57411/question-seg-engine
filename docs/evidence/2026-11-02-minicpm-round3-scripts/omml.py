"""Minimal OMML -> LaTeX for common physics formulas."""
import re
from xml.etree import ElementTree as ET
NS_M='{http://schemas.openxmlformats.org/officeDocument/2006/math}'
NS_W='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
UNI={ '−':'-','–':'-','×':r'\times','÷':r'\div','≤':r'\le','≥':r'\ge','≠':r'\ne','∞':r'\infty',
      'π':r'\pi','θ':r'\theta','α':r'\alpha','β':r'\beta','γ':r'\gamma','Δ':r'\Delta','δ':r'\delta',
      'Ω':r'\Omega','ω':r'\omega','μ':r'\mu','λ':r'\lambda','ρ':r'\rho','σ':r'\sigma','φ':r'\varphi',
      '→':r'\to','⇒':r'\Rightarrow','⇔':r'\Leftrightarrow','↑':r'\uparrow','↓':r'\downarrow',
      '·':r'\cdot','°':r'^\circ','√':r'\sqrt','∑':r'\sum','∫':r'\int','≈':r'\approx','∝':r'\propto' }
def local(t): return t.split('}')[-1]
def txt(el):
    s=''.join(t.text or '' for t in el.iter() if local(t.tag)=='t')
    for a,b in UNI.items(): s=s.replace(a,b)
    return s
def conv(el):
    tag=local(el.tag)
    if tag in ('oMath','oMathPara','e','num','den','sub','sup','deg','fName','lim'):
        return ''.join(conv(c) for c in el)
    if tag=='r': return txt(el)
    if tag=='t': return txt(el)
    if tag in ('rPr','ctrlPr','fPr','radPr','dPr','naryPr','funcPr','limLowPr','limUppPr','accPr',
               'barPr','groupChrPr','sSupPr','sSubPr','sSubSupPr','mPr','eqArrPr','oMathParaPr'):
        return ''
    if tag=='f':
        num=el.find(NS_M+'num'); den=el.find(NS_M+'den')
        return r'\frac{%s}{%s}'%(conv(num) if num is not None else '', conv(den) if den is not None else '')
    if tag=='sSup':
        e=el.find(NS_M+'e'); sup=el.find(NS_M+'sup')
        return '{%s}^{%s}'%(conv(e) if e is not None else '', conv(sup) if sup is not None else '')
    if tag=='sSub':
        e=el.find(NS_M+'e'); sub=el.find(NS_M+'sub')
        return '{%s}_{%s}'%(conv(e) if e is not None else '', conv(sub) if sub is not None else '')
    if tag=='sSubSup':
        e=el.find(NS_M+'e'); sub=el.find(NS_M+'sub'); sup=el.find(NS_M+'sup')
        return '{%s}_{%s}^{%s}'%(conv(e) if e is not None else '', conv(sub) if sub is not None else '', conv(sup) if sup is not None else '')
    if tag=='rad':
        e=el.find(NS_M+'e'); deg=el.find(NS_M+'deg')
        d=conv(deg) if deg is not None else ''
        return (r'\sqrt[%s]{%s}'%(d,conv(e)) if d else r'\sqrt{%s}'%conv(e))
    if tag=='d':
        es=el.findall(NS_M+'e'); inner=''.join(conv(x) for x in es)
        return r'\left(%s\right)'%inner
    if tag=='nary':
        pr=el.find(NS_M+'naryPr'); chr_='∑'
        if pr is not None:
            c=pr.find(NS_M+'chr'); chr_=(c.get(NS_M+'val') if c is not None else None) or '∑'
        op={'∑':r'\sum','∫':r'\int','∏':r'\prod','∐':r'\coprod','⋃':r'\bigcup','⋂':r'\bigcap'}.get(chr_,chr_)
        sub=el.find(NS_M+'sub'); sup=el.find(NS_M+'sup'); e=el.find(NS_M+'e')
        out=op
        if sub is not None: out+='_{%s}'%conv(sub)
        if sup is not None: out+='^{%s}'%conv(sup)
        if e is not None: out+=conv(e)
        return out
    if tag=='func':
        fn=el.find(NS_M+'fName'); e=el.find(NS_M+'e')
        return r'\operatorname{%s}(%s)'%(conv(fn) if fn is not None else '', conv(e) if e is not None else '')
    if tag=='limLow':
        e=el.find(NS_M+'e'); lim=el.find(NS_M+'lim')
        return '{%s}_{%s}'%(conv(e) if e is not None else '', conv(lim) if lim is not None else '')
    if tag=='limUpp':
        e=el.find(NS_M+'e'); lim=el.find(NS_M+'lim')
        return '{%s}^{%s}'%(conv(e) if e is not None else '', conv(lim) if lim is not None else '')
    if tag=='acc':
        e=el.find(NS_M+'e'); pr=el.find(NS_M+'accPr')
        c='^'; 
        if pr is not None:
            cc=pr.find(NS_M+'chr'); c=(cc.get(NS_M+'val') if cc is not None else None) or '^'
        cmd={'^':r'\hat','¯':r'\bar','→':r'\vec','.':r'\dot','¨':r'\ddot'}.get(c,r'\hat')
        return cmd+'{%s}'%conv(e)
    if tag=='bar':
        e=el.find(NS_M+'e'); return r'\overline{%s}'%conv(e)
    if tag=='groupChr':
        e=el.find(NS_M+'e'); return r'\underbrace{%s}'%conv(e)
    if tag=='eqArr':
        es=el.findall(NS_M+'e')
        return r'\begin{aligned}%s\end{aligned}'%r'\\'.join(conv(x) for x in es)
    # default: join children
    return ''.join(conv(c) for c in el)
