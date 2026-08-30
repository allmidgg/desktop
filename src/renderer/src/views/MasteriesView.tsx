/**
 * Every champion in the mode, and the 30-point mastery page for the one you pick.
 *
 * Champion first, and that is the whole layout: the screen opens on the full
 * grid of the mode's champions, you click one, and the three trees underneath
 * fill with the page AllMid would set for it. Your own pages are still here --
 * below the grid, where they are something you go and look at rather than the
 * thing the screen is about.
 *
 * The trees never show a page that was not asked for. Whatever is above them
 * names what they are drawing: a champion's recommendation or one of your own
 * pages. When there is no recommendation to give they stay empty and say so,
 * because the alternative is your own page standing under someone else's name.
 *
 * Activating does exactly that: it switches which page is active. No existing
 * page is ever overwritten, so nothing of yours can be lost here.
 *
 * Classic only, and the tab is hidden elsewhere. The 30-point offence/defence/
 * utility tree is the Season 3 system; Riot deleted it in 2017 and replaced it
 * with Runes Reforged, so there is no modern page for this screen to draw. See
 * `loadout` in core/modes/types.ts.
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
  /**
   * Whether the answer for `champion` is still on its way.
   *
   * Kept apart from `plan`, because a null plan means two different things --
   * not asked yet, and asked and there is nothing -- and the screen owes the
   * reader a different sentence for each. Folding them together is how a
   * champion with no plan sat under "Working it out..." forever.
   */
  const [planBezig, setPlanBezig] = useState(false);
  const [zoek, setZoek] = useState("");

  useEffect(() => {
    if (champion === null) {
      setPlan(null);
      setPlanBezig(false);
      return;
    }
    let levend = true;
    // Cleared before asking, so switching champions cannot leave the previous
    // one's page on screen under the new one's name while the call is in flight.
    setPlan(null);
    setPlanBezig(true);
    void window.jade.masteryPlan(champion).then((p) => {
      if (!levend) return;
      setPlan(p);
      setPlanBezig(false);
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

  /**
   * What the trees draw, and it is never a mixture of the two sources.
   *
   * With a champion open these are the recommendation and nothing else, so no
   * plan means no points. It used to fall through to your own active page
   * whenever the plan was missing or still loading, under a heading reading
   * "Recommended for Ashe" -- which quietly presented your own page as advice
   * the app never gave. An empty tree with a reason above it is the honest
   * answer, and it is also the visibly different one.
   *
   * With no champion open they are your page, which is what the heading then
   * says. Either way: what you are shown is what the button would write.
   */
  const points = gekozenChampion
    ? new Map((plan?.points ?? []).map((p) => [p.masteryId, p.points]))
    : new Map(shownPage?.points ?? []);
  const perTree = gekozenChampion ? plan?.perTree : shownPage?.perTree;

  /**
   * Why this champion has no page, in one sentence, or null when it has one.
   *
   * masteryPlanFor returns null when the client's catalogues are not up, or when
   * the champion is not in the loadout mode's id space. We cannot tell which
   * from here and do not guess: it says what is true either way -- no page was
   * built -- rather than naming a cause it does not know.
   */
  const geenPlan =
    gekozenChampion && !planBezig && !plan
      ? `No page was built for ${gekozenChampion.name}. The trees below stay empty rather than show you someone else's.`
      : null;

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
              // "back to my pages" was the old shape of this screen, where the
              // grid was a detour off your own pages. The grid is the screen
              // now, so the way back says where it goes.
              <button onClick={() => setChampion(null)} className="text-gold-400 hover:text-gold-300">
                back to every champion
              </button>
            ) : (
              // The count and the box together, because with this many portraits
              // one answers "how many am I looking at" and the other is the only
              // way to find a particular face without reading all of them. The
              // count is off the same list the grid draws, so it cannot claim a
              // number the screen does not show.
              <span className="flex items-center gap-2.5">
                <span className="num text-ink-600">
                  {zoek.trim() ? `${gefilterd.length} of ${champions.length}` : `${champions.length}`}{" "}
                  champions
                </span>
                <input
                  value={zoek}
                  onChange={(e) => setZoek(e.target.value)}
                  placeholder="Find a champion"
                  className="w-44 rounded-lg border border-line bg-white/[0.03] px-2.5 py-1 text-[11px] outline-none placeholder:text-ink-700 focus:border-gold-400/45"
                />
              </span>
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
            ? `Masteries for ${gekozenChampion.name}`
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
                {/* Three states, three sentences. The middle one is the reason
                    planBezig exists: "Working it out..." used to stand here for
                    a champion whose answer had already come back empty. */}
                <p className="text-[11px] text-ink-500">
                  {planBezig
                    ? "Working it out..."
                    : plan
                      ? `Built for a ${plan.role}${plan.errors.length ? ` — ${plan.errors[0]}` : ""}`
                      : geenPlan}
                </p>
              </div>
              {/* Off while there is nothing to write. The button plans again in
                  the main process rather than sending what is on screen, so
                  leaving it live under an empty tree offers to apply a page the
                  screen just said it could not build. */}
              <button
                disabled={planBezig || !plan}
                onClick={() => {
                  void window.jade.autoMasteries(gekozenChampion.id).then((r) => setStatus(r.message));
                }}
                className="ml-auto rounded-xl border border-gold-400/30 bg-gold-400/10 px-3.5 py-2 text-[12px] font-medium text-gold-300 transition-colors hover:bg-gold-400/20 disabled:opacity-40"
              >
                Set this page
              </button>
            </div>
          </Panel>
        ) : (
          // The same tile the Meta tier bands use -- a bordered portrait that
          // lights gold on hover -- because this is the app's second grid of
          // champion faces and a second look for the same object would be one
          // look too many.
          <div className="flex flex-wrap gap-1.5">
            {gefilterd.map((c) => (
              <button
                key={c.id}
                onClick={() => setChampion(c.id)}
                title={c.name}
                className="overflow-hidden rounded-md border border-line transition-colors hover:border-gold-500/60"
              >
                <ChampionIcon iconPath={c.iconPath} name={c.name} size={44} />
              </button>
            ))}
            {/* Two different absences, and they are not the same news: nothing
                matched what you typed, or this build has no champions for the
                mode at all -- which is what an unconnected client looks like. */}
            {gefilterd.length === 0 ? (
              <p className="text-xs text-ink-600">
                {champions.length === 0
                  ? "No champions loaded yet. They come from the running client."
                  : "Nobody by that name."}
              </p>
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

      {/* The trees used to stand under nothing, which is how they came to read
          as "the masteries" while they were in fact drawing whichever of your
          own pages had points in it. A heading that names the source is the
          difference between a preview and a claim. */}
      <div>
        <SectionTitle
          hint={
            gekozenChampion
              ? planBezig
                ? "working it out..."
                : plan
                  ? `for a ${plan.role}`
                  : "nothing to show"
              : shownPage
                ? `${shownPage.pointsSpent}/30 points`
                : undefined
          }
        >
          {gekozenChampion
            ? `The page AllMid would set for ${gekozenChampion.name}`
            : shownPage
              ? `Your page "${shownPage.name}"`
              : "Mastery trees"}
        </SectionTitle>

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
    </div>
  );
}
