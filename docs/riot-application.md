# Riot Developer Portal — product registration

Register at <https://developer.riotgames.com/> → Register Product → Personal API Key
(or Production, if that is offered directly). The three fields below are what the
form asks for. The App Notes go in the application as notes, which is where Riot's
own General Policies say to raise anything that might sit in a grey area:

> "If you have an idea that you think might fall within a gray area feel free ask
> us in your project's application. Make sure to include a description and the goal
> behind your project, and then post your question as an App Note within the
> application."

Everything below is written to be true on the day it is sent. Where something is
planned rather than built, it says so.

---

## Product name

```
AllMid
```

## Product URL

```
https://allmid.gg
```

## Product description

```
AllMid is a free companion app and stats site for League of Legends. It helps a
player decide what to do before and during a game, and understand what happened
afterwards.

The desktop app (Windows, Electron) opens by itself when champion select starts
and stays out of the way otherwise. In champion select it shows the masteries,
runes, summoner spells and item builds that win most often on your pick in your
lane, and how that pick has historically fared against the champion opposite you.
During a game an optional overlay can show the same reference information; it is
off by default. After a game it shows a full scoreboard for both teams, a
per-minute timeline of how the game developed, and a comparison between your own
line and what that champion normally does in that lane, so a number like "6.4 CS
per minute" can be read as good or bad rather than just recorded.

The website carries the same statistics: champion tier lists, build and matchup
pages, and a page per champion.

Data sources. The shared statistics that power the tier lists and build advice are
built from match data retrieved through the official Riot API (MATCH-V5) using a
key held on our own server; the desktop client never holds an API key and never
retrieves match data for anyone but its own user. On the player's own machine the
app reads the local League Client API and the Live Client Data API to know which
champion select is open, which game is running, and what that player's own recent
matches were. No game memory is read or written, no code is injected into the game
process, and no game files are modified.

The app also supports League of Legends Classic (the Season 3 remake, game mode
JADE) as a separate mode. Statistics from the two modes are never combined:
different items, runes and map timings make a Classic average meaningless for the
modern game, so each mode keeps its own database and its own averages, and every
screen names which one it is showing.

AllMid is free. There is no paid tier, no subscription, and no feature reserved
for particular users. It does not offer any rating of its own for players, no MMR
or ELO estimate, and no way to report or rate another player.
```

---

## App Notes

Three things that may sit in a grey area. Each is described as it actually works,
with the question at the end.

### App Note 1 — League of Legends Classic data

AllMid began as a companion for League of Legends Classic and still supports it.
For the modern game we retrieve match data through the official Riot API, which is
what we intend to do under this key.

For Classic we could not find a documented source. MATCH-V5 does not appear to
serve JADE matches, and there is no Classic equivalent we could locate in the
developer documentation. The Classic statistics we have today were therefore built
from the local League Client API on players' own machines, with matches
contributed by users who opted in.

We understand this is exactly what the General Policies mean by data from
undocumented endpoints, which is why we are raising it rather than leaving it
unmentioned.

**Question:** is there a documented way to obtain Classic (JADE) match data that we
have missed? If not, is there a form in which supporting Classic would be
acceptable to Riot — for example limited to the player's own matches — or would you
prefer we drop Classic statistics entirely? We would rather change the product than
be in the wrong about it.

### App Note 2 — how the in-game overlay is rendered

The overlay is a separate transparent, click-through window drawn by our own
process and positioned above the game window. It does not inject a DLL into the
game process, does not hook DirectX, DXGI, Present or any other graphics API, and
does not read or write game memory. Because it is an external window it cannot
appear over exclusive fullscreen; we require borderless or windowed mode and say so
in the app rather than work around it.

Everything it displays comes from the Live Client Data API on 127.0.0.1:2999 —
that is, information the player's own client already provides — plus our own
statistics.

**Question:** is a separate external overlay window of this kind acceptable? And is
there any rendering technique Riot considers off limits for a third-party
application beyond reading or writing game memory, so that we can be certain we
stay inside it?

### App Note 3 — showing other players' statistics

Two screens show information about players other than the user: champion select
shows the champion each player has picked and how that champion performs in that
lane, and the post-game screen shows the full scoreboard with a score per player.

We have read the policy against shaming players and against providing alternate
channels to evaluate other players, and we want to be on the right side of it. As
it stands the post-game screen names a best-performing player on each team, which
we understand is permitted as honouring a player, but it also shows a score for
everyone else.

**Question:** where is the line? Specifically: may we show a per-player score in a
post-game summary at all, or should any per-player rating be limited to the user
themselves, with only the positive callout shown for others? We are happy to remove
whatever you consider over the line before this ships more widely.

---

## Checked against the General Policies before sending

| Policy | AllMid |
|---|---|
| No official Riot logos | Own logo and crest throughout. |
| No claim of partnership or approval | Every page carries the standard "not endorsed by Riot Games" disclaimer. |
| API key properly secured | Key lives on our server, read from the environment only. The desktop client never holds one. |
| Development/Interim key not used for a public project | Understood; this application is the request for a production key. |
| One production key per project | Understood. Support for other games would be a separate application. |
| No competitive advantage | Overlay shows reference information and what the player's own client already reports; no hidden information, no automation, no input simulation. |
| No charging or exclusive access | Free, entirely. |
| No shaming players | See App Note 3. |
| No alternate reporting or rating channels | None. No report function, no player rating submitted by users. |
| No MMR/ELO alternative | None. Tier lists rank champions, not players. |
| No undocumented endpoints | This is the intent for the modern game. See App Note 1 for Classic. |
| No Riot-lookalike branding | Own visual identity, dark with a gold accent; not a copy of the client's design. |
