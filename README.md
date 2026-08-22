# jade.gg

Stats, scouting en overlay voor **League of Legends Classic** — de modus die geen
enkele bestaande tool ondersteunt.

## Waarom dit bestaat

Blitz, Porofessor, Mobalytics en OP.GG laten bij League Classic niets zien. Niet
omdat het niet kan, maar omdat ze allemaal filteren op `mapId` 11/12 en
`gameMode: CLASSIC`. League Classic draait onder een andere naam en een andere
map, en valt daardoor overal buiten de boot. De publieke Riot API kent de
Classic-queues ook (nog) niet.

Wij halen alles rechtstreeks uit de lokale League-client. Die weet het wel.

## Wat we hebben uitgezocht

League Classic heet intern **`JADE`**.

| Onderwerp | Waarde |
| --- | --- |
| Game mode | `JADE` |
| Map | `453` — "Classic Rift" (`mapStringId: JD`) |
| Queues | `3260` / `3262` normal, `4310` ranked solo, `4320` bots |
| Ranked queue type | `JADE_RANKED_SOLO_5x5` |
| Client-plugin | `rcp-fe-lol-jade` |
| Rank-tiers | eigen ladder: o.a. **Wood**, **Salt** (niet Iron→Challenger) |

### ID-ruimtes

Classic-champions en -items bestaan naast hun moderne tegenhangers en hebben
daarom eigen ID's:

| Type | Formule | Voorbeeld |
| --- | --- | --- |
| Champion | `60000 + basisId` | Ashe `22` → `60022`, alias `Jade_Ashe` |
| Item | `770000 + basisId` | Infinity Edge `3031` → `773031` |
| Summoner spell | `"7" + basisId` | Flash `4` → `74`, Teleport `12` → `712` |

De client serveert zelf de bijbehorende namen en iconen:

- 63 Classic-champions in `/lol-game-data/assets/v1/champion-summary.json`
- 162 Classic-items in `/lol-game-data/assets/v1/items.json`

`src/core/jade/catalog.ts` bouwt daar de catalogus uit op en **controleert de
formules tegen de assets**, zodat we het merken als Riot de afspraak verandert.

### Wat er (nog) niet in de matchhistorie zit

De velden `perk0` t/m `perk5` zijn in Classic-games allemaal `0`: welke runes en
masteries iemand droeg wordt niet in de matchhistorie vastgelegd. Voor je eigen
pagina's maakt dat niet uit (die staan in de loadout, zie onder), maar het betekent
wel dat we van andere spelers nooit kunnen zien waarmee ze speelden.

## Aanpak

Alles loopt via de **LCU API** (de lokale HTTPS-server van de client) en straks de
**Live Client Data API** op poort 2999. Dat zijn de officiële, door Riot
toegestane routes die Blitz en Porofessor ook gebruiken. Geen memory reading,
geen injectie, geen scripting van gameplay.

Praktisch voordeel: omdat de client namens jou de publieke matchhistorie en
ranked-gegevens van willekeurige spelers mag opvragen, hebben we **geen Riot
API-key nodig**.

## Gebruik

Start de app met de snelkoppeling **jade.gg** op je bureaublad, of met
`Start jade.gg.bat` in deze map. De League-client mag al draaien of later
opstarten -- jade.gg pikt de verbinding vanzelf op.

De interface is Engels. De app heeft vier schermen plus een popup:

| Scherm | Wat je ziet |
| --- | --- |
| **Live** | Je huidige status en je laatste Classic-games met items, spells en KDA. |
| **Champion select** | Verschijnt als **eigen popup** zodra select begint, altijd bovenop. Per lane: wie staat tegenover wie, hun rank en winrate, hun staat van dienst op die champion, hun gebruikelijke rol, de matchup-winrate en de beste counters. |
| **Profiel** | Je eigen cijfers, plus een zoekveld om elke speler op te zoeken. |
| **Runes** | Per champion de beste rune-pagina die je met je bezit kunt maken, met koopadvies, en een knop om hem in te stellen. |
| **Masteries** | Al je pagina's en de volledige boom van het 30-punten-systeem. |

### Ontwikkelen

Vereist: Node 20+.

```bash
npm install
npm run dev
```

Champion select testen zonder in de wachtrij te staan -- speelt je laatste
gespeelde game na als select:

```bash
JADE_DEMO_CHAMPSELECT=1 npx electron .
```

De CLI-versies blijven bestaan voor snel testen zonder UI:

Scout de tien spelers uit je laatste Classic-game:

```bash
npm run scout
```

Eén speler opzoeken:

```bash
npm run scout -- Faker#KR1
```

Je mastery- en rune-pagina's plus je rune-bezit bekijken:

```bash
npm run loadout
```

De beste rune-pagina die je nu kunt maken, voor een champion:

```bash
npm run runes -- Ashe
```

## De matchdatabase

Counters, tier lists en matchup-winrates bestaan nergens voor deze modus, dus
verzamelen we ze zelf. Elke game die we tegenkomen wordt uitgekleed tot de velden
die statistisch tellen en weggeschreven als een regel JSON in `data/matches.jsonl`.

Elke game levert tien spelers op, en elke speler levert weer games op -- de
crawler loopt dat netwerk af vanaf jouw eigen account. Bewust ingehouden: één
verzoek tegelijk met een pauze ertussen, en nooit tijdens champion select of een
lopende game.

```bash
npm run crawl -- 50
```

Wat de data mogelijk maakt:

- **Matchup-winrates per lane.** Riot levert `lane` en `role` per speler, dus we
  weten wie er echt tegenover wie stond. Een matchup telt pas mee vanaf 8 games.
- **Rol-inschatting.** In ranked verbergt Riot de namen van tegenstanders en
  wijst het alleen jouw eigen team een positie toe. Van spelers die we al kennen
  weten we waar ze meestal spelen -- daarmee koppelen we de lanes.
- **Tier lists per positie**, gesorteerd op een naar 50% getrokken winrate, zodat
  "3 van de 4 gewonnen" niet als 75% bovenaan komt te staan.

## Masteries en runes

Classic bewaart die niet in de perks-plugin waar de moderne runes zitten, maar
als slots in je **account-loadout**:

```
MASTERY_PAGE_3_MASTERY_17    een van de 30 puntslots van pagina 3
RUNE_PAGE_1_BLUE_4           het vierde glyph-slot van rune-pagina 1
ACTIVE_MASTERY_PAGE          welke pagina actief is
```

- **Masteries**: 3 bomen (Offense/Defense/Utility), 6 rijen elk, 30 punten te
  verdelen. De volledige boom staat in `jade-mastery-display.json`, inclusief
  `maxRank` en `pointsRequired` per rij — genoeg om pagina's te valideren
  voordat we ze wegschrijven. Riot's eigen presets komen door onze validatie heen.
- **Runes**: 59 stuks (12 Marks, 13 Seals, 14 Glyphs, 20 Quintessences) in
  `jade-perks.json`, mét machineleesbare stats. Slots: 9/9/9/3.
- Runes moeten **gekocht** worden. De optimizer rekent daarom met je inventaris
  en kiest de beste pagina die je nú kunt maken, plus wat een aankoop zou opleveren.

Schrijven gaat via `PATCH /lol-loadouts/v4/loadouts/{id}`. Dat past je echte
pagina's aan, dus er wordt eerst een kopie weggeschreven naar `data/backups/`.

## Structuur

```
src/core/lcu/         verbinding met de client (lockfile, auth, HTTP, events)
src/core/jade/        ID-vertaling, champions/items/spells, masteries, runes
src/core/services/    speleranalyse, champ select, loadout, rune-optimizer
src/main/             Electron main-proces: vensters, IPC, asset-protocol
src/preload/          de afgebakende brug tussen UI en main-proces
src/renderer/         de interface (React + Tailwind)
src/cli/              terminalversies voor snel testen
tools/                Python-scripts voor reverse engineering van de client
```
