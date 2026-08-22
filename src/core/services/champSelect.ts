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

  const publish = async (session: ChampSelectSession): Promise<void> => {
    const scout = async (cell: ChampSelectPlayer): Promise<ScoutedPlayer> => ({
      cell,
      profile: isVisible(cell) ? await profiles.get(cell.puuid).catch(() => null) : null,
      isLocalPlayer: cell.cellId === session.localPlayerCellId,
    });
    const [myTeam, theirTeam] = await Promise.all([
      Promise.all((session.myTeam ?? []).map(scout)),
      Promise.all((session.theirTeam ?? []).map(scout)),
    ]);
    options.onUpdate({ session, myTeam, theirTeam });
  };

  stream.on_(/^\/lol-champ-select\/v1\/session$/, (event) => {
    if (event.eventType === "Delete") {
      if (active) {
        active = false;
        profiles.clear();
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
