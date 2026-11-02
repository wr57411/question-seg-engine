import base64,json,os,re,time,urllib.request,urllib.error
m=re.search(r'MiniCPM_API_KEY="?([^"\n]+)"?',open(os.path.expanduser("~/.zshrc")).read()); KEY=m.group(1).strip()
PAGES=[("23必刷题 1 直线运动",1),("23必刷题 1 直线运动",3),
       ("23必刷题 4 曲线运动",10),("23必刷题 4 曲线运动",13),
       ("物理_教材基础练机械能守恒定律",2),
       ("物理_教材基础练 电路",11),
       ("教材基础练 磁场",7),
       ("答案册-合订本",2)]
def img_path(book,page):
    for w in (2,3):
        p=f"data/out/{book}/pages/page-{page+1:0{w}d}.png"
        if os.path.exists(p): return p
    raise FileNotFoundError((book,page))
for book,page in PAGES:
    out=f"tmp/minicpm-round3/p1-parses/{book}-p{page}.json"
    if os.path.exists(out): print("skip",book,page); continue
    raw=open(img_path(book,page),"rb").read()
    payload={"model":"MiniCPM-OCR-1.0","image":"data:image/png;base64,"+base64.b64encode(raw).decode(),"upright":True,"recognize_seal":True}
    req=urllib.request.Request("https://api.modelbest.cn/v1/document-parse",data=json.dumps(payload).encode(),headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"},method="POST")
    t0=time.time()
    try:
        with urllib.request.urlopen(req,timeout=300) as r: body=r.read()
    except urllib.error.HTTPError as e:
        print("HTTP",e.code,book,page,e.read().decode()[:300]); continue
    d=json.loads(body); d["_elapsed"]=time.time()-t0; d["_imagePath"]=img_path(book,page)
    open(out,"w").write(json.dumps(d,ensure_ascii=False,indent=2))
    pg=d.get("pages",[d])[0]; content=pg.get("choices",[{}])[0].get("message",{}).get("content",""); blocks=pg.get("ocr",{}).get("blocks",[])
    from collections import Counter
    print(f"{book} p{page} {d['_elapsed']:.2f}s chars={len(content)} blocks={len(blocks)} labels={dict(Counter(b.get('label') for b in blocks))}")
