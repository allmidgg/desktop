<#
    bootstrap.ps1 -- zet allmid.gg neer op een server die al aan de voorwaarden voldoet.

    Draaien in een PowerShell ALS ADMINISTRATOR, op de server:

        &([scriptblock]::Create((irm https://raw.githubusercontent.com/allmidgg/desktop/main/deploy/bootstrap.ps1))) -DryRun

    Die vorm (en niet `irm ... | iex`) omdat je schakelaars wilt kunnen meegeven, en
    -DryRun is de eerste die je wilt. Op een machine waar iets draait dat niet stuk
    mag: haal het bestand eerst binnen, lees het, en draai DAT bestand. Een adres met
    /main/ erin levert bij elke run wat er op dat moment op main staat; een commit-hash
    in het adres levert altijd hetzelfde. Zie deploy\README.md.

    -- Wat dit script WEL doet --------------------------------------------------
    Het CONTROLEERT de voorwaarden en stopt met een instructie plus downloadlink als
    er iets ontbreekt. Zijn ze er allemaal, dan doet het het allmid-werk:
    repo klonen of bijwerken, npm ci, de IIS-site aanmaken, publiceren, de
    verzamelserver als geplande taak neerzetten, en achteraf CONTROLEREN of het werkt
    -- afgezet tegen een nulmeting die vooraf is genomen.

    -- Wat dit script NIET doet -------------------------------------------------
    Het installeert niets van buitenaf. Geen node, geen git, geen MSI's. Een eerdere
    versie deed dat wel, via winget en via twee MSI's die als SYSTEM werden
    uitgevoerd. Dat leverde de meeste risico's van het hele script op en bespaarde de
    beheerder vier keer klikken. Bovendien bestaat winget niet op een kale
    Windows Server 2019/2022, dus op de doelmachine kon die weg sowieso niet werken.
    Nu staat er per ontbrekende voorwaarde een regel met een downloadlink en stopt het.

    Het maakt ook GEEN certificaat aan. allmid.gg wijst naar Cloudflare, niet naar deze
    server, dus het certificaat hoort een Cloudflare Origin Certificate te zijn en dat
    maak je aan in dat account. Wat het script WEL doet, is een bestaande .pfx die JIJ
    aanwijst met -PfxPath importeren en er een https-binding op 443 mee opzetten. Zonder
    -PfxPath wordt die stap netjes overgeslagen en staat aan het eind wat je zelf moet
    doen.

    -- Sleutelmateriaal ---------------------------------------------------------
    Er komt GEEN sleutelmateriaal in deze repo, in dit script, in een voorbeeld of in
    een logregel. Het script neemt alleen een PAD naar een bestaande .pfx aan, en het
    WEIGERT een .pfx die in de repo of in de gepubliceerde site-map staat -- want
    publish.ps1 zet die map met robocopy /MIR op het web, en dan staat je private
    sleutel op internet. Het wachtwoord komt binnen als SecureString (of wordt
    interactief gevraagd) en wordt nergens afgedrukt of weggeschreven. De vingerafdruk
    van het certificaat wordt ook niet afgedrukt.

    -- De server, want daar draait alles om ------------------------------------
    Op deze machine draait AL een andere site op poort 80. Dit script VOEGT alleen
    toe: het wijzigt, stopt of verwijdert nooit een bestaande site, toepassingsgroep
    of binding. Botst er iets, dan stopt het met uitleg.

    Er is EEN onvermijdelijke onderbreking: schrijven naar applicationHost.config
    (de site aanmaken, de ARR-proxy, de beschermregel) laat IIS zijn configuratie
    opnieuw inlezen en recyclet daarbij de toepassingsgroepen -- ook die van de
    andere site. Dat duurt seconden, maar lopende verzoeken kunnen sneuvelen. Het
    script meldt dat vooraf en vraagt om bevestiging. Met -Force slaat het die vraag
    over, voor onbeheerde runs.

    -- De ARR-proxy en waarom er een beschermregel bij hoort -------------------
    system.webServer/proxy enabled=true op APPHOST-niveau maakt van IIS een FORWARD
    proxy voor verzoeken met een absolute URI in de requestregel
    ("GET http://ergens-anders/ HTTP/1.1"). Dat is precies wat een open proxy is:
    iedereen op internet kan deze server dan gebruiken om verkeer te versturen dat
    van ons IP-adres lijkt te komen. Een eerdere versie van dit script beweerde in
    het commentaar het tegenovergestelde. Dat was fout.

    Daarom zet dit script een serverbrede URL Rewrite-regel neer die verzoeken met een
    absolute URI weigert met 403 EN de reden 'Forwarding is disabled' in de statusregel.
    Die regel en de proxyschakelaar gaan in EEN schrijfactie naar applicationHost.config,
    dus er bestaat geen moment waarop de proxy aan staat zonder de regel.

    Aan het eind test het zichzelf: het stuurt zo'n verzoek naar 127.0.0.1 en kijkt of
    er precies die reden uit komt. Een kale 403 telt NIET als bewijs -- de bestaande
    site kan om heel andere redenen 403 geven (403.14 bijvoorbeeld). Blijkt het toch een
    open proxy, dan zet dit script de proxy ZELF weer uit en stopt met een foutcode.
    Een halve installatie is beter dan een open proxy op internet.

    -- Schakelaars --------------------------------------------------------------
    -DryRun      voert alle controles ECHT uit en wijzigt niets. Draai dit eerst.
    -Force       slaat de bevestigingsVRAGEN over (niet de controles, en niet het
                 TONEN en LOGGEN van waar je anders ja tegen had gezegd). Voor onbeheerd.
    -NewApiKey   dwingt een nieuwe API-sleutel af; zonder deze schakelaar wordt een
                 bestaande sleutel hergebruikt.
    -ApiKey      je eigen sleutel meegeven.
    -PfxPath     pad naar een BESTAANDE .pfx buiten de repo en buiten de site-map.
                 Zonder deze schakelaar wordt de https-stap overgeslagen.
    -PfxPassword het wachtwoord van die .pfx, als SecureString. Laat je hem weg, dan
                 wordt er interactief om gevraagd. Nooit als platte tekst meegeven --
                 dat komt in je opdrachtgeschiedenis terecht.
#>
[CmdletBinding()]
param(
    # Voert alle controles uit en verandert niets aan de machine. De enige
    # uitzondering staat bij 'Uitvoeringsbeleid' en geldt alleen dit ene proces.
    [switch] $DryRun,

    # Slaat de bevestigingsvragen over. Bedoeld voor een onbeheerde run door iemand
    # die het script al een keer met -DryRun heeft gelezen.
    [switch] $Force,

    # Nieuwe sleutel afdwingen. Let op: alle al ingerichte clients moeten daarna
    # opnieuw ingesteld worden.
    [switch] $NewApiKey,

    # Zelf een sleutel meegeven mag; anders wordt de bestaande hergebruikt of een
    # nieuwe gegenereerd.
    [string] $ApiKey = '',

    <#
        Het PAD naar een .pfx die er al is. Bewust geen certificaatinhoud, geen base64,
        geen sleutel: een pad is geen geheim, en zo kan er nooit sleutelmateriaal in de
        repo, in een voorbeeld of in een logregel belanden.

        Het bestand moet BUITEN de repo en BUITEN de gepubliceerde site-map staan.
        publish.ps1 spiegelt die site-map met robocopy /MIR naar de webroot; een .pfx
        die daar staat, staat daarna op internet. Het script weigert dat.

        Zonder deze schakelaar blijft alles op poort 80 en meldt het script aan het eind
        wat je nog moet doen.
    #>
    [string] $PfxPath = '',

    # Als SecureString, of leeg laten: dan wordt er interactief om gevraagd. Er is met
    # opzet GEEN [string]-variant: een wachtwoord op de opdrachtregel staat in je
    # geschiedenis en is via Win32_Process voor elke gebruiker te lezen.
    [System.Security.SecureString] $PfxPassword,

    [string]   $RepoUrl    = 'https://github.com/allmidgg/desktop.git',
    [string]   $Branch     = 'main',
    [string]   $AllmidRoot = 'C:\allmid',
    [string]   $RepoRoot   = 'C:\allmid\desktop',
    [string]   $SiteRoot   = 'C:\inetpub\allmid',
    [string]   $SiteName   = 'allmid.gg',
    [string[]] $SiteHosts  = @('allmid.gg', 'www.allmid.gg'),

    [string]   $TaskName   = 'AllMid Collector'

    # Er is met opzet GEEN -CollectorPort meer. Die schakelaar werkte maar half: de
    # poort staat ook in deploy\web.config, en die werd niet meegewijzigd. Een half
    # werkende schakelaar is erger dan geen. De poort wordt nu UIT deploy\web.config
    # gelezen en doorgegeven aan install-collector.ps1, zodat er precies een plek is
    # waar hij staat. Andere poort nodig? Wijzig hem in deploy\web.config.
)

$ErrorActionPreference = 'Stop'

# De voortgangsbalk maakt Invoke-WebRequest in PowerShell 5.1 tot tien keer trager.
$ProgressPreference = 'SilentlyContinue'

# Oudere Windows Server-installaties staan standaard nog op TLS 1.0/1.1. Alleen deze
# sessie, geen systeemwijziging. (Dit script downloadt zelf niets meer, maar git en
# npm draaien in eigen processen; dit helpt de controleverzoeken van hieronder.)
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    # Op nieuwere .NET is Tls12 al de standaard; dan mag deze regel wegvallen.
}

# ── Boekhouding ────────────────────────────────────────────────────────────────
$script:Wijzigingen   = New-Object System.Collections.ArrayList
$script:Blokkades     = New-Object System.Collections.ArrayList
$script:Controles     = New-Object System.Collections.ArrayList
$script:Testopdrachten = New-Object System.Collections.ArrayList
$script:Besluiten     = New-Object System.Collections.ArrayList
$script:KanIIS        = $false
$script:Gelukt        = $true
$script:SleutelNieuw  = $false
$script:SleutelBron   = ''
$script:Start         = Get-Date
$script:StateMap      = Join-Path $AllmidRoot 'state'
$script:LogMap        = Join-Path $AllmidRoot 'logs'

# De eindmeting moet ook op het FOUTPAD draaien -- juist als er iets misgaat wil je
# weten of de bestaande site nog antwoordt. Deze vlag voorkomt dat hij twee keer loopt.
$script:EindmetingGedaan = $false

# Hebben WIJ de ARR-proxy in deze run aangezet? Dat bepaalt of we hem bij twijfel weer
# uit mogen zetten: een schakelaar die al aan stond is de beslissing van iemand anders.
$script:ProxyDoorOnsAan = $false

# Wat er in deze run over de commit te melden viel. Wordt getoond EN gelogd, ook met
# -Force -- juist bij een onbeheerde run wil je terug kunnen vinden wat er draaide.
$script:CommitRegel = ''
$script:CommitHash  = ''
$script:CommitVuil  = @()

# De https-stap: wat ervan terecht is gekomen, voor de eindtekst.
$script:HttpsGedaan  = $false
$script:HttpsReden   = 'niet gevraagd (geen -PfxPath meegegeven)'

# ── Uitvoer ────────────────────────────────────────────────────────────────────
# Bewust alleen ASCII in alles wat GEDRUKT wordt: dit bestand staat zonder BOM in de
# repo en Windows PowerShell 5.1 leest zo'n bestand als ANSI. In commentaar valt een
# verkeerd teken niet op, op het scherm wel.
function Kop($t) {
    Write-Host ''
    Write-Host ('  ' + $t) -ForegroundColor White -BackgroundColor DarkBlue
}
function Stap($t)  { Write-Host "`n== $t" -ForegroundColor Cyan }
function Goed($t)  { Write-Host "   $t" -ForegroundColor Green }
function Let($t)   { Write-Host "   $t" -ForegroundColor Yellow }
function Fout($t)  { Write-Host "   $t" -ForegroundColor Red }
function Info($t)  { Write-Host "   $t" -ForegroundColor Gray }
function Plan($t)  { Write-Host "   ZOU DOEN : $t" -ForegroundColor Magenta }
function Terug($t) { Write-Host "   terug    : $t" -ForegroundColor DarkGray }

<#
    De enige plek waar dit script iets aan het systeem verandert.

    De boeking gaat VOORAF, niet achteraf. Dat is het verschil tussen "de machine is
    veranderd en dat staat nergens" en "de machine is veranderd en dat staat er, met
    de melding dat het misging". Een eerdere versie boekte pas na succes; sneuvelde
    de wijziging halverwege, dan stond de machine wel veranderd en het logboek leeg.
#>
function Wijzig {
    param(
        [Parameter(Mandatory = $true)][string] $Wat,
        [Parameter(Mandatory = $true)][string] $Terugdraaien,
        [Parameter(Mandatory = $true)][scriptblock] $Doe
    )
    if ($DryRun) {
        Plan  $Wat
        Terug $Terugdraaien
        return
    }
    $regel = [pscustomobject]@{
        Tijd         = (Get-Date).ToString('HH:mm:ss')
        Wat          = $Wat
        Terugdraaien = $Terugdraaien
        Status       = 'BEGONNEN'
    }
    [void]$script:Wijzigingen.Add($regel)
    Write-Host "   BEZIG    : $Wat" -ForegroundColor DarkYellow
    try {
        & $Doe
    } catch {
        $regel.Status = 'MISLUKT'
        throw
    }
    $regel.Status = 'geslaagd'
    Write-Host "   GEWIJZIGD: $Wat" -ForegroundColor Green
    Terug $Terugdraaien
}

<#
    Iets klopt niet en doorgaan zou schade of een half resultaat opleveren.

    In een echte run stopt het script hier. In -DryRun loopt het bewust door: je
    draait een proefrun juist om het HELE plan en ALLE ontbrekende voorwaarden in een
    keer te zien, en niet om na de eerste regel op te houden.
#>
function Blokkeer {
    param([Parameter(Mandatory = $true)][string] $Reden, [string] $Hint = '')
    [void]$script:Blokkades.Add([pscustomobject]@{ Reden = $Reden; Hint = $Hint })
    Fout "STOP     : $Reden"
    if ($Hint) { Let "           $Hint" }
    if (-not $DryRun) { throw $Reden }
    Info "           (-DryRun: ik toon de rest van het plan; er verandert niets)"
}

<#
    Een controle boeken en tonen.

    Er zijn DRIE uitkomsten en niet twee. "Onbeslist" is er de belangrijkste van: een
    meting die niets bewijst mag nooit als geslaagd doorgaan. Twee plekken in dit
    script leverden precies dat op:

      * een nulmeting die vooraf al geen antwoord gaf (status 0) en achteraf weer 0.
        Twee keer niets is geen bewijs dat de site leeft.
      * een 403 op de open-proxytest zonder de reden die onze eigen regel meestuurt.
        Dat kan net zo goed een 403.14 van de bestaande site zijn.

    Onbeslist laat de run niet falen -- er is immers niets stuks geconstateerd -- maar
    telt ook niet mee als geslaagd, en staat apart in de samenvatting en in het logboek.
#>
function Meld-Controle {
    param([string] $Wat, [bool] $Ok, [string] $Detail = '', [switch] $Onbeslist)
    $staat = 'FOUT'
    if     ($Onbeslist) { $staat = 'ONBESLIST' }
    elseif ($Ok)        { $staat = 'ok' }
    [void]$script:Controles.Add([pscustomobject]@{ Wat = $Wat; Ok = $Ok; Detail = $Detail; Staat = $staat })
    if ($staat -eq 'ok') {
        Write-Host ("   [ok]   {0,-44} {1}" -f $Wat, $Detail) -ForegroundColor Green
    } elseif ($staat -eq 'ONBESLIST') {
        Write-Host ("   [ ? ]  {0,-44} {1}" -f $Wat, $Detail) -ForegroundColor Yellow
    } else {
        Write-Host ("   [FOUT] {0,-44} {1}" -f $Wat, $Detail) -ForegroundColor Red
    }
}

<#
    Vragen of het mag.

    -Force slaat de vraag over, -DryRun vraagt niets (er verandert immers niets) maar
    laat wel zien DAT er gevraagd wordt. Kan er niet gelezen worden -- een run zonder
    console, bijvoorbeeld vanuit een taak -- dan is dat geen reden om "ja" aan te
    nemen, maar om te stoppen met de tip om -Force te gebruiken.
#>
function Boek-Besluit {
    param([string] $Vraag, [string] $Uitkomst, [string[]] $Uitleg = @())
    [void]$script:Besluiten.Add([pscustomobject]@{
        Tijd     = (Get-Date).ToString('HH:mm:ss')
        Vraag    = $Vraag
        Uitkomst = $Uitkomst
        Uitleg   = $Uitleg
    })
}

function Bevestig {
    param([string] $Vraag, [string[]] $Uitleg = @())

    foreach ($r in $Uitleg) { Let $r }
    if ($DryRun) {
        Info "(-DryRun: een echte run vraagt hier: $Vraag)"
        Boek-Besluit -Vraag $Vraag -Uitkomst 'proefrun: niet gevraagd' -Uitleg $Uitleg
        return $true
    }
    if ($Force) {
        # -Force slaat de VRAAG over, niet de uitleg en niet de boekhouding. De uitleg
        # hierboven is al afgedrukt; hier komt hij ook in het logboek terecht, zodat een
        # onbeheerde run achteraf te lezen is: waar is namens mij ja tegen gezegd?
        Let "-Force: bevestiging overgeslagen, maar WEL getoond en gelogd ($Vraag)"
        Boek-Besluit -Vraag $Vraag -Uitkomst '-Force: niet gevraagd, als ja behandeld' -Uitleg $Uitleg
        return $true
    }
    $antwoord = ''
    try {
        $antwoord = Read-Host "   $Vraag [ja/nee]"
    } catch {
        Boek-Besluit -Vraag $Vraag -Uitkomst 'niet te vragen (geen console)' -Uitleg $Uitleg
        Blokkeer -Reden 'Er kan hier niets gelezen worden, dus er is geen bevestiging.' `
                 -Hint  'Draai dit script in een echte PowerShell-console, of geef -Force mee als je de vragen bewust wilt overslaan.'
        return $false
    }
    if ($antwoord -eq 'ja' -or $antwoord -eq 'j' -or $antwoord -eq 'yes' -or $antwoord -eq 'y') {
        Goed 'akkoord'
        Boek-Besluit -Vraag $Vraag -Uitkomst "gevraagd, antwoord: $antwoord" -Uitleg $Uitleg
        return $true
    }
    Boek-Besluit -Vraag $Vraag -Uitkomst "gevraagd, antwoord: $antwoord (GEEN toestemming)" -Uitleg $Uitleg
    Blokkeer -Reden "Geen toestemming gegeven bij: $Vraag" `
             -Hint  'Er is niets gewijzigd. Lees de uitleg hierboven en draai opnieuw als je wel akkoord bent.'
    return $false
}

# ── Gereedschap ────────────────────────────────────────────────────────────────

<#
    Een configuratiewaarde als echte booleaanse waarde.

    Get-WebConfigurationProperty geeft afhankelijk van sectie en versie een [bool],
    de tekst 'True'/'true', of een getal terug. `[bool]'False'` is in PowerShell WAAR
    (elke niet-lege tekst is waar), dus een ongenormaliseerde vergelijking zou hier
    "de proxy staat al aan" concluderen terwijl hij uit staat -- en dan zou de
    beschermregel er niet komen.
#>
function Test-WaardeWaar {
    param($Waarde)
    if ($null -eq $Waarde) { return $false }
    # Get-WebConfigurationProperty levert voor zo'n attribuut vaak geen kale waarde maar
    # een ConfigurationAttribute met de echte waarde in .Value. Uitpakken dus, en niet
    # op type testen: welk type het precies is verschilt per IIS-versie.
    if ($Waarde -isnot [bool] -and $Waarde -isnot [string]) {
        $eigenschap = $Waarde.PSObject.Properties['Value']
        if ($eigenschap) { $Waarde = $eigenschap.Value }
    }
    if ($null -eq $Waarde) { return $false }
    if ($Waarde -is [bool]) { return [bool]$Waarde }
    $tekst = ([string]$Waarde).Trim()
    return ($tekst -eq 'True' -or $tekst -eq 'true' -or $tekst -eq '1')
}

function Get-Pad($naam) {
    $c = Get-Command $naam -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return ''
}

<#
    Een GET met een zelfgekozen Host-kop.

    Nodig omdat allmid.gg naar Cloudflare wijst en niet naar deze server: vanaf de
    server zelf de hostnaam opvragen komt dus nooit bij IIS uit. We kloppen aan op
    127.0.0.1 en zetten de hostnaam in de Host-kop, want daar zoekt IIS de site op.

    Waarom niet Invoke-WebRequest:
      1. Wat -Headers @{Host=...} doet verschilt per build; Host is een beperkte kop.
         HttpWebRequest heeft er een eigenschap voor en doet het overal hetzelfde.
      2. Bij een 4xx of 5xx gooit Invoke-WebRequest een afbrekende fout, en juist dan
         wil je de statuscode HEBBEN: 500 betekent hier iets anders (URL Rewrite) dan
         502 (verzamelserver ligt). Deze functie geeft de status terug als gegeven.
#>
function Invoke-Controleverzoek {
    param(
        [Parameter(Mandatory = $true)][string] $Url,
        [string] $Hostnaam = '',
        [int]    $TimeoutSec = 20,

        # Voor de https-zelftest. Een Cloudflare Origin Certificate wordt alleen door
        # Cloudflare vertrouwd en we kloppen bovendien op 127.0.0.1 aan, dus de keten
        # klopt hier per definitie niet. Dat is geen reden om de test over te slaan --
        # wel om NIET zomaar alles te accepteren: hieronder wordt de vingerafdruk van
        # het aangeboden certificaat vergeleken met die van het certificaat dat we net
        # zelf hebben geimporteerd. Die vingerafdruk wordt nergens afgedrukt.
        [switch] $NegeerCertificaatketen,
        [string] $VerwachteVingerafdruk = ''
    )
    $uit = [pscustomobject]@{
        Ok = $false; Status = 0; Inhoud = ''; Fout = ''
        CertGezien = $false; CertKlopt = $false
    }
    $antwoord = $null
    $oudeCallback  = $null
    $callbackGezet = $false
    if ($NegeerCertificaatketen) {
        # Bewust de globale terugroep en niet die op het verzoek: de eigenschap op
        # HttpWebRequest bestaat pas vanaf .NET 4.5 en is op oudere Windows Server-
        # installaties niet gegarandeerd. In een finally wordt hij weer teruggezet.
        $oudeCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
        [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { param($a, $b, $c, $d) return $true }
        $callbackGezet = $true
    }
    try {
        $verzoek = $null
        try {
            $verzoek = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($Url)
            $verzoek.Method            = 'GET'
            $verzoek.Timeout           = $TimeoutSec * 1000
            $verzoek.ReadWriteTimeout  = $TimeoutSec * 1000
            $verzoek.AllowAutoRedirect = $false
            $verzoek.UserAgent         = 'allmid-bootstrap'
            if ($Hostnaam) { $verzoek.Host = $Hostnaam }
            $antwoord = $verzoek.GetResponse()
        } catch [System.Net.WebException] {
            $uit.Fout = $_.Exception.Message
            if ($_.Exception.Response) { $antwoord = $_.Exception.Response }
        } catch {
            $uit.Fout = $_.Exception.Message
            return $uit
        }

        # Het certificaat dat de server aanbood, ongeacht of het antwoord 200 of 404 was.
        if ($verzoek -and $verzoek.ServicePoint -and $verzoek.ServicePoint.Certificate) {
            $uit.CertGezien = $true
            if ($VerwachteVingerafdruk) {
                $gezien = ''
                try { $gezien = ([string]$verzoek.ServicePoint.Certificate.GetCertHashString()) } catch { $gezien = '' }
                $uit.CertKlopt = ($gezien -and ($gezien -eq $VerwachteVingerafdruk))
            }
        }

        if (-not $antwoord) { return $uit }
        try {
            $uit.Status = [int]$antwoord.StatusCode
            $lezer = New-Object System.IO.StreamReader($antwoord.GetResponseStream())
            try {
                $tekst = $lezer.ReadToEnd()
            } finally {
                $lezer.Dispose()
            }
            if ($tekst.Length -gt 4000) { $tekst = $tekst.Substring(0, 4000) }
            $uit.Inhoud = $tekst
            $uit.Ok     = ($uit.Status -ge 200 -and $uit.Status -lt 400)
        } finally {
            $antwoord.Close()
        }
    } finally {
        if ($callbackGezet) {
            [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $oudeCallback
        }
    }
    return $uit
}

<#
    Een verzoek zoals een proxyclient het stuurt: met een ABSOLUTE URI in de
    requestregel. Precies dat verzoek maakt van een IIS met ARR-proxy een open proxy.

    Waarom met de hand op een socket: HttpWebRequest en curl zetten zo'n absolute URI
    alleen in de requestregel als je ze een proxy meegeeft, en dan gaan ze ook nog
    eens DNS opzoeken. Hier willen we precies deze ene bytes-op-de-lijn versturen.

    Het doel is .invalid. Dat achtervoegsel is in RFC 6761 gereserveerd en resolvet
    per definitie nergens naartoe, dus deze test stuurt gegarandeerd geen verkeer het
    internet op -- ook niet als de bescherming stuk is.

    Uitkomsten:
      403 MET de reden     de beschermregel doet zijn werk -- DIT is het bewijs
      403 ZONDER de reden  onbeslist: 403 zegt op zichzelf niets. De bestaande site
                           geeft bijvoorbeeld 403.14 op een map zonder standaarddocument,
                           en dat is dezelfde 403.
      502 / 504            IIS heeft geprobeerd te proxyen: OPEN PROXY
      400 / 404 / 2xx      lokaal afgehandeld, niet geproxyd (maar de regel antwoordde
                           ook niet; kijk dan naar de volgorde van de globalRules)

    Daarom wordt de hele STATUSREGEL teruggegeven en niet alleen het getal. De
    CustomResponse-actie van onze regel zet er 'Forwarding is disabled' in; dat is de
    enige tekst waar we op afgaan. Het antwoord wordt er ook bij teruggegeven, want de
    statusDescription staat in de body en dient als tweede aanwijzing.
#>
function Test-Proxyverzoek {
    param(
        [string] $Adres = '127.0.0.1',
        [int]    $Poort = 80,
        [string] $Doelhost = 'open-proxy-test.invalid',
        [int]    $TimeoutSec = 15
    )
    $uit = [pscustomobject]@{ Status = 0; Regel = ''; Antwoord = ''; Fout = '' }
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.ReceiveTimeout = $TimeoutSec * 1000
        $client.SendTimeout    = $TimeoutSec * 1000
        $client.Connect($Adres, $Poort)
        $stroom = $client.GetStream()
        $stroom.ReadTimeout  = $TimeoutSec * 1000
        $stroom.WriteTimeout = $TimeoutSec * 1000

        $verzoek = "GET http://$Doelhost/ HTTP/1.1`r`n" +
                   "Host: $Doelhost`r`n" +
                   "User-Agent: allmid-bootstrap-proxytest`r`n" +
                   "Connection: close`r`n`r`n"
        $bytes = [System.Text.Encoding]::ASCII.GetBytes($verzoek)
        $stroom.Write($bytes, 0, $bytes.Length)
        $stroom.Flush()

        $lezer = New-Object System.IO.StreamReader($stroom)
        try {
            $uit.Regel = $lezer.ReadLine()
            # De rest ook lezen (Connection: close, dus dit eindigt vanzelf). Daar zit
            # de statusDescription in, en die is het tweede spoor van onze eigen regel.
            $rest = $lezer.ReadToEnd()
            if ($null -eq $rest) { $rest = '' }
            $geheel = ([string]$uit.Regel) + "`n" + $rest
            if ($geheel.Length -gt 4000) { $geheel = $geheel.Substring(0, 4000) }
            $uit.Antwoord = $geheel
        } finally {
            $lezer.Dispose()
        }
        if ($uit.Regel -match '^HTTP/\d\.\d\s+(\d{3})') { $uit.Status = [int]$Matches[1] }
    } catch {
        $uit.Fout = $_.Exception.Message
    } finally {
        $client.Close()
    }
    return $uit
}

<#
    Een sleutel uit een cryptografisch veilige bron.

    Waarom geen Get-Random: die gebruikt een gewone pseudo-generator met een
    voorspelbaar zaad, en dit is het enige dat uploaden naar de verzamelserver
    afschermt.

    Waarom alleen letters en cijfers: de sleutel eindigt in
    C:\allmid\start-collector.cmd binnen een `set "ALLMID_KEY=..."`. In een
    .cmd-bestand is % bijzonder, en dan zou een sleutel met de verkeerde tekens
    stilletjes verminkt raken. 48 tekens uit 62 mogelijkheden is ruim 285 bits.

    Waarom de restwaarde-lus: byte % 62 zou de eerste tekens van het alfabet vaker
    opleveren dan de laatste. Bytes vanaf 248 gooien we weg; de rest verdeelt precies
    gelijk over 62.
#>
function New-ApiSleutel {
    param([int] $Lengte = 48)
    $alfabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    $bron = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    try {
        $sb = New-Object System.Text.StringBuilder
        $buffer = New-Object byte[] 1
        while ($sb.Length -lt $Lengte) {
            $bron.GetBytes($buffer)
            if ($buffer[0] -lt 248) {
                [void]$sb.Append($alfabet[$buffer[0] % 62])
            }
        }
        return $sb.ToString()
    } finally {
        $bron.Dispose()
    }
}

function Hide-Sleutel {
    param([string] $Sleutel)
    if (-not $Sleutel) { return '(leeg)' }
    if ($Sleutel.Length -le 6) { return ('*' * $Sleutel.Length) }
    return ($Sleutel.Substring(0, 3) + ('*' * ($Sleutel.Length - 3)) + " ($($Sleutel.Length) tekens)")
}

<#
    De sleutel uit een bestaand start-collector.cmd vissen.

    Zonder dit genereert een tweede run een nieuwe sleutel en werkt geen enkele al
    ingerichte client meer. Dat is geen theorie: de sleutel staat in de desktopapp van
    elke gebruiker.
#>
function Get-SleutelUitStartbestand {
    param([string] $Pad)
    if (-not (Test-Path $Pad)) { return '' }
    try {
        foreach ($regel in (Get-Content $Pad -ErrorAction Stop)) {
            if ($regel -match '^\s*set\s+"ALLMID_KEY=(.*)"\s*$') { return $Matches[1] }
            if ($regel -match '^\s*set\s+ALLMID_KEY=(.*)$')      { return $Matches[1].Trim() }
        }
    } catch {
        return ''
    }
    return ''
}

<#
    De poort van de verzamelserver uit deploy\web.config lezen.

    Die staat daar in de rewrite-regel die /api/ doorstuurt. Dit script gebruikt
    dezelfde waarde voor install-collector.ps1, zodat IIS en de server het altijd over
    dezelfde poort hebben. Een tweede plek om de poort in te stellen zou vroeg of laat
    uit de pas lopen -- dat was precies wat er mis was met de oude -CollectorPort.
#>
function Get-CollectorPoort {
    param([string] $WebConfigPad)
    if (-not (Test-Path $WebConfigPad)) { return 0 }
    try {
        $xml = [xml](Get-Content $WebConfigPad -Raw -ErrorAction Stop)
    } catch {
        return 0
    }
    $knoop = $xml.SelectSingleNode("//system.webServer/rewrite/rules/rule[@name='allmid-api']/action")
    if (-not $knoop) { return 0 }
    $url = [string]$knoop.GetAttribute('url')
    if ($url -match '^http://127\.0\.0\.1:(\d+)/') { return [int]$Matches[1] }
    return 0
}

<#
    Mag iemand anders dan Administrators of SYSTEM in deze map schrijven?

    Waarom dit ertoe doet: C:\ geeft via overerving 'Authenticated Users' een
    (OI)(CI)(IO)(M) -- elke ingelogde gebruiker mag schrijven in alles wat daaronder
    nieuw wordt aangemaakt. En in C:\allmid\desktop draait SYSTEM permanent code (de
    geplande taak start node daaruit). Wie daar een bestand mag vervangen, voert
    straks code uit als SYSTEM. Dat is een pad naar Administrator.

    Er wordt op SID vergeleken en niet op naam, want op een Nederlandse Windows heten
    die groepen anders en dan zou de controle vrolijk "in orde" melden.
#>
function Test-SchrijfrechtenBeperkt {
    param([string] $Pad)

    $uit = [pscustomobject]@{
        Bestaat     = (Test-Path $Pad)
        Beschermd   = $false     # overerving verbroken?
        Ongewenst   = @()        # regels die anderen schrijfrecht geven
        Fout        = ''
    }
    if (-not $uit.Bestaat) { return $uit }

    try {
        $acl = Get-Acl -Path $Pad -ErrorAction Stop
    } catch {
        $uit.Fout = $_.Exception.Message
        return $uit
    }
    $uit.Beschermd = $acl.AreAccessRulesProtected

    $rechten = [System.Security.AccessControl.FileSystemRights]
    $schrijfMasker =
        [int]$rechten::WriteData -bor [int]$rechten::AppendData -bor
        [int]$rechten::WriteAttributes -bor [int]$rechten::WriteExtendedAttributes -bor
        [int]$rechten::Delete -bor [int]$rechten::DeleteSubdirectoriesAndFiles -bor
        [int]$rechten::ChangePermissions -bor [int]$rechten::TakeOwnership

    # S-1-5-18 = SYSTEM, S-1-5-32-544 = de ingebouwde groep Administrators.
    $mag = @('S-1-5-18', 'S-1-5-32-544')
    $ongewenst = @()
    foreach ($regel in $acl.Access) {
        if ($regel.AccessControlType -ne 'Allow') { continue }
        $sid = ''
        try {
            $sid = $regel.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
        } catch {
            $sid = [string]$regel.IdentityReference
        }
        if ($mag -contains $sid) { continue }
        if (([int]$regel.FileSystemRights -band $schrijfMasker) -ne 0) {
            $ongewenst += "$($regel.IdentityReference) [$sid] : $($regel.FileSystemRights)"
        }
    }
    $uit.Ongewenst = $ongewenst
    return $uit
}

# ── De beschermregel: wat hij precies moet zijn ───────────────────────────────
# Op EEN plek, zodat de aanleg, de inhoudscontrole en de zelftest gegarandeerd over
# hetzelfde ding gaan. Wijkt een van de drie af, dan is dat een fout in dit bestand en
# niet iets dat op de server stilletjes goed kan gaan.
$script:RegelNaam  = 'allmid-weiger-absolute-uri'
$script:AbsPatroon = '^[a-zA-Z][a-zA-Z0-9+.\-]*://'
$script:RegelVars  = @('{UNENCODED_URL}', '{HTTP_URL}', '{REQUEST_URI}')

# DIT is het bewijsmiddel. De CustomResponse-actie zet deze tekst als reden in de
# statusregel ("HTTP/1.1 403 Forwarding is disabled"), en de zelftest onderaan zoekt er
# precies naar. Een 403 zonder deze tekst komt dus ergens anders vandaan.
$script:RegelReden = 'Forwarding is disabled'
$script:RegelBody  = 'This server does not forward requests with an absolute URI.'

# Stelt de zelftest onderaan vast dat deze machine toch als forward proxy werkt, dan
# wordt dit waar en eindigt het script met een afsluitcode ongelijk nul. Een halve
# installatie is beter dan een open proxy die op internet blijft staan.
$script:OpenProxy = $false

# Draait dit op client-Windows in plaats van Windows Server? Dat mag, maar IIS
# begrenst daar het aantal gelijktijdige verbindingen op 10 -- een beperking van
# de Windows-licentie, geen instelling. Dat hoort in de slotsamenvatting terug te
# komen, want het is precies het soort ding dat je vergeet tot de site traag wordt.
$script:ClientWindows = $false

# Wat het script uit zichzelf heeft teruggedraaid, los van de gewone wijzigingenlijst
# -- dat is namelijk geen wijziging maar een noodrem.
$script:Terugdraaiingen = @()

<#
    Microsoft.Web.Administration -- de beheer-API van IIS zelf.

    Waarom die en niet Add-/Set-WebConfigurationProperty: elke aanroep van die cmdlets
    is een APARTE schrijfactie naar applicationHost.config, en elke schrijfactie laat
    IIS zijn configuratie opnieuw inlezen en RECYCLET daarbij de toepassingsgroepen van
    alle sites -- ook die van de andere site op deze machine. De beschermregel kost er
    tien (regel, match, logicalGrouping, drie condities, vier actie-attributen) en de
    proxyschakelaar een elfde. Elf recycles voor een halve minuut werk.

    Met een ServerManager stel je alles in het geheugen samen en is CommitChanges()
    precies EEN schrijfactie. Bijkomend en belangrijker: de beschermregel en de
    proxyschakelaar landen dan TEGELIJK. Bij losse schrijfacties bestaat er altijd een
    moment waarop de een er wel is en de ander niet.

    De dll staat in %windir%\system32\inetsrv en hoort bij IIS zelf. Is hij er niet,
    dan is IIS stuk en horen we sowieso niets naar applicationHost.config te schrijven.
#>
function Import-IISBeheerapi {
    if ('Microsoft.Web.Administration.ServerManager' -as [type]) { return $true }
    $dll = Join-Path $env:windir 'system32\inetsrv\Microsoft.Web.Administration.dll'
    if (-not (Test-Path $dll)) { return $false }
    try {
        [void][System.Reflection.Assembly]::LoadFrom($dll)
    } catch {
        return $false
    }
    return [bool]('Microsoft.Web.Administration.ServerManager' -as [type])
}

<#
    Een enum-attribuut uit de IIS-configuratie vergelijken.

    Afhankelijk van versie en leesweg komt zo'n attribuut terug als de NAAM
    ('CustomResponse') of als het GETAL uit het schema. Beide accepteren, en dat hier
    op een plek, in plaats van op de aanroepplek te gokken.

    De getallen komen uit rewrite_schema.xml van URL Rewrite 2.x:
      action/@type          : None=0, Rewrite=1, Redirect=2, CustomResponse=3, AbortRequest=4
      conditions/@logicalGrouping : MatchAll=0, MatchAny=1
#>
function Test-Enumwaarde {
    param($Waarde, [string[]] $Toegestaan)
    if ($null -eq $Waarde) { return $false }
    if ($Waarde -isnot [string] -and $Waarde -isnot [bool] -and
        $Waarde -isnot [int] -and $Waarde -isnot [long]) {
        $eig = $Waarde.PSObject.Properties['Value']
        if ($eig) { $Waarde = $eig.Value }
    }
    $tekst = ([string]$Waarde).Trim()
    foreach ($a in $Toegestaan) { if ($tekst -eq $a) { return $true } }
    return $false
}

<#
    Staat de beschermregel er, en KLOPT HIJ?

    Dit was de gevaarlijkste fout in de vorige versie: er werd alleen gekeken of er een
    regel met onze NAAM in de lijst stond. Een regel die halverwege een eerdere run is
    blijven steken -- naam wel, condities niet -- telde daardoor als "staat er al",
    waarna de ARR-proxy alsnog werd aangezet. Precies dan sta je open.

    Daarom wordt hier de INHOUD nagelopen, attribuut voor attribuut:

      1. bestaat de regel                  -- anders is er niets
      2. enabled is niet false             -- een uitgezette regel doet niets
      3. match/@url matcht alles           -- '.*' of gelijkwaardig
      4. conditions/@logicalGrouping       -- MatchAny; met MatchAll moeten alle drie de
                                              variabelen de absolute vorm laten zien en
                                              dat doen ze niet altijd
      5. precies onze drie condities       -- elk met exact het juiste patroon; twee van
                                              de drie is niet genoeg, en een vierde
                                              vreemde conditie in MatchAny zou de regel
                                              op andere verzoeken laten vuren
      6. action/@type = CustomResponse     -- Rewrite of AbortRequest is iets anders
      7. action/@statusCode = 403
      8. action/@statusReason = de reden   -- DIT koppelt de inhoudscontrole aan de
                                              zelftest verderop: dezelfde tekst moet
                                              straks in de statusregel op de lijn staan

    Een half aangelegde regel valt op minstens een van die acht om, en er is geen
    volgorde waarin de aanleg kan stranden waarbij ze alle acht kloppen: de aanleg
    gebeurt in EEN CommitChanges(), dus de regel staat er compleet of hij staat er niet.
    Struikelt hij tussendoor, dan is er niets weggeschreven.
#>
function Get-Beschermregelstaat {
    $uit = [pscustomobject]@{
        Leesbaar  = $false
        Bestaat   = $false
        Ok        = $false
        Problemen = @()
        Leesfout  = ''
    }
    if (-not (Import-IISBeheerapi)) {
        $uit.Leesfout = 'Microsoft.Web.Administration is niet te laden.'
        return $uit
    }
    $mgr = $null
    try {
        $mgr    = New-Object Microsoft.Web.Administration.ServerManager
        $config = $mgr.GetApplicationHostConfiguration()
        $sectie = $config.GetSection('system.webServer/rewrite/globalRules')
        $regels = $sectie.GetCollection()
        $uit.Leesbaar = $true

        $mijn = $null
        foreach ($r in $regels) {
            if (([string]$r.GetAttributeValue('name')) -eq $script:RegelNaam) { $mijn = $r; break }
        }
        if (-not $mijn) {
            $uit.Problemen = @('de regel bestaat niet')
            return $uit
        }
        $uit.Bestaat = $true

        $p = New-Object System.Collections.ArrayList

        if (-not (Test-WaardeWaar $mijn.GetAttributeValue('enabled'))) {
            [void]$p.Add('de regel staat op enabled=false en doet dus niets')
        }
        if (-not (Test-WaardeWaar $mijn.GetAttributeValue('stopProcessing'))) {
            [void]$p.Add('stopProcessing staat niet aan')
        }

        $match = $mijn.GetChildElement('match')
        $url   = ''
        if ($match) { $url = ([string]$match.GetAttributeValue('url')).Trim() }
        if ($url -ne '.*' -and $url -ne '^.*$' -and $url -ne '.+') {
            [void]$p.Add("match/@url is '$url' en matcht dus niet elk pad")
        }

        $cond = $mijn.GetChildElement('conditions')
        if (-not $cond) {
            [void]$p.Add('er is geen conditions-element')
        } else {
            if (-not (Test-Enumwaarde $cond.GetAttributeValue('logicalGrouping') @('MatchAny', '1'))) {
                [void]$p.Add('conditions/@logicalGrouping staat niet op MatchAny')
            }
            $gevonden = @()
            foreach ($c in $cond.GetCollection()) {
                $inv = ([string]$c.GetAttributeValue('input')).Trim()
                $pat = ([string]$c.GetAttributeValue('pattern')).Trim()
                if ($script:RegelVars -contains $inv -and $pat -eq $script:AbsPatroon) {
                    $gevonden += $inv
                } else {
                    [void]$p.Add("onbekende conditie: input='$inv' pattern='$pat'")
                }
            }
            foreach ($v in $script:RegelVars) {
                if ($gevonden -notcontains $v) { [void]$p.Add("conditie op $v ontbreekt of heeft een ander patroon") }
            }
        }

        $actie = $mijn.GetChildElement('action')
        if (-not $actie) {
            [void]$p.Add('er is geen action-element')
        } else {
            if (-not (Test-Enumwaarde $actie.GetAttributeValue('type') @('CustomResponse', '3'))) {
                [void]$p.Add('action/@type is geen CustomResponse')
            }
            $code = ([string]$actie.GetAttributeValue('statusCode')).Trim()
            if ($code -ne '403') { [void]$p.Add("action/@statusCode is '$code' en niet 403") }
            $reden = ([string]$actie.GetAttributeValue('statusReason')).Trim()
            if ($reden -ne $script:RegelReden) {
                [void]$p.Add("action/@statusReason is '$reden'; de zelftest zoekt naar '$($script:RegelReden)'")
            }
        }

        $uit.Problemen = @($p)
        $uit.Ok        = ($p.Count -eq 0)
    } catch {
        $uit.Leesfout = $_.Exception.Message
        $uit.Leesbaar = $false
    } finally {
        if ($mgr) { try { $mgr.Dispose() } catch { } }
    }
    return $uit
}

<#
    Staat de ARR-proxy aan? $null betekent "niet te lezen" en dat is iets anders dan
    "uit" -- daar hangt aan het eind een blokkade aan.
#>
function Get-ArrProxyAan {
    if (-not (Import-IISBeheerapi)) { return $null }
    $mgr = $null
    try {
        $mgr    = New-Object Microsoft.Web.Administration.ServerManager
        $config = $mgr.GetApplicationHostConfiguration()
        $sectie = $config.GetSection('system.webServer/proxy')
        return [bool](Test-WaardeWaar $sectie.GetAttributeValue('enabled'))
    } catch {
        return $null
    } finally {
        if ($mgr) { try { $mgr.Dispose() } catch { } }
    }
}

<#
    De beschermregel neerleggen EN de proxy aanzetten -- in EEN CommitChanges(), dus
    in een schrijfactie naar applicationHost.config en dus in een recycle.

    Stond er al een regel met onze naam die de inhoudscontrole niet haalde, dan wordt
    die eerst uit de collectie gehaald en compleet opnieuw opgebouwd. Repareren van
    losse attributen zou betekenen dat je moet weten welke helft klopt; opnieuw
    aanleggen weet je zeker.
#>
function Set-Proxybescherming {
    param([bool] $RegelOpnieuw, [bool] $ProxyAanzetten)

    if (-not (Import-IISBeheerapi)) { throw 'Microsoft.Web.Administration is niet te laden.' }
    $mgr = $null
    try {
        $mgr    = New-Object Microsoft.Web.Administration.ServerManager
        $config = $mgr.GetApplicationHostConfiguration()

        if ($RegelOpnieuw) {
            $sectie = $config.GetSection('system.webServer/rewrite/globalRules')
            $regels = $sectie.GetCollection()

            $oud = @()
            foreach ($r in $regels) {
                if (([string]$r.GetAttributeValue('name')) -eq $script:RegelNaam) { $oud += $r }
            }
            foreach ($r in $oud) { $regels.Remove($r) }

            $regel = $regels.CreateElement('rule')
            $regel['name']           = $script:RegelNaam
            $regel['patternSyntax']  = 'ECMAScript'
            $regel['stopProcessing'] = $true
            $regel['enabled']        = $true

            $match = $regel.GetChildElement('match')
            $match['url'] = '.*'

            $cond = $regel.GetChildElement('conditions')
            $cond['logicalGrouping'] = 'MatchAny'
            $condCol = $cond.GetCollection()
            foreach ($v in $script:RegelVars) {
                $c = $condCol.CreateElement('add')
                $c['input']   = $v
                $c['pattern'] = $script:AbsPatroon
                [void]$condCol.Add($c)
            }

            $actie = $regel.GetChildElement('action')
            $actie['type']              = 'CustomResponse'
            $actie['statusCode']        = 403
            $actie['statusReason']      = $script:RegelReden
            $actie['statusDescription'] = $script:RegelBody

            [void]$regels.Add($regel)
        }

        if ($ProxyAanzetten) {
            $proxy = $config.GetSection('system.webServer/proxy')
            $proxy['enabled'] = $true
        }

        $mgr.CommitChanges()
    } finally {
        if ($mgr) { try { $mgr.Dispose() } catch { } }
    }
}

<#
    De noodrem: de ARR-proxy uitzetten.

    Wordt aangeroepen als de zelftest aantoont dat deze server toch als forward proxy
    antwoordt, of als de bescherming niet te bewijzen is en WIJ degenen waren die de
    schakelaar hebben omgezet. Een halve installatie is beter dan een open proxy.
#>
function Disable-ArrProxy {
    if (-not (Import-IISBeheerapi)) { throw 'Microsoft.Web.Administration is niet te laden.' }
    $mgr = $null
    try {
        $mgr    = New-Object Microsoft.Web.Administration.ServerManager
        $config = $mgr.GetApplicationHostConfiguration()
        $proxy  = $config.GetSection('system.webServer/proxy')
        $proxy['enabled'] = $false
        $mgr.CommitChanges()
    } finally {
        if ($mgr) { try { $mgr.Dispose() } catch { } }
    }
}

# ── HTTPS ─────────────────────────────────────────────────────────────────────

<#
    Hoeveel schrijfacties doet install-site.ps1 straks naar applicationHost.config?

    Niet geschat: geteld, uit wat er NU in IIS staat. install-site.ps1 doet precies
    deze dingen, en elk ervan is een aparte schrijfactie en dus een recycle:

        New-WebAppPool                                  alleen als de groep ontbreekt
        Set-ItemProperty managedRuntimeVersion          altijd
        Set-ItemProperty startMode                      altijd
        Set-ItemProperty processModel.idleTimeout       altijd
        New-Website                                     alleen als de site ontbreekt
                                                        (maakt meteen de binding voor
                                                        de eerste hostnaam)
        Set-ItemProperty physicalPath                   alleen als de site al bestaat
        Set-ItemProperty applicationPool                alleen als de site al bestaat
        New-WebBinding                                  per hostnaam die nog ontbreekt

    Set-Acl, Start-WebAppPool en Start-Website staan er bewust niet bij: die raken
    applicationHost.config niet.

    Het is een MAXIMUM: zet Set-ItemProperty een waarde die al klopt, dan kan IIS
    besluiten dat er niets vuil is en niets weg te schrijven. Overschatten mag hier,
    onderschatten niet -- iemand die 'ja' zegt moet weten waar hij ja tegen zegt.
#>
function Get-SiteSchrijfplan {
    param([string] $Naam, [string[]] $Hostnamen, [int] $Poort)
    $uit = [pscustomobject]@{ Aantal = 0; Regels = @() }
    $r = New-Object System.Collections.ArrayList

    if (-not (Test-Path "IIS:\AppPools\$Naam")) {
        $uit.Aantal += 1
        [void]$r.Add('1x  toepassingsgroep aanmaken')
    }
    $uit.Aantal += 3
    [void]$r.Add('3x  eigenschappen van de toepassingsgroep (.NET uit, AlwaysRunning, geen idle-timeout)')

    $siteBestaat = Test-Path "IIS:\Sites\$Naam"
    if ($siteBestaat) {
        $uit.Aantal += 2
        [void]$r.Add('2x  pad en toepassingsgroep van de bestaande site bijwerken')
    } else {
        $uit.Aantal += 1
        [void]$r.Add("1x  site aanmaken (met de binding voor $($Hostnamen[0]) erbij)")
    }

    foreach ($h in $Hostnamen) {
        if (-not $siteBestaat -and $h -eq $Hostnamen[0]) { continue }
        $bestaat = $null
        if ($siteBestaat) {
            $bestaat = Get-WebBinding -Name $Naam -Port $Poort -HostHeader $h -ErrorAction SilentlyContinue
        }
        if (-not $bestaat) {
            $uit.Aantal += 1
            [void]$r.Add("1x  binding http://${h}:$Poort toevoegen")
        }
    }
    $uit.Regels = @($r)
    return $uit
}

<#
    Is dit een bruikbare .pfx, en staat hij op een plek waar hij mag staan?

    Die tweede vraag is hier de belangrijkste. publish.ps1 spiegelt de site-map met
    robocopy /MIR naar de webroot. Een .pfx die in de repo of in de site-map staat,
    staat na de eerstvolgende publicatie op internet -- met de private sleutel erin.
    Daarom wordt dat geweigerd en niet met een waarschuwing afgedaan.

    Wat hier NIET gebeurt: het wachtwoord ergens neerzetten, en de vingerafdruk
    afdrukken. De vingerafdruk gaat wel terug naar de aanroeper, want de binding heeft
    hem nodig en de https-zelftest vergelijkt ermee -- maar hij komt op geen enkele
    regel op het scherm of in het logboek.
#>
function Test-Pfxbestand {
    param(
        [string] $Pad,
        [System.Security.SecureString] $Wachtwoord,
        [string[]] $VerbodenMappen = @()
    )
    $uit = [pscustomobject]@{
        Ok = $false; VolPad = ''; Onderwerp = ''; Geldig = ''; DnsNamen = @()
        HeeftSleutel = $false; Vingerafdruk = ''; Problemen = @()
    }
    $p = New-Object System.Collections.ArrayList

    if (-not $Pad) {
        [void]$p.Add('er is geen pad opgegeven')
        $uit.Problemen = @($p)
        return $uit
    }
    $vol = $Pad
    try { $vol = [System.IO.Path]::GetFullPath($Pad) } catch { $vol = $Pad }
    $uit.VolPad = $vol

    if (-not (Test-Path -LiteralPath $vol -PathType Leaf)) {
        [void]$p.Add("er staat geen bestand op $vol")
        $uit.Problemen = @($p)
        return $uit
    }

    foreach ($m in $VerbodenMappen) {
        if (-not $m) { continue }
        $mv = $m
        try { $mv = [System.IO.Path]::GetFullPath($m) } catch { $mv = $m }
        $mv = $mv.TrimEnd('\')
        if ($vol -eq $mv -or $vol.StartsWith($mv + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
            [void]$p.Add("het bestand staat in $mv -- daar mag geen sleutelmateriaal staan (publish.ps1 spiegelt die map met robocopy /MIR naar de webroot, en dan staat je private sleutel op internet)")
        }
    }

    $cert = $null
    try {
        # DefaultKeySet en NIET PersistKeySet: dit is alleen een controle, en de sleutel
        # hoort na deze regel weer weg te zijn.
        $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
            $vol, $Wachtwoord,
            [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::DefaultKeySet)
    } catch {
        [void]$p.Add("dit is geen leesbare .pfx, of het wachtwoord klopt niet ($($_.Exception.GetType().Name))")
        $uit.Problemen = @($p)
        return $uit
    }
    try {
        $uit.Onderwerp    = [string]$cert.Subject
        $uit.Geldig       = "$($cert.NotBefore.ToString('yyyy-MM-dd')) t/m $($cert.NotAfter.ToString('yyyy-MM-dd'))"
        $uit.HeeftSleutel = [bool]$cert.HasPrivateKey
        $uit.Vingerafdruk = [string]$cert.GetCertHashString()
        foreach ($ext in $cert.Extensions) {
            if ($ext.Oid -and $ext.Oid.Value -eq '2.5.29.17') {
                $tekst = ''
                try { $tekst = [string]$ext.Format($false) } catch { $tekst = '' }
                foreach ($treffer in ([regex]::Matches($tekst, 'DNS Name=([^,]+)'))) {
                    $uit.DnsNamen += $treffer.Groups[1].Value.Trim()
                }
            }
        }
        if (-not $uit.HeeftSleutel) {
            [void]$p.Add('deze .pfx bevat geen private sleutel; IIS kan er geen https-binding mee opzetten')
        }
        $nu = Get-Date
        if ($cert.NotAfter -lt $nu)  { [void]$p.Add("het certificaat is verlopen op $($cert.NotAfter.ToString('yyyy-MM-dd'))") }
        if ($cert.NotBefore -gt $nu) { [void]$p.Add("het certificaat is pas geldig vanaf $($cert.NotBefore.ToString('yyyy-MM-dd'))") }
    } finally {
        try { $cert.Dispose() } catch { }
    }

    $uit.Problemen = @($p)
    $uit.Ok        = ($p.Count -eq 0)
    return $uit
}

<#
    Wat is er op 443 nog nodig, en zit iemand anders daar al?

    Ontbreekt-lijst = de hostnamen waarvoor onze site nog geen https-binding heeft.
    Botsing-lijst   = een ANDERE site die op 443 al een van onze hostnamen claimt. Daar
                      blijven we af, net als op poort 80.
#>
function Get-HttpsStaat {
    param([string] $Naam, [string[]] $Hostnamen)
    $uit = [pscustomobject]@{ Leesbaar = $false; SiteBestaat = $false; Ontbreekt = @(); Botsing = @(); Leesfout = '' }
    if (-not (Import-IISBeheerapi)) {
        $uit.Leesfout = 'Microsoft.Web.Administration is niet te laden.'
        return $uit
    }
    $mgr = $null
    try {
        $mgr = New-Object Microsoft.Web.Administration.ServerManager
        $uit.Leesbaar = $true
        $onze = $null
        foreach ($s in $mgr.Sites) {
            if ($s.Name -eq $Naam) { $onze = $s; continue }
            foreach ($b in $s.Bindings) {
                if ([string]$b.Protocol -ne 'https') { continue }
                if ([string]$b.BindingInformation -notmatch '^(.*):(\d+):(.*)$') { continue }
                if ($Matches[2] -eq '443' -and $Matches[3] -and ($Hostnamen -contains $Matches[3])) {
                    $uit.Botsing += "site '$($s.Name)' claimt op 443 al de hostnaam $($Matches[3])"
                }
            }
        }
        if (-not $onze) {
            $uit.Ontbreekt = @($Hostnamen)
            return $uit
        }
        $uit.SiteBestaat = $true
        $heeft = @()
        foreach ($b in $onze.Bindings) {
            if ([string]$b.Protocol -ne 'https') { continue }
            if ([string]$b.BindingInformation -notmatch '^(.*):(\d+):(.*)$') { continue }
            if ($Matches[2] -eq '443') { $heeft += $Matches[3] }
        }
        $mist = @()
        foreach ($h in $Hostnamen) { if ($heeft -notcontains $h) { $mist += $h } }
        $uit.Ontbreekt = $mist
    } catch {
        $uit.Leesfout = $_.Exception.Message
        $uit.Leesbaar = $false
    } finally {
        if ($mgr) { try { $mgr.Dispose() } catch { } }
    }
    return $uit
}

<#
    De .pfx in het certificaatarchief van de MACHINE zetten (LocalMachine\My).

    Niet in dat van de gebruiker: de toepassingsgroep en http.sys draaien niet als jij.
    Staat het certificaat er al (zelfde vingerafdruk), dan gebeurt er niets.

    Geeft de vingerafdruk terug. Die wordt door de aanroeper gebruikt en nooit getoond.
#>
function Import-Pfx {
    param([string] $Pad, [System.Security.SecureString] $Wachtwoord, [string] $Vingerafdruk)

    if ($Vingerafdruk -and (Test-Path "Cert:\LocalMachine\My\$Vingerafdruk")) {
        return $Vingerafdruk
    }
    if (Get-Command Import-PfxCertificate -ErrorAction SilentlyContinue) {
        $c = Import-PfxCertificate -FilePath $Pad -CertStoreLocation 'Cert:\LocalMachine\My' `
                                   -Password $Wachtwoord -ErrorAction Stop
        return [string]$c.Thumbprint
    }
    # Terugval voor installaties zonder de pki-module: hetzelfde met de hand.
    $vlaggen = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]'MachineKeySet,PersistKeySet'
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($Pad, $Wachtwoord, $vlaggen)
    $winkel = New-Object System.Security.Cryptography.X509Certificates.X509Store('My', 'LocalMachine')
    $winkel.Open('ReadWrite')
    try { $winkel.Add($cert) } finally { $winkel.Close() }
    return [string]$cert.Thumbprint
}

<#
    De https-bindingen erbij hangen -- alle hostnamen in EEN CommitChanges(), dus in
    een schrijfactie naar applicationHost.config en dus in een recycle.

    sslFlags = 1 is Server Name Indication, en dat is hier niet optioneel: zonder SNI
    claimt de binding poort 443 voor ALLE hostnamen en zit je de andere site op deze
    machine in de weg zodra die ook https wil. Met SNI staan ze naast elkaar --
    dezelfde redenering als bij de hostnaam-bindingen op poort 80.
#>
function Add-HttpsBindingen {
    param([string] $Naam, [string[]] $Hostnamen, [string] $Vingerafdruk, [string] $Winkel = 'My')

    if (-not (Import-IISBeheerapi)) { throw 'Microsoft.Web.Administration is niet te laden.' }
    if (-not $Vingerafdruk) { throw 'Geen vingerafdruk om de binding aan te hangen.' }

    $bytes = New-Object byte[] ($Vingerafdruk.Length / 2)
    for ($i = 0; $i -lt $bytes.Length; $i++) {
        $bytes[$i] = [Convert]::ToByte($Vingerafdruk.Substring($i * 2, 2), 16)
    }

    $mgr = $null
    try {
        $mgr  = New-Object Microsoft.Web.Administration.ServerManager
        $site = $mgr.Sites[$Naam]
        if (-not $site) { throw "Site '$Naam' bestaat niet in IIS." }
        foreach ($h in $Hostnamen) {
            $b = $site.Bindings.Add("*:443:$h", $bytes, $Winkel)
            $b['sslFlags'] = 1
        }
        $mgr.CommitChanges()
    } finally {
        if ($mgr) { try { $mgr.Dispose() } catch { } }
    }
}

# ═══════════════════════════════════════════════════════════════════════════════
#  Vanaf hier het eigenlijke werk.
# ═══════════════════════════════════════════════════════════════════════════════

try {

Write-Host ''
Write-Host '  allmid.gg -- server klaarzetten' -ForegroundColor White -BackgroundColor DarkBlue
Write-Host ''
if ($DryRun) {
    Write-Host '  -DryRun: alle CONTROLES worden echt gedaan, er wordt NIETS gewijzigd.' -ForegroundColor Magenta
    Write-Host ''
}
Info "repo    : $RepoUrl ($Branch) -> $RepoRoot"
Info "site    : $SiteName op $SiteRoot, hostnamen $($SiteHosts -join ', ')"
Info "taak    : $TaskName"
if ($Force)     { Let '-Force: de bevestigingsvragen worden overgeslagen.' }
if ($NewApiKey) { Let '-NewApiKey: er komt een NIEUWE sleutel; bestaande clients werken daarna niet meer.' }

# ═══ 1. Voorwaarden ════════════════════════════════════════════════════════════
# Dit script installeert niets. Het kijkt of alles er is en stopt anders met een
# instructie plus downloadlink. Ook in -DryRun wordt dit ECHT gecontroleerd: een
# proefrun die groen meldt voor een run die gegarandeerd valt, is nutteloos.
Kop '1/9  Voorwaarden (dit script installeert niets -- het controleert)'

$script:Ontbreekt = New-Object System.Collections.ArrayList
function Mist {
    param([string] $Wat, [string] $Link, [string] $Uitleg = '')
    [void]$script:Ontbreekt.Add([pscustomobject]@{ Wat = $Wat; Link = $Link; Uitleg = $Uitleg })
}

Stap 'Administrator'
$ik = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if ($ik.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Goed "verhoogd, als $($ik.Identity.Name)"
} else {
    Blokkeer -Reden 'Dit script moet als Administrator draaien.' `
             -Hint  'Rechtermuisknop op PowerShell > "Als administrator uitvoeren" en probeer opnieuw.'
}

Stap 'PowerShell'
$psv = $PSVersionTable.PSVersion
Info "versie $psv op $([Environment]::OSVersion.VersionString)"
if ($psv.Major -lt 5) {
    Blokkeer -Reden "PowerShell $psv is te oud; 5.1 of nieuwer is nodig." `
             -Hint  'Windows Management Framework 5.1 bijwerken.'
} else {
    Goed 'bruikbaar'
}

Stap 'Uitvoeringsbeleid'
# De drie deploy-scripts staan straks als BESTAND op schijf en vallen dus wel onder
# het beleid. Alleen voor DIT proces omzetten: dat verdwijnt als het venster dichtgaat
# en laat niets op de machine achter. Dit gebeurt ook in -DryRun, want anders zou een
# proefrun deze voorwaarde niet echt testen.
#
# En daarna NAKIJKEN of het gelukt is. Onder een groepsbeleid (MachinePolicy of
# UserPolicy) wint dat van de procesinstelling en doet Set-ExecutionPolicy niets
# zichtbaars -- dan faalt het straks pas bij het eerste deploy-script.
try {
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop
} catch {
    Let "Set-ExecutionPolicy gaf: $($_.Exception.Message)"
}
$effectief = Get-ExecutionPolicy
if ($effectief -eq 'Bypass' -or $effectief -eq 'Unrestricted' -or $effectief -eq 'RemoteSigned') {
    Goed "effectief beleid: $effectief (procesbereik, verdwijnt met dit venster)"
} else {
    $lijst = ''
    try { $lijst = ((Get-ExecutionPolicy -List | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" }) -join ', ') } catch { }
    Blokkeer -Reden "Het uitvoeringsbeleid blijft op '$effectief'; de deploy-scripts kunnen dan niet starten." `
             -Hint  "Waarschijnlijk staat er een groepsbeleid overheen. Nu ingesteld: $lijst. Laat MachinePolicy/UserPolicy aanpassen of draai de drie scripts uit deploy\ met de hand."
}

Stap 'Architectuur en Windows-versie'
if ([Environment]::Is64BitOperatingSystem) {
    Goed 'x64'
} else {
    Blokkeer -Reden 'Dit is een 32-bits Windows.' `
             -Hint  'De IIS-modules die hier gebruikt worden zijn de amd64-versies.'
}
$os = Get-CimInstance Win32_OperatingSystem
# ProductType: 1 = werkstation, 2 = domeincontroller, 3 = server.
Info "$($os.Caption.Trim())  (ProductType $($os.ProductType))"
if ($os.ProductType -ne 1) {
    Goed 'Windows Server'
} else {
    # Eerder blokkeerde dit. Dat was te streng: IIS draait prima op Windows Pro
    # en alles wat dit script doet werkt daar. Of IIS er is wordt hieronder
    # gewoon apart gecontroleerd, en dat is de vraag die er echt toe doet.
    #
    # Maar er is wel een verschil dat je moet weten, en dat is geen instelling
    # maar een licentiebeperking van Windows zelf.
    Let 'Dit is client-Windows, geen Windows Server.'
    Let 'IIS werkt hier, maar begrenst het aantal GELIJKTIJDIGE verbindingen op 10.'
    Let 'Dat is een limiet van de Windows-licentie en niet uit te zetten. Voor een'
    Let 'publieke site is dat een echt plafond: bij drukte staan bezoekers in de wacht.'
    Let 'Met Cloudflare ervoor die statische bestanden cachet valt er mee te leven;'
    Let 'groeit het, dan is Windows Server (of een reverse proxy die meer aankan) nodig.'
    $script:ClientWindows = $true
}

Stap 'IIS'
$inetstp = 'HKLM:\SOFTWARE\Microsoft\InetStp'
$iisVersie = ''
if (Test-Path $inetstp) {
    $reg = Get-ItemProperty $inetstp
    $iisVersie = "$($reg.MajorVersion).$($reg.MinorVersion)"
}
$w3svc = Get-Service -Name 'W3SVC' -ErrorAction SilentlyContinue
$was   = Get-Service -Name 'WAS'   -ErrorAction SilentlyContinue
if ($iisVersie -and $w3svc) {
    Goed "IIS $iisVersie"
    Goed "W3SVC: $($w3svc.Status)"
    if ($was) { Goed "WAS  : $($was.Status)" } else { Let 'WAS (Windows Process Activation Service) niet gevonden' }
    if ($w3svc.Status -ne 'Running') {
        # Niet zelf starten: staat W3SVC bewust uit, dan is dat een beslissing van de
        # beheerder en niet iets om ongevraagd om te zetten.
        Blokkeer -Reden 'W3SVC draait niet.' `
                 -Hint  'Ik start hem niet ongevraagd -- dat kan een bewuste keuze zijn. Start hem zelf (Start-Service W3SVC) en draai opnieuw.'
    }
    try {
        Import-Module WebAdministration -ErrorAction Stop
        $script:KanIIS = $true
        Goed 'module WebAdministration geladen'
    } catch {
        Blokkeer -Reden "De module WebAdministration laadt niet: $($_.Exception.Message)" `
                 -Hint  'Installeer het IIS-beheerscript-onderdeel: Install-WindowsFeature Web-Scripting-Tools'
    }
    # De beheer-API van IIS zelf. Hiermee gaan de beschermregel en de proxyschakelaar in
    # EEN schrijfactie naar applicationHost.config in plaats van in elf. Zie de uitleg
    # bij Import-IISBeheerapi.
    if (Import-IISBeheerapi) {
        Goed 'Microsoft.Web.Administration geladen (bundelt de IIS-wijzigingen tot een schrijfactie)'
    } else {
        Blokkeer -Reden 'Microsoft.Web.Administration is niet te laden, terwijl IIS wel geinstalleerd is.' `
                 -Hint  "Verwacht op $(Join-Path $env:windir 'system32\inetsrv\Microsoft.Web.Administration.dll'). Ontbreekt die, dan is de IIS-installatie incompleet: Install-WindowsFeature Web-Mgmt-Service, of herstel IIS."
    }
} else {
    Blokkeer -Reden 'IIS is niet geinstalleerd op deze machine.' `
             -Hint  'Install-WindowsFeature Web-Server -IncludeManagementTools'
    Mist -Wat 'IIS' -Link 'Install-WindowsFeature Web-Server -IncludeManagementTools'
}

Stap 'URL Rewrite en Application Request Routing'
# Deze twee werden vroeger door dit script gedownload en als SYSTEM geinstalleerd,
# zonder handtekeningcontrole. Dat is nu weg: ze staan er, of het script stopt hier.
# Zonder URL Rewrite geeft IIS bovendien een 500 op onze web.config, en zonder ARR
# komt /api/ nergens.
$rewriteSleutel = 'HKLM:\SOFTWARE\Microsoft\IIS Extensions\URL Rewrite'
$arrSleutel     = 'HKLM:\SOFTWARE\Microsoft\IIS Extensions\Application Request Routing'
if (Test-Path $rewriteSleutel) {
    Goed 'URL Rewrite aanwezig'
} else {
    Blokkeer -Reden 'URL Rewrite ontbreekt.' -Hint 'Installeer hem zelf: https://www.iis.net/downloads/microsoft/url-rewrite'
    Mist -Wat 'IIS URL Rewrite 2.1' -Link 'https://www.iis.net/downloads/microsoft/url-rewrite'
}
if (Test-Path $arrSleutel) {
    Goed 'Application Request Routing aanwezig'
} else {
    Blokkeer -Reden 'Application Request Routing ontbreekt.' -Hint 'Installeer hem zelf: https://www.iis.net/downloads/microsoft/application-request-routing'
    Mist -Wat 'IIS Application Request Routing 3.0' -Link 'https://www.iis.net/downloads/microsoft/application-request-routing'
}

Stap 'Node'
$node = Get-Pad 'node.exe'
if ($node) {
    $nodeVersie = (& $node --version).TrimStart('v')
    $nodeHoofd  = [int](($nodeVersie -split '\.')[0])
    if ($nodeHoofd -ge 20) {
        Goed "node $nodeVersie op $node"
    } else {
        Blokkeer -Reden "node $nodeVersie is te oud; 20 of nieuwer is nodig." `
                 -Hint  'Haal de LTS-installer op bij https://nodejs.org/en/download (Windows Installer .msi, x64).'
        Mist -Wat "Node 20 of nieuwer (nu $nodeVersie)" -Link 'https://nodejs.org/en/download'
    }
} else {
    Blokkeer -Reden 'node is niet gevonden.' `
             -Hint  'Installeer Node 20 of nieuwer: https://nodejs.org/en/download (Windows Installer .msi, x64). Ik vervang of installeer zelf geen Node -- er kan iets anders op deze server van afhangen.'
    Mist -Wat 'Node.js 20 of nieuwer' -Link 'https://nodejs.org/en/download'
}

Stap 'npm'
$npm = Get-Pad 'npm.cmd'
if (-not $npm) { $npm = Get-Pad 'npm' }
if ($npm) {
    Goed "npm op $npm"
} else {
    Blokkeer -Reden 'npm is niet gevonden.' `
             -Hint  'npm hoort bij de Node-installatie. Open een NIEUWE PowerShell (het PATH van een lopende sessie wordt niet bijgewerkt) en probeer opnieuw.'
    Mist -Wat 'npm (hoort bij Node)' -Link 'https://nodejs.org/en/download'
}

Stap 'Git'
$git = Get-Pad 'git.exe'
if ($git) {
    Goed "$((& $git --version)) op $git"
} else {
    # De oude zip-terugval is weg. Die haalde een tarbal van main op zonder pinning en
    # maakte bijwerken handwerk; dat is meer risico en meer uitleg dan het waard is.
    Blokkeer -Reden 'git is niet gevonden.' `
             -Hint  'Installeer Git for Windows: https://git-scm.com/download/win. Daarna is bijwerken "git pull" in plaats van elke keer een nieuwe download.'
    Mist -Wat 'Git for Windows' -Link 'https://git-scm.com/download/win'
}

if ($script:Ontbreekt.Count -gt 0) {
    Write-Host ''
    Fout 'Dit moet je zelf installeren voordat dit script iets kan doen:'
    foreach ($m in $script:Ontbreekt) {
        Write-Host "   * $($m.Wat)" -ForegroundColor Yellow
        Write-Host "     $($m.Link)" -ForegroundColor Gray
    }
    Info 'Installeer ze, open een NIEUWE PowerShell als administrator, en draai dit script opnieuw.'
}

# ═══ 2. Nulmeting ══════════════════════════════════════════════════════════════
# "Zijn de bestaande sites nog heel?" is niet te beantwoorden zonder te weten hoe ze
# er VOORAF bij stonden. En de State-eigenschap van een site zegt daar bijna niets
# over: die staat op Started zolang IIS de site niet heeft gestopt, ook als elk
# verzoek een 503 oplevert. Daarom hier ook echte HTTP-verzoeken, met de juiste
# host-kop, en de statuscode eruit.
Kop '2/9  Nulmeting: hoe staat de machine er NU bij'

function Get-Nulmeting {
    $meting = [pscustomobject]@{
        Tijd      = Get-Date
        Diensten  = @()
        Sites     = @()
        Pools     = @()
        Probes    = @()
    }

    foreach ($naam in @('W3SVC', 'WAS')) {
        $d = Get-Service -Name $naam -ErrorAction SilentlyContinue
        $status = 'ontbreekt'
        if ($d) { $status = [string]$d.Status }
        $meting.Diensten += [pscustomobject]@{ Naam = $naam; Status = $status }
    }
    if (-not $script:KanIIS) { return $meting }

    foreach ($s in @(Get-ChildItem 'IIS:\Sites' -ErrorAction SilentlyContinue)) {
        $staat = ''
        try { $staat = [string]$s.State } catch { $staat = 'onleesbaar' }
        $bindingen = @()
        foreach ($b in $s.Bindings.Collection) {
            $bindingen += [pscustomobject]@{ Info = $b.bindingInformation; Protocol = $b.protocol }
        }
        $meting.Sites += [pscustomobject]@{
            Naam      = $s.Name
            Staat     = $staat
            Pool      = $s.applicationPool
            Bindingen = $bindingen
        }
    }
    foreach ($p in @(Get-ChildItem 'IIS:\AppPools' -ErrorAction SilentlyContinue)) {
        $staat = ''
        try { $staat = [string]$p.State } catch { $staat = 'onleesbaar' }
        $meting.Pools += [pscustomobject]@{ Naam = $p.Name; Staat = $staat }
    }

    # Echte verzoeken naar de sites die NIET van ons zijn. Alleen http: een
    # https-binding zou een certificaatcontrole meebrengen die hier alleen maar ruis
    # oplevert. Per site hooguit drie bindingen, anders wordt de uitvoer onleesbaar.
    foreach ($s in $meting.Sites) {
        if ($s.Naam -eq $SiteName) { continue }
        $gedaan = 0
        foreach ($b in $s.Bindingen) {
            if ($b.Protocol -ne 'http') { continue }
            if ($gedaan -ge 3) { break }
            # bindingInformation is "adres:poort:hostnaam". Niet klakkeloos op ':'
            # splitsen: bij een IPv6-adres ([::]:80:naam) staan daar meer dubbele punten
            # in en zou de poort de verkeerde waarde krijgen.
            if ($b.Info -notmatch '^(.*):(\d+):(.*)$') { continue }
            $poort  = $Matches[2]
            $bHost  = $Matches[3]
            $url    = "http://127.0.0.1:$poort/"
            $r      = Invoke-Controleverzoek -Url $url -Hostnaam $bHost -TimeoutSec 15
            $meting.Probes += [pscustomobject]@{
                Site   = $s.Naam
                Host   = $bHost
                Poort  = $poort
                Status = $r.Status
                Fout   = $r.Fout
            }
            $gedaan++
        }
    }
    return $meting
}

$nulmeting = Get-Nulmeting

<#
    De nulmeting opnieuw doen en het verschil tonen.

    Waarom dit een functie is en niet gewoon de onderkant van stap 9: hij moet OOK op
    het foutpad draaien. Vroeger stond deze meting alleen in het gelukte pad, en sloeg
    het catch-blok hem over. Precies verkeerd om: juist als er halverwege iets omvalt --
    een mislukte npm ci, een geblokkeerde schrijfactie, een script uit de repo dat
    struikelt -- wil je weten of de ANDERE site op deze machine nog antwoordt. Dat is de
    vraag waar je 's nachts wakker van ligt, niet of onze eigen site het doet.

    Hij is idempotent gemaakt met een vlag: het gelukte pad roept hem aan het eind aan,
    het catch-blok alleen als dat nog niet gebeurd is.
#>
function Invoke-Eindmeting {
    if ($script:EindmetingGedaan) { return }
    $script:EindmetingGedaan = $true

    Stap 'De nulmeting opnieuw, en het verschil'

    $eindmeting = $null
    try {
        $eindmeting = Get-Nulmeting
    } catch {
        Fout "De eindmeting zelf mislukte: $($_.Exception.Message)"
        Meld-Controle -Wat 'eindmeting' -Ok $false -Detail 'de meting kon niet uitgevoerd worden'
        return
    }

    foreach ($voorD in $script:nulmeting.Diensten) {
        $naD = @($eindmeting.Diensten | Where-Object { $_.Naam -eq $voorD.Naam })[0]
        $naStatus = 'onbekend'
        if ($naD) { $naStatus = $naD.Status }
        Meld-Controle -Wat "dienst $($voorD.Naam)" -Ok ($naStatus -eq $voorD.Status) `
            -Detail "$($voorD.Status) -> $naStatus"
    }

    foreach ($voorS in $script:nulmeting.Sites) {
        $naS = @($eindmeting.Sites | Where-Object { $_.Naam -eq $voorS.Naam })[0]
        if (-not $naS) {
            Meld-Controle -Wat "site $($voorS.Naam)" -Ok $false -Detail "$($voorS.Staat) -> WEG"
            continue
        }
        Meld-Controle -Wat "site $($voorS.Naam)" -Ok ($naS.Staat -eq $voorS.Staat) `
            -Detail "$($voorS.Staat) -> $($naS.Staat)"
    }
    foreach ($naS in $eindmeting.Sites) {
        $bekend = @($script:nulmeting.Sites | Where-Object { $_.Naam -eq $naS.Naam })
        if ($bekend.Count -eq 0) {
            Info ("nieuw (van ons): site {0} staat op {1}" -f $naS.Naam, $naS.Staat)
        }
    }

    foreach ($voorP in $script:nulmeting.Pools) {
        $naP = @($eindmeting.Pools | Where-Object { $_.Naam -eq $voorP.Naam })[0]
        $naStaat = 'WEG'
        if ($naP) { $naStaat = $naP.Staat }
        # Een pool die recyclet komt vanzelf weer op Started; hij hoort niet op
        # Stopped te blijven staan.
        Meld-Controle -Wat "toepassingsgroep $($voorP.Naam)" -Ok ($naStaat -eq $voorP.Staat) `
            -Detail "$($voorP.Staat) -> $naStaat"
    }

    if ($script:nulmeting.Probes.Count -eq 0) {
        Info 'Er waren vooraf geen andere sites met een http-binding om te bevragen.'
    } else {
        foreach ($voorPr in $script:nulmeting.Probes) {
            $naPr = @($eindmeting.Probes | Where-Object {
                $_.Site -eq $voorPr.Site -and $_.Host -eq $voorPr.Host -and $_.Poort -eq $voorPr.Poort
            })[0]
            $naStatus = 0
            if ($naPr) { $naStatus = $naPr.Status }
            $wat = "HTTP $($voorPr.Site) $($voorPr.Host):$($voorPr.Poort)"

            <#
                Status 0 in de NULMETING betekent: die site gaf vooraf al geen antwoord.
                Is hij aan het eind weer 0, dan is dat gelijk aan de nulmeting -- maar het
                bewijst niets. Twee keer niets is geen bewijs dat de site leeft, en dat
                mocht niet langer als een geslaagde controle in de samenvatting staan.
            #>
            if ($voorPr.Status -eq 0) {
                Meld-Controle -Wat $wat -Onbeslist -Ok $false `
                    -Detail "kon vooraf al niet gemeten worden (0 -> $naStatus); dit zegt niets over die site"
                continue
            }
            Meld-Controle -Wat $wat -Ok ($naStatus -eq $voorPr.Status) `
                -Detail "$($voorPr.Status) -> $naStatus"
        }
    }
}

Stap 'Diensten'
foreach ($d in $nulmeting.Diensten) { Info ("{0,-8} {1}" -f $d.Naam, $d.Status) }

if ($script:KanIIS) {
    Stap 'Sites'
    foreach ($s in $nulmeting.Sites) {
        $b = ($s.Bindingen | ForEach-Object { $_.Info }) -join ', '
        Write-Host ("   {0,-24} {1,-9} pool={2,-18} {3}" -f $s.Naam, $s.Staat, $s.Pool, $b) -ForegroundColor Gray
    }
    Goed "$($nulmeting.Sites.Count) site(s) -- geen enkele wordt aangeraakt"

    Stap 'Toepassingsgroepen'
    foreach ($p in $nulmeting.Pools) { Write-Host ("   {0,-30} {1}" -f $p.Naam, $p.Staat) -ForegroundColor Gray }

    Stap 'Echte HTTP-verzoeken naar de bestaande sites'
    if ($nulmeting.Probes.Count -eq 0) {
        Info 'geen andere site met een http-binding gevonden'
    } else {
        $ongemeten = 0
        foreach ($p in $nulmeting.Probes) {
            $detail = "HTTP $($p.Status)"
            if ($p.Status -eq 0) {
                $detail = "geen antwoord: $($p.Fout)"
                $ongemeten++
            }
            Write-Host ("   {0,-24} {1,-28} {2}" -f $p.Site, "$($p.Host):$($p.Poort)", $detail) -ForegroundColor Gray
        }
        Info 'Deze getallen zijn de meetlat. Aan het eind wordt exact hetzelfde opnieuw gedaan.'
        if ($ongemeten -gt 0) {
            Let "$ongemeten binding(en) gaven nu al geen antwoord (status 0)."
            Let 'Daarvan valt aan het eind niets te bewijzen: weer 0 is geen bewijs dat die'
            Let 'site leeft. Die komen straks als ONBESLIST in de uitslag, niet als geslaagd.'
        }
    }
} else {
    Info 'IIS is hier niet leesbaar, dus er valt niets te meten.'
    Info 'Op de server gebeurt hier: alle sites, toepassingsgroepen en diensten opnemen,'
    Info 'plus een echt HTTP-verzoek per http-binding van elke bestaande site.'
}

# ═══ 3. Botsingen ══════════════════════════════════════════════════════════════
Kop '3/9  Botst er iets met wat er al draait?'

if ($script:KanIIS) {
    Stap 'Hostnamen'
    foreach ($s in $nulmeting.Sites) {
        foreach ($b in $s.Bindingen) {
            $bHost = ''
            if ($b.Info -match '^(.*):(\d+):(.*)$') { $bHost = $Matches[3] }
            if ($bHost -and ($SiteHosts -contains $bHost) -and $s.Naam -ne $SiteName) {
                Blokkeer -Reden "De hostnaam '$bHost' hoort al bij site '$($s.Naam)'." `
                         -Hint  'Ik pak geen bindingen af. Los dit eerst met de hand op in IIS Manager.'
            }
        }
    }
    Goed 'geen botsende hostnaam'

    Stap "Site '$SiteName'"
    if (Test-Path "IIS:\Sites\$SiteName") {
        $bestaandPad = (Get-Item "IIS:\Sites\$SiteName").physicalPath
        if ($bestaandPad -and ($bestaandPad.TrimEnd('\') -ne $SiteRoot.TrimEnd('\'))) {
            Blokkeer -Reden "Site '$SiteName' bestaat al maar wijst naar '$bestaandPad' in plaats van '$SiteRoot'." `
                     -Hint  'Dat is niet onze site. Hernoem er een, of geef -SiteName / -SiteRoot mee.'
        } else {
            Goed "bestaat al en wijst naar $bestaandPad -- dit is een herhaalde run"
        }
    } else {
        Goed 'nog niet aanwezig; hij wordt straks toegevoegd'
    }

    Stap "Toepassingsgroep '$SiteName'"
    if (Test-Path "IIS:\AppPools\$SiteName") {
        $anderen = @($nulmeting.Sites | Where-Object { $_.Naam -ne $SiteName -and $_.Pool -eq $SiteName })
        if ($anderen.Count -gt 0) {
            Blokkeer -Reden "Toepassingsgroep '$SiteName' is in gebruik door site '$($anderen[0].Naam)'." `
                     -Hint  'Geef -SiteName een andere waarde; ik deel geen toepassingsgroep met een vreemde site.'
        }
        Goed 'bestaat al en is van ons'
    } else {
        Goed 'nog niet aanwezig; hij wordt straks toegevoegd'
    }
} else {
    Info 'Niet te controleren zonder IIS. Op de server wordt hier gekeken of een andere'
    Info "site $($SiteHosts -join ' of ') claimt, en of '$SiteName' als site en"
    Info 'toepassingsgroep ontbreekt of al van ons is. Botst er iets, dan stopt het.'
}

# ── Wat gaat er straks NAAR applicationHost.config? ───────────────────────────
<#
    Dit is puur lezen, en het staat hier omdat de volgende stap toestemming vraagt.
    Die vraag noemde vroeger "drie schrijfacties". Dat waren er in werkelijkheid
    ongeveer achttien: tien in dit script voor de beschermregel en de proxyschakelaar,
    en zeven in install-site.ps1. Elk daarvan recyclet de toepassingsgroep van de
    andere site op deze machine.

    Twee dingen zijn daaraan gedaan. Ten eerste zijn de tien uit dit script tot EEN
    teruggebracht door ze met Microsoft.Web.Administration in een CommitChanges() te
    bundelen. Ten tweede wordt hieronder GETELD wat er nog overblijft, uit wat er nu
    echt in IIS staat, zodat de vraag straks een getal noemt dat klopt.
#>
$script:RegelStaat     = $null
$script:ProxyAan       = $null
$script:SitePlan       = $null
$script:HttpsStaat     = $null
$script:PfxStaat       = $null
$script:SchrijfBootstrap = 0
$script:SchrijfSite      = 0
$script:SchrijfHttps     = 0

Stap 'Beschermregel en ARR-proxy: hoe staan ze er NU bij?'
if ($script:KanIIS) {
    $script:RegelStaat = Get-Beschermregelstaat
    if (-not $script:RegelStaat.Leesbaar) {
        Blokkeer -Reden "De serverbrede rewrite-regels zijn niet te lezen: $($script:RegelStaat.Leesfout)" `
                 -Hint  'Zonder die controle kan ik niet vaststellen of de bescherming er is, en dan gaat de proxy niet aan.'
    } elseif ($script:RegelStaat.Ok) {
        Goed "beschermregel '$($script:RegelNaam)' staat er en de INHOUD klopt"
    } elseif ($script:RegelStaat.Bestaat) {
        Let "Er staat een regel '$($script:RegelNaam)', maar de inhoud deugt niet:"
        foreach ($pr in $script:RegelStaat.Problemen) { Let "  - $pr" }
        Let 'Hij wordt daarom compleet opnieuw aangelegd. Alleen de naam zegt niets:'
        Let 'een half aangelegde of uitgezette regel weigert niets.'
    } else {
        Info 'de beschermregel ontbreekt nog; hij wordt straks aangelegd'
    }

    $script:ProxyAan = Get-ArrProxyAan
    if ($null -eq $script:ProxyAan) {
        Blokkeer -Reden 'De ARR-proxyinstelling is niet leesbaar terwijl ARR wel geinstalleerd is.' `
                 -Hint  'Herstart de server (of iisreset) en draai dit script opnieuw.'
    } elseif ($script:ProxyAan) {
        Let 'de ARR-proxy staat AL AAN -- deze server kon dus al als forward proxy aangesproken worden'
    } else {
        Info 'de ARR-proxy staat uit; hij gaat straks aan, tegelijk met de beschermregel'
    }

    # Een schrijfactie voor de regel plus de proxy samen -- of nul, als beide al goed staan.
    $regelNodig = $true
    if ($script:RegelStaat.Ok) { $regelNodig = $false }
    $proxyNodig = $true
    if ($script:ProxyAan) { $proxyNodig = $false }
    if ($regelNodig -or $proxyNodig) { $script:SchrijfBootstrap = 1 }

    $script:SitePlan   = Get-SiteSchrijfplan -Naam $SiteName -Hostnamen $SiteHosts -Poort 80
    $script:SchrijfSite = $script:SitePlan.Aantal
} else {
    Info 'Niet te lezen zonder IIS. Op de server wordt hier de INHOUD van de'
    Info 'beschermregel nagelopen (bestaat hij, staat hij aan, heeft hij de drie'
    Info 'condities en de CustomResponse-actie met de juiste reden) en wordt geteld'
    Info 'hoeveel schrijfacties naar applicationHost.config er nog nodig zijn.'
    $script:SchrijfBootstrap = 1
    $script:SchrijfSite      = 7
}

# ── De .pfx, als er een is meegegeven ─────────────────────────────────────────
Stap 'HTTPS'
if (-not $PfxPath) {
    Info 'geen -PfxPath meegegeven: de https-stap wordt overgeslagen.'
    Info 'Aan het eind staat wat je daarvoor moet doen.'
    $script:HttpsReden = 'overgeslagen: geen -PfxPath meegegeven'
} else {
    # Het wachtwoord eerst, want zonder wachtwoord valt er niets aan de .pfx te
    # controleren. Nooit als platte tekst, nooit afgedrukt, nooit gelogd.
    if (-not $PfxPassword) {
        if ($Force) {
            Blokkeer -Reden 'Met -Force kan er niet interactief om het .pfx-wachtwoord gevraagd worden.' `
                     -Hint  'Geef -PfxPassword mee als SecureString, bijvoorbeeld: -PfxPassword (Read-Host -AsSecureString) in het aanroepende script, of laat -PfxPath weg.'
        } else {
            try {
                $PfxPassword = Read-Host "   Wachtwoord van $PfxPath" -AsSecureString
            } catch {
                Blokkeer -Reden 'Het .pfx-wachtwoord kan hier niet gevraagd worden (geen console).' `
                         -Hint  'Geef -PfxPassword mee als SecureString, of laat -PfxPath weg.'
            }
        }
    }

    # Waar de .pfx NIET mag staan. De repo en de site-map zijn de twee die je echt op
    # het web zetten; C:\allmid staat er ook bij omdat de repo daaronder hangt en de
    # verzamelserver daar als SYSTEM in draait.
    $verboden = @($RepoRoot, $SiteRoot, $AllmidRoot)
    if ($PSScriptRoot) { $verboden += (Split-Path $PSScriptRoot -Parent) }

    $script:PfxStaat = Test-Pfxbestand -Pad $PfxPath -Wachtwoord $PfxPassword -VerbodenMappen $verboden
    if ($script:PfxStaat.Ok) {
        Goed "bruikbare .pfx op $($script:PfxStaat.VolPad)"
        Info "onderwerp : $($script:PfxStaat.Onderwerp)"
        Info "geldig    : $($script:PfxStaat.Geldig)"
        if ($script:PfxStaat.DnsNamen.Count -gt 0) {
            Info "hostnamen : $($script:PfxStaat.DnsNamen -join ', ')"
        }
        Info 'De vingerafdruk en het wachtwoord worden met opzet niet getoond en niet gelogd.'

        foreach ($h in $SiteHosts) {
            $past = $false
            foreach ($d in $script:PfxStaat.DnsNamen) {
                if ($d -eq $h) { $past = $true }
                if ($d.StartsWith('*.') -and $h.EndsWith($d.Substring(1))) { $past = $true }
            }
            if (-not $past -and $script:PfxStaat.DnsNamen.Count -gt 0) {
                Let "Het certificaat noemt $h niet. Cloudflare klaagt daar straks over."
            }
        }

        if ($script:KanIIS) {
            $script:HttpsStaat = Get-HttpsStaat -Naam $SiteName -Hostnamen $SiteHosts
            if ($script:HttpsStaat.Botsing.Count -gt 0) {
                foreach ($b in $script:HttpsStaat.Botsing) { Fout "  $b" }
                Blokkeer -Reden 'Een andere site claimt op 443 al een van onze hostnamen.' `
                         -Hint  'Ik pak geen bindingen af. Los dat eerst met de hand op in IIS Manager.'
            }
            if ($script:HttpsStaat.Ontbreekt.Count -gt 0) { $script:SchrijfHttps = 1 }
        } else {
            $script:SchrijfHttps = 1
        }
    } else {
        foreach ($pr in $script:PfxStaat.Problemen) { Fout "  $pr" }
        Blokkeer -Reden "De opgegeven .pfx is niet bruikbaar: $PfxPath" `
                 -Hint  'Zet het bestand buiten de repo en buiten de site-map (bijvoorbeeld C:\certs\), controleer het wachtwoord, en draai opnieuw.'
        $script:HttpsReden = 'overgeslagen: de opgegeven .pfx is niet bruikbaar'
    }
}

# ═══ 4. Toestemming ════════════════════════════════════════════════════════════
# Alles hierboven was lezen. Hieronder wordt er geschreven, en de eerste schrijfactie
# naar applicationHost.config raakt ook de ANDERE site. Dat hoort niet stilletjes te
# gebeuren.
Kop '4/9  Wat er gaat gebeuren -- en wat de andere site daarvan merkt'

$totaalSchrijf = $script:SchrijfBootstrap + $script:SchrijfSite + $script:SchrijfHttps

Write-Host @"

   Aan de machine:
     * $AllmidRoot wordt aangemaakt, met overerving UIT en schrijfrecht alleen voor
       Administrators en SYSTEM (daar draait straks permanent code als SYSTEM).
     * de repo komt in $RepoRoot (git clone of git pull) en er draait npm ci.
     * $SiteRoot wordt gevuld met de sitebestanden.
     * er komt een geplande taak '$TaskName' die als SYSTEM draait.

   Aan IIS (dit is wat de bestaande site merkt):
     * er komt een serverbrede URL Rewrite-regel die verzoeken met een absolute URI
       weigert -- de bescherming tegen een open proxy.
     * de ARR-proxy gaat aan (als hij nog uit staat).
     * er komt een site '$SiteName' bij, met een eigen toepassingsgroep.
"@ -ForegroundColor Gray

Write-Host @"
   ELKE schrijfactie naar applicationHost.config laat IIS zijn configuratie opnieuw
   inlezen, en RECYCLET daarbij de toepassingsgroepen van ALLE sites op deze machine
   -- ook die van de andere site. Een schrijfactie is dus een recycle. Dit zijn ze,
   geteld uit wat er NU in IIS staat:
"@ -ForegroundColor Gray

Write-Host ("     {0,2}x  bootstrap.ps1     beschermregel + ARR-proxy" -f $script:SchrijfBootstrap) -ForegroundColor White
if ($script:SchrijfBootstrap -gt 0) {
    Write-Host '           (gebundeld in een CommitChanges; los waren dit er elf)' -ForegroundColor DarkGray
} else {
    Write-Host '           (allebei staan ze al goed; er hoeft niets geschreven te worden)' -ForegroundColor DarkGray
}
Write-Host ("     {0,2}x  install-site.ps1  site, toepassingsgroep en bindingen" -f $script:SchrijfSite) -ForegroundColor White
if ($script:SitePlan) {
    foreach ($r in $script:SitePlan.Regels) { Write-Host "           $r" -ForegroundColor DarkGray }
} else {
    Write-Host '           (schatting: op deze machine is IIS niet te lezen)' -ForegroundColor DarkGray
}
Write-Host ("     {0,2}x  bootstrap.ps1     https-binding op 443 (beide hostnamen samen)" -f $script:SchrijfHttps) -ForegroundColor White
if ($script:SchrijfHttps -eq 0) {
    Write-Host '           (geen -PfxPath, of de bindingen staan er al)' -ForegroundColor DarkGray
}
Write-Host '     ---------------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ("     {0,2}x  schrijfacties = evenveel recycles van de andere site" -f $totaalSchrijf) -ForegroundColor Yellow

Write-Host @"

   Het is een BOVENGRENS: zet install-site.ps1 een eigenschap op de waarde die er al
   staat, dan kan IIS besluiten dat er niets weg te schrijven valt. Overschatten mag
   hier, onderschatten niet.

   Een recycle duurt seconden en de site komt vanzelf terug, maar verzoeken die op dat
   moment onderweg zijn kunnen sneuvelen. Plan dit buiten piekuren.

   Wat er NIET gebeurt: geen bestaande site, binding of toepassingsgroep wordt
   gewijzigd, gestopt of verwijderd. Er wordt niets geinstalleerd.
"@ -ForegroundColor Gray

[void](Bevestig -Vraag "Doorgaan met $totaalSchrijf schrijfactie(s) naar applicationHost.config?" -Uitleg @(
    "Dat zijn $totaalSchrijf recycles van de toepassingsgroepen van ALLE sites op deze machine,",
    'dus ook van de site die hier al draait.'
))

# ═══ 5. C:\allmid en de rechten daarop ═════════════════════════════════════════
Kop "5/9  $AllmidRoot en de rechten daarop"

Info 'C:\ geeft via overerving Authenticated Users (OI)(CI)(IO)(M): elke ingelogde'
Info 'gebruiker mag schrijven in wat daaronder nieuw wordt aangemaakt. In de map'
Info 'hieronder draait SYSTEM permanent code, dus dat moet dicht.'

if ($DryRun) {
    Plan  "$AllmidRoot (en logs\ en state\) aanmaken als ze ontbreken"
    Plan  'overerving verbreken en schrijfrecht beperken tot Administrators (S-1-5-32-544) en SYSTEM (S-1-5-18)'
    Terug "icacls `"$AllmidRoot`" /reset  (zet de overerving van C:\ terug)"
    $huidig = Test-SchrijfrechtenBeperkt -Pad $AllmidRoot
    if ($huidig.Bestaat) {
        Info "bestaat al; overerving verbroken: $($huidig.Beschermd)"
        foreach ($o in $huidig.Ongewenst) { Let "mag nu schrijven: $o" }
    } else {
        Info 'bestaat nog niet'
    }
} else {
    foreach ($map in @($AllmidRoot, $script:LogMap, $script:StateMap)) {
        if (-not (Test-Path $map)) {
            Wijzig -Wat "map $map aangemaakt" `
                   -Terugdraaien "Remove-Item -Recurse -Force `"$map`"" `
                   -Doe { New-Item -ItemType Directory -Path $map -Force | Out-Null }
        } else {
            Goed "bestaat al: $map"
        }
    }

    $voor = Test-SchrijfrechtenBeperkt -Pad $AllmidRoot
    if ($voor.Beschermd -and $voor.Ongewenst.Count -eq 0) {
        Goed 'rechten stonden al goed -- niets te doen'
    } else {
        foreach ($o in $voor.Ongewenst) { Let "mag nu schrijven: $o" }
        Wijzig -Wat "rechten op $AllmidRoot beperkt tot Administrators en SYSTEM (overerving verbroken)" `
               -Terugdraaien "icacls `"$AllmidRoot`" /reset  (herstelt de overerving vanaf C:\)" `
               -Doe {
                   # Een VERSE DirectorySecurity in plaats van Get-Acl + regels weghalen:
                   # geerfde regels laten zich niet met RemoveAccessRule verwijderen, en
                   # SetAccessRuleProtection($true, $false) zegt "verbreek de overerving
                   # en neem de geerfde regels NIET over". Wat overblijft is precies wat
                   # we hieronder toevoegen.
                   $acl = New-Object System.Security.AccessControl.DirectorySecurity
                   $acl.SetAccessRuleProtection($true, $false)
                   foreach ($sid in @('S-1-5-32-544', 'S-1-5-18')) {
                       $wie = New-Object System.Security.Principal.SecurityIdentifier($sid)
                       $regel = New-Object System.Security.AccessControl.FileSystemAccessRule(
                           $wie, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
                       $acl.AddAccessRule($regel)
                   }
                   Set-Acl -Path $AllmidRoot -AclObject $acl
               }
    }

    # Controleren, niet aannemen. Ook een paar niveaus dieper: het verbreken van de
    # overerving op de bovenste map ruimt geen EXPLICIETE regels op die iemand ooit op
    # een submap heeft gezet.
    Stap 'Nakijken met icacls'
    $paden = @($AllmidRoot)
    foreach ($sub in @('desktop', 'logs', 'state', 'server-data')) {
        $p = Join-Path $AllmidRoot $sub
        if (Test-Path $p) { $paden += $p }
    }
    foreach ($p in $paden) {
        # Geen 2>&1 hierachter: PowerShell 5.1 maakt van elke stderr-regel van een
        # extern programma een ErrorRecord, en met $ErrorActionPreference = 'Stop'
        # sneuvelt het script daar dan op.
        $regels = @()
        try { $regels = @(& icacls $p) } catch { $regels = @("icacls gaf: $($_.Exception.Message)") }
        foreach ($r in $regels) { Write-Host "   $r" -ForegroundColor DarkGray }
        $na = Test-SchrijfrechtenBeperkt -Pad $p
        if ($na.Ongewenst.Count -eq 0) {
            Meld-Controle -Wat "schrijfrechten $p" -Ok $true -Detail 'alleen Administrators en SYSTEM'
        } else {
            Meld-Controle -Wat "schrijfrechten $p" -Ok $false -Detail ($na.Ongewenst -join ' | ')
            Let 'Zet dat recht met: icacls <pad> /inheritance:r /grant *S-1-5-32-544:(OI)(CI)F /grant *S-1-5-18:(OI)(CI)F'
        }
    }
}

# ═══ 6. De repo ════════════════════════════════════════════════════════════════
Kop '6/9  Repo neerzetten en npm ci'

Stap $RepoRoot
$isGitKloon  = Test-Path (Join-Path $RepoRoot '.git')
$mapAanwezig = Test-Path $RepoRoot

if ($mapAanwezig -and -not $isGitKloon) {
    $inhoud = @(Get-ChildItem $RepoRoot -Force -ErrorAction SilentlyContinue)
    if ($inhoud.Count -gt 0) {
        Blokkeer -Reden "$RepoRoot bestaat al, is niet leeg, en is geen git-kloon." `
                 -Hint  'Hernoem of leeg die map zelf, of geef -RepoRoot een andere waarde. Ik overschrijf hem niet.'
    } else {
        Goed 'map bestaat maar is leeg'
    }
}

if ($isGitKloon) {
    # Een bestaande kloon kan naar een heel andere repo wijzen. Daar straks code uit
    # draaien als Administrator zonder dat te controleren, is precies het soort ding
    # dat je een keer overkomt.
    $herkomst = ''
    try { $herkomst = ([string](& $git -C $RepoRoot remote get-url origin)).Trim() } catch { $herkomst = '' }
    if (-not $herkomst) {
        Blokkeer -Reden "In $RepoRoot staat een .git-map, maar 'origin' is er niet uit te lezen." `
                 -Hint  "Kijk zelf met: git -C `"$RepoRoot`" remote -v. Ik werk geen kloon bij waarvan ik de herkomst niet ken."
    } elseif ($herkomst.TrimEnd('/') -ne $RepoUrl.TrimEnd('/')) {
        Blokkeer -Reden "De kloon in $RepoRoot komt van '$herkomst' en niet van '$RepoUrl'." `
                 -Hint  'Geef -RepoUrl mee als dat klopt, of ruim die map op. Ik draai geen code uit een repo die ik niet verwacht.'
    }
    Goed "bestaat al als git-kloon van $herkomst"
    Wijzig -Wat "repo bijgewerkt naar origin/$Branch" `
           -Terugdraaien "git -C `"$RepoRoot`" reset --hard <de commit van hiervoor>" `
           -Doe {
               & $git -C $RepoRoot fetch --prune origin
               if ($LASTEXITCODE -ne 0) { throw "git fetch mislukte (code $LASTEXITCODE)" }
               # --ff-only en niet reset --hard: staan er lokale wijzigingen, dan wil ik
               # dat horen in plaats van ze zonder te vragen weg te gooien.
               & $git -C $RepoRoot merge --ff-only "origin/$Branch"
               if ($LASTEXITCODE -ne 0) {
                   throw "git merge --ff-only mislukte (code $LASTEXITCODE). Er staan waarschijnlijk lokale wijzigingen in $RepoRoot. Los dat met de hand op; ik gooi hier niets weg."
               }
           }
} else {
    Wijzig -Wat "repo gekloond naar $RepoRoot" `
           -Terugdraaien "Remove-Item -Recurse -Force `"$RepoRoot`"" `
           -Doe {
               & $git clone --branch $Branch $RepoUrl $RepoRoot
               if ($LASTEXITCODE -ne 0) { throw "git clone mislukte (code $LASTEXITCODE)" }
           }
}

Stap 'De deploy-scripts moeten er zijn'
$nodig = @('deploy\install-site.ps1', 'deploy\publish.ps1', 'deploy\install-collector.ps1',
           'deploy\web.config', 'server\index.ts', 'site\build.mjs', 'package-lock.json')
if ($DryRun -and -not (Test-Path $RepoRoot)) {
    Info "$RepoRoot bestaat hier nog niet; na het klonen wordt gecontroleerd op:"
    foreach ($n in $nodig) { Info "  $n" }
} else {
    foreach ($n in $nodig) {
        $p = Join-Path $RepoRoot $n
        if (Test-Path $p) {
            Goed "aanwezig: $n"
        } else {
            Blokkeer -Reden "Ontbreekt in de repo: $n" -Hint 'Klopt -Branch? Is de kloon compleet?'
        }
    }
}

# ── Welke commit gaan we straks uitvoeren? ─────────────────────────────────────
# Dit script roept straks drie PowerShell-scripts uit die repo aan, als Administrator,
# en npm ci voert de bouwstappen van de afhankelijkheden uit. Wie op main kan
# schrijven, kan dus code op deze server draaien. Daar is met de middelen van nu geen
# technische oplossing voor (we ondertekenen niets), dus dan maar eerlijk: laten zien
# WAT er uitgevoerd gaat worden en vragen of het klopt.
Stap 'Welke commit gaat er draaien?'
$commitRegel = ''
$vuil = @()
if (Test-Path (Join-Path $RepoRoot '.git')) {
    try {
        $commitRegel = (& $git -C $RepoRoot log -1 --date=iso --format='%h  %ad  %an  %s' 2>$null)
        $vuil = @(& $git -C $RepoRoot status --porcelain 2>$null)
    } catch {
        $commitRegel = ''
    }
}
if ($commitRegel) {
    <#
        -Force slaat de VRAAG over. Wat het niet mag overslaan is het TONEN en LOGGEN
        van welke commit er zo als Administrator gaat draaien -- juist bij een onbeheerde
        run is dat het enige spoor dat achteraf nog te lezen is. Daarom staat het hier
        buiten Bevestig: het gebeurt altijd, en het gaat altijd het logboek in.
    #>
    $volleHash = ''
    try { $volleHash = ([string](& $git -C $RepoRoot rev-parse HEAD 2>$null)).Trim() } catch { $volleHash = '' }

    $script:CommitRegel = [string]$commitRegel
    $script:CommitHash  = $volleHash
    $script:CommitVuil  = @($vuil)

    Write-Host ''
    Write-Host '   -- DIT GAAT ER DRAAIEN ------------------------------------' -ForegroundColor Black -BackgroundColor Yellow
    Write-Host "   $commitRegel" -ForegroundColor White
    Info "volledige hash: $volleHash"
    if ($vuil.Count -gt 0) {
        Let "LET OP: $($vuil.Count) bestand(en) in de werkmap wijken af van die commit:"
        foreach ($v in ($vuil | Select-Object -First 10)) { Let "  $v" }
        Let 'Wat er draait is dus NIET precies wat er in die commit staat.'
    } else {
        Goed 'werkmap is schoon: wat er draait is exact deze commit'
    }
    if ($Force -and -not $DryRun) {
        Let '-Force: hier wordt niet gevraagd. De commit hierboven staat ook in het logboek.'
    }
    [void](Bevestig -Vraag 'Deze code als Administrator uitvoeren?' -Uitleg @(
        'Hierna draaien npm ci en drie PowerShell-scripts UIT DEZE REPO, met volle rechten.',
        "Commit: $commitRegel",
        "Hash  : $volleHash",
        'Controleer de commit hierboven als je de repo niet zelf beheert.'
    ))
} elseif ($DryRun) {
    Info 'Nog geen kloon, dus er valt hier niets te tonen. Een echte run laat hash,'
    Info 'datum, auteur en onderwerp van de commit zien en vraagt om bevestiging'
    Info 'voordat er ook maar iets uit de repo wordt aangeroepen.'
} else {
    Blokkeer -Reden 'De commit is niet af te lezen uit de kloon.' -Hint 'Is git clone goed gegaan?'
}

# ── De poort van de verzamelserver ─────────────────────────────────────────────
Stap 'Poort van de verzamelserver'
$webConfigPad = Join-Path $RepoRoot 'deploy\web.config'
if (-not (Test-Path $webConfigPad) -and $PSScriptRoot) {
    # In een proefrun vanaf een uitgecheckte repo staat web.config gewoon naast dit
    # bestand; dan kunnen we de poort toch alvast laten zien.
    $webConfigPad = Join-Path $PSScriptRoot 'web.config'
}
$CollectorPort = Get-CollectorPoort -WebConfigPad $webConfigPad
# Puur voor de leesbaarheid van de uitvoer: in een proefrun zonder kloon is de poort
# nog onbekend, en dan is "127.0.0.1:0" een misleidend getal om af te drukken.
$poortTekst = '<poort uit deploy\web.config>'
if ($CollectorPort -gt 0) { $poortTekst = [string]$CollectorPort }
if ($CollectorPort -gt 0) {
    Goed "$CollectorPort, gelezen uit $webConfigPad"
    Info 'Dezelfde waarde gaat naar install-collector.ps1. Een tweede plek om dit in te'
    Info 'stellen zou vroeg of laat uit de pas lopen; daarom is -CollectorPort weg.'
} elseif ($DryRun -and -not (Test-Path $webConfigPad)) {
    Info 'web.config is hier nog niet; na het klonen wordt de poort daaruit gelezen.'
} else {
    Blokkeer -Reden "De poort is niet uit $webConfigPad te lezen." `
             -Hint  "Verwacht wordt een regel <rule name=`"allmid-api`"> met een action url http://127.0.0.1:<poort>/api/{R:1}."
}

# ── npm ci ─────────────────────────────────────────────────────────────────────
Stap 'npm ci'
Info 'Niet optioneel: tsx komt hieruit en zonder node_modules start de verzamelserver niet.'

<#
    Twee dingen die hier eerder misgingen.

    1. Bij een tweede run houdt de DRAAIENDE verzamelserver bestanden in node_modules
       vast (aangetoond op esbuild.exe) en loopt npm ci vast. Daarom wordt de geplande
       taak eerst gestopt en daarna weer gestart. De andere optie -- npm ci overslaan
       als er niets veranderd is -- is bewust NIET gekozen: npm ci gooit node_modules
       eerst helemaal weg en bouwt hem opnieuw op uit package-lock.json, en of de map
       op schijf nog klopt is niet af te leiden uit een hash van dat lockbestand. Een
       overgeslagen npm ci die er wel had moeten zijn, kost je een halve avond zoeken.
       Het herstarten gebeurt in een finally, zodat een mislukte npm ci de collector
       niet uit laat staan.

    2. npm ci draait hier als Administrator. Met --ignore-scripts draaien de
       install- en postinstall-scripts van de afhankelijkheden NIET mee. Dat is op
       deze boom getest en het werkt:
         - esbuild (waar tsx op leunt) heeft een postinstall, maar die valideert en
           kopieert alleen de binary die al in het platformpakket @esbuild/win32-x64
           zit. Zonder dat script draait tsx gewoon; nagemeten met een echt
           TypeScript-bestand met extensieloze imports, en met esbuild over
           server\index.ts.
         - electron 43 heeft in het geheel geen install-script meer (de binary komt
           via `install-electron`), dus daar valt niets over te slaan. De oude
           ELECTRON_SKIP_BINARY_DOWNLOAD is daarmee zinloos geworden en is hier weg.
         - fsevents is alleen macOS en wordt op Windows niet geinstalleerd;
           electron-winstaller heeft wel een install-script maar wordt alleen gebruikt
           om installers te BOUWEN, nooit op deze server.
       Na afloop wordt gecontroleerd dat tsx echt start. Blijkt een toekomstige
       afhankelijkheid zijn install-script wel nodig te hebben, dan valt dat daar op
       in plaats van pas als de collector niet meer opkomt.
#>
Info 'Draait met --ignore-scripts: geen install-scripts van afhankelijkheden als Administrator.'

if ($DryRun) {
    Plan  "geplande taak '$TaskName' stoppen (als hij draait), zodat node_modules vrij is"
    Plan  "npm ci --ignore-scripts in $RepoRoot"
    Plan  "taak daarna weer starten"
    Terug "Remove-Item -Recurse -Force `"$RepoRoot\node_modules`""
} else {
    $taakDraaide = $false
    $taakVooraf = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($taakVooraf -and $taakVooraf.State -eq 'Running') {
        $taakDraaide = $true
        Let "De verzamelserver draait en houdt bestanden in node_modules vast; ik stop hem even."
        Wijzig -Wat "geplande taak '$TaskName' gestopt voor npm ci" `
               -Terugdraaien "Start-ScheduledTask -TaskName '$TaskName'" `
               -Doe {
                   Stop-ScheduledTask -TaskName $TaskName
                   # Wachten tot hij echt weg is: Stop-ScheduledTask komt terug voordat
                   # het proces zijn bestanden heeft losgelaten.
                   $tot = (Get-Date).AddSeconds(30)
                   while ((Get-Date) -lt $tot) {
                       $t = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
                       $leeft = Invoke-Controleverzoek -Url "http://127.0.0.1:$CollectorPort/api/v1/health" -TimeoutSec 3
                       if ((-not $t -or $t.State -ne 'Running') -and -not $leeft.Ok) { break }
                       Start-Sleep -Seconds 2
                   }
               }
    }

    try {
        Wijzig -Wat "npm ci --ignore-scripts uitgevoerd in $RepoRoot" `
               -Terugdraaien "Remove-Item -Recurse -Force `"$RepoRoot\node_modules`"" `
               -Doe {
                   Push-Location $RepoRoot
                   try {
                       & $npm ci --ignore-scripts --no-audit --no-fund
                       if ($LASTEXITCODE -ne 0) { throw "npm ci eindigde met code $LASTEXITCODE" }
                   } finally {
                       Pop-Location
                   }
               }
    } finally {
        if ($taakDraaide) {
            # Ook als npm ci sneuvelde: de collector hoort te draaien. install-collector.ps1
            # registreert hem straks opnieuw, maar tot dat moment mag hij niet uit staan.
            try {
                Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
                Goed "taak '$TaskName' weer gestart"
            } catch {
                Let "De taak kon niet herstart worden: $($_.Exception.Message)"
            }
        }
    }

    Stap 'Werkt tsx echt?'
    $tsx = Join-Path $RepoRoot 'node_modules\tsx\dist\cli.mjs'
    if (-not (Test-Path $tsx)) {
        Blokkeer -Reden "tsx ontbreekt na npm ci ($tsx)." -Hint 'Kijk naar de uitvoer van npm hierboven.'
    }
    $tsxUit = ''
    $tsxOk  = $false
    try {
        $tsxUit = ((& $node $tsx --version) -join ' / ').Trim()
        $tsxOk  = ($LASTEXITCODE -eq 0 -and $tsxUit -match 'tsx')
    } catch {
        $tsxUit = $_.Exception.Message
        $tsxOk  = $false
    }
    if ($tsxOk) {
        Meld-Controle -Wat 'tsx start' -Ok $true -Detail $tsxUit
    } else {
        Meld-Controle -Wat 'tsx start' -Ok $false -Detail 'tsx komt niet op'
        Blokkeer -Reden 'tsx staat er wel, maar start niet.' `
                 -Hint  "Draai met de hand: npm ci  (dus zonder --ignore-scripts) in $RepoRoot en kijk wat er anders gaat."
    }
}

# ═══ 7. De API-sleutel ═════════════════════════════════════════════════════════
Kop '7/9  API-sleutel'

# Deze staat voor stap 8 omdat install-collector.ps1 hem nodig heeft. Getoond wordt
# hij pas in de eindsamenvatting, zodat hij onderaan het scherm staat.
$startBestand = Join-Path $AllmidRoot 'start-collector.cmd'
$bestaandeSleutel = Get-SleutelUitStartbestand -Pad $startBestand

if ($ApiKey) {
    $script:SleutelBron  = 'meegegeven met -ApiKey'
    $script:SleutelNieuw = $false
    Goed "eigen sleutel meegegeven: $(Hide-Sleutel $ApiKey)"
    if ($bestaandeSleutel -and $bestaandeSleutel -ne $ApiKey) {
        Let 'Dit is een ANDERE sleutel dan die nu in start-collector.cmd staat.'
        Let 'Elke al ingerichte client moet daarna opnieuw ingesteld worden.'
    }
    if ($ApiKey.Length -lt 24) {
        Let "Deze sleutel is maar $($ApiKey.Length) tekens. Dit is het enige dat uploaden afschermt; neem er minstens 32."
    }
} elseif ($bestaandeSleutel -and -not $NewApiKey) {
    # Dit is de reden dat deze functie bestaat: een tweede run mag geen nieuwe sleutel
    # verzinnen. Dat zou elke al ingerichte client breken, en dat merk je pas als de
    # uploads stoppen.
    $ApiKey = $bestaandeSleutel
    $script:SleutelBron  = "hergebruikt uit $startBestand"
    $script:SleutelNieuw = $false
    Goed "bestaande sleutel hergebruikt: $(Hide-Sleutel $ApiKey)"
    Info 'Alle clients die hem al hebben, blijven werken. Wil je toch een nieuwe:'
    Info 'draai opnieuw met -NewApiKey (en stel daarna elke client opnieuw in).'
} else {
    if ($bestaandeSleutel -and $NewApiKey) {
        Let '-NewApiKey: de bestaande sleutel wordt vervangen.'
        Let 'ALLE al ingerichte clients moeten daarna opnieuw ingesteld worden.'
        [void](Bevestig -Vraag 'Bestaande sleutel echt vervangen?' -Uitleg @(
            "De huidige sleutel staat in $startBestand en is in gebruik."
        ))
    }
    if ($DryRun) {
        Info 'Er is nog geen sleutel. Een echte run genereert er een van 48 tekens uit'
        Info 'RNGCryptoServiceProvider, bewaart hem in start-collector.cmd (alleen'
        Info 'leesbaar voor Administrators en SYSTEM) en toont hem een keer.'
        $ApiKey = 'proefrun-geen-echte-sleutel'
        $script:SleutelBron = 'proefrun'
    } else {
        $ApiKey = New-ApiSleutel -Lengte 48
        $script:SleutelNieuw = $true
        $script:SleutelBron  = 'nieuw gegenereerd'
        Goed '48 tekens gegenereerd uit RNGCryptoServiceProvider'
        Info "Hij komt onderaan te staan en wordt bewaard in $startBestand."
    }
}

# ═══ 8. IIS en de drie scripts ═════════════════════════════════════════════════
Kop '8/9  Proxybescherming, ARR, site, publiceren, verzamelserver'

# ── 8a. De bescherming en de proxy, in EEN schrijfactie ───────────────────────
<#
    Waarom samen en niet na elkaar: bij losse schrijfacties bestaat er altijd een
    moment waarop de een er wel is en de ander niet. Met een ServerManager worden de
    regel en de proxyschakelaar in het geheugen samengesteld en landen ze in EEN
    CommitChanges() -- een schrijfactie naar applicationHost.config, een recycle, en
    geen tussenstand waarin deze server een open proxy is.

    Wat de regel doet: een serverbrede (globalRules) URL Rewrite-regel die verzoeken
    met een absolute URI in de requestregel beantwoordt met 403.

    Waarom een CONDITIE op de serverbenamingen en niet het patroon van de regel zelf:
    Microsoft documenteert dat globale regels altijd op het PAD van de URL werken --
    "the requested URI without the server name". Een patroon als ^https?:// zou daar
    dus nooit op passen. De drie variabelen hieronder bevatten de URL wel zoals de
    client hem stuurde; UNENCODED_URL is gedocumenteerd als "the original URL exactly
    as it was requested by a Web client". Ze staan in een MatchAny: het is genoeg als
    er EEN de absolute vorm laat zien.

    Waarom dit de bestaande site niet raakt: een gewoon verzoek stuurt de oorsprong-
    vorm ("GET /pad HTTP/1.1"), en die begint met een schuine streep. Het patroon is
    verankerd aan het begin, dus /redirect?url=http://... past er niet op. Alleen een
    client die deze server als PROXY aanspreekt stuurt "GET http://... HTTP/1.1", en
    dat is precies wat we willen weigeren.

    Waarom dit geen prestatieverlies geeft: alle drie de variabelen staan op de lijst
    van Microsoft met server-variabelen die de uitvoercache van IIS niet uitschakelen.

    Waarom globalRules: die zijn alleen op serverniveau in te stellen en kunnen op een
    lager niveau niet overschreven of uitgezet worden -- ook niet door een web.config
    van een andere site. Ze worden bovendien vroeg in de pijplijn geevalueerd
    (PreBeginRequest), voordat ARR het verzoek in handen krijgt.

    En dan het eerlijke deel: dit is niet op een machine met IIS na te meten geweest
    (deze ontwikkelmachine heeft geen IIS). Daarom test het script het straks zelf,
    door zo'n verzoek naar 127.0.0.1 te sturen, en staat de opdracht om het vanaf een
    andere machine na te doen in de eindtekst. Vertrouw de test, niet dit commentaar.

    En daarom kijkt het script hier ook naar de INHOUD van een al bestaande regel en
    niet naar de naam. Een regel die er alleen bij NAAM is -- half aangelegd, of op
    enabled=false gezet -- weigert niets, en zou wel als "staat er al" doorgaan. Dan
    ging de proxy aan zonder bescherming. Zie Get-Beschermregelstaat.
#>
$RegelNaam  = $script:RegelNaam
$absPatroon = $script:AbsPatroon

Stap "Beschermregel '$RegelNaam' en de ARR-proxy"
Info 'Zonder de proxyschakelaar geeft IIS een 502 op /api/: ARR mag dan niet doorsturen.'
Info 'Aanzetten maakt IIS ook een FORWARD proxy voor verzoeken met een absolute URI.'
Info 'Daarom gaan de beschermregel en die schakelaar samen in een schrijfactie.'

if ($script:KanIIS) {
    # Opnieuw lezen, en niet vertrouwen op de meting uit stap 3: daartussen zit npm ci,
    # het klonen van de repo en een bevestiging, en dat kan minuten duren.
    $regelStaat = Get-Beschermregelstaat
    if (-not $regelStaat.Leesbaar) {
        Blokkeer -Reden "De serverbrede rewrite-regels zijn niet te lezen: $($regelStaat.Leesfout)" `
                 -Hint  'Zonder die controle zet ik de proxy niet aan.'
    }
    $proxyAan = Get-ArrProxyAan
    if ($null -eq $proxyAan) {
        Blokkeer -Reden 'De ARR-proxyinstelling is niet leesbaar terwijl ARR wel geinstalleerd is.' `
                 -Hint  'Herstart de server (of iisreset) en draai dit script opnieuw.'
    }

    $regelNodig = -not $regelStaat.Ok
    $proxyNodig = -not $proxyAan

    if ($regelStaat.Ok) {
        Goed 'de beschermregel staat er en de inhoud klopt -- niet aangeraakt'
    } elseif ($regelStaat.Bestaat) {
        Let 'Er staat een regel met onze naam, maar de inhoud deugt niet:'
        foreach ($pr in $regelStaat.Problemen) { Let "  - $pr" }
        Let 'Hij wordt compleet opnieuw aangelegd. Repareren van losse attributen zou'
        Let 'betekenen dat je moet weten welke helft klopt; opnieuw aanleggen weet je zeker.'
    } else {
        Info 'de beschermregel ontbreekt en wordt aangelegd'
    }

    # De volgorde van de serverbrede regels blijft een aandachtspunt: onze regel komt
    # achteraan, en een eerdere regel met stopProcessing kan hem het werk uit handen nemen.
    # Daar valt niet automatisch over te oordelen, dus het wordt gemeld.
    $andereGlobals = @()
    try {
        $andereGlobals = @(Get-WebConfiguration -PSPath 'MACHINE/WEBROOT/APPHOST' `
            -Filter 'system.webServer/rewrite/globalRules/rule' -ErrorAction Stop |
            ForEach-Object { [string]$_.name } | Where-Object { $_ -ne $RegelNaam })
    } catch {
        $andereGlobals = @()
    }
    if ($regelNodig -and $andereGlobals.Count -gt 0) {
        Let "Er staan al $($andereGlobals.Count) andere serverbrede regel(s): $($andereGlobals -join ', ')"
        Let 'Onze regel komt er ACHTER. Heeft een van die regels stopProcessing en past'
        Let 'hij eerder, dan komt onze regel niet aan de beurt. Zet hem in IIS Manager >'
        Let '(server) > URL Rewrite > View Ordered List bovenaan als dat zo is.'
        Let 'De zelftest in stap 9 laat zien of dat gebeurt.'
    }

    if ($proxyAan) {
        Let 'De ARR-proxy stond AL AAN -- die schakelaar is niet van ons en blijft van iemand anders.'
        Let 'Deze server kon dus al als forward proxy aangesproken worden, buiten ons om.'
    }

    if (-not $regelNodig -and -not $proxyNodig) {
        Goed 'niets te schrijven: regel en proxy staan allebei al goed'
    } else {
        $wat = @()
        if ($regelNodig) { $wat += "beschermregel '$RegelNaam' (403 + reden '$($script:RegelReden)')" }
        if ($proxyNodig) { $wat += 'ARR-proxy aan (system.webServer/proxy enabled=true)' }
        $terug = @()
        if ($regelNodig) { $terug += "Remove-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/rewrite/globalRules' -Name '.' -AtElement @{name='$RegelNaam'}" }
        if ($proxyNodig) { $terug += "Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value `$false" }

        $doeRegel = $regelNodig
        $doeProxy = $proxyNodig
        Wijzig -Wat ("APPHOST in EEN schrijfactie: " + ($wat -join ' + ')) `
               -Terugdraaien ($terug -join ' ; ') `
               -Doe {
                   Set-Proxybescherming -RegelOpnieuw $doeRegel -ProxyAanzetten $doeProxy
               }
        if ($proxyNodig) { $script:ProxyDoorOnsAan = $true }

        # Nakijken, niet aannemen: staat er nu echt een regel die de inhoudscontrole haalt?
        $naStaat = Get-Beschermregelstaat
        if ($naStaat.Ok) {
            Meld-Controle -Wat 'beschermregel in applicationHost.config' -Ok $true -Detail 'inhoud gecontroleerd, niet alleen de naam'
        } else {
            Meld-Controle -Wat 'beschermregel in applicationHost.config' -Ok $false `
                -Detail (($naStaat.Problemen) -join ' | ')
            # De proxy staat nu mogelijk aan zonder werkende bescherming. Dat is precies
            # de toestand die we nooit willen laten bestaan.
            if ($script:ProxyDoorOnsAan) {
                Fout 'De regel staat er niet goed op terwijl de proxy net aan is gegaan. Ik zet hem terug uit.'
                try {
                    Disable-ArrProxy
                    Fout 'ARR-proxy weer UIT gezet.'
                    $script:Terugdraaiingen += 'ARR-proxy weer uitgezet: de beschermregel haalde de inhoudscontrole niet'
                    $script:ProxyDoorOnsAan = $false
                } catch {
                    Fout "De proxy kon niet uitgezet worden: $($_.Exception.Message)"
                    Fout "  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value `$false"
                    $script:OpenProxy = $true
                }
            }
            Blokkeer -Reden 'De beschermregel is aangelegd maar haalt de inhoudscontrole niet.' `
                     -Hint  'Kijk in IIS Manager > (server) > URL Rewrite naar de regel, of in applicationHost.config onder system.webServer/rewrite/globalRules.'
        }
    }
} else {
    Plan  "serverbrede rewrite-regel '$RegelNaam': match .* met MatchAny-condities op"
    Plan  "{UNENCODED_URL}, {HTTP_URL} en {REQUEST_URI} tegen $absPatroon -> CustomResponse 403"
    Plan  "met statusReason '$($script:RegelReden)' -- dat is waar de zelftest op afgaat"
    Plan  'plus system.webServer/proxy enabled = true, in DEZELFDE schrijfactie'
    Terug "de regel verwijderen en system.webServer/proxy enabled weer op false zetten"
    Info  'Een al bestaande regel wordt op INHOUD gecontroleerd (bestaat, staat aan, drie'
    Info  'condities, CustomResponse met de juiste reden) en anders opnieuw aangelegd.'
}

# ── 8c. De drie deploy-scripts ────────────────────────────────────────────────
<#
    De drie scripts kennen zelf geen -DryRun. In een proefrun worden ze dus NIET
    aangeroepen -- ze beschrijven alleen wat ze zouden doen.

    Waarom `& $Pad @Argumenten` en niet `powershell.exe -File`: de API-sleutel gaat
    als parameter mee naar install-collector.ps1, en een opdrachtregel is op Windows
    voor elke gebruiker uit te lezen (Get-CimInstance Win32_Process). Binnen deze
    sessie aanroepen houdt de sleutel uit de procestabel.

    De scripts zetten zelf $ErrorActionPreference op Stop en gooien bij problemen een
    fout, die hier gewoon doorkomt. $LASTEXITCODE nakijken heeft geen zin: een .ps1
    die niet zelf `exit` aanroept laat de waarde van het vorige programma staan.
#>
function Roep-Deployscript {
    param([string] $Pad, [hashtable] $Argumenten, [string] $Wat, [string] $Terugdraaien, [string[]] $Toelichting)

    Stap $Wat
    foreach ($r in $Toelichting) { Info $r }

    $tonen = foreach ($k in ($Argumenten.Keys | Sort-Object)) {
        if ($k -eq 'ApiKey') {
            "-$k <sleutel, niet getoond>"
        } else {
            $waarde = ($Argumenten[$k] -join ',')
            if ($waarde -match '\s') { $waarde = "'$waarde'" }
            "-$k $waarde"
        }
    }
    Write-Host "   aanroep  : $(Split-Path $Pad -Leaf) $($tonen -join ' ')" -ForegroundColor DarkGray

    if ($DryRun) {
        Plan  $Wat
        Terug $Terugdraaien
        return
    }
    Wijzig -Wat $Wat -Terugdraaien $Terugdraaien -Doe {
        & $Pad @Argumenten
    }
}

$siteScript      = Join-Path $RepoRoot 'deploy\install-site.ps1'
$publishScript   = Join-Path $RepoRoot 'deploy\publish.ps1'
$collectorScript = Join-Path $RepoRoot 'deploy\install-collector.ps1'

Roep-Deployscript -Pad $siteScript `
    -Argumenten @{ SiteName = $SiteName; Root = $SiteRoot; Hosts = $SiteHosts; Port = 80 } `
    -Wat "IIS-site '$SiteName' aanmaken" `
    -Terugdraaien "Remove-Website -Name '$SiteName'; Remove-WebAppPool -Name '$SiteName'" `
    -Toelichting @(
        'Voegt toepassingsgroep, site en bindingen met hostnaam toe op poort 80.',
        'De bestaande site houdt zijn binding zonder hostnaam en vangt alles op wat',
        'geen allmid.gg is. install-site.ps1 weigert zelf ook een binding af te pakken.'
    )

# ── Voordat er gespiegeld wordt ───────────────────────────────────────────────
<#
    publish.ps1 spiegelt met robocopy /MIR. Dat is voor een site precies goed -- wat
    uit de bron verdwijnt, verdwijnt ook op het doel -- maar het betekent ook dat
    ALLES in de doelmap dat niet in de bron staat, weg is. Eenmaal een verkeerd -Target
    (of een verkeerde -SiteRoot hier) en er staat iemands data niet meer.

    Dus: voor de eerste publicatie moet de doelmap leeg zijn of aantoonbaar van ons.

    Het bewijs staat in $AllmidRoot\state\site-target.txt en niet in de doelmap zelf,
    want een merkbestand IN de doelmap zou door de eerstvolgende /MIR weggegooid worden
    (het staat immers niet in de bron). In de doelmap komt wel een leesbaar merkbestand
    te staan, maar dat is een hint voor een mens, geen bewijs.

    De claim wordt VOOR het publiceren geschreven: sneuvelt publish.ps1 halverwege, dan
    staat de map half vol en moet een volgende run gewoon door kunnen.
#>
Stap 'Mag er in de doelmap gespiegeld worden?'
$claimBestand = Join-Path $script:StateMap 'site-target.txt'
$merkInDoel   = Join-Path $SiteRoot '.allmid-site'

<#
    Hier stond -ErrorAction SilentlyContinue. Dat is precies de verkeerde kant op
    falen: een map die niet te LEZEN is (rechten, een pad dat naar een netwerkshare
    wijst die weg is, een beschadigde map) leverde dan een lege lijst op, en een lege
    lijst betekent hier "leeg, dus veilig om te spiegelen". Robocopy /MIR zou daarna
    alles in die map wissen.

    Een fout bij het lezen betekent STOP. Niet weten wat er staat is geen bewijs dat er
    niets staat.
#>
$doelInhoud   = @()
$doelLeesbaar = $true
if (Test-Path $SiteRoot) {
    try {
        $doelInhoud = @(Get-ChildItem $SiteRoot -Force -ErrorAction Stop |
                        Where-Object { $_.Name -ne '.allmid-site' })
    } catch {
        $doelLeesbaar = $false
        Blokkeer -Reden "$SiteRoot is niet te lezen: $($_.Exception.Message)" `
                 -Hint  "publish.ps1 spiegelt die map met robocopy /MIR. Zolang ik niet weet wat erin staat, gebeurt dat niet. Kijk zelf met: Get-ChildItem `"$SiteRoot`" -Force"
    }
}
$claim = ''
if (Test-Path $claimBestand) {
    try { $claim = ((Get-Content $claimBestand -Raw -ErrorAction Stop) -split "`r?`n")[0].Trim() } catch { $claim = '' }
}
$vanOns = ($claim -and ($claim.TrimEnd('\') -eq $SiteRoot.TrimEnd('\'))) -or (Test-Path $merkInDoel)

if (-not $doelLeesbaar) {
    # In -DryRun loopt Blokkeer door; dan mag hier in geen geval 'veilig' komen te staan.
    Fout "$SiteRoot is niet te lezen -- er wordt niet gespiegeld."
} elseif ($doelInhoud.Count -eq 0) {
    Goed "$SiteRoot is leeg of bestaat nog niet -- veilig"
} elseif ($vanOns) {
    Goed "$SiteRoot is eerder door dit script gevuld ($($doelInhoud.Count) items) -- veilig"
} else {
    Blokkeer -Reden "$SiteRoot bevat $($doelInhoud.Count) item(s) en is niet door dit script neergezet." `
             -Hint  "publish.ps1 spiegelt met robocopy /MIR en zou dat weggooien. Controleer het pad, of leeg de map zelf, of geef -SiteRoot een andere waarde."
}

if (-not $DryRun) {
    if ($claim.TrimEnd('\') -ne $SiteRoot.TrimEnd('\')) {
        Wijzig -Wat "doelmap $SiteRoot als de onze vastgelegd in $claimBestand" `
               -Terugdraaien "Remove-Item `"$claimBestand`"" `
               -Doe {
                   if (-not (Test-Path $script:StateMap)) {
                       New-Item -ItemType Directory -Path $script:StateMap -Force | Out-Null
                   }
                   Set-Content -Path $claimBestand -Encoding ASCII -Value @(
                       $SiteRoot,
                       "vastgelegd door deploy\bootstrap.ps1 op $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))",
                       'Deze map wordt door publish.ps1 gespiegeld met robocopy /MIR.'
                   )
               }
    }
}

Roep-Deployscript -Pad $publishScript `
    -Argumenten @{ Target = $SiteRoot; RepoRoot = $RepoRoot } `
    -Wat "sitebestanden naar $SiteRoot zetten" `
    -Terugdraaien "Remove-Item -Recurse -Force `"$SiteRoot`"" `
    -Toelichting @(
        'Bouwt index.html opnieuw, spiegelt site\ met robocopy /MIR en zet web.config ernaast.',
        'De ontwerpvarianten (_var-*.html) gaan bewust niet mee.'
    )

if (-not $DryRun) {
    # Leesbaar merkbestand voor een mens die later in die map kijkt. Na elke publicatie
    # opnieuw, want de /MIR van zonet heeft hem weggegooid als hij er stond.
    Set-Content -Path $merkInDoel -Encoding ASCII -Value @(
        'Deze map wordt beheerd door allmid.gg (deploy\publish.ps1, robocopy /MIR).',
        'Alles wat hier staat en niet in site\ van de repo, wordt bij de volgende publicatie verwijderd.'
    )
}

Roep-Deployscript -Pad $collectorScript `
    -Argumenten @{ ApiKey = $ApiKey; RepoRoot = $RepoRoot; Port = $CollectorPort; SiteDir = $SiteRoot; TaskName = $TaskName } `
    -Wat "verzamelserver als geplande taak '$TaskName'" `
    -Terugdraaien "Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false; Remove-Item $startBestand" `
    -Toelichting @(
        "Schrijft $startBestand (met de sleutel erin, alleen leesbaar voor Administrators",
        'en SYSTEM) en registreert een taak die bij het opstarten meekomt en zichzelf',
        "herstart. Luistert op 127.0.0.1:$poortTekst -- niet vanaf buiten bereikbaar."
    )

# ── 8e. HTTPS ─────────────────────────────────────────────────────────────────
<#
    Deze stap staat hier omdat de site nu pas bestaat: een https-binding hang je aan een
    site, en install-site.ps1 heeft hem zojuist aangemaakt.

    Wat hier NIET gebeurt:
      * geen certificaat aanmaken. Dat is een Cloudflare Origin Certificate en dat maak
        je in dat account.
      * geen sleutelmateriaal in de repo, in dit script, in een voorbeeld of in een
        logregel. Alleen een PAD naar een bestaande .pfx, en dat pad is geen geheim.
      * het wachtwoord en de vingerafdruk worden niet afgedrukt en niet gelogd.

    Zonder -PfxPath gebeurt hier niets en staat aan het eind wat je zelf moet doen.
#>
Stap 'HTTPS op 443'
if (-not $PfxPath) {
    Info 'Overgeslagen: geen -PfxPath meegegeven. De site luistert alleen op poort 80.'
    Info 'Aan het eind staat wat je moet doen om dit alsnog dicht te zetten.'
    $script:HttpsReden = 'overgeslagen: geen -PfxPath meegegeven'
} elseif (-not $script:PfxStaat -or -not $script:PfxStaat.Ok) {
    # In een echte run zijn we hier al gestopt bij de afkeuring in stap 3; in -DryRun
    # loopt het door en dan hoort hier geen plan te staan alsof het wel goed komt.
    Fout 'De .pfx is in stap 3 afgekeurd; de https-stap gebeurt niet.'
    $script:HttpsReden = 'overgeslagen: de opgegeven .pfx is niet bruikbaar'
} elseif ($DryRun) {
    Plan  "de .pfx op $($script:PfxStaat.VolPad) importeren in Cert:\LocalMachine\My"
    Plan  "https-bindingen op 443 met SNI voor $($SiteHosts -join ' en '), in EEN schrijfactie"
    Plan  'daarna controleren dat 443 antwoordt EN dat het ONS certificaat is'
    Terug "Get-WebBinding -Name '$SiteName' -Protocol https -Port 443 | Remove-WebBinding  (en het certificaat uit Cert:\LocalMachine\My halen)"
    Info  'Het wachtwoord en de vingerafdruk worden nergens afgedrukt of weggeschreven.'
} else {
    $vingerafdruk = $script:PfxStaat.Vingerafdruk

    if (Test-Path "Cert:\LocalMachine\My\$vingerafdruk") {
        Goed 'het certificaat stond al in het archief van de machine -- niet opnieuw geimporteerd'
    } else {
        Wijzig -Wat "certificaat uit $($script:PfxStaat.VolPad) geimporteerd in Cert:\LocalMachine\My" `
               -Terugdraaien "Remove-Item Cert:\LocalMachine\My\<vingerafdruk>  (te vinden via: Get-ChildItem Cert:\LocalMachine\My | Where-Object Subject -like '*allmid*')" `
               -Doe {
                   $nieuw = Import-Pfx -Pad $script:PfxStaat.VolPad -Wachtwoord $PfxPassword -Vingerafdruk $script:PfxStaat.Vingerafdruk
                   if (-not $nieuw) { throw 'Het importeren gaf geen certificaat terug.' }
               }
    }

    $httpsNu = Get-HttpsStaat -Naam $SiteName -Hostnamen $SiteHosts
    if ($httpsNu.Botsing.Count -gt 0) {
        foreach ($b in $httpsNu.Botsing) { Fout "  $b" }
        Blokkeer -Reden 'Een andere site claimt op 443 al een van onze hostnamen.' `
                 -Hint  'Ik pak geen bindingen af. Los dat eerst met de hand op in IIS Manager.'
    }
    if (-not $httpsNu.SiteBestaat) {
        Blokkeer -Reden "Site '$SiteName' bestaat niet, dus er valt geen https-binding aan te hangen." `
                 -Hint  'Kijk naar de uitvoer van install-site.ps1 hierboven.'
    }

    if ($httpsNu.Ontbreekt.Count -eq 0) {
        Goed "de https-bindingen op 443 stonden er al voor $($SiteHosts -join ' en ')"
    } else {
        $missend = @($httpsNu.Ontbreekt)
        Wijzig -Wat ("https-binding op 443 met SNI voor " + ($missend -join ' en ') + " (EEN schrijfactie)") `
               -Terugdraaien ("Get-WebBinding -Name '$SiteName' -Protocol https -Port 443 | Remove-WebBinding") `
               -Doe {
                   Add-HttpsBindingen -Naam $SiteName -Hostnamen $missend -Vingerafdruk $script:PfxStaat.Vingerafdruk
               }
    }
    $script:HttpsGedaan = $true
    $script:HttpsReden  = 'ingericht met de meegegeven .pfx'
}

# ═══ 9. Controle ═══════════════════════════════════════════════════════════════
Kop '9/9  Controle -- afgezet tegen de nulmeting'

if ($DryRun) {
    Info 'Een echte run controleert hier, en meldt per regel geslaagd of niet:'
    Info "  1. verzamelserver rechtstreeks : GET http://127.0.0.1:$poortTekst/api/v1/health"
    Info "  2. site via IIS                : GET http://127.0.0.1/ met Host: $($SiteHosts[0])"
    Info "  3. /api/ door de ARR-proxy     : GET http://127.0.0.1/api/v1/health met Host: $($SiteHosts[0])"
    Info "  4. geplande taak               : Get-ScheduledTask '$TaskName' moet Running zijn"
    Info '  5. GEEN open proxy             : een rauw verzoek met absolute URI naar'
    Info '                                   127.0.0.1:80 hoort 403 op te leveren'
    Info '  6. de nulmeting opnieuw        : diensten, sites, toepassingsgroepen en'
    Info '                                   dezelfde HTTP-verzoeken, met het verschil erbij'
} else {
    # De taak is net (her)start; de server heeft even nodig om de database in te lezen.
    Start-Sleep -Seconds 5

    Stap 'Verzamelserver rechtstreeks'
    $r1 = Invoke-Controleverzoek -Url "http://127.0.0.1:$CollectorPort/api/v1/health"
    if ($r1.Ok) {
        Meld-Controle -Wat "collector 127.0.0.1:$CollectorPort" -Ok $true -Detail "HTTP $($r1.Status)"
    } else {
        Meld-Controle -Wat "collector 127.0.0.1:$CollectorPort" -Ok $false -Detail "$($r1.Status) $($r1.Fout)"
        Let "Kijk in $($script:LogMap)\collector.log"
    }

    Stap "Site via IIS, met Host: $($SiteHosts[0])"
    Info 'Via 127.0.0.1 en niet via de hostnaam: allmid.gg wijst naar Cloudflare,'
    Info 'dus die naam komt vanaf deze machine nooit bij IIS uit.'
    $r2 = Invoke-Controleverzoek -Url 'http://127.0.0.1/' -Hostnaam $SiteHosts[0]
    if ($r2.Ok -and $r2.Inhoud -match 'allmid|AllMid') {
        Meld-Controle -Wat "site op $($SiteHosts[0])" -Ok $true -Detail "HTTP $($r2.Status)"
    } elseif ($r2.Ok) {
        Meld-Controle -Wat "site op $($SiteHosts[0])" -Ok $false `
            -Detail "HTTP $($r2.Status), maar de pagina lijkt niet van ons -- staat de binding met hostnaam er wel?"
    } else {
        Meld-Controle -Wat "site op $($SiteHosts[0])" -Ok $false -Detail "HTTP $($r2.Status) $($r2.Fout)"
    }

    Stap '/api/ door de ARR-proxy'
    $r3 = Invoke-Controleverzoek -Url 'http://127.0.0.1/api/v1/health' -Hostnaam $SiteHosts[0]
    if ($r3.Ok) {
        Meld-Controle -Wat '/api/v1/health via IIS' -Ok $true -Detail "HTTP $($r3.Status)"
    } else {
        $duiding = ''
        if ($r3.Status -eq 500) { $duiding = 'URL Rewrite ontbreekt of web.config wordt niet begrepen' }
        if ($r3.Status -eq 502) { $duiding = 'ARR-proxy staat uit of de verzamelserver ligt' }
        Meld-Controle -Wat '/api/v1/health via IIS' -Ok $false -Detail "HTTP $($r3.Status) $duiding"
    }

    Stap 'Geplande taak'
    $taak = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($taak -and $taak.State -eq 'Running') {
        Meld-Controle -Wat "taak '$TaskName'" -Ok $true -Detail 'Running'
    } elseif ($taak) {
        Meld-Controle -Wat "taak '$TaskName'" -Ok $false -Detail "staat op $($taak.State)"
    } else {
        Meld-Controle -Wat "taak '$TaskName'" -Ok $false -Detail 'bestaat niet'
    }

    Stap 'Is dit GEEN open proxy?'
    Info 'Er gaat nu een rauw verzoek met absolute URI naar 127.0.0.1:80. Het doel is een'
    Info '.invalid-naam, die per RFC 6761 nergens naartoe resolvet -- er verlaat dus'
    Info 'gegarandeerd niets deze machine, ook niet als de bescherming stuk is.'
    Info "Bewijs is niet het GETAL 403, maar de reden '$($script:RegelReden)' in de statusregel."
    $pt = Test-Proxyverzoek -Adres '127.0.0.1' -Poort 80

    <#
        Een kale 403 is GEEN bewijs. De bestaande site op deze machine geeft er zelf ook
        een -- een 403.14 als mapweergave uitstaat, een 403.1 op een map zonder
        uitvoerrechten -- en die 403 zegt niets over onze regel. Alleen de reden die onze
        eigen CustomResponse in de statusregel zet, bewijst dat ONZE regel het verzoek
        tegenhield. Die reden staat in $script:RegelReden, wordt door Set-Proxybescherming
        weggeschreven, en door Get-Beschermregelstaat in de configuratie nagekeken. Drie
        plekken, een waarde.

        De statusDescription staat in de body en telt als tweede spoor; die wordt alleen
        gebruikt als de statusregel om wat voor reden dan ook zonder reden binnenkomt.
    #>
    $redenGezien = ($pt.Regel -like "*$($script:RegelReden)*") -or
                   ($pt.Antwoord -like "*$($script:RegelBody)*")
    $vanOnzeRegel = ($pt.Status -eq 403) -and $redenGezien

    # Aantoonbaar geproxyd: IIS heeft geprobeerd door te sturen.
    $isOpenProxy = ($pt.Status -eq 502 -or $pt.Status -eq 504)

    if ($vanOnzeRegel) {
        Meld-Controle -Wat 'absolute URI wordt geweigerd' -Ok $true -Detail "$($pt.Regel)"
    } elseif ($isOpenProxy) {
        Meld-Controle -Wat 'absolute URI wordt geweigerd' -Ok $false `
            -Detail "$($pt.Regel) -- IIS PROBEERDE TE PROXYEN. Dit is een open proxy."
        $script:OpenProxy = $true
    } elseif ($pt.Status -eq 403) {
        # Wel geweigerd, maar niet aantoonbaar door ons. Dat is geen open proxy, maar
        # ook geen bewijs -- en dat verschil moet zichtbaar blijven.
        Meld-Controle -Wat 'absolute URI wordt geweigerd' -Onbeslist -Ok $false `
            -Detail "403 zonder '$($script:RegelReden)' -- ONBESLIST, kan van een andere regel of site komen"
        Let "Antwoordregel: $($pt.Regel)"
        Let 'Controleer met de hand: IIS Manager > (server) > URL Rewrite > View Ordered List.'
    } elseif ($pt.Status -gt 0) {
        Meld-Controle -Wat 'absolute URI wordt geweigerd' -Onbeslist -Ok $false `
            -Detail "$($pt.Regel) -- ONBESLIST: niet geproxyd, maar ook niet door onze regel geweigerd"
        Let 'Kijk naar de volgorde van de serverbrede regels: IIS Manager > (server) > URL Rewrite > View Ordered List.'
    } else {
        Meld-Controle -Wat 'absolute URI wordt geweigerd' -Onbeslist -Ok $false `
            -Detail "ONBESLIST, geen antwoord: $($pt.Fout)"
    }

    <#
        En dan de kant waar het fout mag gaan.

        Vroeger drukte het script hier alleen een opdracht af die IEMAND ANDERS nog moest
        uitvoeren. Dat is de verkeerde kant op falen: tot die iemand het doet, staat er
        een open proxy op internet.

        Twee gevallen, en ze verschillen:

        1. Aantoonbaar open proxy (502/504). Dan gaat de schakelaar uit, ook als hij al
           aan stond voordat wij er waren. Van andermans instellingen blijven we af --
           behalve als die instelling aantoonbaar een open proxy op internet is.

        2. Onbeslist: de bescherming is niet te bewijzen. Dan zetten we hem alleen uit als
           WIJ hem in deze run hebben aangezet. Stond hij al aan, dan is dat de beslissing
           van de beheerder en er is niets AANGETOOND; dan volstaat een luide melding en
           een afsluitcode ongelijk nul.
    #>
    $onbewezen = -not $vanOnzeRegel
    $uitzetten = $isOpenProxy -or ($onbewezen -and $script:ProxyDoorOnsAan)

    if ($uitzetten) {
        if ($isOpenProxy) {
            Fout 'OPEN PROXY VASTGESTELD. Ik zet de ARR-proxy nu zelf uit.'
        } else {
            Fout 'De bescherming is niet te bewijzen en WIJ hebben de proxy in deze run aangezet.'
            Fout 'Ik zet hem terug uit; onbewezen is hier hetzelfde als onveilig.'
        }
        try {
            Disable-ArrProxy
            Fout 'ARR-proxy UITGEZET. /api/ werkt hierdoor NIET tot de beschermregel klopt.'
            $script:Terugdraaiingen += 'ARR-proxy automatisch uitgezet: de open-proxytest leverde geen bewijs van bescherming'
            $script:ProxyDoorOnsAan = $false
        } catch {
            Fout "Uitzetten is NIET gelukt: $($_.Exception.Message)"
            Fout 'Doe dit met de hand, nu meteen:'
            Fout "  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value `$false"
        }
        $script:OpenProxy = $true
    } elseif ($onbewezen) {
        Fout 'De bescherming is NIET bewezen. De ARR-proxy stond al aan voordat dit script'
        Fout 'begon, dus die schakelaar is niet van ons en ik zet hem niet om -- maar deze'
        Fout 'machine kan nu een open proxy zijn. Controleer dat vanaf een andere machine'
        Fout 'met de opdracht onderaan, en zet hem uit als dat zo is:'
        Fout "  Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value `$false"
        $script:OpenProxy = $true
    }

    if ($script:HttpsGedaan) {
        Stap 'HTTPS op 443'
        Info 'De keten wordt hier bewust niet gevalideerd -- een Cloudflare Origin'
        Info 'Certificate is alleen door Cloudflare vertrouwd en we kloppen op 127.0.0.1'
        Info 'aan. In plaats daarvan wordt vergeleken of het aangeboden certificaat HET'
        Info 'certificaat is dat we net geimporteerd hebben. De vingerafdruk zelf wordt'
        Info 'niet getoond.'
        $r4 = Invoke-Controleverzoek -Url 'https://127.0.0.1/' -Hostnaam $SiteHosts[0] `
                  -NegeerCertificaatketen -VerwachteVingerafdruk $script:PfxStaat.Vingerafdruk
        if ($r4.Ok -and $r4.CertKlopt) {
            Meld-Controle -Wat "https op $($SiteHosts[0])" -Ok $true -Detail "HTTP $($r4.Status), en het is ons certificaat"
        } elseif ($r4.Ok) {
            Meld-Controle -Wat "https op $($SiteHosts[0])" -Ok $false `
                -Detail "HTTP $($r4.Status), maar 443 biedt een ANDER certificaat aan -- staat SNI aan?"
        } else {
            Meld-Controle -Wat "https op $($SiteHosts[0])" -Ok $false -Detail "HTTP $($r4.Status) $($r4.Fout)"
        }
    }

    Invoke-Eindmeting
}

# ── De opdrachten waarmee je het zelf nakijkt ─────────────────────────────────
[void]$script:Testopdrachten.Add(@"
Is deze server GEEN open proxy? Draai dit VANAF EEN ANDERE MACHINE, met het echte
IP-adres van de server erin (curl.exe zit in Windows 10/Server 2019 en nieuwer):

    curl.exe -sS -o NUL -w "%{http_code}\n" -x http://<ip-van-de-server>:80 http://example.com/

  403  goed: de beschermregel weigert verzoeken met een absolute URI.
  200  ALARM: de server heeft example.com voor je opgehaald. Dat is een open proxy.
  502  ALARM: de server PROBEERDE door te sturen. Ook een open proxy.

En controleer meteen dat de gewone site het nog doet (dit hoort 200 te geven):

    curl.exe -sS -o NUL -w "%{http_code}\n" -H "Host: $($SiteHosts[0])" http://<ip-van-de-server>/

Gaat de eerste opdracht mis, zet de proxy dan uit tot het klopt:

    Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' ``
        -Filter 'system.webServer/proxy' -Name 'enabled' -Value `$false
"@)

[void]$script:Testopdrachten.Add(@"
Rechten op $AllmidRoot nakijken (hier hoort alleen Administrators en SYSTEM te staan,
en geen (I) voor overerving):

    icacls $AllmidRoot
"@)

[void]$script:Testopdrachten.Add(@"
Leeft de verzamelserver?

    Invoke-RestMethod http://127.0.0.1:$poortTekst/api/v1/health
    Get-Content $($script:LogMap)\collector.log -Tail 40 -Wait
"@)

# ── Samenvatting ───────────────────────────────────────────────────────────────
Kop 'Samenvatting'

if ($DryRun) {
    Write-Host ''
    Write-Host '  Dit was een proefrun. Er is niets aan de machine gewijzigd.' -ForegroundColor Magenta
    Write-Host '  (Behalve het uitvoeringsbeleid van DIT proces; dat verdwijnt met dit venster.)' -ForegroundColor DarkGray
    if ($script:Blokkades.Count -gt 0) {
        Write-Host ''
        Fout "Een echte run was gestopt op $($script:Blokkades.Count) punt(en):"
        $n = 0
        foreach ($b in $script:Blokkades) {
            $n++
            Write-Host "   $n. $($b.Reden)" -ForegroundColor Red
            if ($b.Hint) { Write-Host "      $($b.Hint)" -ForegroundColor Yellow }
        }
        Write-Host ''
        Let 'Los deze eerst op. Daarna dezelfde regel zonder -DryRun.'
    } else {
        Write-Host ''
        Goed 'Geen blokkades gevonden. Draai hem zonder -DryRun om het echt te doen.'
    }
    $script:Gelukt = ($script:Blokkades.Count -eq 0)
} else {
    Stap 'Wat er aan deze machine veranderd is'
    if ($script:Wijzigingen.Count -eq 0) {
        Goed 'niets -- alles stond al goed (dit was dus een herhaalde run)'
    } else {
        $i = 0
        foreach ($w in $script:Wijzigingen) {
            $i++
            $kleur = 'White'
            if ($w.Status -ne 'geslaagd') { $kleur = 'Red' }
            Write-Host "   $i. [$($w.Tijd)] [$($w.Status)] $($w.Wat)" -ForegroundColor $kleur
            Write-Host "      terug: $($w.Terugdraaien)" -ForegroundColor DarkGray
        }
    }

    # Dit logboek is het enige waar je op terug kunt vallen als er over een half jaar
    # iemand vraagt "wat heeft dat script eigenlijk gedaan".
    if (-not (Test-Path $script:LogMap)) { New-Item -ItemType Directory -Path $script:LogMap -Force | Out-Null }
    $logpad = Join-Path $script:LogMap ("bootstrap-{0:yyyyMMdd-HHmmss}.log" -f $script:Start)
    $regels = @("allmid.gg bootstrap -- $($script:Start.ToString('yyyy-MM-dd HH:mm:ss'))", '')

    # Welke commit er als Administrator gedraaid heeft. Dit gaat er ALTIJD in, ook met
    # -Force: zonder deze regels is achteraf niet meer vast te stellen wat er is
    # uitgevoerd, en dat is nou juist wat je bij een onbeheerde run wilt weten.
    if ($script:CommitRegel) {
        $regels += 'Uitgevoerde code:'
        $regels += "  commit: $($script:CommitRegel)"
        $regels += "  hash  : $($script:CommitHash)"
        if ($script:CommitVuil.Count -gt 0) {
            $regels += "  LET OP: $($script:CommitVuil.Count) bestand(en) weken af van die commit:"
            foreach ($v in ($script:CommitVuil | Select-Object -First 20)) { $regels += "          $v" }
        } else {
            $regels += '  werkmap was schoon'
        }
        $regels += ''
    }

    # Waar toestemming voor gegeven is -- of namens wie er met -Force is doorgelopen.
    if ($script:Besluiten.Count -gt 0) {
        $regels += 'Bevestigingen:'
        foreach ($b in $script:Besluiten) {
            $regels += "  [$($b.Tijd)] $($b.Vraag)  ->  $($b.Uitkomst)"
            foreach ($u in $b.Uitleg) { $regels += "             $u" }
        }
        $regels += ''
    }

    foreach ($w in $script:Wijzigingen) {
        $regels += "[$($w.Tijd)] [$($w.Status)] $($w.Wat)"
        $regels += "          terug: $($w.Terugdraaien)"
    }
    if ($script:Terugdraaiingen.Count -gt 0) {
        $regels += ''
        $regels += 'Door het script zelf teruggedraaid (noodrem):'
        foreach ($t in $script:Terugdraaiingen) { $regels += "  $t" }
    }
    $regels += ''
    foreach ($c in $script:Controles) {
        $status = 'FOUT'
        if ($c.Staat -eq 'ok') { $status = 'ok  ' } elseif ($c.Staat -eq 'ONBESLIST') { $status = ' ?  ' }
        $regels += "[$status] $($c.Wat)  $($c.Detail)"
    }
    # De sleutel gaat hier bewust NIET in: dit logbestand is niet afgeschermd. Het
    # .pfx-wachtwoord en de vingerafdruk van het certificaat ook niet, om dezelfde reden.
    $regels += ''
    $regels += "De API-sleutel staat in $startBestand en staat met opzet niet in dit logbestand."
    $regels += 'Het .pfx-wachtwoord en de vingerafdruk van het certificaat staan hier ook niet in.'
    Set-Content -Path $logpad -Value $regels -Encoding UTF8
    Info "logboek: $logpad"

    Stap 'Uitkomst van de controles'
    $mislukt   = @($script:Controles | Where-Object { $_.Staat -eq 'FOUT' })
    $onbeslist = @($script:Controles | Where-Object { $_.Staat -eq 'ONBESLIST' })
    $geslaagd  = @($script:Controles | Where-Object { $_.Staat -eq 'ok' })
    if ($mislukt.Count -eq 0 -and $onbeslist.Count -eq 0) {
        Goed "alle $($script:Controles.Count) controles geslaagd"
    } else {
        Info "$($geslaagd.Count) geslaagd, $($onbeslist.Count) onbeslist, $($mislukt.Count) mislukt (van $($script:Controles.Count))"
    }
    if ($onbeslist.Count -gt 0) {
        Let "$($onbeslist.Count) controle(s) ONBESLIST -- gemeten, maar niets bewezen:"
        foreach ($c in $onbeslist) { Let "  $($c.Wat): $($c.Detail)" }
        Let 'Onbeslist laat de run niet falen, maar het is ook geen groen vinkje.'
    }
    if ($mislukt.Count -gt 0) {
        Fout "$($mislukt.Count) van de $($script:Controles.Count) controles mislukt:"
        foreach ($c in $mislukt) { Fout "  $($c.Wat): $($c.Detail)" }
        $script:Gelukt = $false
    }

    if ($script:SleutelNieuw) {
        Write-Host ''
        Write-Host '  -- API-SLEUTEL -- schrijf deze nu over ----------------------' -ForegroundColor Black -BackgroundColor Yellow
        Write-Host ''
        Write-Host "      $ApiKey" -ForegroundColor Yellow
        Write-Host ''
        Info 'Hiermee upload je vanaf je eigen pc naar de verzamelserver. Zet hem in de'
        Info 'AllMid-desktopapp bij de serverinstellingen.'
        Info ''
        Info "Bewaard op de server in : $startBestand"
        Info 'Leesbaar voor           : alleen Administrators en SYSTEM'
        Info 'Staat NIET in           : de repo, het logbestand, of enig ander bestand'
        Write-Host ''
    } else {
        Info "Sleutel: $(Hide-Sleutel $ApiKey) -- $($script:SleutelBron)."
    }
}

# ── Zelf nakijken ──────────────────────────────────────────────────────────────
Kop 'Dit moet je zelf nakijken'
foreach ($t in $script:Testopdrachten) {
    Write-Host ''
    Write-Host $t -ForegroundColor Gray
}

# ── Wat de gebruiker zelf nog moet doen ────────────────────────────────────────
Kop 'Dit is nog NIET af -- HTTPS moet je zelf doen'

Write-Host @"

   Wat hierboven is neergezet luistert op poort 80. Cloudflare praat nu dus
   onversleuteld met deze server. Dat moet nog dicht, en dat kan dit script niet
   voor je doen: een Cloudflare Origin Certificate maak je aan in jouw
   Cloudflare-account, en daar heeft dit script geen token voor.

   Poort 443 was op deze machine nog ongebruikt, dus je zit niemand in de weg.

   1. Certificaat aanmaken
      Cloudflare > allmid.gg > SSL/TLS > Origin Server > Create Certificate
        - laat Cloudflare de sleutel genereren (RSA 2048)
        - hostnamen : allmid.gg  en  *.allmid.gg
        - geldigheid: 15 jaar
      Bewaar het certificaat en de private sleutel. De sleutel krijg je EEN keer
      te zien.

   2. Omzetten naar .pfx, want IIS importeert niets anders
        openssl pkcs12 -export -inkey origin.key -in origin.pem -out allmid.pfx

   3. Importeren
      IIS Manager > (servernaam) > Server Certificates > Import... > allmid.pfx

   4. Binding erop
      IIS Manager > Sites > $SiteName > Bindings... > Add...
        type https, poort 443, hostnaam allmid.gg,
        >>> "Require Server Name Indication" AANVINKEN <<<
      Herhaal voor www.allmid.gg.

      Dat vinkje is hier niet optioneel. Zonder SNI claimt de binding poort 443
      voor alle hostnamen, en dan zit je de andere site op deze machine in de weg
      zodra die ook https wil. Met SNI staan ze naast elkaar.

   5. Cloudflare op Full (strict)
      SSL/TLS > Overview > Full (strict). Pas NA stap 4, anders krijgen bezoekers
      een 526.

   6. Http naar https
      Doe dat in Cloudflare (SSL/TLS > Edge Certificates > Always Use HTTPS) en
      NIET met een omleidingsregel in IIS. Cloudflare beeindigt de versleuteling
      toch al, en een IIS-regel op serverniveau zou de andere site raken.

   Controleren als je klaar bent:
     Invoke-WebRequest https://allmid.gg/api/v1/health -UseBasicParsing

   -- Nog twee dingen om te weten -----------------------------------------

   * Het origin-certificaat wordt alleen door Cloudflare vertrouwd. Ga je met een
     browser rechtstreeks naar het IP van de server, dan krijg je een waarschuwing.
     Dat hoort zo.

   * De verzamelserver begrenst het aantal verzoeken per IP en leest dat IP uit de
     kop X-Forwarded-For. Cloudflare vult die met het echte adres van de bezoeker,
     dus dat werkt -- maar die kop is van buitenaf ook te verzinnen. Wil je dat
     dichttimmeren, laat de server dan CF-Connecting-IP gebruiken en alleen
     vertrouwen als het verzoek van een Cloudflare-adres komt. Dat is serverwerk en
     valt buiten dit script.
"@ -ForegroundColor Gray

Write-Host ''
if ($script:Gelukt) {
    if ($DryRun) {
        Write-Host '  Proefrun afgerond.' -ForegroundColor Green
    } else {
        Write-Host '  Klaar, op HTTPS na (zie hierboven) en op de tests die je zelf moet doen.' -ForegroundColor Green
    }
} else {
    Write-Host '  NIET klaar. Zie de fouten hierboven.' -ForegroundColor Red
}
Write-Host ("  duur: {0:n0} s" -f ((Get-Date) - $script:Start).TotalSeconds) -ForegroundColor DarkGray
Write-Host ''

} catch {
    Write-Host ''
    Write-Host '  GESTOPT' -ForegroundColor White -BackgroundColor DarkRed
    Write-Host ''
    Fout $_.Exception.Message

    # Regelnummer alleen bij een ONVERWACHTE fout. Bij een bewuste blokkade wijst dat
    # naar de throw in Blokkeer, en dat is voor de lezer niets dan ruis: de uitleg
    # staat al hierboven. Bij een echte bug wil je het juist wel zien.
    $bewust = $false
    foreach ($b in $script:Blokkades) { if ($b.Reden -eq $_.Exception.Message) { $bewust = $true } }
    if ($bewust) {
        $laatste = $script:Blokkades[$script:Blokkades.Count - 1]
        if ($laatste.Hint) { Let $laatste.Hint }
    } elseif ($_.InvocationInfo -and $_.InvocationInfo.ScriptLineNumber) {
        Info "onverwacht, in bootstrap.ps1 regel $($_.InvocationInfo.ScriptLineNumber)"
    }
    Write-Host ''

    <#
        De eindmeting hoort JUIST hier te draaien.

        Vroeger sloeg dit blok hem over: ging er iets mis, dan stopte het script zonder
        ooit te kijken of de ANDERE site op deze machine nog antwoordde. Dat is precies
        het moment waarop je dat wilt weten -- er is dan immers al van alles gebeurd, en
        de laatste schrijfactie naar applicationHost.config kan halverwege zijn blijven
        steken.

        Hij draait in een eigen try: een eindmeting die zelf omvalt mag de foutmelding
        hierboven en de lijst met wijzigingen hieronder niet opeten.
    #>
    if (-not $DryRun) {
        try {
            Invoke-Eindmeting
        } catch {
            Fout "De eindmeting kon niet uitgevoerd worden: $($_.Exception.Message)"
        }
    }
    Write-Host ''

    # Half werk is erger dan geen werk, dus hier stopt het. Wat er tot nu toe wel
    # veranderd is staat hieronder, met hoe je het terugdraait -- inclusief de
    # wijziging die MISLUKT is, want juist die laat de machine in een halve stand
    # achter.
    if ($script:Wijzigingen.Count -gt 0) {
        Let 'Tot hier is er dit aan de machine gewijzigd:'
        $i = 0
        foreach ($w in $script:Wijzigingen) {
            $i++
            $kleur = 'White'
            if ($w.Status -ne 'geslaagd') { $kleur = 'Red' }
            Write-Host "   $i. [$($w.Tijd)] [$($w.Status)] $($w.Wat)" -ForegroundColor $kleur
            Write-Host "      terug: $($w.Terugdraaien)" -ForegroundColor DarkGray
        }
        Write-Host ''
        Info 'Los de oorzaak op en draai het script opnieuw: het slaat over wat al goed staat.'
    } else {
        Info 'Er is niets aan de machine gewijzigd.'
    }
    Write-Host ''
    $script:Gelukt = $false
}

if ($script:Terugdraaiingen.Count -gt 0) {
    Write-Host ''
    Let 'Het script heeft zelf iets teruggedraaid:'
    foreach ($t in $script:Terugdraaiingen) { Let "  - $t" }
}

if ($script:OpenProxy) {
    Write-Host ''
    Fout '================================================================'
    Fout ' LET OP: de bescherming tegen een open forward proxy is NIET'
    Fout ' bewezen op deze machine.'
    if ($script:ProxyDoorOnsAan) {
        Fout ' De ARR-proxy staat NOG AAN en die schakelaar was niet van ons.'
        Fout ' Controleer dit nu vanaf een andere machine, en zet hem uit:'
        Fout "   Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' ``"
        Fout "       -Filter 'system.webServer/proxy' -Name 'enabled' -Value `$false"
    } else {
        Fout ' De ARR-proxy is uitgezet. /api/ werkt daardoor niet.'
        Fout ' Los de beschermregel op en draai dit script opnieuw.'
    }
    Fout '================================================================'
    $script:Gelukt = $false
}

<#
    `exit` zou bij een aanroep in een bestaand venster dat venster kunnen sluiten, en
    dat is precies het moment waarop je de foutmelding nog wilt kunnen lezen. Voor de
    gewone fouten geldt dat nog steeds: dan alleen een echte afsluitcode als dit als
    BESTAND draait (bijvoorbeeld in de CI).

    Voor een open proxy geldt het niet. Dat is de ene uitkomst die niemand mag missen en
    die geen enkele automatisering als geslaagd mag lezen, dus daar wordt onvoorwaardelijk
    met een code ongelijk nul afgesloten. Het alarm hierboven is dan al afgedrukt.
#>
if ($script:OpenProxy) {
    $global:LASTEXITCODE = 2
    exit 2
}
if (-not $script:Gelukt) {
    $global:LASTEXITCODE = 1
    if ($PSCommandPath) { exit 1 }
} else {
    $global:LASTEXITCODE = 0
}
