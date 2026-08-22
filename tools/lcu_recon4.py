"""Recon 4: kunnen we ANDERE spelers opvragen? En bestaat er JADE-ranked data?"""
import base64, json, ssl, urllib.request

with open(r"C:\Riot Games\League of Legends\lockfile") as f:
    _, _, PORT, PW, _ = f.read().split(":")
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
AUTH = "Basic " + base64.b64encode(f"riot:{PW}".encode()).decode()
def get(p):
    r = urllib.request.Request(f"https://127.0.0.1:{PORT}{p}", headers={"Authorization": AUTH})
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=20) as x: return json.loads(x.read().decode("utf-8"))
    except Exception as e: return {"__error__": f"{type(e).__name__}: {e}"}

items = get("/lol-game-data/assets/v1/items.json")
jade_items = [i for i in items if 770000 < i["id"] < 780000]
print(f"JADE items (77xxxx) in items.json: {len(jade_items)}")
for i in jade_items[:8]: print(f'   {i["id"]:<8} {i.get("name"):<28} price={i.get("priceTotal")}')

me = get("/lol-summoner/v1/current-summoner")
print(f'\nIk: {me["gameName"]}#{me["tagLine"]}  puuid={me["puuid"]}')

print("\n--- RANKED STATS (eigen) ---")
rs = get(f'/lol-ranked/v1/current-ranked-stats')
if "__error__" not in rs:
    for q, v in (rs.get("queueMap") or {}).items():
        if v.get("tier") or v.get("wins"): print(f'   {q:<28} {v.get("tier")} {v.get("division")} {v.get("leaguePoints")}LP  W{v.get("wins")}/L{v.get("losses")}')
    print("   highestRankedEntry:", rs.get("highestRankedEntry", {}).get("queueType"))

# een tegenstander uit de laatste game
mh = get("/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=1")
gid = mh["games"]["games"][0]["gameId"]
full = get(f"/lol-match-history/v1/games/{gid}")
other = next(p["player"] for p in full["participantIdentities"] if p["player"]["puuid"] != me["puuid"])
print(f'\n--- ANDERE SPELER: {other["gameName"]}#{other["tagLine"]} ({other["puuid"]}) ---')

for path in [
    f'/lol-summoner/v2/summoners/puuid/{other["puuid"]}',
    f'/lol-match-history/v1/products/lol/{other["puuid"]}/matches?begIndex=0&endIndex=5',
    f'/lol-ranked/v1/ranked-stats/{other["puuid"]}',
]:
    d = get(path)
    label = path.split("?")[0][:60]
    if isinstance(d, dict) and "__error__" in d:
        print(f'   {label:<62} FOUT {d["__error__"][:50]}')
    else:
        j = json.dumps(d, ensure_ascii=False)
        print(f'   {label:<62} OK  {len(j)} bytes')
        if "matches" in path and isinstance(d, dict):
            for g in (d.get("games", {}) or {}).get("games", [])[:5]:
                print(f'       -> queue={g["queueId"]} mode={g["gameMode"]} champ={g["participants"][0]["championId"]} win={g["participants"][0]["stats"]["win"]}')
        if "ranked-stats" in path:
            for q, v in (d.get("queueMap") or {}).items():
                if v.get("tier"): print(f'       -> {q}: {v.get("tier")} {v.get("division")} {v.get("leaguePoints")}LP')
