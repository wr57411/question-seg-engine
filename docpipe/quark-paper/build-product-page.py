#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包「成品网页」：单文件自包含，仿 Final 布局，含对比模式。

关键结构保证：成品与对比右侧**调用同一个 renderFaithful**（源码原样内联），
不是两处各写一遍碰巧长得像 —— 对应 final/final.js:7-9 的产品定义。

产物：data/out-doc/教材基础练-电路/成品.html
"""
import base64
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DOC = os.path.join(ROOT, "data", "out-doc", "教材基础练-电路")
STAGES = os.path.join(ROOT, "stages")
# 原卷页图在只读主仓库（与 data/out-doc 不同源）
PAGES = "/Users/john/WorkBuddy/Worktrees/question-seg-engine/feature-oxr-6b3489a1/data/out/物理_教材基础练 电路/pages"


def b64(path, mime):
    if not os.path.exists(path):
        return ""
    return "data:%s;base64,%s" % (mime, base64.b64encode(open(path, "rb").read()).decode("ascii"))


def strip_module(src):
    """去掉 ESM import/export，使内核可作为普通 <script> 内联。"""
    src = re.sub(r"^import[^\n]*\n", "", src, flags=re.M)
    src = re.sub(r"^export\s+", "", src, flags=re.M)
    return src


# 依赖的最小实现（与 stages/ 源码一致，避免两套实现漂移）
DEPS = r"""
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const enc = encodeURIComponent;
function fitTables(root) {
  const nodes = root?.querySelectorAll ? root.querySelectorAll(".blk-table") : [];
  for (const rawNode of nodes) {
    const node = rawNode;
    const table = node.querySelector("table");
    if (!table || typeof node.clientHeight !== "number" || node.clientHeight <= 0) continue;
    let fs = parseFloat(table.style.fontSize) || 12;
    let guard = 0;
    while (node.scrollHeight > node.clientHeight + 1 && fs > 6 && guard++ < 60) {
      fs = Math.max(6, fs - 0.25);
      table.style.fontSize = `${fs}px`;
    }
  }
}
const CHIP_H = 14, MAX_VISIBLE = 3;
function stackHeight(n, lv) { return lv === "full" ? Math.min(n, MAX_VISIBLE) * 15 + (n > MAX_VISIBLE ? 15 : 0) : 15; }
function tagStackPlacements(items, canvasH) {
  const out = new Map();
  for (const side of ["left", "right"]) {
    const list = items.filter(x => x.side === side).sort((a, b) => a.topPx - b.topPx);
    let occupiedBottom = -Infinity;
    for (const it of list) {
      const top = it.topPx + CHIP_H + 1;
      const bumps = top < occupiedBottom;
      const fits = lv => top + stackHeight(it.tagCount, lv) <= canvasH;
      let level = "full";
      if (bumps || !fits(level)) level = "count";
      if (bumps || !fits(level)) level = "chip";
      occupiedBottom = level === "chip" ? Math.max(occupiedBottom, it.topPx + CHIP_H) : top + stackHeight(it.tagCount, level);
      out.set(it.key, { level, side, topPx: top, tagCount: it.tagCount });
    }
  }
  return out;
}
function stackContents(tagCount, level) {
  if (level === "full") return { visible: Math.min(tagCount, MAX_VISIBLE), more: Math.max(0, tagCount - MAX_VISIBLE), countBadge: 0 };
  return { visible: 0, more: 0, countBadge: tagCount };
}
"""

CSS = r"""
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#f4f2ec;color:#222;
  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
header.top{position:sticky;top:0;z-index:30;background:#fff;border-bottom:1px solid #ddd;
  padding:8px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header.top strong{font-size:15px;color:#a83232}
header.top .sub{font-size:12px;color:#888}
header.top .spacer{flex:1}
header.top button,header.top select,header.top input{font-size:12px;padding:4px 8px;border:1px solid #ccc;
  border-radius:4px;background:#fff;color:#333}
header.top button{cursor:pointer}
header.top button.on{background:#a83232;color:#fff;border-color:#a83232}
main{padding:14px;max-width:1700px;margin:0 auto}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:10px;font-size:12px;color:#666}
.pages{display:flex;gap:14px;align-items:flex-start;flex-wrap:nowrap;justify-content:center}
.page-wrap{background:#fff;border:1px solid #d8d5cc;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:0}
.page-wrap .cap{font-size:11px;color:#777;padding:5px 8px;border-bottom:1px solid #eee;background:#faf9f6}
.page-wrap .cap b{color:#a83232}
.pane-title{font-size:11px;color:#777;margin:0 0 5px}
.compare-pane{min-width:0}
.compare-pane .canvas{width:100%}
.origin-page-img{width:100%;display:block}
.canvas{position:relative;background:#fff;overflow:hidden}
.blk{position:absolute}
.gutter{position:absolute;top:0;bottom:0;width:22px}
.q-chip{position:absolute;font:11px/14px system-ui;color:#a83232;cursor:pointer}
.q-chip:hover{text-decoration:underline}
.qtag{position:absolute;font:10px/14px system-ui;background:#e8f5e9;color:#1b7a3d;padding:0 2px;border-radius:2px}
.legend{font-size:11px;color:#777;margin-top:8px;display:flex;gap:14px;flex-wrap:wrap}
.legend i{display:inline-block;width:10px;height:10px;margin-right:4px;vertical-align:-1px}
dialog{border:1px solid #ccc;border-radius:8px;padding:14px;max-width:520px;font-size:13px}
h3{margin:0 0 8px;font-size:14px}
.paper-host{display:flex;justify-content:center}
@media(max-width:900px){.pages{flex-direction:column;align-items:center}.page-wrap{max-width:100%}}
@media print{
  @page{size:A4;margin:0}
  header.top,.toolbar,.legend,.page-wrap .cap,.q-chip{display:none !important}
  body{background:#fff}
  /* 交互视图只在屏幕显示；打印只看 print-root 的三页，否则 PDF 第 1 页是当前交互页 */
  #main{display:none !important}
  main{padding:0;max-width:none}
  #print-root{display:block}
  #print-root .page-wrap{border:0;box-shadow:none;page-break-after:always;break-after:page;
    height:761px;overflow:visible}
  #print-root .canvas{height:761px !important;width:538px !important}
  #print-root .page-wrap:last-child{page-break-after:auto;break-after:auto}
}
#print-root{display:none}
"""

JS = r"""
const DATA = __DATA__;
const IMGS = __IMGS__;
const PAGES = __PAGES__;
let mode = 'product';   // product | compare
let pageIdx = 0;
let zoom = 1;

function renderFaithfulHost(host, p, opts) {
  host.innerHTML = '';
  const res = renderFaithful(p, Object.assign({ doc: DATA.docId, paneW: Math.round(538 * zoom) }, opts || {}));
  host.appendChild(res.wrap);
  return res;
}

function pageWrap(title, build, width) {
  const w = el('div', 'page-wrap');
  const cap = el('div', 'cap'); cap.innerHTML = title; w.appendChild(cap);
  const inner = el('div'); inner.style.width = width + 'px'; inner.style.margin = '0 auto';
  build(inner); w.appendChild(inner);
  return w;
}

function draw() {
  const main = document.getElementById('main');
  main.innerHTML = '';
  const p = DATA.pages[pageIdx];
  const bar = el('div', 'toolbar');
  bar.innerHTML = '第 <b>' + (pageIdx+1) + '</b> / ' + DATA.pages.length + ' 页　';
  const prev = el('button','','上一页'), next = el('button','','下一页');
  prev.onclick = () => { if (pageIdx>0) { pageIdx--; draw(); } };
  next.onclick = () => { if (pageIdx<DATA.pages.length-1) { pageIdx++; draw(); } };
  bar.append(prev, ' ', next);
  const zl = el('button','','−'), zr = el('button','','＋');
  zl.onclick = () => { zoom=Math.max(.5,zoom-.1); draw(); };
  zr.onclick = () => { zoom=Math.min(2,zoom+.1); draw(); };
  bar.append('　缩放 ', zl, ' ', zr, ' ' + Math.round(zoom*100) + '%');
  main.appendChild(bar);

  const row = el('div', 'pages');
  const cb = document.getElementById('btn-compare');
  if (cb) cb.classList.toggle('on', mode === 'compare');
  const pb = document.getElementById('btn-product');
  if (pb) pb.classList.toggle('on', mode === 'product');

  if (mode === 'compare') {
    // 左：真原卷页图（base64 内嵌）；右：与成品同一函数渲染
    const left = pageWrap('<b>原卷</b> · 印刷页 ' + p.pageNo, (inner) => {
      const t = el('p','pane-title','原卷页图（扫描件）'); inner.appendChild(t);
      const img = el('img','origin-page-img');
      img.src = PAGES[p.pageNo] || ''; img.alt = '原卷第' + p.pageNo + '页';
      inner.appendChild(img);
    }, Math.round(538*zoom));
    const right = pageWrap('<b>成品</b> · 结构化数据重建（非原图）', (inner) => {
      inner.appendChild(el('p','pane-title','成品（与成品模式同一渲染函数）'));
      renderFaithfulHost(inner, p, { onChipClick: showDetail });
    }, Math.round(538*zoom));
    row.append(left, right);
    main.appendChild(row);
    const lg = el('div','legend');
    lg.innerHTML = '<span><i style="background:rgba(216,27,96,.85)"></i>解析遗漏·内容级</span>' +
                   '<span><i style="border:1px dashed #999"></i>解析遗漏·家具级（版式墨迹）</span>';
    main.appendChild(lg);
  } else {
    const one = pageWrap('<b>成品</b> · 印刷页 ' + p.pageNo + '（1:1 复刻，无答案）', (inner) => {
      renderFaithfulHost(inner, p, { onChipClick: showDetail });
    }, Math.round(538*zoom));
    row.appendChild(one); main.appendChild(row);
  }
  document.getElementById('page-now').textContent = (pageIdx+1) + '/' + DATA.pages.length;
}

function showDetail(q) {
  const d = document.getElementById('detail');
  document.getElementById('detail-title').textContent = '第 ' + (q.number || '?') + ' 题';
  const b = document.getElementById('detail-body');
  const stem = (q.blocks || []).filter(x => x.kind === 'text').map(x => {
    return String(x.html || x.text || '').replace(/<[^>]+>/g,'');
  }).join(' ');
  b.textContent = stem.slice(0, 600) || '（无文本）';
  d.showModal();
}

function jump() {
  const v = document.getElementById('jump').value.trim();
  if (!v) return;
  const m = v.match(/^(\d{2,3})[-–]?(\d+)$/);
  if (m) {
    const key = DATA.docId + ':' + m[1] + '-' + m[2];
    for (let i=0;i<DATA.pages.length;i++) {
      if (DATA.pages[i].questions.some(q => q.id === key)) { pageIdx=i; draw(); return; }
    }
  }
  const n = parseInt(v,10);
  if (!isNaN(n) && n>=1 && n<=DATA.pages.length) { pageIdx=n-1; draw(); }
}

// A10/B18：打印时把三页全部展开（默认是交互视图只渲染当前页，直接打印只有 1 页）。
function buildPrintRoot() {
  let root = document.getElementById('print-root');
  if (root) return root;
  root = el('div'); root.id = 'print-root'; document.body.appendChild(root);
  const saved = pageIdx;
  DATA.pages.forEach((pg, i) => {
    const w = el('div', 'page-wrap');
    const inner = el('div'); inner.style.width = '538px'; inner.style.margin = '0 auto';
    renderFaithfulHost(inner, pg, {});
    w.appendChild(inner); root.appendChild(w);
  });
  pageIdx = saved;
  return root;
}
// headless --print-to-pdf 不触发 beforeprint ⇒ 加载后延迟直接建好，
// 屏幕靠 @media print{display:block} 之外默认 #print-root{display:none} 隐藏。
buildPrintRoot();
document.getElementById('btn-product').onclick = () => { mode='product'; draw(); };
document.getElementById('btn-compare').onclick = () => { mode='compare'; draw(); };
document.getElementById('go').onclick = jump;
document.getElementById('jump').addEventListener('keydown', e => { if (e.key==='Enter') jump(); });
draw();
"""

KERNEL = strip_module(open(os.path.join(STAGES, "render-faithful.js"), encoding="utf-8").read())
# 单文件场景：服务路径不可用，改成优先读内嵌 data URL。
OLD_SRC = 'img.src = `/data/out/${enc(doc)}/images/${enc(b.img)}`;'
NEW_SRC = 'img.src = (p.imgData && p.imgData[b.img]) || `/data/out/${enc(doc)}/images/${enc(b.img)}`;'
if OLD_SRC not in KERNEL:
    raise SystemExit("内核图片路径写法已变，打包脚本需同步（拒绝静默丢图）")
KERNEL = KERNEL.replace(OLD_SRC, NEW_SRC)
# flow 页的行内占位符走 injectImages()，同样有服务路径写法 —— 之前漏改，
# 导致 108/109 页 8 张图全显示「原卷插图」占位文字（原尺寸截图才发现）。
OLD_SRCS = 'const src = `/data/out/${enc(doc)}/images/${enc(rid)}.jpeg`;'
NEW_SRCS = ('const src = (p.imgData && p.imgData[rid + ".jpeg"]) || '
            '`/data/out/${enc(doc)}/images/${enc(rid)}.jpeg`;')
if OLD_SRCS not in KERNEL:
    raise SystemExit("内核行内图片路径写法已变，打包脚本需同步（拒绝静默丢图）")
KERNEL = KERNEL.replace(OLD_SRCS, NEW_SRCS)

# 注入数据与页图
pages_img = {}
# 印刷页码 != 页图序号：107/108/109 对应 page-01/02/03.png
all_pages = json.load(open(os.path.join(DOC, "faithful.json"), encoding="utf-8"))["pages"]
for i, p in enumerate(all_pages, start=1):
    n = p["pageNo"]
    src = os.path.join(PAGES, "page-%02d.png" % i)
    if not os.path.exists(src):
        raise SystemExit("原卷页图缺失：" + src + "（拒绝静默用空图）")
    pages_img[str(n)] = b64(src, "image/png")

data = json.load(open(os.path.join(DOC, "faithful.json"), encoding="utf-8"))
# 只内嵌真正被引用的插图：images/ 下有 238 张，本品只用其中十几张，
# 全量内嵌会把单文件从 ~10MB 撑到 25MB（实测）。
used = set()
for pg in data["pages"]:
    for b in pg["blocks"]:
        if b.get("kind") == "image" and b.get("img"):
            used.add(b["img"])
        # flow 页：图片是文本里的 @@IMG:rid@@ 占位符，必须一并收集，
        # 否则 108/109 页的 8 张图会以「原卷插图」占位文字显示（原尺寸截图才发现）
        for rid in re.findall(r"@@IMG:(\w+)@@", str(b.get("html", ""))):
            used.add(rid + ".jpeg")
imgs = {}
for fn in os.listdir(os.path.join(DOC, "images")):
    if fn not in used:
        continue
    imgs[fn.split(".")[0]] = b64(os.path.join(DOC, "images", fn), "image/jpeg")


data["docId"] = "教材基础练-电路"
# key 与 block.img 对齐（"rId441.jpeg"）
for _p in data["pages"]:
    # block.img 形如 "rId441.jpeg"，键必须完全一致
    _p["imgData"] = {(k if k.endswith(".jpeg") else k + ".jpeg"): v for k, v in imgs.items()}
js = JS.replace("__DATA__", json.dumps(data, ensure_ascii=False)) \
       .replace("__IMGS__", json.dumps(imgs)) \
       .replace("__PAGES__", json.dumps(pages_img, ensure_ascii=False))

html = ("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
        "<title>成品 · 教材基础练 电路</title><style>%s</style></head><body>"
        "<header class=\"top\">"
        "<strong>成品</strong><span class=\"sub\">教材基础练 · 电路 · 1:1 复刻（无答案）</span>"
        "<span class=\"sub\" id=\"page-now\">—</span><span class=\"spacer\"></span>"
        "<input id=\"jump\" placeholder=\"题号 / 页码\" style=\"width:120px\">"
        "<button id=\"go\">跳转</button>"
        "<button id=\"btn-product\">成品</button><button id=\"btn-compare\">对比</button>"
        "</header><main id=\"main\"></main>"
        "<dialog id=\"detail\"><h3 id=\"detail-title\"></h3><div id=\"detail-body\"></div>"
        "<p><button onclick=\"document.getElementById('detail').close()\">关闭</button></p></dialog>"
        "<script>%s\n%s\n%s</script></body></html>" % (CSS, DEPS, KERNEL, js))

out = os.path.join(DOC, "成品.html")
open(out, "w", encoding="utf-8").write(html)
print("写出", out, "%.1f MB" % (os.path.getsize(out) / 1048576))
print("页图:", [n for n in pages_img], "插图:", len(imgs))
