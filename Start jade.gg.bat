@echo off
rem Start jade.gg zonder dat er een terminalvenster open blijft staan.
cd /d "%~dp0"
if not exist "out\main\index.js" (
  echo Eerste keer: de app wordt gebouwd, dit duurt even...
  call npm run build
)
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
