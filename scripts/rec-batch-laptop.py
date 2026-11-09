#!/usr/bin/env python3
"""洞条批量识别（笔记本 ppenv 运行）：PP-OCRv5_server_rec 逐洞读文本。
用法：python rec-batch-laptop.py <crops_dir> <out_json>
输出：[{id, crop, recText, score}] —— hole-read 流水线的主读来源（仓库内 runner，2026-11-09 补齐）。
"""
import json, os, sys
from paddleocr import TextRecognition

crops_dir, out_json = sys.argv[1], sys.argv[2]
model = TextRecognition(model_name="PP-OCRv5_server_rec")
rows = []
names = sorted(f for f in os.listdir(crops_dir) if f.endswith(".png"))
print(f"REC_BATCH_START {len(names)}", flush=True)
for i, name in enumerate(names):
    hid = name.rsplit("-", 1)[0]
    try:
        r = model.predict(os.path.join(crops_dir, name))
        res = r[0] if isinstance(r, list) else r
        rec = res["rec_text"] if isinstance(res, dict) and "rec_text" in res else getattr(res, "rec_text", None)
        score = res["rec_score"] if isinstance(res, dict) and "rec_score" in res else getattr(res, "rec_score", None)
        if rec is None and isinstance(res, dict):
            rec = next((v for k, v in res.items() if "text" in k.lower()), None)
            score = next((v for k, v in res.items() if "score" in k.lower()), None)
        rows.append({"id": hid, "crop": name, "recText": str(rec or ""), "score": float(score) if score is not None else None})
    except Exception as e:
        rows.append({"id": hid, "crop": name, "recText": "", "score": None, "error": str(e)[:200]})
    if (i + 1) % 20 == 0:
        print(f"PROGRESS {i + 1}/{len(names)}", flush=True)
json.dump(rows, open(out_json, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"REC_BATCH_DONE {len(rows)}", flush=True)
