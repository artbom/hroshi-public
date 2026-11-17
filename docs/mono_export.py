#!/usr/bin/env python3
"""Export Monobank statements for all accounts (cards, FOP, jars) to JSON.

Usage:
  export MONO_TOKEN='...'            # personal token from api.monobank.ua
  python3 mono_export.py 2026-08-01   # start date (default: 2026-08-01)

Monobank limits: 1 request per 60 s, max 31 days per statement request.
The script waits between calls and saves progress after every request,
so you can stop it and run it again — finished windows are skipped.
Output: mono_export.json next to the script. The token is never written.
"""
import json, os, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone

API = "https://api.monobank.ua"
TOKEN = os.environ.get("MONO_TOKEN")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mono_export.json")
WINDOW = 31 * 24 * 3600
PAUSE = 61

if not TOKEN:
    sys.exit("Set MONO_TOKEN env var first: export MONO_TOKEN='...'")

start = int(datetime.strptime(sys.argv[1] if len(sys.argv) > 1 else "2026-08-01", "%Y-%m-%d")
            .replace(tzinfo=timezone.utc).timestamp())
now = int(time.time())

def get(path):
    for attempt in range(5):
        req = urllib.request.Request(API + path, headers={"X-Token": TOKEN})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print("  rate limited, waiting 61 s…"); time.sleep(PAUSE); continue
            raise
    raise RuntimeError("too many retries: " + path)

data = json.load(open(OUT)) if os.path.exists(OUT) else {"accounts": [], "jars": [], "statements": {}, "done": []}

if not data["accounts"]:
    print("Fetching accounts…")
    info = get("/personal/client-info")
    data["accounts"] = [{k: a.get(k) for k in ("id", "type", "currencyCode", "balance", "creditLimit", "maskedPan", "iban")}
                        for a in info.get("accounts", [])]
    data["jars"] = [{k: j.get(k) for k in ("id", "title", "currencyCode", "balance", "goal")} for j in info.get("jars", [])]
    json.dump(data, open(OUT, "w"), ensure_ascii=False, indent=1)
    time.sleep(PAUSE)

ids = [a["id"] for a in data["accounts"]] + [j["id"] for j in data["jars"]]
windows = [(f, min(f + WINDOW - 1, now)) for f in range(start, now, WINDOW)]
total = len(ids) * len(windows)
n = 0
for acc in ids:
    for f, t in windows:
        n += 1
        key = f"{acc}:{f}"
        if key in data["done"]:
            continue
        print(f"[{n}/{total}] {acc[:6]}… {datetime.fromtimestamp(f, timezone.utc):%Y-%m-%d} → {datetime.fromtimestamp(t, timezone.utc):%Y-%m-%d}")
        items = get(f"/personal/statement/{acc}/{f}/{t}")
        data["statements"].setdefault(acc, []).extend(items)
        data["done"].append(key)
        json.dump(data, open(OUT, "w"), ensure_ascii=False, indent=1)
        if n < total:
            time.sleep(PAUSE)

print(f"Done → {OUT}")
