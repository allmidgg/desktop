/** Your own Classic profile: rank, form, and which champions work for you. */
import { useState } from "react";
import type { AppSnapshot } from "../../../shared/types";
import type { PlayerProfile } from "../../../core/services/player";
import {
  ChampionIcon, EmptyState, FormDots, Panel, RankPill, SectionTitle, Spinner, Streak, Winrate,
} from "../ui";

export function ProfileView({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<PlayerProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const champions = new Map(snapshot.champions.map((c) => [c.jadeId, c]));
  const profile = lookup ?? snapshot.profile;

  async function search(): Promise<void> {
    const riotId = query.trim();
    if (!riotId.includes("#")) return;
    setBusy(true);
    setNotFound(false);
    const found = await window.jade.lookupPlayer(riotId);
    setLookup(found);
    setNotFound(!found);
    setBusy(false);
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
          className="w-80 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-2.5 text-sm outline-none placeholder:text-ink-700 focus:border-jade-500/40"
        />
        <button
          onClick={() => void search()}
          disabled={busy}
          className="rounded-xl border border-jade-500/25 bg-jade-500/10 px-4 py-2.5 text-sm font-medium text-jade-300 transition-colors hover:bg-jade-500/20 disabled:opacity-40"
        >
          {busy ? "Searching..." : "Search"}
        </button>
        {lookup ? (
          <button
            onClick={() => {
              setLookup(null);
              setQuery("");
              setNotFound(false);
            }}
            className="text-sm text-ink-500 hover:text-ink-300"
          >
            back to my profile
          </button>
        ) : null}
        {notFound ? <span className="text-sm text-loss-400">Player not found.</span> : null}
      </div>

      <Panel className="p-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-2xl font-semibold tracking-tight">{profile.riotId}</p>
            <p className="mt-1 text-xs text-ink-500">Level {profile.summonerLevel}</p>
            <div className="mt-3 flex items-center gap-2">
              <RankPill rank={profile.rank} />
              {profile.rank ? (
                <span className="num text-[11px] text-ink-500">
                  {profile.rank.wins}W / {profile.rank.losses}L in ranked Classic
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex gap-8 text-right">
            <Stat label="Winrate" value={jade.games ? `${Math.round(jade.winrate * 100)}%` : "-"} />
            <Stat label="KDA" value={jade.games ? jade.kda.toFixed(2) : "-"} />
            <Stat label="Games" value={String(jade.games)} />
          </div>
        </div>

        <div className="mt-5 flex items-center gap-3 border-t border-white/5 pt-4">
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
