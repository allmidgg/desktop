# Ontwerprichting C

Dit is een van de drie volledige ontwerprichtingen die voor de landingspagina
gemaakt zijn. Deze is niet de gepubliceerde site, maar de opdrachtgever wilde
hem bewaard hebben — er zitten dingen in die de uiteindelijke pagina niet heeft
overgenomen, en het is de referentie waaruit het goud, de gekantelde
splash-achtergrond en de diepere panelen komen.

## Wat er hier het meest toe doet

De sluier over de splash-art. Alle drie de richtingen legden beeld achter tekst,
en twee daarvan werden modder. Deze werkt, en het verschil zit in twee regels:

```css
.mosaic img   { filter: saturate(1.1) contrast(1.02) brightness(1.22) }
.mosaic-veil  { background:
    linear-gradient(180deg, ...),
    radial-gradient(90% 70% at 22% 34%, ...),
    radial-gradient(70% 60% at 78% 30%, ...) }
```

De art wordt **lichter** gemaakt, niet donkerder. Het donker komt van de sluier,
en die is *gevormd*: de twee radiale vlekken staan precies onder de kop en onder
de verkenner, zodat er contrast is waar tekst staat en de rest helder blijft.
Een egale sluier over de volle breedte doet dat niet en levert modder op.

## Opnieuw bouwen

```
node design/var-c/build.cjs
```

Schrijft `site/_var-c.html`. Dat bestand staat in `.gitignore`, want het is een
referentie en geen onderdeel van de site — publiceer je `site/`, dan hoort hij
er niet bij.

Let op: `build.cjs` heeft het projectpad hardgecodeerd bovenin staan. Dat is
bewust niet opgeschoond; dit is bewaard materiaal, geen productiecode.

Invoer is `site/data/meta.json` en `site/img/champions/manifest.json`.
