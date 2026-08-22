# allmid.gg op de server zetten

Dit is de handleiding voor de dedicated server: **Windows Server met IIS 10**.

Op die machine draait al een andere site op poort 80. Alles hieronder is geschreven
om daar *naast* te komen en niet overheen. IIS kan meerdere sites op dezelfde poort
hebben zolang ze op hostnaam verschillen, en een binding mét hostnaam wint van een
binding zonder. De bestaande site blijft dus alles opvangen wat niet `allmid.gg` is.

`install-site.ps1` weigert te draaien als een hostnaam al bij een andere site hoort.
Het pakt niets af.

---

## Eerst: dit installeer je zelf

`bootstrap.ps1` installeert **niets**. Het controleert of onderstaande er is, en stopt
met een downloadlink zodra er iets ontbreekt. Dat is een bewuste keuze: de vorige
versie haalde node, git en twee MSI's binnen en installeerde die als SYSTEM. Dat
leverde het grootste deel van het risico van het hele script op, en het bespaarde je
vier keer klikken. Bovendien deed het dat met `winget`, dat op een kale
Windows Server 2019/2022 helemaal niet bestaat.

| Voorwaarde | Waar | Waarom |
|---|---|---|
| **Windows Server, x64** | — | op werkstation-Windows ontbreken IIS-onderdelen en gedraagt een geplande taak zich anders |
| **PowerShell 5.1**, als Administrator | zit in Windows | de scripts wijzigen IIS-configuratie en registreren een taak als SYSTEM |
| **IIS 10** + beheerscripts | `Install-WindowsFeature Web-Server -IncludeManagementTools` en `Install-WindowsFeature Web-Scripting-Tools` | zonder de module `WebAdministration` kan er niets aan IIS gecontroleerd of toegevoegd worden |
| **URL Rewrite** | <https://www.iis.net/downloads/microsoft/url-rewrite> | zonder deze module geeft IIS een **500** op onze `web.config` |
| **Application Request Routing** | <https://www.iis.net/downloads/microsoft/application-request-routing> | zonder ARR komt `/api/` nergens: dat is de module die doorstuurt |
| **Node 20 of nieuwer** | <https://nodejs.org/en/download> (Windows Installer .msi, x64) | de verzamelserver draait hierop. Staat er al een Node op deze machine waar iets anders van afhangt, dan blijft die met rust — het script vervangt hem niet |
| **Git for Windows** | <https://git-scm.com/download/win> | de repo wordt gekloond en later bijgewerkt met `git pull` |

Het installeren van URL Rewrite en ARR **herstart de IIS-werkprocessen**. Doe dat dus
ook buiten piekuren, net als de eerste run van het script hieronder.

De verzamelserver is TypeScript en wordt geladen door `tsx`. Kale node met
`--experimental-strip-types` werkt hier **niet**: de imports hebben geen
bestandsextensie en de ESM-resolver van node eist die wel. Dat is getest, niet
aangenomen.

## In één regel

In een PowerShell **als Administrator**, op de server:

```powershell
&([scriptblock]::Create((irm https://raw.githubusercontent.com/allmidgg/desktop/main/deploy/bootstrap.ps1))) -DryRun
```

Deze vorm en niet `irm ... | iex`, omdat `iex` geen schakelaars kan doorgeven — en
`-DryRun` is de eerste die je wilt. Die voert **alle controles echt uit**, laat regel
voor regel zien wat er zou gebeuren en met welke opdracht je elke wijziging
terugdraait, en raakt niets aan. Klopt het beeld, dan dezelfde regel zonder `-DryRun`.

### Op een machine die niet stuk mag: eerst downloaden, dan lezen

Het adres hierboven bevat `/main/`. Dat levert bij elke run op wat er op dát moment op
`main` staat — je voert dus code uit die je niet gezien hebt, met volle rechten. Op de
productieserver liever zo:

```powershell
# 1. binnenhalen en lezen
irm https://raw.githubusercontent.com/allmidgg/desktop/main/deploy/bootstrap.ps1 -OutFile bootstrap.ps1
notepad bootstrap.ps1

# 2. het bestand draaien dat je zojuist gelezen hebt
powershell -ExecutionPolicy Bypass -File .\bootstrap.ps1 -DryRun
```

Wil je vastleggen wélke versie je draait, zet dan een commit-hash in plaats van `main`
in het adres:
`https://raw.githubusercontent.com/allmidgg/desktop/<commit-hash>/deploy/bootstrap.ps1`.
Dat adres levert altijd exact hetzelfde bestand.

Datzelfde geldt voor de repo die op de server komt te staan: het script laat vóór het
klonen of bijwerken zien welke **commit** er straks als Administrator uitgevoerd gaat
worden (hash, datum, auteur, onderwerp, plus een waarschuwing als de werkmap afwijkt)
en vraagt om bevestiging. Ondertekening is er niet; eerlijk laten zien wat er draait
wel.

### Schakelaars

| | |
|---|---|
| `-DryRun` | alle controles echt doen, niets wijzigen |
| `-Force` | de bevestigingsvragen overslaan (voor onbeheerde runs). Slaat géén controles over |
| `-ApiKey` | je eigen sleutel meegeven |
| `-NewApiKey` | een nieuwe sleutel afdwingen — **alle al ingerichte clients moeten daarna opnieuw ingesteld worden** |
| `-SiteName`, `-SiteRoot`, `-SiteHosts`, `-RepoRoot`, `-RepoUrl`, `-Branch`, `-AllmidRoot`, `-TaskName` | paden en namen |

Er is met opzet **geen** `-CollectorPort`. Die werkte maar half: de poort staat ook in
`deploy/web.config` en die werd niet meegewijzigd. Nu leest `bootstrap.ps1` de poort
uít `deploy/web.config` en geeft die door aan `install-collector.ps1`. Andere poort
nodig? Wijzig hem in `deploy/web.config` — dat is de enige plek.

## Wat het script wél en niet aanraakt

Het **voegt alleen toe**. Een bestaande site, toepassingsgroep of binding wordt nooit
gewijzigd, gestopt of verwijderd. Botst er iets — een andere site claimt `allmid.gg`,
of er staat al een site met die naam die ergens anders naar wijst — dan stopt het met
uitleg. Twee keer draaien mag: elke stap kijkt eerst of hij nog nodig is.

Wat de bestaande site tóch merkt:

- Het script schrijft drie keer in `applicationHost.config` (de beschermregel
  hieronder, de ARR-proxy, en de nieuwe site). IIS leest die configuratie daarna
  opnieuw in en **recyclet de toepassingsgroepen — ook die van de andere site**. Dat
  duurt seconden en de site komt vanzelf terug, maar verzoeken die op dat moment
  onderweg zijn kunnen sneuvelen. Het script meldt dit vóóraf en **vraagt om
  bevestiging**; met `-Force` slaat het die vraag over. Plan de eerste run buiten
  piekuren.

Wat het **niet** doet is HTTPS — zie [stap 6](#6-https--doe-je-zelf). Dat vereist je
Cloudflare-account. Aan het eind van de run staat precies wat je nog zelf moet doen.

Van elke run komt een logboek in `C:\allmid\logs\bootstrap-<datum>.log`, met per
wijziging of hij geslaagd of mislukt is en hoe je hem terugdraait. De API-sleutel staat
er met opzet niet in.

## De ARR-proxy is een open proxy — en wat daartegen gedaan wordt

Dit is belangrijk genoeg voor een eigen kopje. `system.webServer/proxy enabled=true` op
APPHOST-niveau is nodig om `/api/` te kunnen doorsturen, maar diezelfde schakelaar
maakt van IIS ook een **forward proxy** voor verzoeken met een absolute URI in de
requestregel:

```
GET http://ergens-anders.example/ HTTP/1.1
```

Zonder maatregel kan iedereen op internet deze server dus gebruiken om verkeer te
versturen dat van jouw IP-adres lijkt te komen. Een eerdere versie van dit script
beweerde in het commentaar het tegenovergestelde. Dat was fout.

`bootstrap.ps1` zet daarom — **vóór** het aanzetten van de proxy, zodat er geen open
moment bestaat — een serverbrede URL Rewrite-regel neer:

```
system.webServer/rewrite/globalRules
  rule "allmid-weiger-absolute-uri", stopProcessing
    match url = .*
    conditions logicalGrouping = MatchAny
      {UNENCODED_URL}  matcht  ^[a-zA-Z][a-zA-Z0-9+.-]*://
      {HTTP_URL}       matcht  ^[a-zA-Z][a-zA-Z0-9+.-]*://
      {REQUEST_URI}    matcht  ^[a-zA-Z][a-zA-Z0-9+.-]*://
    action = CustomResponse 403
```

Waarom zo:

- Een conditie op serverbenamingen en niet het patroon van de regel zelf, omdat
  Microsoft documenteert dat globale regels altijd op het **pad** werken ("the
  requested URI without the server name"). Een patroon `^https?://` zou daar nooit op
  passen. `UNENCODED_URL` is gedocumenteerd als de URL "exactly as it was requested by
  a Web client"; de drie staan in een `MatchAny` zodat één treffer genoeg is.
- Dit raakt de bestaande site niet: een gewoon verzoek stuurt `GET /pad HTTP/1.1`, en
  dat begint met een schuine streep. Het patroon is verankerd aan het begin, dus ook
  `/redirect?url=http://...` past er niet op.
- Alle drie de variabelen staan op de lijst van Microsoft met server-variabelen die de
  uitvoercache van IIS **niet** uitschakelen, dus dit kost geen prestaties.
- `globalRules` kan alleen op serverniveau en is op een lager niveau niet te
  overschrijven of uit te zetten, ook niet door een `web.config` van een andere site.

Stond de proxy al aan, dan blijft hij aan — die kan van iemand anders zijn — maar het
script meldt dat en zet de beschermregel er alsnog bij.

**Controleer het zelf.** Het script test het aan het eind ook (met een `.invalid`-naam,
die per RFC 6761 nergens naartoe resolvet, dus er verlaat niets de machine), maar doe
dit vanaf een andere machine:

```powershell
curl.exe -sS -o NUL -w "%{http_code}\n" -x http://<ip-van-de-server>:80 http://example.com/
```

- **403** — goed, de beschermregel weigert absolute URI's.
- **200** — alarm: de server heeft `example.com` voor je opgehaald. Open proxy.
- **502** — alarm: de server *probeerde* door te sturen. Ook een open proxy.

En meteen erna, om te zien dat de site zelf nog werkt (hoort 200 te geven):

```powershell
curl.exe -sS -o NUL -w "%{http_code}\n" -H "Host: allmid.gg" http://<ip-van-de-server>/
```

Klopt de eerste niet, zet de proxy dan uit tot het wel klopt:

```powershell
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' `
    -Filter 'system.webServer/proxy' -Name 'enabled' -Value $false
```

## Rechten op `C:\allmid`

`C:\` geeft via overerving `Authenticated Users: (OI)(CI)(IO)(M)` — elke ingelogde
gebruiker mag schrijven in wat daaronder nieuw wordt aangemaakt. En in
`C:\allmid\desktop` draait **SYSTEM** permanent code (de geplande taak start `node`
daaruit). Wie daar een bestand mag vervangen, voert straks code uit als SYSTEM.

Daarom verbreekt `bootstrap.ps1` bij het aanmaken de overerving en beperkt het
schrijfrechten tot `Administrators` en `SYSTEM`. Achteraf controleert het dat met
`icacls` en laat het de uitkomst zien. Zelf nakijken:

```powershell
icacls C:\allmid
```

Er hoort alleen `BUILTIN\Administrators:(OI)(CI)(F)` en `NT AUTHORITY\SYSTEM:(OI)(CI)(F)`
te staan, en géén `(I)` (dat zou geërfde rechten betekenen). Met de hand rechtzetten:

```powershell
icacls C:\allmid /inheritance:r /grant *S-1-5-32-544:(OI)(CI)F /grant *S-1-5-18:(OI)(CI)F
```

## Een tweede keer draaien

Dat mag, en het is de normale manier om bij te werken. Drie dingen die daarbij
gebeuren en die je moet weten:

- **De API-sleutel blijft dezelfde.** Staat er al een `C:\allmid\start-collector.cmd`,
  dan wordt de sleutel daaruit hergebruikt. Een nieuwe sleutel zou elke al ingerichte
  client breken. Wil je hem tóch vervangen: `-NewApiKey`, en stel daarna elke client
  opnieuw in.
- **De verzamelserver wordt even gestopt.** Een draaiende collector houdt bestanden in
  `node_modules` vast (aangetoond op `esbuild.exe`) en dan loopt `npm ci` vast. Het
  script stopt de geplande taak, draait `npm ci`, en start hem weer — ook als `npm ci`
  misgaat. `npm ci` overslaan "omdat er niets veranderd is" gebeurt bewust níét: `npm
  ci` gooit `node_modules` eerst helemaal weg en bouwt hem opnieuw op, en of die map op
  schijf nog klopt valt niet af te leiden uit een hash van het lockbestand.
- **De doelmap wordt gecontroleerd voordat er gespiegeld wordt.** `publish.ps1` gebruikt
  `robocopy /MIR`, en dat verwijdert in de doelmap alles wat niet in de bron staat. Het
  script publiceert daarom alleen als die map leeg is of aantoonbaar van ons — dat
  bewijs staat in `C:\allmid\state\site-target.txt`, buiten de gespiegelde map, want
  een merkbestand ín die map zou door de eerstvolgende `/MIR` verdwijnen.

`npm ci` draait met `--ignore-scripts`. De install- en postinstall-scripts van
afhankelijkheden draaien dus niet mee als Administrator. Dat is op deze boom
nagemeten: `esbuild` (waar `tsx` op leunt) heeft een postinstall, maar die valideert en
kopieert alleen de binary die al in het platformpakket `@esbuild/win32-x64` zit —
zonder dat script draait `tsx` gewoon, getest met een echt TypeScript-bestand met
extensieloze imports en met `esbuild` over `server/index.ts`. `electron` 43 heeft
helemaal geen install-script meer (de binary komt via `install-electron`), dus
`ELECTRON_SKIP_BINARY_DOWNLOAD` is zinloos geworden en is weg. `fsevents` is alleen
macOS, en `electron-winstaller` heeft wel een install-script maar wordt alleen gebruikt
om installers te bouwen, nooit op deze server. Na afloop controleert het script dat
`tsx` echt start, zodat een toekomstige afhankelijkheid die zijn install-script wél
nodig heeft daar opvalt.

---

Hieronder staan dezelfde stappen met de hand, voor wie liever zelf stuurt of moet
uitzoeken waar het misging.

## Wat waar komt te staan

| | |
|---|---|
| Site | `C:\inetpub\allmid` — statische bestanden, IIS serveert ze rechtstreeks |
| Repo | `C:\allmid\desktop` — de broncode, voor de verzamelserver en het bouwen |
| Data | `C:\allmid\server-data\data\matches.jsonl` — de gebundelde database |
| Logs | `C:\allmid\logs\collector.log` en `C:\allmid\logs\bootstrap-<datum>.log` |
| Sleutel | `C:\allmid\start-collector.cmd` — **buiten de repo**, alleen leesbaar voor Administrators en SYSTEM |
| Claim op de doelmap | `C:\allmid\state\site-target.txt` |

De verzamelserver luistert op **127.0.0.1:8123**. Poort 8080 was al bezet op deze
machine, en localhost-only is bewust: IIS stuurt `/api/` erheen, dus dat is de enige weg
naar binnen en de snelheidsbegrenzing valt niet te omzeilen. Die poort staat in
`deploy/web.config` en nergens anders.

## Eenmalig

### 1. De twee IIS-modules

Zie de tabel bovenaan. Na het installeren van ARR moet de proxy nog aan:

```
IIS Manager > (servernaam) > Application Request Routing Cache
  > Server Proxy Settings... > "Enable proxy" aanvinken > Apply
```

Doe je dat met de hand, zet dan ook zelf de beschermregel neer die hierboven staat —
anders is deze server een open proxy. `bootstrap.ps1` doet beide, in die volgorde.

### 2. Node

Node **20 of nieuwer** (24 is wat de CI gebruikt). Zie de tabel bovenaan.

### 3. De repo neerzetten

```powershell
git clone https://github.com/allmidgg/desktop.git C:\allmid\desktop
cd C:\allmid\desktop
npm ci --ignore-scripts
```

`npm ci` is niet optioneel: `tsx` komt daaruit, en zonder `node_modules` start de
verzamelserver niet. Draait de collector al, stop hem dan eerst
(`Stop-ScheduledTask -TaskName 'AllMid Collector'`), anders loopt `npm ci` vast op
bestanden die nog vastgehouden worden.

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

Verzin een sleutel van minstens 24 tekens. Dat is het enige dat uploaden afschermt;
zonder sleutel mag iedereen de database volschrijven. Draai je dit met de hand op een
server die al clients heeft, gebruik dan de **bestaande** sleutel uit
`C:\allmid\start-collector.cmd` — een nieuwe breekt elke client.

Verzin hem niet zelf en gebruik **geen** `Get-Random`: dat is een gewone
pseudo-generator met een voorspelbaar zaad. `bootstrap.ps1` genereert er een van 48
tekens uit `RNGCryptoServiceProvider`. Met de hand:

```powershell
$b = New-Object byte[] 32
(New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b)
($b | ForEach-Object { $_.ToString('x2') }) -join ''   # 64 hexadecimale tekens
```

Houd het bij letters en cijfers. De sleutel komt terecht in een `set "..."` in
`C:\allmid\start-collector.cmd`, en daar is `%` een bijzonder teken — een sleutel met
de verkeerde tekens raakt stilletjes verminkt en dan werkt het uploaden niet.

Dit registreert een geplande taak die bij het opstarten meekomt en zichzelf herstart
als hij valt. Node kan niet rechtstreeks als Windows-dienst draaien — een dienst moet
aan het Service Control Manager-protocol voldoen en `node.exe` doet dat niet. De
gebruikelijke oplossing is een extra programma zoals `nssm` installeren; een geplande
taak is ingebouwd, doet hetzelfde, en scheelt een download die je moet vertrouwen.

### 6. HTTPS — doe je zelf

Poort 443 was op deze machine nog helemaal ongebruikt, dus je zit niemand in de weg.
Dit is de enige stap die `bootstrap.ps1` niet kan overnemen: het certificaat maak je
aan in het Cloudflare-account, en daar heeft een script op de server geen token voor.

`allmid.gg` wijst naar Cloudflare, niet naar deze server. Daarom **geen Let's Encrypt
via win-acme**, maar een **Cloudflare Origin Certificate**: Cloudflare praat ermee met
de server, en dat is precies het stuk dat nu nog onversleuteld is. Een publiek
vertrouwd certificaat is er niet voor nodig — bezoekers zien het certificaat van
Cloudflare, niet dat van ons.

1. **Aanmaken** — Cloudflare > allmid.gg > SSL/TLS > Origin Server >
   Create Certificate. Sleutel door Cloudflare laten genereren (RSA 2048), hostnamen
   `allmid.gg` en `*.allmid.gg`, geldigheid 15 jaar. De private sleutel krijg je **één
   keer** te zien.

2. **Omzetten naar `.pfx`**, want IIS importeert niets anders:

   ```
   openssl pkcs12 -export -inkey origin.key -in origin.pem -out allmid.pfx
   ```

3. **Importeren** — IIS Manager > (servernaam) > Server Certificates > Import...

4. **Binding** — IIS Manager > Sites > allmid.gg > Bindings... > Add..., type https,
   poort 443, hostnaam `allmid.gg`, en **"Require Server Name Indication" aanvinken**.
   Herhaal voor `www.allmid.gg`.

   Dat vinkje is hier niet optioneel. Zonder SNI claimt de binding poort 443 voor álle
   hostnamen, en dan zit je de andere site op deze machine in de weg zodra die ook
   https wil. Met SNI staan ze naast elkaar — dezelfde redenering als bij de
   hostnaam-bindingen op poort 80.

5. **Cloudflare op Full (strict)** — SSL/TLS > Overview. Pas ná stap 4, anders krijgen
   bezoekers een 526.

6. **Http naar https** — zet dat aan in Cloudflare (SSL/TLS > Edge Certificates >
   Always Use HTTPS), niet met een omleidingsregel in IIS. Cloudflare beëindigt de
   versleuteling toch al, en een IIS-regel op serverniveau zou de andere site raken.

Controleren:

```powershell
Invoke-WebRequest https://allmid.gg/api/v1/health -UseBasicParsing
```

Het origin-certificaat wordt alleen door Cloudflare vertrouwd. Ga je met een browser
rechtstreeks naar het IP van de server, dan krijg je een waarschuwing. Dat hoort zo.

## Publiceren

Elke keer dat de site verandert:

```powershell
powershell -ExecutionPolicy Bypass -File C:\allmid\desktop\deploy\publish.ps1
```

Dat bouwt `index.html` opnieuw uit de datamomentopname, spiegelt `site\` naar
`C:\inetpub\allmid` en zet `web.config` ernaast.

Let op het `-Target`: `publish.ps1` spiegelt met `robocopy /MIR` en verwijdert dus
alles in de doelmap dat niet in `site\` staat. Een typefout in dat pad wist iemands
data. `bootstrap.ps1` controleert daarom vooraf of de doelmap leeg is of van ons; roep
je `publish.ps1` met de hand aan, dan doe je die controle zelf.

De ontwerpvarianten (`site\_var-*.html`) gaan **niet** mee. Die staan al in
`.gitignore`, maar iemand kan ze lokaal hebben staan en ze horen niet op een publieke
site.

## De site ververst zichzelf

Zodra er genoeg nieuwe games binnen zijn, rekent de verzamelserver de cijfers opnieuw
uit en publiceert ze. Je hoeft daar niets voor te doen; `publish.ps1` is alleen nog
nodig als de pagina zelf verandert (nieuwe tekst, ander ontwerp).

Standaard gebeurt dat bij **2.000 nieuwe games**, en hooguit **eens per half uur**. Die
tweede grens is geen luxe: een doorloop leest de database twee keer en eindigt in een
`robocopy /MIR` over de map die IIS staat te serveren. Zonder ondergrens zou een
handvol clients die hun achterstand loost dat tientallen keren per uur uitlokken. Staat
er iets klaar en is de laatste doorloop ouder dan **zes uur**, dan gaat hij toch —
anders zou de site bij één trage client dagen stil kunnen staan zonder dat je ziet dat
er iets mis is.

Waarom niet bij elke upload: 2.000 games is op ~300.000 nog geen procent van de
dataset, en de site drukt winrates op één decimaal af. Vaker herrekenen levert
letterlijk hetzelfde plaatje op, voor negen seconden werk per keer.

Een mislukte doorloop raakt de gepubliceerde bestanden niet aan. De generator schrijft
eerst in een werkmap; pas als alle drie de bestanden parsen én hetzelfde aantal games
melden, worden ze op hun plek gezet. Daarna loopt de pauze op (30, 60, 120, 240
minuten) tot het weer lukt.

Wat er gebeurt zie je hier:

```powershell
Invoke-RestMethod http://127.0.0.1:8123/api/v1/health | Select-Object -Expand site
```

Dat toont wanneer er voor het laatst ververst is, met hoeveel games, hoeveel er nu
klaarstaan, of er op dit moment een doorloop bezig is, en de laatste fout.

Uitzetten kan met `-SiteDir ''` bij `install-collector.ps1`, of door
`ALLMID_SITE_REFRESH` op `0` te zetten in `C:\allmid\start-collector.cmd`.

## Wat er nog niet af is

De site haalt zijn cijfers uit meegeleverde JSON-bestanden, niet rechtstreeks bij de
API. Dat werkt en het is snel — IIS serveert statische bestanden — maar het betekent
wel dat de pagina in stappen bijwerkt in plaats van continu.

## Als er iets misgaat

| Symptoom | Waar te kijken |
|---|---|
| Bootstrap stopt meteen op "Voorwaarden" | dat is de bedoeling: installeer wat er in de lijst staat en draai opnieuw |
| 500 op elke pagina | URL Rewrite ontbreekt |
| 502 op `/api/` | ARR-proxy staat uit, of de verzamelserver ligt: `Get-Content C:\allmid\logs\collector.log -Tail 40` |
| 403 op een gewone pagina | de beschermregel `allmid-weiger-absolute-uri` slaat aan op iets wat hij niet zou moeten raken; kijk in IIS Manager > (server) > URL Rewrite |
| De open-proxy-test geeft 200 of 502 | de beschermregel staat er niet, of niet als eerste: IIS Manager > (server) > URL Rewrite > View Ordered List |
| `allmid.gg` toont de andere site | de binding met hostnaam ontbreekt; draai `install-site.ps1` opnieuw |
| 526 bij Cloudflare | de 443-binding of het origin-certificaat ontbreekt; zie stap 6 |
| `npm ci` loopt vast op een bestand in `node_modules` | de collector draait nog: `Stop-ScheduledTask -TaskName 'AllMid Collector'` |
| Bootstrap stopte halverwege | `C:\allmid\logs\bootstrap-*.log` — daar staat per wijziging of hij geslaagd of mislukt is, en hoe je hem terugdraait |

Snel controleren of de verzamelserver leeft:

```powershell
Invoke-RestMethod http://127.0.0.1:8123/api/v1/health
```
