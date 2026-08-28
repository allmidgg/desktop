# Installer- en app-beelden

Vier bestanden. De eerste is de belangrijkste en ontbreekt nu volledig — zonder
app-icoon draagt je installer, je snelkoppeling en je taakbalk het standaard
Electron-logo.

Gebruik dezelfde huisstijl-alinea als bij de vorige ronde. Die staat hieronder
nog een keer, aangevuld met wat er voor deze vier specifiek anders is.

---

## De huisstijl — boven elke prompt plakken

> Visual language for AllMid, an analytics tool for League of Legends.
> Palette: near-black ground (#06080C), cool blue-grey neutrals, and a single
> accent of aged gold (#E7C76E) — the gold of worn engraved brass, not bright
> yellow and not orange. Think a well-made instrument: precise, weighty,
> slightly worn from use. Materials may have subtle depth, grain and edge
> light. Contrast is dramatic rather than uniform: most of the frame sits in
> near-darkness so the light that remains genuinely glows. Absolutely no
> lettering, numerals or logos anywhere in the image. No neon, no purple-to-
> blue gradient, no lens flare, no chrome sheen, no fantasy filigree.

Bij deze vier komt er één regel bij, want ze staan straks op een klein formaat
in een Windows-venster:

> This is a UI asset, not a poster. It must stay legible and calm at small
> sizes. Keep the composition simple and uncluttered — a single clear subject,
> generous empty space, nothing fussy or busy.

---

## 1. App-icoon — dit is de belangrijkste

Wordt je `.exe`-icoon, je snelkoppeling, je taakbalkknop en het icoon in
Add/Remove Programs. Nu ontbreekt hij helemaal.

Het merk is de M waarvan de middenstok naar beneden duikt naar een oplichtend
punt. Ik heb die al als SVG voor de site en de tray. Dit is dezelfde vorm, maar
dan als app-icoon met wat meer gewicht.

```
[huisstijl-alinea + UI-regel]

A square application icon, 1024x1024, on a dark rounded-square ground. The mark
is a letter M formed from two tapering strokes that flow down and inward to meet
at the centre — and there the middle stroke keeps going, diving down as a sharp
spike to a single bright point of light. Everything above is dimmer aged gold;
the point at the bottom is the brightest thing in the frame and casts a soft
glow. The strokes have subtle bevel and edge light, like brass inlaid into dark
stone. Bold and simple enough to stay readable at 32 pixels. Centred, generous
margin around the mark. No text.
```

**Opslaan als:** `build/icon.png` — 1024×1024, PNG
Ik zet hem daarna om naar `.ico` met alle formaten erin.

---

## 2. Installer-zijpaneel

De verticale strook links in het installatievenster. Smal en hoog, en er komt
tekst naast — dus dit moet rustig zijn.

```
[huisstijl-alinea + UI-regel]

A tall narrow vertical banner, 164x314 pixels, for the left side of a software
installer window. Subject: a dark landscape seen from far above at night,
cropped to a narrow vertical slice — faint terrain, and one small warm point of
light glowing about two thirds of the way down. The top third fades to almost
pure black so a logo can sit over it. Extremely simple, no detail that would
turn to mush at this size. Vertical composition. No text.
```

**Opslaan als:** `build/installerSidebar.bmp` — 164×314

> Let op het formaat: NSIS wil hier écht een **BMP**, geen PNG. Vraag ChatGPT om
> een PNG en stuur hem naar mij, dan converteer ik hem.

---

## 3. Installer-kopbanner

Het smalle balkje rechtsboven op de vervolgschermen. Heel klein — hier past
alleen textuur.

```
[huisstijl-alinea + UI-regel]

A very small horizontal banner, 150x57 pixels, for the top-right corner of an
installer window. Subject: an abstract close-up of dark engraved brass catching
a single raking light from the right — just material and light, no scene, no
object. Almost black on the left, warmest on the right. Must read as texture at
a glance. No text.
```

**Opslaan als:** `build/installerHeader.bmp` — 150×57

---

## 4. Splash-achtergrond

Het venstertje dat verschijnt terwijl de app opstart. Hier heb je meer ruimte,
en het mag wel indruk maken — dit is het eerste wat iemand van je software ziet.

```
[huisstijl-alinea]

A splash screen background, 900x520. Subject: a dark battlefield seen from
directly overhead at night, abstracted to routes and structures — the same world
as the site's hero image but framed tighter and turned so the light falls
differently. One structure burns warm in the lower right; the upper left is
nearly black, leaving room for a logo and a loading line. Atmospheric and
painterly, deep and quiet. No text, no characters, no recognisable game assets.
```

**Opslaan als:** `site/img/splash.png` → ik zet hem daarna in de app.

---

## Wat ik zelf doe

- Het icoon omzetten naar `.ico` met alle Windows-formaten
- PNG's omzetten naar BMP waar NSIS dat eist
- De installer-config aanvullen zodat hij ze gebruikt
- Het splash-venster bouwen, plus de "geen game actief"-weergave en de
  UI-restyling — als één blok, in één stijl
