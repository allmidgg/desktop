<#
    Zet allmid.gg neer als eigen site in IIS, naast wat er al draait.

    Op deze server draait al een andere site op poort 80. Die blijft met rust:
    IIS kan meerdere sites op dezelfde poort hebben zolang ze op hostnaam
    verschillen, en een binding met hostnaam wint van een binding zonder. De
    bestaande site blijft dus alles opvangen wat niet allmid.gg is.

    Het script is herhaalbaar: bestaat de site al, dan wordt hij bijgewerkt in
    plaats van opnieuw aangemaakt. Het weigert te draaien als een binding al bij
    een andere site hoort, in plaats van die af te pakken.

    Draaien als Administrator:
        powershell -ExecutionPolicy Bypass -File deploy\install-site.ps1
#>
[CmdletBinding()]
param(
    [string] $SiteName = 'allmid.gg',
    [string] $Root     = 'C:\inetpub\allmid',
    [string[]] $Hosts  = @('allmid.gg', 'www.allmid.gg'),
    [int]    $Port     = 80
)

$ErrorActionPreference = 'Stop'

function Stap($t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Goed($t) { Write-Host "   $t" -ForegroundColor Green }
function Let($t)  { Write-Host "   $t" -ForegroundColor Yellow }

# ── Voorwaarden ────────────────────────────────────────────────────────────
Stap 'Voorwaarden controleren'

if (-not ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
        ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Dit script moet als Administrator draaien.'
}

Import-Module WebAdministration -ErrorAction Stop
Goed 'IIS-module geladen'

# URL Rewrite en ARR zijn nodig voor /api/. Zonder die twee geeft IIS een 500 op
# web.config, en dat is een verwarrende fout om achteraf te zoeken.
$rewrite = Test-Path 'HKLM:\SOFTWARE\Microsoft\IIS Extensions\URL Rewrite'
$arr     = Test-Path 'HKLM:\SOFTWARE\Microsoft\IIS Extensions\Application Request Routing'

if (-not $rewrite) { Let 'URL Rewrite ontbreekt  -> https://www.iis.net/downloads/microsoft/url-rewrite' }
if (-not $arr)     { Let 'Application Request Routing ontbreekt -> https://www.iis.net/downloads/microsoft/application-request-routing' }
if (-not ($rewrite -and $arr)) {
    Let 'De site werkt straks wel, maar /api/ geeft een fout tot beide modules staan.'
} else {
    Goed 'URL Rewrite en ARR aanwezig'
}

# ── Botsende bindingen opsporen voordat we iets veranderen ────────────────
Stap 'Bestaande sites nakijken'

foreach ($site in Get-ChildItem IIS:\Sites) {
    foreach ($b in $site.Bindings.Collection) {
        $parts = $b.bindingInformation -split ':'
        $bHost = $parts[2]
        if ($bHost -and ($Hosts -contains $bHost) -and $site.Name -ne $SiteName) {
            throw "De hostnaam '$bHost' hoort al bij site '$($site.Name)'. Los dat eerst handmatig op; ik pak geen bindingen af."
        }
    }
    Write-Host ("   bestaand: {0,-28} {1}" -f $site.Name, (($site.Bindings.Collection | ForEach-Object { $_.bindingInformation }) -join ', '))
}
Goed 'Geen botsing; bestaande sites blijven ongemoeid'

# ── Map ────────────────────────────────────────────────────────────────────
Stap "Doelmap $Root"
if (-not (Test-Path $Root)) {
    New-Item -ItemType Directory -Path $Root -Force | Out-Null
    Goed 'aangemaakt'
} else {
    Goed 'bestaat al'
}

# ── Toepassingsgroep ──────────────────────────────────────────────────────
Stap "Toepassingsgroep $SiteName"
if (-not (Test-Path "IIS:\AppPools\$SiteName")) {
    New-WebAppPool -Name $SiteName | Out-Null
    Goed 'aangemaakt'
} else {
    Goed 'bestaat al'
}

# De site is statisch, dus .NET is nergens voor nodig. Dat scheelt geheugen en
# aanvalsoppervlak.
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name managedRuntimeVersion -Value ''
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name startMode -Value 'AlwaysRunning'
Set-ItemProperty "IIS:\AppPools\$SiteName" -Name processModel.idleTimeout -Value ([TimeSpan]::Zero)
Goed 'geen .NET, blijft draaien, valt niet in slaap'

# ── Site ───────────────────────────────────────────────────────────────────
Stap "Site $SiteName"
if (-not (Test-Path "IIS:\Sites\$SiteName")) {
    New-Website -Name $SiteName -PhysicalPath $Root -ApplicationPool $SiteName `
                -HostHeader $Hosts[0] -Port $Port | Out-Null
    Goed "aangemaakt op poort $Port"
} else {
    Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $Root
    Set-ItemProperty "IIS:\Sites\$SiteName" -Name applicationPool -Value $SiteName
    Goed 'bestond al, bijgewerkt'
}

foreach ($h in $Hosts) {
    $bestaat = Get-WebBinding -Name $SiteName -Port $Port -HostHeader $h -ErrorAction SilentlyContinue
    if (-not $bestaat) {
        New-WebBinding -Name $SiteName -Port $Port -HostHeader $h -Protocol http
        Goed "binding toegevoegd: http://${h}:$Port"
    } else {
        Goed "binding bestond al: http://${h}:$Port"
    }
}

# ── Rechten ────────────────────────────────────────────────────────────────
Stap 'Leesrechten'
$identiteit = "IIS AppPool\$SiteName"
$acl = Get-Acl $Root
$regel = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $identiteit, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.SetAccessRule($regel)
Set-Acl -Path $Root -AclObject $acl
Goed "$identiteit mag lezen (niet schrijven)"

Start-WebAppPool -Name $SiteName -ErrorAction SilentlyContinue
Start-Website -Name $SiteName -ErrorAction SilentlyContinue

Stap 'Klaar'
Write-Host @"
   Site        : $SiteName
   Map         : $Root
   Hostnamen   : $($Hosts -join ', ')

   Hierna:
     1. deploy\publish.ps1        -- de sitebestanden erheen kopieren
     2. deploy\install-collector.ps1 -- de verzamelserver als dienst
     3. win-acme (wacs.exe)       -- https aanzetten voor deze hostnamen

   Nog niets van de bestaande site is aangeraakt.
"@ -ForegroundColor Gray
