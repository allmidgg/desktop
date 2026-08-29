/**
 * Exercises shared/samenloop.ts against the real timeline of the one game this
 * machine both played and recorded, gameId 7965097532.
 *
 * The recording side is a fixture and is labelled as one. No line in
 * data/buildorders.jsonl carries a `verloop` -- all eleven predate the sampler --
 * so a ten-second series has to be stood up here to have anything to merge. It is
 * built to behave the way the real recording was measured to behave: creep score
 * floored to whole tens, sampled every ten seconds. That makes the check a check
 * of the merge, not of the client.
 */
import { LcuClient } from "../core/lcu/connector";
import { fetchGameTimeline } from "../core/lcu/timeline";
import { goudPerStoel, verloopUitTimeline } from "../core/services/historieTijdlijn";
import { krommeVoor, samenloop, stoelenUitChampions } from "../shared/samenloop";
import type { HistorieTijdlijn, OpnameRecord, Verloop, VerloopKolommen } from "../shared/types";

const GAME_ID = 7965097532;

async function main(): Promise<void> {
  const client = await LcuClient.connect();
  const timeline = await fetchGameTimeline(client, GAME_ID);
  if (!timeline) throw new Error("no timeline");

  const verloop = verloopUitTimeline(timeline, 10, null);
  // Cast rather than typed, on purpose: HistorieTijdlijn is still growing fields
  // in a neighbouring change, and a probe standing up a fixture should not be the
  // thing that breaks when it gains one.
  const historie = {
    gameId: GAME_ID,
    opgehaaldOp: Date.now(),
    verloop,
    goudPerStoel: goudPerStoel(timeline, 10),
    gebeurtenissen: [],
    jouwStoel: null,
    gemeten: {
      cs: true, level: true, kills: true, deaths: true, assists: true,
      wards: false, gestolen: false, aankopen: false, skills: false,
    },
  } as unknown as HistorieTijdlijn;

  // The fixture: ten-second samples, creep score floored to tens.
  const eind = verloop.tijden[verloop.tijden.length - 1] ?? 0;
  const tijden: number[] = [];
  for (let t = 0; t <= eind; t += 10) tijden.push(t);
  const opnameSpelers: VerloopKolommen[] = Array.from({ length: 10 }, (_, stoel) =>
    tijden.reduce<VerloopKolommen>(
      (kolom, t) => {
        let i = 0;
        while (i + 1 < verloop.tijden.length && (verloop.tijden[i + 1] ?? 0) <= t) i++;
        const cs = verloop.spelers[stoel]?.cs[i] ?? null;
        kolom.cs.push(cs === null ? null : Math.floor(cs / 10) * 10);
        kolom.kills.push(verloop.spelers[stoel]?.kills[i] ?? null);
        kolom.deaths.push(verloop.spelers[stoel]?.deaths[i] ?? null);
        kolom.assists.push(verloop.spelers[stoel]?.assists[i] ?? null);
        kolom.level.push(verloop.spelers[stoel]?.level[i] ?? null);
        kolom.wards.push(Math.floor(t / 120));
        return kolom;
      },
      { kills: [], deaths: [], assists: [], cs: [], wards: [], level: [] },
    ),
  );
  const opnameVerloop: Verloop = {
    interval: 10, tijden, goud: tijden.map(() => 300), spelers: opnameSpelers,
  };
  const opname = { verloop: opnameVerloop, spelers: [] } as unknown as OpnameRecord;

  const champs = [60086, 60035, 60075, 60042, 60025, 60024, 60064, 60013, 60022, 60044];
  // The recording's seat order is deliberately not the match's, to prove the
  // champion alignment does the work an index would get wrong.
  const opnameChamps = [champs[8]!, ...champs.slice(0, 8), champs[9]!];
  const stoelen = stoelenUitChampions(opnameChamps, champs);
  console.log("seat map (recording seat -> timeline seat):", stoelen.join(","));

  for (const [naam, uit] of [
    ["both", samenloop(opname.verloop, historie, stoelen)],
    ["timeline only", samenloop(null, historie, null)],
    ["recording only", samenloop(opname.verloop, null, null)],
    ["neither", samenloop(null, null, null)],
  ] as const) {
    console.log(`\n== ${naam} ==`);
    console.log("  axis:", uit.verloop?.tijden.length ?? 0, "samples,",
      "gold sidecar:", uit.goudPerStoel ? "yes" : "no", "| beide:", uit.beide);
    for (const [veld, h] of Object.entries(uit.herkomst)) {
      if (!h) { console.log(`  ${veld.padEnd(7)} -- no source`); continue; }
      console.log(`  ${veld.padEnd(7)} ${h.bron.padEnd(9)} every ${h.cadansSeconden}s, ${h.metingen} readings`);
    }
    const orde = [0, 1, 2, 3, 4];
    const chaos = [5, 6, 7, 8, 9];
    for (const veld of ["cs", "gold", "kills"] as const) {
      const k = krommeVoor(uit, orde, chaos, veld);
      const laatste = k.punten[k.punten.length - 1];
      console.log(`    ${veld}: ${k.punten.length} points, from ${k.vanaf}s, skipped ${k.overgeslagen}` +
        (laatste ? `, ends ${laatste.orde} v ${laatste.chaos}` : ""));
    }
  }
  const beide = samenloop(opname.verloop, historie, stoelen);
  console.log("\ncs sentence:", beide.herkomst.cs?.zin);
  console.log("\nkills sentence:", beide.herkomst.kills?.zin);
  console.log("\ncs sentence, no timeline:", samenloop(opname.verloop, null, null).herkomst.cs?.zin);
}

main().catch((e) => { console.error(e); process.exit(1); });
