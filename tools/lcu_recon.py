"""Recon: wat levert de LCU API op rond League Classic?"""
import base64, json, ssl, sys, urllib.request, re, os

LOCKFILE = r"C:\Riot Games\League of Legends\lockfile"

def lockfile():
    with open(LOCKFILE) as f:
        name, pid, port, pw, proto = f.read().split(":")
    return int(port), pw

PORT, PW = lockfile()
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE
AUTH = "Basic " + base64.b64encode(f"riot:{PW}".encode()).decode()

def get(path):
    req = urllib.request.Request(f"https://127.0.0.1:{PORT}{path}", headers={"Authorization": AUTH})
    try:
        with urllib.request.urlopen(req, context=CTX, timeout=10) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        return {"__error__": str(e)}

def show(title, data, limit=1200):
    print("=" * 70)
    print(title)
    print("-" * 70)
    s = json.dumps(data, indent=2, ensure_ascii=False)
    print(s[:limit] + (" ...[truncated]" if len(s) > limit else ""))

if __name__ == "__main__":
    print(f"LCU op poort {PORT}\n")
    s = get("/lol-summoner/v1/current-summoner")
    show("Huidige summoner", {k: s.get(k) for k in ("gameName","tagLine","summonerLevel","puuid")} if "__error__" not in s else s)

    ph = get("/lol-gameflow/v1/gameflow-phase")
    show("Gameflow phase", ph)

    qs = get("/lol-game-queues/v1/queues")
    if isinstance(qs, list):
        classic = [q for q in qs if re.search(r"classic|nostalg|legacy|retro", json.dumps(q), re.I)]
        print("=" * 70)
        print(f"Queues totaal: {len(qs)} | met 'classic'-achtige tekst: {len(classic)}")
        print("-" * 70)
        for q in qs:
            print(f'  id={q.get("id"):<6} map={q.get("mapId"):<4} type={str(q.get("type")):<28} '
                  f'gameMode={str(q.get("gameMode")):<12} enabled={q.get("queueAvailability")} :: {q.get("name")}')
    else:
        show("Queues", qs)
