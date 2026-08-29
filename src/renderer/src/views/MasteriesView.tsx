/**
 * Your mastery pages, plus the full tree of the classic 30-point system.
 *
 * Activating does exactly that: it switches which page is active. No existing
 * page is ever overwritten, so nothing of yours can be lost here.
 */
import { useEffect, useState } from "react";
import type { AppSnapshot, MasteryPlanSummary, MasteryTreeInfo } from "../../../shared/types";
import { asset, ChampionIcon, Panel, SectionTitle, Spinner, SplashBackdrop } from "../ui";
import { describeMode } from "../../../core/modes/registry";

const TREE_STYLE: Record<string, { text: string; ring: string; bar: string }> = {
  offense: { text: "text-loss-400", ring: "border-loss-500/30", bar: "bg-loss-500" },
  defense: { text: "text-jade-300", ring: "border-jade-500/30", bar: "bg-jade-500" },
  utility: { text: "text-[#7aa8ff]", ring: "border-[#7aa8ff]/30", bar: "bg-[#7aa8ff]" },
};

export function MasteriesView({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [trees, setTrees] = useState<MasteryTreeInfo[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Which champion's recommendation we are looking at, if any. */
  const [champion, setChampion] = useState<number | null>(null);
  const [plan, setPlan] = useState<MasteryPlanSummary | null>(null);
  const [zoek, setZoek] = useState("");

  useEffect(() => {
    if (champion === null) {
      setPlan(null);
      return;
    }
    let levend = true;
    void window.jade.masteryPlan(champion).then((p) => {
      if (levend) setPlan(p);
    });
    return () => {
      levend = false;
    };
  }, [champion]);

  // See RunesView: the trees only exist once the client catalogues are loaded.
  useEffect(() => {
    if (snapshot.connection !== "connected") return;
    void window.jade.getMasteryTrees().then(setTrees);
  }, [snapshot.connection]);

  // If the active page is empty there is nothing to look at, so fall back to the
  // first page with points instead of showing three grey trees.
  const activePage = snapshot.masteryPages.find((page) => page.isActive);
  const firstFilled = snapshot.masteryPages.find((page) => !page.isEmpty);
  const shownPage =
    snapshot.masteryPages.find((page) => page.index === selected) ??
    (activePage && !activePage.isEmpty ? activePage : (firstFilled ?? activePage));
  // Either the page you have, or the page we would build for a champion. The
  // trees below render the same either way, which is the point: what you are
  // shown is what the button would write.
  const points = plan
    ? new Map(plan.points.map((p) => [p.masteryId, p.points]))
    : new Map(shownPage?.points ?? []);
  const perTree = plan?.perTree ?? shownPage?.perTree;

  // Filtered on the browse mode before anything else: the snapshot carries both
  // id spaces, and both name the same champions, so an unfiltered picker would
  // list Ashe twice and send whichever one you happened to click.
  const champions = snapshot.champions
    .filter((c) => c.mode === snapshot.loadoutModus)
    .sort((a, b) => a.name.localeCompare(b.name));
  const gefilterd = zoek.trim()
    ? champions.filter((c) => c.name.toLowerCase().includes(zoek.trim().toLowerCase()))
    : champions;
  const gekozenChampion = champion === null ? undefined : champions.find((c) => c.id === champion);

  async function activate(index: number): Promise<void> {
    const result = await window.jade.activateMasteryPage(index);
    setStatus(result.message);
  }

  if (trees.length === 0) {
    return (
      <Panel className="p-8">
        <Spinner label="Loading mastery trees..." />
      </Panel>
    );
  }

  return (
    <div className="animate-rise space-y-5">
      <div className="relative">
        <SectionTitle
          hint={
            gekozenChampion ? (
              <button onClick={() => setChampion(null)} className="text-gold-400 hover:text-gold-300">
                back to my pages
              </button>
            ) : (
              <input
                value={zoek}
                onChange={(e) => setZoek(e.target.value)}
                placeholder="Find a champion"
                className="w-44 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1 text-[11px] outline-none placeholder:text-ink-700 focus:border-gold-400/45"
              />
            )
          }
        >
          {/* The heading names the mode the list below it was filtered by, off
              the same field the filter reads. It used to say "Classic" in fixed
              type, which was true of the only mode there was and becomes a
              false claim the moment loadoutModus is anything else -- the list
              would change under a heading that did not. Falls back to no mode
              at all rather than to a name, because a mode this build cannot
              describe is one it also has no champions for, and the grid under
              this heading is then empty. */}
          {gekozenChampion
            ? `Recommended for ${gekozenChampion.name}`
            : describeMode(snapshot.loadoutModus)
              ? `Every ${describeMode(snapshot.loadoutModus)?.label} champion`
              : "Every champion"}
        </SectionTitle>

        {gekozenChampion ? (
          <Panel className="relative overflow-hidden p-4">
            <SplashBackdrop champion={gekozenChampion} strip />
            <div className="relative flex items-center gap-3">
              <ChampionIcon iconPath={gekozenChampion.iconPath} name={gekozenChampion.name} size={44} />
              <div>
                <p className="text-sm font-semibold">{gekozenChampion.name}</p>
                <p className="text-[11px] text-ink-500">
                  {plan ? `Built for a ${plan.role}` : "Working it out..."}
                  {plan?.errors.length ? ` — ${plan.errors[0]}` : ""}
                </p>
              </div>
              <button
                onClick={() => {
                  void window.jade.autoMasteries(gekozenChampion.id).then((r) => setStatus(r.message));
                }}
                className="ml-auto rounded-xl border border-gold-400/30 bg-gold-400/10 px-3.5 py-2 text-[12px] font-medium text-gold-300 transition-colors hover:bg-gold-400/20"
              >
                Set this page
              </button>
            </div>
          </Panel>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {gefilterd.map((c) => (
              <button
                key={c.id}
                onClick={() => setChampion(c.id)}
                title={c.name}
                className="rounded-lg border border-transparent transition-colors hover:border-gold-400/50"
              >
                <ChampionIcon iconPath={c.iconPath} name={c.name} size={40} />
              </button>
            ))}
            {gefilterd.length === 0 ? (
              <p className="text-xs text-ink-600">Nobody by that name.</p>
            ) : null}
          </div>
        )}
        {status ? <p className="mt-2 text-xs text-gold-300">{status}</p> : null}
      </div>

      <div className={gekozenChampion ? "hidden" : ""}>
        <SectionTitle hint={`${snapshot.masteryPages.length} pages`}>Your pages</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {snapshot.masteryPages.map((page) => {
            const isShown = shownPage?.index === page.index;
            return (
              <button
                key={page.index}
                onClick={() => setSelected(page.index)}
                className={`panel min-w-[168px] px-4 py-3 text-left transition-colors ${
                  isShown ? "border-gold-400/45" : "hover:border-line-lit"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium capitalize">{page.name}</span>
                  {page.isActive ? (
                    <span className="rounded bg-gold-400/15 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-gold-300 uppercase">
                      active
                    </span>
                  ) : null}
                </div>
                <div className="num mt-2 flex items-center gap-2 text-[11px] text-ink-500">
                  <span className="text-loss-400">{page.perTree.offense}</span>
                  <span className="text-jade-300">{page.perTree.defense}</span>
                  <span className="text-[#7aa8ff]">{page.perTree.utility}</span>
                  <span className="ml-auto">{page.pointsSpent}/30</span>
                </div>
                {!page.isActive ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      void activate(page.index);
                    }}
                    className="mt-2 block text-[11px] text-gold-400 hover:text-gold-300"
                  >
                    activate
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {trees.map((tree) => {
          const style = TREE_STYLE[tree.type] ?? TREE_STYLE.offense!;
          const spent = perTree?.[tree.type] ?? 0;
          return (
            <Panel key={tree.type} className="p-4">
              <div className="mb-4 flex items-baseline justify-between">
                <h3 className={`text-sm font-semibold ${style.text}`}>{tree.name}</h3>
                <span className="num text-[11px] text-ink-500">{spent} points</span>
              </div>

              <div className="space-y-2.5">
                {tree.rows.map((row, rowIndex) => {
                  const unlocked = spent >= row.pointsRequired;
                  return (
                    <div key={rowIndex} className="flex items-center gap-2">
                      <span className="num w-5 shrink-0 text-right text-[10px] text-ink-700">
                        {row.pointsRequired}
                      </span>
                      <div className="grid flex-1 grid-cols-4 gap-1.5">
                        {row.masteries.map((mastery, col) => {
                          if (!mastery) return <div key={col} />;
                          const rank = points.get(mastery.id) ?? 0;
                          const active = rank > 0;
                          return (
                            <div
                              key={mastery.id}
                              title={`${mastery.name} (${rank}/${mastery.maxRank})\n${mastery.description}`}
                              className={`relative aspect-square rounded-lg border ${
                                active ? style.ring : "border-line"
                              } ${unlocked ? "" : "opacity-35"}`}
                            >
                              <img
                                src={asset(active ? mastery.activeIconPath : mastery.inactiveIconPath)}
                                alt={mastery.name}
                                className={`h-full w-full rounded-lg object-cover ${
                                  active ? "" : "opacity-45 grayscale"
                                }`}
                              />
                              {active ? (
                                <span className="num absolute -right-1 -bottom-1 rounded bg-void px-1 text-[9px] font-semibold text-ink-100">
                                  {rank}/{mastery.maxRank}
                                </span>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          );
        })}
      </div>
    </div>
  );
}
