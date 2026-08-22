<#
    Zet de verzamelserver neer als dienst die bij het opstarten meekomt.

    Node kan niet rechtstreeks als Windows-dienst draaien -- een dienst moet aan
    het Service Control Manager-protocol voldoen en dat doet node.exe niet. De
    gebruikelijke oplossing is een extra programma zoals nssm installeren. Dat
    doen we hier niet: een geplande taak met een opstart-trigger is ingebouwd,
    doet hetzelfde, en scheelt een download die je moet vertrouwen.

    De sleutel komt in een startbestand buiten de repo te staan, zodat hij nooit
    per ongeluk meegecommit wordt.

    Draaien als Administrator:
        powershell -ExecutionPolicy Bypass -File deploy\install-collector.ps1 -ApiKey 'iets-langs-en-willekeurigs'
#>
[CmdletBinding()]
param(
    # Zonder sleutel mag iedereen uploaden. Verplicht dus.
    [Parameter(Mandatory = $true)]
    [string] $ApiKey,

    # Waar de repo op de server staat.
    [string] $RepoRoot = 'C:\allmid\desktop',

    # Waar de gebundelde database komt te staan (server schrijft hier data\matches.jsonl).
    [string] $DataRoot = 'C:\allmid\server-data',

    # 8080 is op deze machine al bezet, vandaar 8123.
    [int]    $Port = 8123,

    # Waar de site staat die IIS serveert. De verzamelserver publiceert daar de
    # verse cijfers naartoe zodra er genoeg games bij zijn gekomen. Leeg laten
    # zet het automatisch verversen uit.
    [string] $SiteDir = 'C:\inetpub\allmid',

    [string] $TaskName = 'AllMid Collector'
)

$ErrorActionPreference = 'Stop'

function Stap($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Goed($t) { Write-Host "   $t" -ForegroundColor Green }
function Let($t)  { Write-Host "   $t" -ForegroundColor Yellow }

Stap 'Voorwaarden'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Dit script moet als Administrator draaien.'
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node niet gevonden in PATH. Installeer Node 24 of nieuwer.' }

$versie = (& $node --version).TrimStart('v')
$hoofd = [int]($versie -split '\.')[0]
if ($hoofd -lt 20) {
    throw "Node $versie gevonden, maar 20 of nieuwer is nodig."
}
Goed "node $versie op $node"

# De server is TypeScript en wordt door tsx geladen. Kale node met
# --experimental-strip-types werkt hier NIET: de imports hebben geen
# bestandsextensie en de ESM-resolver van node eist die wel. Getest.
$tsx = Join-Path $RepoRoot 'node_modules\tsx\dist\cli.mjs'
if (-not (Test-Path $tsx)) {
    throw "tsx niet gevonden op $tsx. Draai eerst 'npm ci' in $RepoRoot."
}
Goed 'tsx aanwezig'

$entry = Join-Path $RepoRoot 'server\index.ts'
if (-not (Test-Path $entry)) { throw "Niet gevonden: $entry. Klopt -RepoRoot?" }
Goed "serverbestand gevonden"

if ($ApiKey.Length -lt 24) {
    Let "Je sleutel is $($ApiKey.Length) tekens. Neem er minstens 24, dit is het enige dat uploaden afschermt."
}

# ── Mappen ─────────────────────────────────────────────────────────────────
Stap 'Mappen'
foreach ($p in @($DataRoot, (Join-Path $DataRoot 'data'), 'C:\allmid\logs')) {
    if (-not (Test-Path $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}
Goed "$DataRoot en C:\allmid\logs"

# ── Startbestand ───────────────────────────────────────────────────────────
# Buiten de repo, want hier staat de sleutel in.
Stap 'Startbestand schrijven'
$cmdPad = 'C:\allmid\start-collector.cmd'
$cmd = @"
@echo off
rem Gegenereerd door deploy\install-collector.ps1 -- NIET in versiebeheer zetten.
rem Hier staat de API-sleutel in.

set "ALLMID_KEY=$ApiKey"
set "ALLMID_DATA=$DataRoot"
set "ALLMID_HOST=127.0.0.1"
set "PORT=$Port"
set "NODE_ENV=production"

rem Zodra er genoeg nieuwe games binnen zijn, rekent de server de cijfers van de
rem site opnieuw uit en publiceert ze. Zonder deze twee regels blijft de site op
rem de cijfers staan waarmee hij is uitgerold.
set "ALLMID_SITE_REFRESH=$(if ($SiteDir) { '1' } else { '0' })"
set "ALLMID_SITE_OUT=$SiteDir"

cd /d "$RepoRoot"
"$node" "$tsx" server\index.ts >> "C:\allmid\logs\collector.log" 2>&1
"@
Set-Content -Path $cmdPad -Value $cmd -Encoding ASCII
Goed $cmdPad

# Alleen Administrators en SYSTEM mogen dit bestand lezen; de sleutel staat erin.
$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($wie in @('BUILTIN\Administrators', 'NT AUTHORITY\SYSTEM')) {
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($wie, 'FullControl', 'Allow')))
}
Set-Acl -Path $cmdPad -AclObject $acl
Goed 'rechten beperkt tot Administrators en SYSTEM'

# ── Geplande taak ──────────────────────────────────────────────────────────
Stap "Taak '$TaskName'"

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Goed 'oude taak verwijderd'
}

$actie   = New-ScheduledTaskAction -Execute $cmdPad
$trigger = New-ScheduledTaskTrigger -AtStartup
$account = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest

# Blijft draaien, herstart bij een val, en wordt nooit afgekapt op tijd.
$opties = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $actie -Trigger $trigger `
    -Principal $account -Settings $opties | Out-Null
Goed 'geregistreerd, start bij het opstarten van de machine'

Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 6

# ── Controle ───────────────────────────────────────────────────────────────
Stap 'Controleren of hij echt luistert'
try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/v1/health" -TimeoutSec 15
    Goed "antwoord: $($r.games) games, $($r.players) spelers"
} catch {
    Let "Geen antwoord op poort $Port. Kijk in C:\allmid\logs\collector.log"
    Let $_.Exception.Message
}

Stap 'Klaar'
Write-Host @"
   Poort       : 127.0.0.1:$Port   (alleen lokaal; IIS stuurt /api/ hierheen)
   Site        : $(if ($SiteDir) { "$SiteDir  (ververst zichzelf)" } else { 'automatisch verversen UIT' })
   Data        : $DataRoot\data\matches.jsonl
   Log         : C:\allmid\logs\collector.log
   Taak        : $TaskName

   Handig:
     Get-ScheduledTask -TaskName '$TaskName'
     Stop-ScheduledTask  -TaskName '$TaskName'
     Start-ScheduledTask -TaskName '$TaskName'
     Get-Content C:\allmid\logs\collector.log -Tail 40 -Wait
"@ -ForegroundColor Gray
