# Beeldlijst voor AllMid — tweede versie

De eerste ronde kwam dood terug en dat lag aan de prompt. Die zat vol met wat
er *niet* in mocht — plat, geen glow, laag contrast, "financial terminal" — en
had geen onderwerp. Wat je dan krijgt is correct en levenloos.

Drie dingen zijn nu anders:

1. **Elk beeld heeft een onderwerp** uit de wereld van het spel, niet abstracte
   geometrie. Het oog moet ergens naar kunnen kijken.
2. **Elk beeld heeft een contrastopbouw.** Meestal donker, met één plek die echt
   licht is. Overal laag contrast is modder.
3. **Eén prompt per beeld.** Tien assets in één vraag betekent een tiende
   aandacht per asset.

De vorige versie zei "flat vector, no dimension". Dat is nu weg. Wel gebleven:
geen neon, geen paars-blauwe gradiënt, geen lens flares, geen tekst.

---

## De huisstijl — plak dit boven elke prompt

> Visual language for AllMid, an analytics tool for League of Legends.
> Palette: near-black ground (#06080C), cool blue-grey neutrals, and a single
> accent of aged gold (#E7C76E) — the gold of worn engraved brass, not bright
> yellow and not orange. Think a well-made instrument: precise, weighty,
> slightly worn from use. Materials may have subtle depth, grain and edge
> light. Composition is asymmetric, never centred and evenly spaced. Contrast
> is dramatic rather than uniform: roughly 80% of the frame sits in near-
> darkness so the remaining 20% can genuinely glow. Absolutely no lettering,
> numerals, logos or UI chrome anywhere in the image. No neon, no purple-to-
> blue gradient, no lens flare, no chrome sheen, no fantasy filigree.

Die laatste twee regels zijn de belangrijkste. De verboden lijst is kort en
specifiek; verder mag het model zijn gang gaan.

---

## 1. Hero-achtergrond

**Waar:** achter de kop op de voorpagina, op ~20% dekking.
**Bestand:** `site/img/hero-bg.png` — 2400×1200

```
[huisstijl-alinea]

A wide atmospheric background, 2400x1200. Subject: a battlefield seen from
directly overhead, at night, abstracted almost to the point of a diagram. Three
broad routes run corner to corner across a dark field, with a river cutting
diagonally between them. Where routes meet there are structures — suggested by
mass and glow rather than drawn in detail. The upper-left is nearly black. The
light concentrates along the central route and at one structure in the lower
right, as though something is burning there. Fog pools in the spaces between
routes. Aged gold light on near-black. Painterly and atmospheric, not a clean
vector diagram. No text, no icons, no characters, no recognisable game assets.
```

**Waarom dit beter is:** de vorige gaf een printplaat. Deze geeft een slagveld
van bovenaf met één brandpunt rechtsonder — daar kan een oog naartoe.

---

## 2. Open Graph-kaart

**Waar:** de voorvertoning als iemand allmid.gg in Discord plakt. Waarschijnlijk
het meest bekeken beeld dat je hebt.
**Bestand:** `site/img/meta.png` — exact 1200×630

```
[huisstijl-alinea]

A social preview image, exactly 1200x630. Composition is deliberately
lopsided: the left 45% is almost entirely empty near-black, reserved for a
wordmark to be placed later. The right side holds a single striking object — a
sheet of aged brass, angled in three-quarter view, with fine data engraved into
its surface: a rising line, tick marks, a scatter of small drilled points.
Light rakes across it from the upper right, catching the engraved edges so they
read as physical grooves rather than printed lines. The brass is worn at the
corners. Deep shadow underneath. No text, no numerals, no logo, no charts that
look like screenshots.
```

**Waarom dit beter is:** "een staafdiagram" is een idee dat iedereen heeft. Een
gegraveerde messing plaat is een voorwerp — dat heeft materiaal, licht en een
schaduw, en het zegt "meetinstrument" zonder een grafiek na te doen.

---

## 3. Lege-staat beeld

**Waar:** bij de 110 champions zonder Classic-data, en later bij lege wachtrijen.
**Bestand:** `site/img/leeg.png` — 900×600

```
[huisstijl-alinea]

A quiet image, 900x600, meaning "nothing recorded here yet" — patient, never an
error. Subject: a single empty seat at a long dark table, seen from a low
angle, lit by one narrow shaft of warm light from off-frame left. The table
surface is bare. Everything beyond the seat falls away into darkness. Aged gold
light, deep shadow, a lot of empty space in the right two thirds. Calm and
still. No text, no characters, no icons, no magnifying glasses, no empty boxes,
no question marks.
```

**Waarom dit beter is:** een lege grafiekas zegt "kapot". Een lege stoel zegt
"we wachten nog", en dat is precies wat er aan de hand is.

---

## 4. Sectie-scheidingen

**Waar:** tussen secties op de voorpagina. Drie stuks, en ze moeten van elkaar
verschillen.
**Bestanden:** `site/img/scheiding-1.png` t/m `-3.png` — 2400×200

```
[huisstijl-alinea]

A narrow horizontal band, 2400x200, to separate sections of a dark page.
Subject: the silhouette of a distant treeline and low structures along a
horizon, seen at night from far away — nearly abstract, reduced to a broken
edge where dark shapes meet slightly-less-dark sky. One faint point of warm
light sits off-centre, about a third from the right. Both the far left and far
right fade completely to black. Extremely wide and shallow. No text, no
characters, no repeating pattern.
```

Vraag om drie varianten, elk met dat lichtpunt op een **andere** plek. Anders
krijg je weer drie identieke banden.

---

## 5. Logo — dit heb ik al gedaan

Variant 1 uit jouw sheet was de goede: een 3×3 raster waarin alleen het midden
gevuld is. Dat *is* de naam — AllMid, de middelste lane. De andere vijf waren
richtkruizen en ruiten die op elk tech-product hadden gekund.

Ik heb hem gebouwd. De acht cellen eromheen staan nu als omtrek en alleen het
midden is massief goud met een lichte gloed, zodat het oog daar landt in plaats
van een patroon te zien. Het is CSS, dus scherp op elk formaat en geen bestand
dat geladen hoeft te worden.

Wil je er tóch nog naar laten kijken, vraag dan niet om varianten maar om
verfijning van deze ene:

```
[huisstijl-alinea]

Refine a single logo mark, shown large and alone on a dark square. The mark is
a 3x3 grid of squares. The eight outer squares are drawn as thin hairline
outlines in dim blue-grey; the centre square is solid aged gold and lit, as
though it is the only one switched on. Explore proportion: how thin the
outlines should be, how much gap between cells, whether the corners are sharp
or fractionally rounded, how far the centre's glow spreads. Show 4 refinements
of this same idea, never a different idea. No text.
```

---

## Wat ik zelf maak

De zes feature-blokken op de voorpagina worden **echte screenshots van de app**.
Geen AI. Een getekend plaatje van een functie is een claim die niemand kan
nakijken, en de hele site leunt erop dat elke claim controleerbaar is. Blitz
doet dat trouwens net zo — hun feature-beelden zijn gewoon hun eigen product.

## Waar de bestanden heen moeten

Alles in `site/img/`. De build pakt ze automatisch op zodra ze er staan, dus je
kunt ze één voor één aanvullen — tot die tijd staat er een verzorgd leeg vlak.
