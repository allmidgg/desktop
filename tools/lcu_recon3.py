"""Recon 3: bestaan er JADE-champion/item/rune assets? En hoe zien de teams eruit?"""
import base64, json, ssl, urllib.request, re

with open(r"C:\Riot Games\League of Legends\lockfile") as f:
    _, _, PORT, PW, _ = f.read().split(":")
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
AUTH = "Basic " + base64.b64encode(f"riot:{PW}".encode()).decode()
def get(p):
    r = urllib.request.Request(f"https://127.0.0.1:{PORT}{p}", headers={"Authorization": AUTH})
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=20) as x: return json.loads(x.read().decode("utf-8"))
    except Exception as e: return {"__error__": f"{type(e).__name__}: {e}"}

champs = get("/lol-game-data/assets/v1/champion-summary.json")
hi = [c for c in champs if c["id"] > 10000]
print(f"champion-summary: {len(champs)} totaal, {len(hi)} met id > 10000")
for c in hi[:12]: print(f'   {c["id"]:<8} {c["alias"]:<14} {c["name"]}')

items = get("/lol-game-data/assets/v1/items.json")
hi_i = [i for i in items if i["id"] > 100000]
print(f"\nitems.json: {len(items)} totaal, {len(hi_i)} met id > 100000")
for i in hi_i[:12]: print(f'   {i["id"]:<8} {i.get("name")}')

perks = get("/lol-game-data/assets/v1/perks.json")
print(f"\nperks.json: {len(perks)} | ids: {sorted(p['id'] for p in perks)[:20]} ...")
styles = get("/lol-game-data/assets/v1/perkstyles.json")
print("perkstyles:", json.dumps(styles)[:300])

maps = get("/lol-game-data/assets/v1/maps.json")
for m in maps: print(f'   map {m.get("id")}: {m.get("name")} | {m.get("mapStringId")}')

print("\n" + "="*70, "\nVOLLEDIGE GAME DETAIL (JADE)\n", "-"*70)
mh = get("/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=1")
g0 = mh["games"]["games"][0]
full = get(f'/lol-match-history/v1/games/{g0["gameId"]}')
if "__error__" in full: print("fout:", full)
else:
    print("top-level keys:", list(full.keys()))
    print("participantIdentities voorbeeld:", json.dumps(full.get("participantIdentities", [{}])[0], ensure_ascii=False)[:400])
    for p in full.get("participants", []):
        s = p["stats"]
        print(f'  team{p["teamId"]} champ={p["championId"]:<7} spells={p["spell1Id"]}/{p["spell2Id"]:<5} '
              f'{s["kills"]}/{s["deaths"]}/{s["assists"]:<3} items={[s[f"item{i}"] for i in range(7)]}')
    # zoek naar rune/mastery-achtige velden buiten perk0..5
    s = full["participants"][0]["stats"]
    extra = {k: v for k, v in s.items() if re.search(r"rune|mastery|perk|talent", k, re.I) and v}
    print("\n  niet-nul rune/mastery velden:", extra or "GEEN")
    print("  teams[0] keys:", list(full.get("teams",[{}])[0].keys()))
