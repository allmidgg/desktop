# allmid.gg op de server zetten

Dit is de handleiding voor de dedicated server: **Windows Server met IIS 10**.

Op die machine draait al een andere site op poort 80. Alles hieronder is
geschreven om daar *naast* te komen en niet overheen. IIS kan meerdere sites op
dezelfde poort hebben zolang ze op hostnaam verschillen, en een binding mét
hostnaam wint van een binding zonder. De bestaande site blijft dus alles
opvangen wat niet `allmid.gg` is.

`install-site.ps1` weigert te draaien als een hostnaam al bij een andere site
hoort. Het pakt niets af.

## Wat waar komt te staan

| | |
|---|---|
| Site | `C:\inetpub\allmid` — statische bestanden, IIS serveert ze rechtstreeks |
| Repo | `C:\allmid\desktop` — de broncode, voor de verzamelserver en het bouwen |
| Data | `C:\allmid\server-data\data\matches.jsonl` — de gebundelde database |
| Logs | `C:\allmid\logs\collector.log` |
| Sleutel | `C:\allmid\start-collector.cmd` — **buiten de repo**, alleen leesbaar voor Administrators |

De verzamelserver luistert op **127.0.0.1:8123**. Poort 8080 was al bezet op
deze machine, en localhost-only is bewust: IIS stuurt `/api/` erheen, dus dat is
de enige weg naar binnen en de snelheidsbegrenzing valt niet te omzeilen.

## Eenmalig

### 1. Twee IIS-modules

Nodig om `/api/` door te sturen naar de verzamelserver. Zonder deze twee geeft
IIS een **500** op `web.config`, en dat is achteraf een vervelende fout om te
zoeken.

- [URL Rewrite](https://www.iis.net/downloads/microsoft/url-rewrite)
- [Application Request Routing](https://www.iis.net/downloads/microsoft/application-request-routing)

Na het installeren van ARR moet de proxy nog aan:

```
IIS Manager > (servernaam) > Application Request Routing Cache
  > Server Proxy Settings... > "Enable proxy" aanvinken > Apply
```

Dat is een serverbrede instelling. Draaide er al iets anders achter een proxy,
dan staat hij waarschijnlijk al aan.

### 2. Node

Node **20 of nieuwer** (24 is wat de CI gebruikt).

De verzamelserver is TypeScript en wordt geladen door `tsx`. Kale node met
`--experimental-strip-types` werkt hier **niet**: de imports hebben geen
bestandsextensie en de ESM-resolver van node eist die wel. Dat is getest, niet
aangenomen.

### 3. De repo neerzetten

```powershell
git clone https://github.com/allmidgg/desktop.git C:\allmid\desktop
cd C:\allmid\desktop
npm ci
```

`npm ci` is niet optioneel: `tsx` komt daaruit, en zonder `node_modules` start
de verzamelserver niet.

### 4. De site aanmaken

```powershell
powershell -ExecutionPolicy Bypass -File C:\allmid\desktop\deploy\install-site.ps1
```

Maakt de toepassingsgroep, de site en de bindingen voor `allmid.gg` en
`www.allmid.gg`. Herhaalbaar: bestaat er al iets, dan wordt het bijgewerkt.

### 5. De verzamelserver

```powershell
powershell -ExecutionPolicy Bypass -File C:\allmid\desktop\deploy\install-collector.ps1 -ApiKey "<lange-willekeurige-sleutel>"
```

Verzin een sleutel van minstens 24 tekens. Dat is het enige dat uploaden
afschermt; zonder sleutel mag iedereen de database volschrijven.

Dit registreert een geplande taak die bij het opstarten meekomt en zichzelf
herstart als hij valt. Node kan niet rechtstreeks als Windows-dienst draaien —
een dienst moet aan het Service Control Manager-protocol voldoen en `node.exe`
doet dat niet. De gebruikelijke oplossing is een extra programma zoals `nssm`
installeren; een geplande taak is ingebouwd, doet hetzelfde, en scheelt een
download die je moet vertrouwen.

### 6. HTTPS

Poort 443 was op deze machine nog helemaal ongebruikt. Gebruik
[win-acme](https://www.win-acme.com/): dat regelt een Let's Encrypt-certificaat,
hangt het aan de IIS-bindingen en vernieuwt het vanzelf.

```powershell
.\wacs.exe
# N (nieuw certificaat) > kies de site allmid.gg > beide hostnamen > bevestigen
```

Zet daarna een omleiding van http naar https. Doe dat **op de AllMid-site**, niet
serverbreed — anders raak je de andere site die op deze machine draait.

## Publiceren

Elke keer dat de site verandert:

```powershell
powershell -ExecutionPolicy Bypass -File C:\allmid\desktop\deploy\publish.ps1
```

Dat bouwt `index.html` opnieuw uit de datamomentopname, spiegelt `site\` naar
`C:\inetpub\allmid` en zet `web.config` ernaast.

De ontwerpvarianten (`site\_var-*.html`) gaan **niet** mee. Die staan al in
`.gitignore`, maar iemand kan ze lokaal hebben staan en ze horen niet op een
publieke site.

## Wat er nog niet af is

**De cijfers op de site ververen zichzelf nog niet.** `site\data\*.json` zijn
momentopnamen die met de hand gemaakt zijn. Zolang dat zo is, veroudert de site
zodra de crawler doorloopt.

Wat daarvoor nog moet gebeuren: één generator die in één doorloop over
`matches.jsonl` alle databestanden opnieuw schrijft, en een geplande taak die
die generator plus `publish.ps1` bijvoorbeeld elk uur draait. Zolang die
generator er niet is, moet elke verversing met de hand.

De stap daarna is dat de site zijn cijfers rechtstreeks bij de verzamelserver
ophaalt in plaats van uit meegeleverde bestanden. Dan is er geen verversing meer
nodig, want site en server draaien op dezelfde machine.

## Als er iets misgaat

| Symptoom | Waar te kijken |
|---|---|
| 500 op elke pagina | URL Rewrite of ARR ontbreekt; zie stap 1 |
| 502 op `/api/` | verzamelserver ligt: `Get-Content C:\allmid\logs\collector.log -Tail 40` |
| `allmid.gg` toont de andere site | de binding met hostnaam ontbreekt; draai `install-site.ps1` opnieuw |
| Certificaat verloopt | win-acme-taak nakijken in de Taakplanner |

Snel controleren of de verzamelserver leeft:

```powershell
Invoke-RestMethod http://127.0.0.1:8123/api/v1/health
```
