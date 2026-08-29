/** Your own profile in one mode: rank, form, and which champions work for you. */
import { useState } from "react";
import type { AppSnapshot } from "../../../shared/types";
import type { PlayerProfile } from "../../../core/services/player";
import type { CollectedMode } from "../../../core/modes/registry";
import { describeMode, modeLabel } from "../../../core/modes/registry";
import { rangVoor, samenvatting } from "../modus";
import {
  asset, catalogusIndex, ChampionIcon, EmptyState, FormDots, Panel, RankPill, SectionTitle,
  Spinner, Streak, Winrate, WinrateRing,
} from "../ui";

export function ProfileView({
  snapshot,
  modus,
}: {
  snapshot: AppSnapshot;
  /** The mode the window is browsing. Every figure on this page is that mode's. */
  modus: CollectedMode;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<PlayerProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  // One mode, named out loud, and the same one for every figure on the page.
  // The champion ids in a summary are that mode's ids, so the catalogue index
  // has to be built from the same choice -- indexing Classic ids against the
  // modern catalogue draws no icons and no names, which reads as missing art
  // rather than as the wrong lookup it is.
  const modusNaam = describeMode(modus)?.shortLabel ?? modeLabel(modus);
  const champions = catalogusIndex(snapshot.champions, modus);
  const profile = lookup ?? snapshot.profile;

  /**
   * Look someone up by Riot ID.
   *
   * The old version returned silently when the query had no "#", so typing a
   * name and pressing enter did nothing at all -- no result, no error, no hint
   * that a tag was needed. Every outcome says something now.
   */
  async function search(): Promise<void> {
    const riotId = query.trim();
    if (riotId === "") return;
    if (!riotId.includes("#")) {
      setMelding("Riot IDs need their tag: Faker#KR1, not just Faker.");
      return;
    }
    setBusy(true);
    setMelding(null);
    try {
      const found = await window.jade.lookupPlayer(riotId);
      setLookup(found);
      if (!found) setMelding(`No player called ${riotId}. Check the spelling and the tag.`);
    } catch (err) {
      setMelding(`Lookup failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!profile) {
    return (
      <Panel className="p-8">
        <Spinner label="Loading profile..." />
      </Panel>
    );
  }

  // Null when this player has no games in this mode, and that is what the page
  // says. There is deliberately no fall back to the other mode's figures: a
  // Classic winrate under a heading naming the modern game would be the exact
  // merge this rebuild exists to prevent, and it would arrive looking like an
  // ordinary number.
  const stats = samenvatting(profile, modus);
  const rang = rangVoor(profile, modus);

  return (
    <div className="animate-rise space-y-6">
      <div className="flex items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void search()}
          placeholder="Search a player, e.g. Faker#KR1"
          className="w-80 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-2.5 text-sm outline-none placeholder:text-ink-700 focus:border-gold-400/45"
        />
        <button
          onClick={() => void search()}
          disabled={busy}
          className="rounded-xl border border-gold-400/30 bg-gold-400/10 px-4 py-2.5 text-sm font-medium text-gold-300 transition-colors hover:bg-gold-400/20 disabled:opacity-40"
        >
          {busy ? "Searching..." : "Search"}
        </button>
        {lookup ? (
          <button
            onClick={() => {
              setLookup(null);
              setQuery("");
              setMelding(null);
            }}
            className="text-sm text-ink-500 hover:text-ink-300"
          >
            back to my profile
          </button>
        ) : null}
        {melding ? <span className="text-sm text-loss-400">{melding}</span> : null}
      </div>

      <Panel className="p-6">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4">
            <span className="relative shrink-0">
              <img
                src={asset(`/lol-game-data/assets/v1/profile-icons/${profile.profileIconId}.jpg`)}
                alt=""
                className="h-16 w-16 rounded-2xl border border-line-lit object-cover"
              />
              <span className="num absolute -right-1.5 -bottom-1.5 rounded-md border border-line-lit bg-void px-1.5 py-0.5 text-[10px] text-ink-300">
                {profile.summonerLevel}
              </span>
            </span>
            <div>
            <p className="text-2xl font-semibold tracking-tight">{profile.riotId}</p>
            {/* No pill at all where we read no ladder, rather than an
                "Unranked" one: Classic ranked and modern solo queue are
                separate ladders, and both a tier and the word unranked are
                claims about a specific one of them. */}
            <div className="mt-2 flex items-center gap-2">
              {rang === undefined ? null : <RankPill rank={rang} />}
              {rang ? (
                <span className="num text-[11px] text-ink-500">
                  {rang.wins}W / {rang.losses}L in ranked {modusNaam}
                </span>
              ) : null}
            </div>
            </div>
          </div>
          {/* Eén hoofdgetal en twee die het ondersteunen. Drie gelijke kolommen
              lieten de lezer zelf uitzoeken wat het belangrijkste was. */}
          {stats ? (
            <div className="flex items-center gap-6">
              <WinrateRing winrate={stats.winrate} games={stats.games} maat={92} />
              <div className="flex gap-7 text-right">
                <Stat label="KDA" value={stats.games ? stats.kda.toFixed(2) : "-"} />
                <Stat label="Games" value={String(stats.games)} />
              </div>
            </div>
          ) : (
            <span className="self-center text-xs text-ink-500">
              No {modusNaam} games in this player's last 30.
            </span>
          )}
        </div>

        {stats ? (
          <div className="mt-5 flex items-center gap-3 border-t border-line pt-4">
            <span className="text-xs text-ink-500">Recent form</span>
            <FormDots results={stats.recentResults} />
            <Streak streak={stats.streak} />
            {stats.games > 0 ? (
              <span className="num ml-auto text-xs text-ink-500">
                avg {stats.avgKills.toFixed(1)} / {stats.avgDeaths.toFixed(1)} /{" "}
                {stats.avgAssists.toFixed(1)}
              </span>
            ) : null}
          </div>
        ) : null}
      </Panel>

      <div>
        {/* "the X games among the last 30" and not "the last 30 X games": the
            scan is thirty games of whatever you played, so with two modes in
            the history the count behind these figures is smaller than thirty
            and the sentence has to admit it. */}
        <SectionTitle hint={`based on the ${modusNaam} games in the last 30`}>
          Your champions
        </SectionTitle>
        {!stats || stats.topChampions.length === 0 ? (
          <Panel className="p-6">
            <EmptyState title={`No ${modusNaam} games to analyse yet`} />
          </Panel>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {stats.topChampions.map((record) => {
              const champion = champions.get(record.championId);
              const kda =
                record.deaths === 0
                  ? record.kills + record.assists
                  : (record.kills + record.assists) / record.deaths;
              return (
                <Panel key={record.championId} className="flex items-center gap-3 p-3">
                  <ChampionIcon iconPath={champion?.iconPath} name={champion?.name} size={44} />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{champion?.name ?? record.championId}</p>
                    <p className="num text-[11px] text-ink-500">KDA {kda.toFixed(2)}</p>
                  </div>
                  <Winrate winrate={record.wins / record.games} games={record.games} />
                </Panel>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div>
      <p className="num text-2xl font-semibold">{value}</p>
      <p className="text-[11px] tracking-wide text-ink-500 uppercase">{label}</p>
    </div>
  );
}
