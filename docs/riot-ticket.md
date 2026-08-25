# Riot Developer Relations ticket

Submit at https://support-developer.riotgames.com/ (accepts policy questions from
developers with no API key and no registered product). Register the product first
at https://developer.riotgames.com/ if you want the key anyway.

Use a reply address you actually read. contact@allmid.gg does not receive mail yet.

---

**Subject:** Third-party companion app — approval process for in-game overlay rendering

Hi Riot Developer Relations,

I'm building AllMid (allmid.gg), a desktop companion app for League of Legends —
the same category of product as Blitz, Porofessor or Mobalytics: build, rune and
matchup information before a game, and a small overlay during one.

**How it works today**

- It reads the local League Client (LCU) API and the Live Client Data API on
  `127.0.0.1:2999`, on the player's own machine.
- It does not read or write game memory, does not inject any code into the game
  process, and does not modify any game files.
- Its overlay is a separate always-on-top window drawn by our own process.

Because that overlay is an external window, it cannot be shown when League runs
in Full Screen mode — only in Borderless or Windowed. I understand other
third-party apps solve this by rendering from inside the game process, hooking
the DirectX swapchain's `Present` call, which is why their overlays appear in
exclusive fullscreen.

**My questions**

1. Is there an approval process under which a third-party application may render
   an in-game overlay that way? If so, what are the requirements, and how do I
   apply? I would not build anything of the sort without approval in writing.

2. If there is no such process: can you confirm that our current approach — an
   external always-on-top window, no injection, no memory access — is acceptable
   under Riot's third-party policy? In that case we will keep it and ask users to
   run Borderless.

3. On content rather than technique: we would like to show neutral jungle camp
   and objective timers derived from the game clock. Are camp **spawn** timers
   (a countdown to a fixed, known spawn time) and camp **respawn** timers
   permitted? I am aware that enemy ability cooldowns, enemy summoner spell
   timers, ultimate timers and power-spike alerts are prohibited, and none of
   those are in the product.

Thanks for your time,

Jeffrey Verleijsdonk
allmid.gg

---

## Optional paragraph — League Classic

Include this if you want an answer that actually covers what the app does today.
Leaving it out gets you a correct answer to a question about a product you are
not currently shipping.

> **One more thing I should be upfront about.** The app's current coverage is
> League Classic, and I've seen Riot's statement that League Classic data is not
> approved for aggregation or display on third-party products. I want to respect
> that, so: is the restriction aimed at aggregated, persisted, cross-game data
> such as match history and leaderboards, or does it also cover a purely local,
> in-session display of data the Live Client Data API already returns on the
> player's own machine? If it covers both, I will disable Classic entirely and
> focus on standard League — I would rather ask now than find out later.
