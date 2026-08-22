/**
 * Rune advice, and applying it.
 *
 * Suggestions always come from what you actually own -- runes have to be bought
 * in Classic. What you are missing shows up next to it as a buy tip.
 */
import { useEffect, useMemo, useState } from "react";
import type { AppSnapshot, RunePlanSummary } from "../../../shared/types";
import type { RuneKind } from "../../../core/jade/runes";
import { asset, ChampionIcon, EmptyState, Panel, SectionTitle, Spinner } from "../ui";

const KIND_LABELS: Record<RuneKind, { label: string; color: string }> = {
  mark: { label: "Marks", color: "text-loss-400" },
  seal: { label: "Seals", color: "text-gold-400" },
  glyph: { label: "Glyphs", color: "text-[#7aa8ff]" },
  quintessence: { label: "Quintessences", color: "text-jade-300" },
};

export function RunesView({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [championId, setChampionId] = useState<number | null>(null);
  const [plan, setPlan] = useState<RunePlanSummary | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // The main process needs a moment to load its catalogues. Until then the plan
  // comes back empty, so we ask again once the connection is up.
  useEffect(() => {
    if (snapshot.connection !== "connected") return;
    void window.jade.planRunes(championId).then(setPlan);
    setStatus(null);
  }, [championId, snapshot.connection]);

  const champions = useMemo(
    () =>
      [...snapshot.champions]
        .filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [snapshot.champions, search],
  );

  const selected = snapshot.champions.find((c) => c.jadeId === championId) ?? null;
  // Prefer an empty page so nothing of yours is lost.
  const targetPage = snapshot.runePages.find((p) => p.isEmpty) ?? snapshot.runePages[0];

  // Overwriting a filled page costs you your own setup, so we ask first.
  // An empty page applies straight away.
  async function apply(): Promise<void> {
    if (!plan || !targetPage) return;
    if (!targetPage.isEmpty && !confirming) {
      setConfirming(true);
      return;
    }
    setApplying(true);
    setConfirming(false);
    const result = await window.jade.applyRunes(targetPage.index, plan.slots);
    setStatus(result);
    setApplying(false);
  }

  return (
    <div className="animate-rise grid grid-cols-[240px_1fr] gap-6">
      <div className="min-h-0">
        <SectionTitle>Champion</SectionTitle>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search..."
          className="mb-2 w-full rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2 text-sm outline-none placeholder:text-ink-700 focus:border-jade-500/40"
        />
        <div className="max-h-[calc(100vh-220px)] space-y-1 overflow-y-auto pr-1">
          {champions.map((champion) => (
            <button
              key={champion.jadeId}
              onClick={() => setChampionId(champion.jadeId)}
              className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors ${
                championId === champion.jadeId ? "bg-jade-500/12 text-jade-300" : "hover:bg-white/5"
              }`}
            >
              <ChampionIcon iconPath={champion.iconPath} name={champion.name} size={30} />
              <span className="truncate text-[13px]">{champion.name}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-5">
        {!plan ? (
          <Panel className="p-8">
            <Spinner label="Calculating runes..." />
          </Panel>
        ) : (
          <>
            <Panel className="flex items-center justify-between p-5">
              <div className="flex items-center gap-3">
                <ChampionIcon iconPath={selected?.iconPath} name={selected?.name} size={48} />
                <div>
                  <p className="text-lg font-medium">{selected?.name ?? "General advice"}</p>
                  <p className="text-xs text-ink-500">
                    Weighted for role: <span className="text-ink-300">{plan.role}</span>
                  </p>
                </div>
              </div>
              <div className="text-right">
                <button
                  onClick={() => void apply()}
                  disabled={applying || !targetPage}
                  className={`rounded-xl border px-5 py-2.5 text-sm font-medium transition-colors disabled:opacity-40 ${
                    confirming
                      ? "border-gold-500/40 bg-gold-500/15 text-gold-300 hover:bg-gold-500/25"
                      : "border-jade-500/30 bg-jade-500/12 text-jade-300 hover:bg-jade-500/22"
                  }`}
                >
                  {applying
                    ? "Applying..."
                    : confirming
                      ? "Yes, overwrite"
                      : "Apply in client"}
                </button>
                {targetPage ? (
                  <p
                    className={`mt-1.5 max-w-[260px] text-[11px] ${
                      targetPage.isEmpty ? "text-ink-500" : "text-gold-400"
                    }`}
                  >
                    {targetPage.isEmpty
                      ? `writes to page ${targetPage.index}, which is empty`
                      : `heads up: this overwrites your page "${targetPage.name}" — a backup is saved first`}
                  </p>
                ) : null}
                {confirming ? (
                  <button
                    onClick={() => setConfirming(false)}
                    className="mt-1 text-[11px] text-ink-500 hover:text-ink-300"
                  >
                    cancel
                  </button>
                ) : null}
              </div>
            </Panel>

            {status ? (
              <Panel
                className={`p-4 text-sm ${
                  status.ok ? "border-jade-500/30 text-jade-300" : "border-loss-500/30 text-loss-400"
                }`}
              >
                {status.message}
              </Panel>
            ) : null}

            <div className="grid grid-cols-2 gap-3">
              {plan.kinds.map((kind) => (
                <Panel key={kind.kind} className="p-4">
                  <div className="mb-3 flex items-baseline justify-between">
                    <span className={`text-sm font-semibold ${KIND_LABELS[kind.kind].color}`}>
                      {KIND_LABELS[kind.kind].label}
                    </span>
                    <span className="num text-[11px] text-ink-500">
                      {kind.slots - kind.emptySlots}/{kind.slots} slots
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    {kind.choices.length === 0 ? (
                      <p className="text-xs text-ink-700">You do not own any usable runes.</p>
                    ) : null}
                    {kind.choices.map((choice) => (
                      <div key={choice.runeId} className="flex items-center gap-2.5">
                        {choice.iconPath ? (
                          <img
                            src={asset(choice.iconPath)}
                            alt=""
                            className="h-7 w-7 rounded-lg border border-white/8"
                          />
                        ) : null}
                        <span className="num w-7 text-[13px] font-semibold text-jade-400">
                          {choice.count}x
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px]">{choice.title}</p>
                          <p className="truncate text-[11px] text-ink-500">{choice.tooltip}</p>
                        </div>
                      </div>
                    ))}
                    {kind.emptySlots > 0 ? (
                      <p className="text-[11px] text-gold-400">
                        {kind.emptySlots} slot(s) stay empty
                      </p>
                    ) : null}
                  </div>

                  {kind.upgrade && kind.upgrade.gapPercent > 0 ? (
                    <div className="mt-3 rounded-lg border border-gold-500/20 bg-gold-500/8 px-2.5 py-2">
                      <p className="text-[11px] text-gold-300">
                        Buy: {kind.slots}x {kind.upgrade.title}
                      </p>
                      <p className="num text-[10px] text-ink-500">
                        {kind.upgrade.gapPercent}% stronger than what you own
                      </p>
                    </div>
                  ) : null}
                </Panel>
              ))}
            </div>

            <Panel className="p-4">
              <SectionTitle>What this page gives you</SectionTitle>
              {plan.totalStats.length === 0 ? (
                <EmptyState title="You do not own any usable runes yet" />
              ) : (
                <div className="flex flex-wrap gap-2">
                  {plan.totalStats.map(([stat, amount]) => (
                    <span
                      key={stat}
                      className="num rounded-lg bg-white/[0.04] px-2.5 py-1 text-[12px] text-ink-300"
                    >
                      +{amount.toFixed(2).replace(/\.00$/, "")}{" "}
                      <span className="text-ink-500">{stat}</span>
                    </span>
                  ))}
                </div>
              )}
            </Panel>
          </>
        )}
      </div>
    </div>
  );
}
