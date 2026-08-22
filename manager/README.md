# Server Manager

Eén desktop-app die meerdere game-servers host. Nu draait er één service —
**League of Legends Classic**, die matchdata van clients verzamelt — maar de opzet
is gemaakt om er games bij te krijgen zonder dat er aan de host iets verandert.

De app staat naast jade.gg in dezelfde repo en deelt de dependencies, maar bouwt
naar zijn eigen `manager/out` en start met zijn eigen main-proces.

## De vorm: host + services

```
                 ┌──────────────────────────────┐
   clients ─────▶│  host.ts   één HTTP-server   │
                 │  poort 8080, pad-routering   │
                 └───┬──────────────────────┬───┘
                     │ /lol-classic/…       │ /ander-spel/…
                 ┌───▼──────────┐       ┌───▼──────────┐
                 │ GameService  │       │ GameService  │
                 │  eigen data  │       │  eigen data  │
                 └──────────────┘       └──────────────┘
```

De host doet alles wat met de buitenwereld te maken heeft: luisteren, het verzoek
uitpakken, rate limiting, loggen, en het antwoord terugsturen. Een service krijgt
een uitgepakt verzoek binnen en geeft een status plus een object terug. Meer niet.

Daardoor kan elke service los gestart, gestopt en herstart worden terwijl de host
blijft luisteren. Een gestopte service houdt zijn paden: die antwoorden dan met
**503**, zodat een client het verschil ziet tussen "even niet" en "bestaat niet".

## Waarom één poort met pad-routering, en niet een poort per service

Een poort per service lijkt netter — echt gescheiden processen, elk hun eigen
server — maar het kost de gebruiker meer dan het oplevert:

- **Eén poort om open te zetten.** Wie dit thuis draait moet in zijn router één
  regel maken en één keer de firewall doorstaan. Bij een poort per service moet
  dat opnieuw bij elke game die erbij komt, en dat is precies het moment waarop
  mensen afhaken.
- **Eén adres om te delen.** Clients kennen `http://host:8080/lol-classic/...`.
  Komt er een game bij, dan is dat een pad erbij, geen nieuw adres. Achter een
  reverse proxy met TLS scheelt dat ook een certificaat en een subdomein per game.
- **Een service kan de host niet slopen.** Zou elke service zelf `listen()` doen,
  dan bepaalt hij ook zelf wat er gebeurt bij een bezette poort, en kan een fout
  in zijn opstartcode de hele app meenemen. Nu is er precies één plek die luistert
  en precies één plek die fouten opvangt.
- **Starten en stoppen doet niets met verbindingen.** Een service stoppen sluit
  geen socket; het zet alleen een vlag om. Geen half afgebroken verbindingen, geen
  poort die in `TIME_WAIT` blijft hangen waardoor herstarten mislukt.
- **Eén logboek en één teller.** Alle verzoeken lopen door hetzelfde punt, dus de
  UI kan ze eerlijk optellen en op volgorde tonen.

Wat we ervoor inleveren: services delen één proces, dus een service die het
geheugen volloopt of de event loop blokkeert raakt de rest. Dat is een bewuste
ruil — het gaat om lees- en schrijfwerk op JSONL-bestanden, niet om rekenwerk —
en het contract houdt de deur open: `basePath` is het enige wat een client van de
indeling ziet, dus een service naar een eigen proces verhuizen kan later zonder
dat er één client iets merkt.

## Het contract

`src/main/services/types.ts` is het enige raakvlak tussen host en services. De
host kent geen enkele service bij naam; een service kent de host niet.

```ts
interface GameService {
  id: string           // 'lol-classic', ook de naam van de datamap
  name: string         // 'League of Legends Classic'
  description: string
  basePath: string     // '/lol-classic'

  start(ctx: ServiceContext): Promise<void>
  stop(): Promise<void>
  routes(): ServiceRoute[]
  summary(): Promise<ServiceSummary>
}
```

De afspraken die niet uit de types af te lezen zijn:

- **Nooit zelf luisteren.** Geen `createServer`, geen `listen`. De host doet dat.
- **`routes()` is vast.** Altijd dezelfde lijst, ook op een gestopte service. De
  host mount de paden één keer en beantwoordt ze met 503 zolang er niet gedraaid
  wordt. `path` is relatief aan `basePath`, exacte match, en een pad dat eindigt
  op `/*` matcht ook alles eronder.
- **`start()` mag traag zijn** — een database inlezen duurt even — en mag gooien.
  De host onthoudt de fout, zet de status op `error` en draait door.
- **`stop()` geeft alles vrij** wat `start()` heeft aangezet: timers, watchers,
  open bestanden. Wordt ook aangeroepen als de app sluit.
- **`summary()` is goedkoop.** De UI vraagt hem periodiek op, dus tellers bijhouden
  in het geheugen in plaats van uitrekenen. Werkt ook op een gestopte service.
- **Data blijft binnen `ctx.dataRoot`.** Die map bestaat al als `start()` draait.
- De sleutels van `ServiceSummary.detail` komen letterlijk in beeld: kort en
  Engels, zoals `"Players"` of `"Last upload"`.

`shared/types.ts` is hetzelfde verhaal tussen main-proces en UI. De UI krijgt met
`ManagerSnapshot` in één keer de hele stand van zaken en houdt zelf geen staat
bij, zodat er nooit een halve waarheid in beeld staat waarin de ene service al
gestopt is en de teller van de andere nog van tien seconden geleden komt.
`MANAGER_CHANNELS` staat daar ook, zodat main, preload en renderer niet elk hun
eigen spelling van een kanaalnaam kunnen verzinnen.

De renderer haakt het geheel aan `window.manager` op met de `ManagerApi` uit
`shared/types.ts`.

## Structuur

```
manager/shared/types.ts            IPC-types tussen main-proces en UI
manager/src/main/                  Electron main-proces: venster, IPC, host
manager/src/main/services/         het contract plus de services zelf
manager/src/preload/               de afgebakende brug naar de UI
manager/src/renderer/              de interface (React + Tailwind)
manager/out/                       buildresultaat, los van dat van jade.gg
```

## Ontwikkelen

```bash
npm run manager:dev      # dev-server plus Electron
npm run manager:build    # naar manager/out
```

Twee dingen om te weten bij het draaien:

- `package.json` blijft van jade.gg: het `main`-veld wijst naar `out/main/index.js`.
  De manager-config zet daarom `ELECTRON_ENTRY` zodat electron-vite de juiste app
  opstart. Wie de manager buiten deze scripts om start, moet dat pad zelf meegeven.
- Electron leidt de map voor gebruikersdata af uit de naam in `package.json`, en
  die is voor beide apps gelijk. Het main-proces zet daarom zijn eigen naam en
  `userData`-pad, anders delen de manager en jade.gg hun instellingen.
