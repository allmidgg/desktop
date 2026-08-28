; Eigen gedrag voor de installer.
;
; Wordt via `nsis.include` in het script van electron-builder meegenomen in
; plaats van het te vervangen. Dat is expres: hun script regelt uninstall,
; snelkoppelingen, elevatie en het samenspel met de auto-updater, en dat zelf
; overdoen is precies waar mensen hun installer mee slopen.
;
; Er staan hier bewust geen kleuren of paginateksten meer in. Die golden voor de
; wizard, en die is er niet meer: de installer is nu één klik met een
; voortgangsbalk. Wat overblijft is het enige dat NSIS niet uit zichzelf goed
; doet.

; ── De draaiende app afsluiten voordat we eroverheen schrijven ────────────────
; Zonder dit mislukt een herinstallatie of een update stil op een bestand dat in
; gebruik is, en blijf je met een halve installatie zitten. Dat raakt AllMid
; harder dan de meeste apps: hij leeft in de tray, dus hij draait vrijwel altijd
; nog terwijl je de nieuwe versie installeert -- en de auto-updater doet exact
; deze stap als hij zichzelf vervangt.
;
; /T neemt kindprocessen mee (de renderer en de GPU-processen van Electron).
; De uitkomst wordt weggegooid: draait hij niet, dan geeft taskkill een fout en
; dat is hier geen probleem maar de normale situatie bij een eerste installatie.
!macro customInit
  nsExec::Exec 'taskkill /F /IM AllMid.exe /T'
  Pop $0
!macroend
