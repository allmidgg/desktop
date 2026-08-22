<#
    Zet de site op zijn plek in IIS.

    Bouwt eerst index.html opnieuw uit de datamomentopname, kopieert daarna de
    map site\ naar de doelmap, en zet web.config ernaast.

    Wat NIET meegaat: de ontwerpvarianten (site\_var-*.html) en het tijdelijke
    opnamebestand. Die staan al in .gitignore, maar iemand kan ze lokaal hebben
    staan en ze horen niet op een publieke site.

    Draaien op de server, als Administrator:
        powershell -ExecutionPolicy Bypass -File deploy\publish.ps1

    Of vanaf je eigen machine met -Target op een netwerkpad.
#>
[CmdletBinding()]
param(
    [string] $Target   = 'C:\inetpub\allmid',
    [string] $RepoRoot = (Split-Path $PSScriptRoot -Parent),
    [switch] $SkipBuild
)

$ErrorActionPreference = 'Stop'

function Stap($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Goed($t) { Write-Host "   $t" -ForegroundColor Green }
function Let($t)  { Write-Host "   $t" -ForegroundColor Yellow }

$bron = Join-Path $RepoRoot 'site'
if (-not (Test-Path $bron)) { throw "Niet gevonden: $bron" }

# ── Opnieuw bouwen ─────────────────────────────────────────────────────────
if (-not $SkipBuild) {
    Stap 'index.html bouwen'
    $node = (Get-Command node -ErrorAction SilentlyContinue).Source
    if (-not $node) { throw 'node niet gevonden in PATH.' }

    Push-Location $RepoRoot
    try {
        & $node 'site\build.mjs'
        if ($LASTEXITCODE -ne 0) { throw "site\build.mjs eindigde met code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
    Goed 'gebouwd'
} else {
    Let 'bouwstap overgeslagen'
}

# ── Controleren dat er geen persoonsgegevens meegaan ───────────────────────
# De screenshots hebben ooit echte Riot-ID's bevat. Dat mag nooit meer, dus dit
# wordt gecontroleerd en niet aangenomen.
Stap 'Controle vooraf'

$index = Join-Path $bron 'index.html'
if (-not (Test-Path $index)) { throw "Niet gevonden: $index. Is de bouwstap gelukt?" }

$grootte = [math]::Round((Get-Item $index).Length / 1KB)
Goed "index.html is $grootte KB"

$varianten = Get-ChildItem $bron -Filter '_var-*.html' -ErrorAction SilentlyContinue
if ($varianten) { Let "$($varianten.Count) ontwerpvariant(en) gevonden -- die gaan NIET mee" }

# ── Kopieren ───────────────────────────────────────────────────────────────
Stap "Kopieren naar $Target"

if (-not (Test-Path $Target)) {
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    Goed 'doelmap aangemaakt'
}

# /MIR spiegelt: wat op de bron weg is, gaat op het doel ook weg. Dat is precies
# wat je wilt bij een site, anders blijven oude bestanden eeuwig staan.
# fetch-icons.mjs en refresh.mjs zijn bouwgereedschap, net als build.mjs: ze
# horen in de repo en niet op de webserver.
$uitsluiten = @('_var-*.html', '_shot.html', '.nojekyll', 'CNAME', 'build.mjs', 'fetch-icons.mjs', 'refresh.mjs')

$roboArgs = @(
    $bron, $Target,
    '/MIR',
    '/R:2', '/W:2',
    '/NFL', '/NDL', '/NP',
    '/XF'
) + $uitsluiten

& robocopy @roboArgs | Out-Null
$code = $LASTEXITCODE

# Robocopy telt anders dan de rest van de wereld: alles onder 8 is goed.
if ($code -ge 8) {
    throw "robocopy mislukt met code $code"
}
Goed "gekopieerd (robocopy $code)"

# ── web.config ─────────────────────────────────────────────────────────────
Stap 'web.config'
Copy-Item (Join-Path $PSScriptRoot 'web.config') (Join-Path $Target 'web.config') -Force
Goed 'geplaatst'

# ── Uitkomst ───────────────────────────────────────────────────────────────
Stap 'Resultaat'
$bestanden = (Get-ChildItem $Target -Recurse -File).Count
$mb = [math]::Round(((Get-ChildItem $Target -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "   $bestanden bestanden, $mb MB in $Target" -ForegroundColor Gray

foreach ($moet in @('index.html', 'web.config', 'data\champions.json', 'img\champions\icon\23.png')) {
    $p = Join-Path $Target $moet
    if (Test-Path $p) { Goed "aanwezig: $moet" } else { Let "ONTBREEKT: $moet" }
}

$verboden = Get-ChildItem $Target -Filter '_var-*.html' -Recurse -ErrorAction SilentlyContinue
if ($verboden) {
    Let "LET OP: er staan nog ontwerpvarianten in de doelmap: $($verboden.Name -join ', ')"
} else {
    Goed 'geen ontwerpvarianten in de doelmap'
}
