import base64, json, os, time, urllib.request, urllib.error, re
from collections import defaultdict

KEY=os.popen("grep -E '^export[[:space:]]+MiniCPM_API_KEY=' ~/.zshrc | sed -E 's/^export[[:space:]]+MiniCPM_API_KEY=\"?([^\"]*)\"?[[:space:]]*$//'").read()
# safer extraction
m=re.search(r'MiniCPM_API_KEY="?([^"\n]+)"?', open(os.path.expanduser("~/.zshrc")).read())
KEY=m.group(1).strip() if m else ""
assert KEY.startswith("sk-"), "key not found"

cases=json.load(open("tmp/minicpm-p0p1/cases.json"))["cases"]
os.makedirs("tmp/minicpm-p0p1/jev-batches",exist_ok=True)

def data_uri(p):
    return "data:image/png;base64,"+base64.b64encode(open(p,"rb").read()).decode()

# byte-budget batching
batches=[]; cur=[]; cur_bytes=0
for c in cases:
    b=os.path.getsize(c["cropPath"])
    if cur and (len(cur)>=8 or cur_bytes+b>6_000_000):
        batches.append(cur); cur=[]; cur_bytes=0
    cur.append(c); cur_bytes+=b
if cur: batches.append(cur)
print("batches",len(batches),"sizes",[len(b) for b in batches])

def post(payload):
    req=urllib.request.Request("https://api.modelbest.cn/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={"Authorization":"Bearer "+KEY,"Content-Type":"application/json"},method="POST")
    with urllib.request.urlopen(req,timeout=240) as r: return json.loads(r.read())

all_results=[]
for bi,batch in enumerate(batches):
    content=[]; items=[]
    for c in batch:
        img=data_uri(c["cropPath"])
        content.append({"type":"image_url","image_url":{"url":img}})
        content.append({"type":"text","text":c["correct"]+"\n\n"+c["wrong"]})
        items.append({"case_id":c["id"],"image":img,"category":c["category"],"candidates":[c["correct"],c["wrong"]]})
    payload={"model":"MiniCPM-OCR-Jev","messages":[{"role":"user","content":content}],
             "minicpm_ocr_jev":{"mode":"score_best_batch","items":items},"stream":False}
    fp=f"tmp/minicpm-p0p1/jev-batches/batch-{bi:03d}.json"
    t0=time.time(); reused=os.path.exists(fp)
    if reused:
        d=json.load(open(fp))
    else:
        for attempt in range(4):
            try:
                d=post(payload); break
            except urllib.error.HTTPError as e:
                code=e.code; body=e.read().decode()[:500]
                if code==429:
                    time.sleep(5*(attempt+1)); continue
                if code in (500,502,503,504):
                    time.sleep(3*(attempt+1)); continue
                print("HTTP",code,body); raise
        else:
            print("FAILED batch",bi); continue
        open(fp,"w").write(json.dumps(d,ensure_ascii=False,indent=2))
    parsed=json.loads(d["choices"][0]["message"]["content"])
    res=parsed.get("results",[])
    if len(res)!=len(batch):
        print("WARN batch",bi,"results",len(res),"expected",len(batch))
    for c,r in zip(batch,res):
        all_results.append({**{k:c.get(k) for k in ("id","book","pageIndex","category","text","source","questionId")},
                            "correct":c["correct"],"wrong":c["wrong"],
                            "scores":r.get("scores"),"verdicts":r.get("verdicts"),
                            "best_index":r.get("best_index"),"best_text":r.get("best_text"),
                            "cropPath":c["cropPath"]})
    print(f"batch {bi+1}/{len(batches)} n={len(batch)} {time.time()-t0:.1f}s reused={reused} usage={d.get('usage')}")

json.dump({"results":all_results,"batches":len(batches)},open("tmp/minicpm-p0p1/jev-results.json","w"),ensure_ascii=False,indent=2)
print("saved results",len(all_results))
