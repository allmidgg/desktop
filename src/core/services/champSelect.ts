/**
 * Champ select-scout: wie zit er in je lobby en hoe goed zijn ze in Classic?
 *
 * Belangrijk detail voor ranked solo: de namen van het vijandelijke team zijn
 * tijdens champ select verborgen (`nameVisibilityType: HIDDEN`, lege puuid). Hun
 * *picks* zien we wel. We tonen dus volledige profielen voor je eigen team, en
 * voor de tegenstanders de champion die ze pakken -- genoeg voor counterinfo.
 * Zodra de game laadt komen de echte namen alsnog binnen via de Live Client API.
 */
import type { LcuClient } from "../lcu/connector";
import { LcuEventStream } from "../lcu/events";
import { isJadeChampionId } from "../jade/ids";
import { resolveMode } from "../modes/detect";
import type { ModeId } from "../modes/types";
import { buildPlayerProfile, type PlayerProfile } from "./player";

export interface ChampSelectPlayer {
  cellId: number;
  puuid: string;
  championId: number;
  /** Wat iemand hovert voordat hij locked. */
  championPickIntent: number;
  assignedPosition: string;
  spell1Id: number;
  spell2Id: number;
  summonerId: number;
  nameVisibilityType?: string;
}

export interface ChampSelectAction {
  actorCellId: number;
  championId: number;
  completed: boolean;
  isAllyAction: boolean;
  type: "pick" | "ban" | "ten_bans_reveal" | string;
}

export interface ChampSelectSession {
  localPlayerCellId: number;
  myTeam: ChampSelectPlayer[];
  theirTeam: ChampSelectPlayer[];
  bans: { myTeamBans: number[]; theirTeamBans: number[]; numBans: number };
  /** Per ronde een groep acties; hier staan de bans in zodra ze gelockt zijn. */
  actions?: ChampSelectAction[][];
  timer: { phase: string; adjustedTimeLeftInPhase: number; totalTimeInPhase: number };
}

/**
 * De bans staan op twee plekken, en welke gevuld is verschilt per fase en queue.
 * We nemen `bans` als die iets bevat en vallen anders terug op de ban-acties.
 */
export function resolveBans(session: ChampSelectSession): {
  myTeamBans: number[];
  theirTeamBans: number[];
} {
  const fromField = {
    myTeamBans: (session.bans?.myTeamBans ?? []).filter((id) => id > 0),
    theirTeamBans: (session.bans?.theirTeamBans ?? []).filter((id) => id > 0),
  };
  if (fromField.myTeamBans.length > 0 || fromField.theirTeamBans.length > 0) return fromField;

  const myTeamBans: number[] = [];
  const theirTeamBans: number[] = [];
  for (const group of session.actions ?? []) {
    for (const action of group) {
      if (action.type !== "ban" || !action.completed || !action.championId) continue;
      (action.isAllyAction ? myTeamBans : theirTeamBans).push(action.championId);
    }
  }
  return { myTeamBans, theirTeamBans };
}

/**
 * What the gameflow session says about the game being set up.
 *
 * Only the three fields the mode is decided on. Verified against the running
 * client's own type registry (GET /help), which describes
 * LolGameflowGameflowSession as { phase, gameData, gameClient, map, gameDodge }
 * with gameData.queue of type LolGameflowQueue carrying id, mapId and gameMode,
 * and map of type LolGameflowGameMap carrying id and gameMode. The endpoint
 * itself could not be read while writing this -- at phase "None" it answers 404
 * "No gameflow session exists", so it only exists during a lobby, a queue or a
 * game.
 */
interface GameflowSession {
  gameData?: { queue?: { id?: number; mapId?: number; gameMode?: string } };
  map?: { id?: number; gameMode?: string };
}

/**
 * Which mode this champion select is for.
 *
 * ChampSelectSession carries localPlayerCellId, myTeam, theirTeam, bans, actions
 * and a timer, and no mapId, gameMode or queueId at all -- so the mode cannot be
 * read off the session and has to come from outside it.
 *
 * The gameflow session is that outside source, and all three of its signals are
 * handed to the resolver rather than only the queue id: a queue we have never
 * seen leaves the map and the mode string to place the lobby between them. Two
 * signals that disagree resolve to unknown, which is the answer we want -- a
 * disagreement means the table no longer matches what Riot is doing.
 *
 * The fallback reads the id space of whatever is picked or hovered, which is the
 * only mode signal the session itself contains. It is last for a reason: ARAM
 * Mayhem plays modern champions with Classic items, so the id space of a
 * champion is evidence about content and not about the map. Nothing hovered yet
 * returns null and the screen shows no marker -- which is safe, because at that
 * moment there is nothing on screen to mislabel either. Defaulting to Classic
 * there would label a modern pick as Classic, and that is the failure worth
 * avoiding.
 */
export async function champSelectMode(
  client: LcuClient,
  session: ChampSelectSession,
): Promise<ModeId | null> {
  const flow = await client.tryGet<GameflowSession>("/lol-gameflow/v1/session").catch(() => null);
  const queue = flow?.gameData?.queue;
  // The map the game is actually on wins over the map the queue belongs to. They
  // agree everywhere we know of, and where they would not, the game is the fact
  // and the queue is only its label. A queue id of zero or less is not a queue
  // at all and is dropped rather than looked up.
  const queueId = typeof queue?.id === "number" && queue.id > 0 ? queue.id : undefined;
  const mapId = flow?.map?.id ?? queue?.mapId;
  const gameMode = flow?.map?.gameMode || queue?.gameMode;
  if (queueId !== undefined || (mapId !== undefined && gameMode)) {
    // Whatever it says, that is the answer -- including "unknown". A session
    // that spoke and could not be placed must not be talked into a mode by a
    // hovered champion.
    return resolveMode({ queueId, mapId, gameMode }).mode;
  }
  for (const entry of [...(session.myTeam ?? []), ...(session.theirTeam ?? [])]) {
    const id = entry.championId || entry.championPickIntent;
    if (id > 0) return isJadeChampionId(id) ? "lol:jade" : "lol:sr";
  }
  return null;
}

export interface ScoutedPlayer {
  cell: ChampSelectPlayer;
  /** Null zolang het profiel nog laadt of de speler verborgen is. */
  profile: PlayerProfile | null;
  isLocalPlayer: boolean;
}

export interface ChampSelectView {
  session: ChampSelectSession;
  myTeam: ScoutedPlayer[];
  theirTeam: ScoutedPlayer[];
  /** What champSelectMode() made of this lobby. Null while nothing has said yet. */
  mode: ModeId | null;
}

/**
 * Profielen zijn duur (meerdere requests per speler) en veranderen niet tijdens
 * champ select, dus we halen ze eenmalig op per puuid.
 */
class ProfileCache {
  private readonly cache = new Map<string, Promise<PlayerProfile>>();

  constructor(private readonly client: LcuClient) {}

  get(puuid: string): Promise<PlayerProfile> {
    let pending = this.cache.get(puuid);
    if (!pending) {
      pending = buildPlayerProfile(this.client, puuid, 20);
      // Bij een fout willen we het bij de volgende update opnieuw kunnen proberen.
      pending.catch(() => this.cache.delete(puuid));
      this.cache.set(puuid, pending);
    }
    return pending;
  }

  clear(): void {
    this.cache.clear();
  }
}

const isVisible = (player: ChampSelectPlayer): boolean =>
  Boolean(player.puuid) && player.puuid !== "00000000-0000-0000-0000-000000000000";

export interface ChampSelectWatcherOptions {
  /** Wordt aangeroepen bij elke wijziging in champ select. */
  onUpdate: (view: ChampSelectView) => void;
  /** Wordt aangeroepen als champ select eindigt (game start of dodge). */
  onEnd?: () => void;
}

/**
 * Volgt champ select live. Geeft een functie terug die het volgen stopt.
 *
 * De eerste update komt zodra de sessie bestaat; profielen druppelen daarna
 * binnen zonder dat de rest van de weergave hoeft te wachten.
 */
export function watchChampSelect(client: LcuClient, options: ChampSelectWatcherOptions): () => void {
  const profiles = new ProfileCache(client);
  const stream = new LcuEventStream(client);
  let active = false;
  /**
   * The mode of the lobby we are in, worked out once and kept.
   *
   * A queue cannot change once champ select has started, so asking the gameflow
   * session on every pick and every ban would be a request to somebody's client
   * for an answer we already have. Null is not an answer, so it is asked again
   * -- that is the case where the session had nothing to say and nobody had
   * hovered yet, and one more look costs one request.
   */
  let modus: ModeId | null = null;

  const publish = async (session: ChampSelectSession): Promise<void> => {
    modus ??= await champSelectMode(client, session).catch(() => null);
    const scout = async (cell: ChampSelectPlayer): Promise<ScoutedPlayer> => ({
      cell,
      profile: isVisible(cell) ? await profiles.get(cell.puuid).catch(() => null) : null,
      isLocalPlayer: cell.cellId === session.localPlayerCellId,
    });
    const [myTeam, theirTeam] = await Promise.all([
      Promise.all((session.myTeam ?? []).map(scout)),
      Promise.all((session.theirTeam ?? []).map(scout)),
    ]);
    options.onUpdate({ session, myTeam, theirTeam, mode: modus });
  };

  stream.on_(/^\/lol-champ-select\/v1\/session$/, (event) => {
    if (event.eventType === "Delete") {
      if (active) {
        active = false;
        profiles.clear();
        // The next champ select is a different lobby and may be a different
        // queue, so the mode is forgotten with the profiles rather than carried
        // into it.
        modus = null;
        options.onEnd?.();
      }
      return;
    }
    active = true;
    void publish(event.data as ChampSelectSession);
  });

  stream.connect();

  // Als de app midden in champ select wordt gestart, is er geen event meer om op
  // te wachten -- dan halen we de huidige stand een keer zelf op.
  void client
    .tryGet<ChampSelectSession>("/lol-champ-select/v1/session")
    .then((session) => {
      if (session) {
        active = true;
        return publish(session);
      }
    })
    .catch(() => undefined);

  return () => stream.close();
}
