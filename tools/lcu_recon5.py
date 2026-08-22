"""Recon 5: welke endpoints bestaan er voor JADE-masteries/runes/champ-select?"""
import base64, json, ssl, urllib.request, re

with open(r"C:\Riot Games\League of Legends\lockfile") as f:
    _, _, PORT, PW, _ = f.read().split(":")
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
AUTH = "Basic " + base64.b64encode(f"riot:{PW}".encode()).decode()
def raw(p):
    r = urllib.request.Request(f"https://127.0.0.1:{PORT}{p}", headers={"Authorization": AUTH})
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=60) as x: return x.read().decode("utf-8", "replace")
    except Exception as e: return json.dumps({"__error__": f"{type(e).__name__}: {e}"})

h = raw("/help?format=Full")
print(f"/help grootte: {len(h)} bytes")
try:
    doc = json.loads(h)
except Exception as e:
    print("parse fout:", e); raise SystemExit

paths = sorted(doc.get("paths", {}).keys()) if isinstance(doc, dict) else []
if not paths and isinstance(doc, dict):
    paths = sorted(k for k in doc.keys())
print(f"aantal endpoints: {len(paths)}\n")

def grep(label, pattern):
    hits = [p for p in paths if re.search(pattern, p, re.I)]
    print(f"--- {label} ({len(hits)}) ---")
    for p in hits[:40]: print("   ", p)
    if len(hits) > 40: print(f"    ... +{len(hits)-40} meer")
    print()

grep("JADE / CLASSIC", r"jade|classic")
grep("MASTERIES / TALENTS", r"mastery|masteries|talent")
grep("RUNES / PERKS", r"perk|rune")
grep("CHAMP SELECT", r"champ-select")
