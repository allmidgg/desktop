<#
    Zet de site op zijn plek in IIS.

    Bouwt eerst index.html opnieuw uit de datamomentopname, kopieert daarna de
    map site\ naar de doelmap, en zet web.config ernaast.

    Wat NIET meegaat: de ontwerpvarianten (site\_var-*.html) en het tijdelijke
    opnamebestand. Die staan al in .gitignore, maar iemand kan ze lokaal hebben
    staan en ze horen niet op een publieke site.

    Het script haalt zelf de nieuwste code op. Doe daar GEEN "git pull" voor: de
    checkout op de server is een spiegel en geen werkmap. De collectieserver
    schrijft er continu in -- site\data\*.json, index.html, style.css en champion\
    worden bij elke automatische verversing opnieuw weggeschreven -- dus een
    gewone pull botst gegarandeerd op lokale wijzigingen. Hier gaat het met een
    harde reset op origin/main, waarna de data opnieuw uit de database op deze
    machine gegenereerd wordt. Alles in site\ dat niet in git staat gaat daarbij
    verloren; dat hoort ook zo, het is allemaal bouwsel.

    Draaien op de server, als Administrator:
        powershell -ExecutionPolicy Bypass -File C:\allmid\desktop\deploy\publish.ps1

    Of vanaf je eigen machine met -Target op een netwerkpad, en -NoPull.
#>
[CmdletBinding()]
param(
    [string] $Target   = 'C:\inetpub\allmid',
    [string] $RepoRoot,
    [string] $Database,
    [switch] $SkipBuild,
    [switch] $NoPull
)

$ErrorActionPreference = 'Stop'

function Stap($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Goed($t) { Write-Host "   $t" -ForegroundColor Green }
function Let($t)  { Write-Host "   $t" -ForegroundColor Yellow }

# $PSScriptRoot is in een param()-standaardwaarde niet betrouwbaar gevuld: bij de
# aanroep op de server kwam het er leeg uit en viel Split-Path om met
# "Cannot bind argument to parameter 'Path'". In de body van het script is het wel
# gezet, met $MyInvocation als terugval.
if (-not $RepoRoot) {
    $hier = $PSScriptRoot
    if (-not $hier) { $hier = Split-Path -Parent $MyInvocation.MyCommand.Path }
    if (-not $hier) { throw 'Kan de scriptmap niet bepalen. Geef -RepoRoot mee.' }
    $RepoRoot = Split-Path $hier -Parent
}

$bron = Join-Path $RepoRoot 'site'
if (-not (Test-Path $bron)) { throw "Niet gevonden: $bron" }

# -- Code ophalen -----------------------------------------------------------
if (-not $NoPull) {
    Stap 'Nieuwste code ophalen'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'git niet gevonden in PATH.' }

    & git -C $RepoRoot fetch --prune origin
    if ($LASTEXITCODE -ne 0) { throw "git fetch mislukte met code $LASTEXITCODE" }

    # Harde reset en geen merge: alles wat hier lokaal afwijkt is door de
    # automatische verversing geschreven en wordt hieronder opnieuw gemaakt.
    & git -C $RepoRoot reset --hard origin/main
    if ($LASTEXITCODE -ne 0) { throw "git reset mislukte met code $LASTEXITCODE" }
    Goed "op commit $(& git -C $RepoRoot rev-parse --short HEAD)"
}

# -- Data verversen ---------------------------------------------------------
# De reset hierboven zet site\data terug op de momentopname uit de repo, en die
# is zo oud als de laatste commit. De verse cijfers staan in de database op deze
# machine, dus die gebruiken we. Anders zou publiceren de site terugzetten in de
# tijd tot de volgende automatische verversing hem weer bijtrekt.
if (-not $SkipBuild) {
    if (-not $Database) {
        $kandidaten = @()
        if ($env:ALLMID_DATA) { $kandidaten += (Join-Path $env:ALLMID_DATA 'data\matches.jsonl') }
        $kandidaten += @(
            'C:\allmid\server\data\matches.jsonl',
            'C:\allmid\data\matches.jsonl',
            (Join-Path $RepoRoot 'data\matches.jsonl')
        )
        $Database = $kandidaten | Where-Object { Test-Path $_ } | Select-Object -First 1
    }

    if ($Database) {
        Stap 'Data verversen uit de database'
        $nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $nodeExe) { throw 'node niet gevonden in PATH.' }
        Push-Location $RepoRoot
        try {
            & $nodeExe 'site\data\refresh.mjs' '--in' $Database '--out' 'site\data'
            if ($LASTEXITCODE -ne 0) { throw "refresh.mjs eindigde met code $LASTEXITCODE" }
        } finally {
            Pop-Location
        }
        Goed "ververst uit $Database"
    } else {
        Let 'Geen database gevonden. De site wordt gebouwd met de momentopname uit de repo,'
        Let 'en die kan ouder zijn dan wat hier inmiddels verzameld is. Geef anders -Database mee.'
    }
}

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
$uitsluiten = @(
    '_var-*.html', '_shot.html', '.nojekyll', 'CNAME',
    # Build tooling. Belongs in the repository, not on a web server.
    # catalogus.mjs was missing from this list and was being published: it is the
    # script that downloads the champion portraits, and it has no business on a
    # web server any more than build.mjs does.
    'build.mjs', 'fetch-icons.mjs', 'refresh.mjs', 'catalogus.mjs',
    # The site does not read these at runtime: index.html and the champion pages
    # do no fetch at all, every figure is baked into the page at build time. They
    # were only ever published because robocopy /MIR mirrors the whole folder,
    # which meant 1.2 MB of the full dataset sitting there for anyone to take.
    # app-stats.json stays, because the desktop app really does download it.
    'champions.json', 'builds.json', 'meta.json',
    # Read by build.mjs to lay out the League pages and by nothing at runtime.
    'lol-catalog.json'
)

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

# app-stats.json instead of champions.json: the latter is deliberately no longer
# published, so its absence is the point rather than a warning.
foreach ($moet in @('index.html', 'style.css', 'web.config', 'data\app-stats.json', 'champion\nasus.html', 'img\champions\icon\23.png')) {
    $p = Join-Path $Target $moet
    if (Test-Path $p) { Goed "aanwezig: $moet" } else { Let "ONTBREEKT: $moet" }
}

$verboden = Get-ChildItem $Target -Filter '_var-*.html' -Recurse -ErrorAction SilentlyContinue
if ($verboden) {
    Let "LET OP: er staan nog ontwerpvarianten in de doelmap: $($verboden.Name -join ', ')"
} else {
    Goed 'geen ontwerpvarianten in de doelmap'
}
