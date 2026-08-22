"""LCU event sniffer: luistert naar alle client-events en logt welke URI's veranderen.

Gebruik: python tools/lcu_sniff.py [seconden] [filter-regex]
Doel: ontdekken welke endpoints League Classic (JADE) gebruikt voor masteries/runes.
"""
import asyncio, base64, json, re, ssl, sys, time
from collections import Counter
from pathlib import Path

import websockets

LOG = Path(__file__).parent.parent / "data" / "sniff.log"
LOG.parent.mkdir(exist_ok=True)

DURATION = int(sys.argv[1]) if len(sys.argv) > 1 else 180
FILTER = re.compile(sys.argv[2], re.I) if len(sys.argv) > 2 else None
# ruis die elke seconde binnenkomt en niks zegt
NOISE = re.compile(r"lol-heartbeat|riotclient|/performance|lol-chat/v1/conversations/.*/messages|"
                   r"telemetry|lol-activity-center|lol-regalia|patcher|lol-cosmetics", re.I)

def creds():
    with open(r"C:\Riot Games\League of Legends\lockfile") as f:
        _, _, port, pw, _ = f.read().split(":")
    return int(port), pw

async def main():
    port, pw = creds()
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    auth = base64.b64encode(f"riot:{pw}".encode()).decode()
    seen, hits = Counter(), []
    print(f"Verbonden met LCU op poort {port}. Luistert {DURATION}s...")
    print("--> Open nu in de client: League Classic -> Runes / Masteries, en klik wat rond.\n")

    async with websockets.connect(
        f"wss://127.0.0.1:{port}/", ssl=ctx,
        additional_headers={"Authorization": f"Basic {auth}"},
        subprotocols=["wamp"], max_size=None, ping_interval=None,
    ) as ws:
        await ws.send(json.dumps([5, "OnJsonApiEvent"]))  # 5 = SUBSCRIBE
        end = time.time() + DURATION
        with LOG.open("w", encoding="utf-8") as fh:
            while time.time() < end:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=max(1, end - time.time()))
                except asyncio.TimeoutError:
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                if not (isinstance(msg, list) and len(msg) == 3):
                    continue
                payload = msg[2]
                uri, ev = payload.get("uri", ""), payload.get("eventType", "")
                if NOISE.search(uri):
                    continue
                seen[f"{ev:<7} {uri}"] += 1
                fh.write(json.dumps(payload, ensure_ascii=False)[:4000] + "\n")
                interesting = FILTER.search(uri) if FILTER else re.search(
                    r"jade|perk|rune|mastery|loadout|talent|champ-select|item-set", uri, re.I)
                if interesting:
                    hits.append(payload)
                    print(f"  [{ev:<6}] {uri}")

    print("\n" + "=" * 74)
    print(f"TOP URI'S ({len(seen)} unieke, volledige log: {LOG})")
    print("=" * 74)
    for k, v in seen.most_common(35):
        print(f"  {v:>4}x  {k}")
    if hits:
        print("\n" + "=" * 74)
        print(f"RELEVANTE EVENTS ({len(hits)}) — eerste payload per unieke URI")
        print("=" * 74)
        shown = set()
        for h in hits:
            if h["uri"] in shown:
                continue
            shown.add(h["uri"])
            print(f'\n[{h["eventType"]}] {h["uri"]}')
            print("  " + json.dumps(h.get("data"), ensure_ascii=False)[:1200])
    else:
        print("\nGeen jade/perk/rune/mastery events gezien.")

asyncio.run(main())
