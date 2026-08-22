# PFX Maker

Plak een certificaat en een private sleutel, krijg een `.pfx`.

IIS importeert geen los certificaat plus sleutel — dat moet één PKCS#12-bestand
zijn. De gebruikelijke weg daarheen is `openssl pkcs12 -export`, maar openssl
staat niet op een kale Windows Server. Dit doet dezelfde omzetting met wat er in
.NET Framework zit, dus je hoeft niets te installeren.

Gemaakt voor het Cloudflare Origin Certificate van allmid.gg, maar werkt voor elk
RSA-certificaat met bijbehorende sleutel.

## Gebruiken

Dubbelklik `PfxMaker.exe`. Plak links het certificaat, rechts de sleutel,
inclusief de `-----BEGIN`- en `-----END`-regels. Verzin een wachtwoord, kies waar
de `.pfx` moet komen.

Ook vanaf de commandoregel, bijvoorbeeld vanuit een installatiescript:

```
PfxMaker.exe cert.pem key.pem "wachtwoord" uit.pfx
```

Afsluitcode 0 als het gelukt is, 1 bij een fout, 2 bij verkeerd gebruik.

## Bouwen

```
build.cmd
```

Gebruikt de `csc.exe` die sinds .NET Framework 4 in elke Windows-installatie
zit. Geen Visual Studio, geen SDK, geen NuGet — dat is de reden dat dit in C#
geschreven is en niet in iets dat je eerst moet ophalen: het moet ook te bouwen
zijn op een server waar niets op staat.

`PfxMaker.exe` staat in `.gitignore`. Bouw hem zelf, dan weet je wat je draait.

## Wat het doet met je sleutel

Niets bewaren. De sleutel gaat alleen in de `.pfx` die jij aanwijst, en wordt
nergens gelogd.

Een detail dat wél de moeite waard is: `X509Certificate2.PrivateKey` eist dat de
sleutel in een echte CSP-container staat, niet alleen in het geheugen — anders
krijg je "Keyset does not exist". Er wordt dus een container met een eigen naam
aangemaakt, en na de export meteen weer weggegooid (`PersistKeyInCsp = false`).
Zonder die opruiming blijft je private sleutel achter in het sleutelarchief van
je gebruikersprofiel, op elke machine waar dit ooit gedraaid heeft. Gecontroleerd
met een telling voor en na drie conversies: nul containers blijven staan.

In het venster wordt het sleutelveld leeggemaakt zodra de `.pfx` geschreven is.
Mensen laten zo'n venster open staan.

## Controles

- Weigert een sleutel die niet bij het certificaat hoort (vergelijkt de modulus).
  Zonder die controle krijg je een `.pfx` die IIS pas veel later weigert, en dan
  zoek je in de verkeerde hoek.
- Snapt PKCS#8 (`BEGIN PRIVATE KEY`, wat Cloudflare levert) en PKCS#1
  (`BEGIN RSA PRIVATE KEY`).
- Zegt het met zoveel woorden bij een EC-sleutel of een sleutel die zelf met een
  wachtwoord versleuteld is, in plaats van een onbegrijpelijke ASN.1-fout.

## Alleen RSA

Kies bij het aanmaken van een Cloudflare Origin Certificate dus **RSA (2048)**,
niet ECC.
