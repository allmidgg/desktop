/** Your own Classic profile: rank, form, and which champions work for you. */
import { useState } from "react";
import type { AppSnapshot } from "../../../shared/types";
import type { PlayerProfile } from "../../../core/services/player";
import {
  asset, ChampionIcon, EmptyState, FormDots, Panel, RankPill, SectionTitle, Spinner, Streak,
  Winrate, WinrateRing,
} from "../ui";

export function ProfileView({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<PlayerProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [melding, setMelding] = useState<string | null>(null);

  const champions = new Map(snapshot.champions.map((c) => [c.jadeId, c]));
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

  const { jade } = profile;

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
            <div className="mt-2 flex items-center gap-2">
              <RankPill rank={profile.rank} />
              {profile.rank ? (
                <span className="num text-[11px] text-ink-500">
                  {profile.rank.wins}W / {profile.rank.losses}L in ranked Classic
                </span>
              ) : null}
            </div>
            </div>
          </div>
          {/* Eén hoofdgetal en twee die het ondersteunen. Drie gelijke kolommen
              lieten de lezer zelf uitzoeken wat het belangrijkste was. */}
          <div className="flex items-center gap-6">
            <WinrateRing winrate={jade.winrate} games={jade.games} maat={92} />
            <div className="flex gap-7 text-right">
              <Stat label="KDA" value={jade.games ? jade.kda.toFixed(2) : "-"} />
              <Stat label="Games" value={String(jade.games)} />
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3 border-t border-line pt-4">
          <span className="text-xs text-ink-500">Recent form</span>
          <FormDots results={jade.recentResults} />
          <Streak streak={jade.streak} />
          {jade.games > 0 ? (
            <span className="num ml-auto text-xs text-ink-500">
              avg {jade.avgKills.toFixed(1)} / {jade.avgDeaths.toFixed(1)} /{" "}
              {jade.avgAssists.toFixed(1)}
            </span>
          ) : null}
        </div>
      </Panel>

      <div>
        <SectionTitle hint="based on your last 30 Classic games">Your champions</SectionTitle>
        {jade.topChampions.length === 0 ? (
          <Panel className="p-6">
            <EmptyState title="No Classic games to analyse yet" />
          </Panel>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {jade.topChampions.map((record) => {
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
