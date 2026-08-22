@echo off
rem Bouwt PfxMaker.exe met de C#-compiler die bij Windows zit.
rem
rem Geen Visual Studio, geen SDK, geen NuGet: csc.exe staat sinds .NET Framework
rem 4 in elke Windows-installatie. Dat is precies waarom dit gereedschap in C#
rem geschreven is en niet in iets dat je eerst moet installeren -- het moet ook
rem te bouwen zijn op een kale server.

setlocal

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
    echo csc.exe niet gevonden. Is .NET Framework 4 aanwezig?
    exit /b 1
)

"%CSC%" /nologo /target:winexe /optimize+ /out:"%~dp0PfxMaker.exe" ^
    /reference:System.dll ^
    /reference:System.Drawing.dll ^
    /reference:System.Windows.Forms.dll ^
    "%~dp0PfxMaker.cs"

if errorlevel 1 (
    echo Bouwen mislukt.
    exit /b 1
)

echo Klaar: %~dp0PfxMaker.exe
endlocal
