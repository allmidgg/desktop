"""Recon 2: match history, JADE-specifieke game data (champs/items/runes)."""
import base64, json, ssl, urllib.request

with open(r"C:\Riot Games\League of Legends\lockfile") as f:
    _, _, PORT, PW, _ = f.read().split(":")
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
AUTH = "Basic " + base64.b64encode(f"riot:{PW}".encode()).decode()

def get(path, raw=False):
    req = urllib.request.Request(f"https://127.0.0.1:{PORT}{path}", headers={"Authorization": AUTH})
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=15) as r:
            b = r.read()
            return b if raw else json.loads(b.decode("utf-8"))
    except Exception as e:
        return {"__error__": f"{type(e).__name__}: {e}"}

print("=" * 70, "\nMATCH HISTORY (laatste 20)\n", "-" * 70)
mh = get("/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=0&endIndex=20")
games = (mh.get("games", {}) or {}).get("games", []) if isinstance(mh, dict) else []
if not games:
    print("geen games / fout:", json.dumps(mh)[:400])
for g in games:
    p = g["participants"][0]["stats"]
    print(f'  {g["gameCreationDate"][:16]}  queue={g["queueId"]:<6} mode={g["gameMode"]:<10} map={g["mapId"]:<4} '
          f'dur={g["gameDuration"]//60}m  {p.get("kills")}/{p.get("deaths")}/{p.get("assists")}  win={p.get("win")}')

jade = [g for g in games if g["gameMode"] == "JADE" or g["mapId"] == 453]
print(f"\n  -> JADE games in laatste 20: {len(jade)}")
if jade:
    g = jade[0]
    print("\n" + "=" * 70, "\nVOORBEELD JADE-GAME (velden van 1 participant)\n", "-" * 70)
    print(json.dumps(g["participants"][0], indent=2, ensure_ascii=False)[:2500])
    print("\n-- gameVersion:", g.get("gameVersion"), "| teams:", len(g.get("teams", [])))

print("\n" + "=" * 70, "\nJADE-SPECIFIEKE GAME DATA ENDPOINTS\n", "-" * 70)
for path in [
    "/lol-game-data/assets/v1/champion-summary.json",
    "/lol-game-data/assets/v1/items.json",
    "/lol-game-data/assets/v1/perks.json",
    "/lol-game-data/assets/v1/perkstyles.json",
    "/lol-game-data/assets/v1/maps.json",
    "/lol-game-data/assets/v1/summoner-spells.json",
]:
    d = get(path)
    if isinstance(d, dict) and "__error__" in d:
        print(f"  {path:<58} FOUT {d['__error__'][:40]}")
    else:
        n = len(d) if isinstance(d, list) else len(d.get("maps", d)) if isinstance(d, dict) else "?"
        print(f"  {path:<58} OK  entries={n}")

maps = get("/lol-game-data/assets/v1/maps.json")
if isinstance(maps, list):
    for m in maps:
        if m.get("id") in (453, 11, 12):
            print(f'    map {m.get("id")}: {m.get("name")} / {m.get("description","")[:60]}')
