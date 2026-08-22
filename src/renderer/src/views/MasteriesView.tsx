/**
 * Your mastery pages, plus the full tree of the classic 30-point system.
 *
 * Activating does exactly that: it switches which page is active. No existing
 * page is ever overwritten, so nothing of yours can be lost here.
 */
import { useEffect, useState } from "react";
import type { AppSnapshot, MasteryTreeInfo } from "../../../shared/types";
import { asset, Panel, SectionTitle, Spinner } from "../ui";

const TREE_STYLE: Record<string, { text: string; ring: string; bar: string }> = {
  offense: { text: "text-loss-400", ring: "border-loss-500/30", bar: "bg-loss-500" },
  defense: { text: "text-jade-300", ring: "border-jade-500/30", bar: "bg-jade-500" },
  utility: { text: "text-[#7aa8ff]", ring: "border-[#7aa8ff]/30", bar: "bg-[#7aa8ff]" },
};

export function MasteriesView({ snapshot }: { snapshot: AppSnapshot }): JSX.Element {
  const [trees, setTrees] = useState<MasteryTreeInfo[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);

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
  const points = new Map(shownPage?.points ?? []);

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
      <div>
        <SectionTitle hint={`${snapshot.masteryPages.length} pages`}>Your pages</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {snapshot.masteryPages.map((page) => {
            const isShown = shownPage?.index === page.index;
            return (
              <button
                key={page.index}
                onClick={() => setSelected(page.index)}
                className={`panel min-w-[168px] px-4 py-3 text-left transition-colors ${
                  isShown ? "border-jade-500/40" : "hover:border-white/14"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-[13px] font-medium capitalize">{page.name}</span>
                  {page.isActive ? (
                    <span className="rounded bg-jade-500/15 px-1.5 py-0.5 text-[9px] font-semibold tracking-wide text-jade-300 uppercase">
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
                    className="mt-2 block text-[11px] text-jade-400 hover:text-jade-300"
                  >
                    activate
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        {status ? <p className="mt-2 text-xs text-jade-300">{status}</p> : null}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {trees.map((tree) => {
          const style = TREE_STYLE[tree.type] ?? TREE_STYLE.offense!;
          const spent = shownPage?.perTree[tree.type] ?? 0;
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
                                active ? style.ring : "border-white/6"
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
