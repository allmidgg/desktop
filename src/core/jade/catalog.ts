/**
 * Catalogus van alles wat in het spel bestaat: champions, items en spells.
 *
 * De client serveert deze data zelf op /lol-game-data/assets, inclusief iconen.
 * We halen die eenmalig op en bouwen er lookup-tabellen van. Dat betekent dat de
 * app automatisch meegroeit als Riot champions of items toevoegt -- er is geen
 * handmatig bijgehouden lijst die kan verouderen.
 *
 * One loader, two indexes. Riot serves one file per kind with both id spaces in
 * it, so building two catalogues would mean fetching the same file twice; but
 * putting both spaces in one map is the other extreme, and that is exactly the
 * mixing this rebuild exists to stop. `catalog.for("lol:sr").champion(75)` is
 * modern Nasus and `catalog.for("lol:jade").champion(75)` is undefined -- not
 * quietly something else.
 *
 * That distinction is not hypothetical for spells. Measured against the client's
 * own summoner-spells.json: the two spaces collide on eleven ids. Id 75 arrives
 * twice, once as a nameless leftover row and once as Clairvoyance, and a single
 * map lets whichever was written last win. It happened to be the right one while
 * the app was Classic-only, and it is silently wrong the moment it is not.
 *
 * The file still lives under jade/ because that is where every importer looks
 * for it; the class no longer does.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LcuClient } from "../lcu/connector";
import { spaceForMode, spaceOf, type IdSpace } from "../ids/space";
import type { KnownModeId } from "../modes/types";
import { JADE_CHAMPION_OFFSET, JADE_ITEM_OFFSET } from "./ids";

interface RawChampion { id: number; name: string; alias: string; squarePortraitPath?: string; roles?: string[] }
interface RawItem { id: number; name: string; description?: string; priceTotal?: number; iconPath?: string; from?: number[]; to?: number[]; categories?: string[] }
interface RawSpell { id: number; name: string; description?: string; iconPath?: string; summonerLevel?: number }

/**
 * What every catalogue row carries, whichever kind it is.
 *
 * `counterpartId` is how you cross from one space to the other, and it is a
 * lookup rather than a sum on purpose: it was resolved once against the real
 * index on the other side and confirmed by name. Null means there is nothing
 * over there -- Heart of Gold, Philosopher's Stone and Promote have no modern
 * equivalent, and no arithmetic can invent one.
 */
interface CatalogEntry {
  /** ID zoals de game het gebruikt: 60022 in Classic, 22 in het moderne spel. */
  id: number;
  space: IdSpace;
  name: string;
  iconPath: string;
  counterpartId: number | null;
}

export interface CatalogChampion extends CatalogEntry {
  /** Alias zonder Jade_-prefix, bijv. "Ashe" -- matcht de normale Riot-alias. */
  alias: string;
  /** Full-bleed splash, subject roughly centred. For backdrops. */
  splashPath: string;
  /** The wide crop, better where a strip of art is wanted rather than a scene. */
  tilePath: string;
  roles: string[];
}

export interface CatalogItem extends CatalogEntry {
  price: number;
  /** Componenten waaruit dit item wordt gebouwd, in de ID-ruimte van dit item. */
  buildsFrom: number[];
  buildsInto: number[];
}

export type CatalogSpell = CatalogEntry;

/**
 * Iconen worden niet als kant-en-klare URL opgeslagen maar als pad. De client
 * serveert ze achter een self-signed certificaat met authenticatie, dus de UI
 * haalt ze op via het jade://-protocol dat het main-proces registreert.
 */
const assetPath = (path: string | undefined): string => path ?? "";

/**
 * A guess at where a Classic champion's splash art lives.
 *
 * Only a fallback, and worth being honest about why. The first version of this
 * derived every path from the alias and was checked against Nasus, Ezreal, Miss
 * Fortune and Cho'Gath -- four champions that happened to agree. They do not all
 * agree: Ashe, Blitzcrank, Kennen and Lux carry a _16_16 suffix, and Kayle's base
 * art sits under Skins/Skin302 with 302 in the filename. Five of sixty-three
 * showed no background at all.
 *
 * Classic only. There is no equivalent guess for a modern champion, and inventing
 * one would put a broken image path on screen with the same confidence as a
 * working one; those start empty and wait for vulSplashPaden.
 *
 * The real paths come from each champion's own file; see vulSplashPaden. This
 * stays as the value to fall back on when that lookup cannot be made.
 */
const jadeSplashGok = (alias: string, soort: "centered" | "uncentered" | "tile"): string =>
  `/lol-game-data/assets/ASSETS/Characters/Jade_${alias}/Skins/Base/Images/Jade_${alias}_splash_${soort}_0.project_jade.jpg`;

/** The shape of the per-champion file, limited to the bit we want. */
interface RawChampionDetail {
  skins?: Array<{ splashPath?: string; tilePath?: string }>;
}

/**
 * Replace the guessed splash paths with the ones the game actually publishes.
 *
 * One request per champion, which is why it is not the first thing you reach
 * for -- but the naming is not consistent enough to derive, and a champion with
 * no backdrop is exactly the kind of gap nobody reports because it just looks
 * like a design choice.
 *
 * Deliberately forgiving: a champion whose file will not load keeps whatever it
 * had. Losing a background is not worth failing to build a catalogue over.
 */
async function vulSplashPaden(
  champions: Iterable<CatalogChampion>,
  fetchAsset: (path: string) => Promise<unknown>,
): Promise<void> {
  const rijen = [...champions];
  // In batches, so a cold client does not get every champion at once.
  const grootte = 12;
  for (let i = 0; i < rijen.length; i += grootte) {
    await Promise.all(
      rijen.slice(i, i + grootte).map(async (champion) => {
        try {
          const detail = (await fetchAsset(
            `/lol-game-data/assets/v1/champions/${champion.id}.json`,
          )) as RawChampionDetail;
          const skin = detail?.skins?.[0];
          if (!skin) return;
          if (skin.splashPath) champion.splashPath = skin.splashPath;
          if (skin.tilePath) champion.tilePath = skin.tilePath;
        } catch {
          // Keep what we had.
        }
      }),
    );
  }
}

/** One mode's slice of the catalogue: exactly the ids that mode's games carry. */
export interface CatalogView {
  readonly mode: KnownModeId;
  readonly champions: ReadonlyMap<number, CatalogChampion>;
  readonly items: ReadonlyMap<number, CatalogItem>;
  readonly spells: ReadonlyMap<number, CatalogSpell>;
  champion(id: number): CatalogChampion | undefined;
  championName(id: number): string;
  item(id: number): CatalogItem | undefined;
  itemName(id: number): string;
  spell(id: number): CatalogSpell | undefined;
  spellName(id: number): string;
}

// The answer for a mode whose numbering for that kind we have never seen. An
// empty index makes every lookup miss, which is the honest outcome; borrowing
// the other space's index would make them all hit and all be wrong.
const LEEG_CHAMPIONS: ReadonlyMap<number, CatalogChampion> = new Map();
const LEEG_ITEMS: ReadonlyMap<number, CatalogItem> = new Map();
const LEEG_SPELLS: ReadonlyMap<number, CatalogSpell> = new Map();

/** Wat er op schijf staat. Zie CACHE_VERSIE. */
interface CacheBestand {
  version: number;
  champions: CatalogChampion[];
  items: CatalogItem[];
  spells: CatalogSpell[];
}

/**
 * Which shape the cache file has.
 *
 * Version 1 held Classic only, and its contents are indistinguishable from
 * "there happen to be no modern champions". Accepting one would start the app
 * with an empty modern index and a screen that looks entirely normal, so a file
 * that does not say 2 is refetched rather than read.
 */
const CACHE_VERSIE = 2;

export class GameCatalog {
  private constructor(
    private readonly perSpace: Record<
      IdSpace,
      {
        champions: Map<number, CatalogChampion>;
        items: Map<number, CatalogItem>;
        spells: Map<number, CatalogSpell>;
      }
    >,
    readonly warnings: string[],
    private readonly fetchAsset: (path: string) => Promise<unknown>,
  ) {}

  /**
   * The catalogue as one mode sees it.
   *
   * A mode with no known space for a kind gets an empty index for that kind
   * rather than the other mode's -- lol:kiwi-jade has never shown us a spell id,
   * and answering with Classic's would be a guess wearing a lookup's clothes.
   */
  for(mode: KnownModeId): CatalogView {
    const champions = this.bak(spaceForMode(mode, "champion"))?.champions ?? LEEG_CHAMPIONS;
    const items = this.bak(spaceForMode(mode, "item"))?.items ?? LEEG_ITEMS;
    const spells = this.bak(spaceForMode(mode, "spell"))?.spells ?? LEEG_SPELLS;
    return {
      mode,
      champions,
      items,
      spells,
      champion: (id) => champions.get(id),
      championName: (id) => champions.get(id)?.name ?? `Champion ${id}`,
      item: (id) => items.get(id),
      itemName: (id) => (id === 0 ? "" : (items.get(id)?.name ?? `Item ${id}`)),
      // No fallback lookup any more, and there is nothing left for one to
      // repair: within a single space every id is its own key, so spell(720)
      // finds Promote and spell(74) finds Flash without either being stripped
      // down to a number that means something else.
      spell: (id) => spells.get(id),
      spellName: (id) => spells.get(id)?.name ?? `Spell ${id}`,
    };
  }

  private bak(space: IdSpace | null): GameCatalog["perSpace"][IdSpace] | null {
    return space ? this.perSpace[space] : null;
  }

  /** Every champion we know, both spaces, for the code that has to hand them all over. */
  alleChampions(): CatalogChampion[] {
    return [...this.perSpace.jade.champions.values(), ...this.perSpace.base.champions.values()];
  }

  /**
   * Look up the real splash paths, afterwards.
   *
   * The catalogue is complete without them: every Classic champion already
   * carries a guessed path and every modern one is waiting for its own file.
   * Blocking on this meant the window sat empty until they all came back, which
   * is a poor trade for artwork that can appear a second later.
   *
   * Resolves to true when something actually changed, so the caller knows
   * whether it is worth telling the interface again.
   */
  async verrijkSplashPaden(): Promise<boolean> {
    const alle = this.alleChampions();
    const voor = alle.map((c) => c.splashPath).join("|");
    await vulSplashPaden(alle, this.fetchAsset);
    return alle.map((c) => c.splashPath).join("|") !== voor;
  }

  static async load(client: LcuClient): Promise<GameCatalog> {
    return GameCatalog.build((path) => client.get(path));
  }

  /**
   * Zelfde catalogus, maar opgehaald bij Community Dragon in plaats van bij de
   * client. Die spiegelt exact dezelfde bestanden, dus dit werkt ook als League
   * dicht staat -- handig voor de statistiek-tools.
   */
  static async fromCommunityDragon(): Promise<GameCatalog> {
    const base = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/";
    return GameCatalog.build(async (path) => {
      const res = await fetch(base + path.replace("/lol-game-data/assets/v1/", ""));
      if (!res.ok) throw new Error(`Community Dragon ${res.status} voor ${path}`);
      return res.json();
    });
  }

  private static leegPerSpace(): GameCatalog["perSpace"] {
    return {
      base: { champions: new Map(), items: new Map(), spells: new Map() },
      jade: { champions: new Map(), items: new Map(), spells: new Map() },
    };
  }

  private static async build(fetchAsset: (path: string) => Promise<unknown>): Promise<GameCatalog> {
    const [rawChampions, rawItems, rawSpells] = (await Promise.all([
      fetchAsset("/lol-game-data/assets/v1/champion-summary.json"),
      fetchAsset("/lol-game-data/assets/v1/items.json"),
      fetchAsset("/lol-game-data/assets/v1/summoner-spells.json"),
    ])) as [RawChampion[], RawItem[], RawSpell[]];
    const warnings: string[] = [];
    const perSpace = GameCatalog.leegPerSpace();

    for (const raw of rawChampions) {
      // No longer dropped. One line here -- `if (!isJadeChampionId(raw.id))
      // continue;` -- is why the catalogue could only ever describe Classic:
      // every base-id champion went in the bin and survived only as a validation
      // control group that was never exported. Feed a modern game to any of the
      // renderer lookups built on this and nothing throws: the portrait draws its
      // "?" and every name falls back to the bare integer, so the screen looks
      // structurally fine and is entirely unlabelled.
      const space = spaceOf("champion", raw.id);
      if (!space) continue; // The {-1, "None"} sentinel, and nothing else today.
      const alias = raw.alias.replace(/^Jade_/, "");
      perSpace[space].champions.set(raw.id, {
        id: raw.id,
        space,
        name: raw.name,
        alias,
        iconPath: assetPath(raw.squarePortraitPath),
        splashPath: space === "jade" ? jadeSplashGok(alias, "centered") : "",
        tilePath: space === "jade" ? jadeSplashGok(alias, "tile") : "",
        roles: raw.roles ?? [],
        counterpartId: null,
      });
    }

    for (const raw of rawItems) {
      const space = spaceOf("item", raw.id);
      if (!space) continue;
      perSpace[space].items.set(raw.id, {
        id: raw.id,
        space,
        name: raw.name,
        price: raw.priceTotal ?? 0,
        iconPath: assetPath(raw.iconPath),
        buildsFrom: raw.from?.map(Number) ?? [],
        buildsInto: raw.to?.map(Number) ?? [],
        counterpartId: null,
      });
    }

    for (const raw of rawSpells) {
      const space = spaceOf("spell", raw.id);
      // Null is the client's own sentinel row, id 4294967295 ("Primal Smite").
      if (!space) continue;
      perSpace[space].spells.set(raw.id, {
        id: raw.id,
        space,
        name: raw.name,
        iconPath: assetPath(raw.iconPath),
        counterpartId: null,
      });
    }

    verbindCounterparts(perSpace, warnings);

    if (perSpace.jade.champions.size === 0) {
      warnings.push("Geen enkele JADE-champion gevonden -- is League Classic nog actief?");
    }
    if (perSpace.base.champions.size === 0) {
      warnings.push("Geen enkele moderne champion gevonden -- de assets zien er niet uit zoals verwacht.");
    }
    return new GameCatalog(perSpace, warnings, fetchAsset);
  }

  /**
   * Bewaart de catalogus op schijf. De namen en iconen veranderen alleen bij een
   * patch, dus tools die geen live client nodig hebben (statistiek bijvoorbeeld)
   * kunnen er prima uit lezen terwijl League dicht staat.
   */
  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const data: CacheBestand = {
      version: CACHE_VERSIE,
      champions: this.alleChampions(),
      items: [...this.perSpace.jade.items.values(), ...this.perSpace.base.items.values()],
      spells: [...this.perSpace.jade.spells.values(), ...this.perSpace.base.spells.values()],
    };
    await writeFile(path, JSON.stringify(data), "utf8");
  }

  static async fromCache(path: string): Promise<GameCatalog | null> {
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as Partial<CacheBestand>;
      // A file from before both spaces existed carries no version and looks
      // exactly like a catalogue in which the modern game is empty. Refusing it
      // costs one fetch; accepting it costs a whole mode, silently.
      if (data.version !== CACHE_VERSIE) return null;
      const perSpace = GameCatalog.leegPerSpace();
      for (const champion of data.champions ?? []) perSpace[champion.space].champions.set(champion.id, champion);
      for (const item of data.items ?? []) perSpace[item.space].items.set(item.id, item);
      for (const spell of data.spells ?? []) perSpace[spell.space].spells.set(spell.id, spell);
      return new GameCatalog(
        perSpace,
        [],
        // A catalogue read back from disk already has its real paths in it, so
        // there is nothing left to look up.
        () => Promise.reject(new Error("catalogus uit bestand: niets op te halen")),
      );
    } catch {
      return null; // kapotte cache is geen fout; we halen hem gewoon opnieuw op
    }
  }

  /**
   * Haalt de catalogus bij de client op als die draait, en anders uit de cache.
   * Gooit alleen als beide ontbreken.
   */
  static async loadOrCached(clientFactory: () => Promise<LcuClient>, cachePath: string): Promise<GameCatalog> {
    try {
      const client = await clientFactory();
      const catalog = await GameCatalog.load(client);
      await catalog.save(cachePath);
      return catalog;
    } catch {
      const cached = await GameCatalog.fromCache(cachePath);
      if (cached) return cached;
      // Laatste redmiddel: dezelfde bestanden van Community Dragon.
      const remote = await GameCatalog.fromCommunityDragon();
      await remote.save(cachePath);
      return remote;
    }
  }
}

/**
 * Point every row at its opposite number, once, and only where the name agrees.
 *
 * The arithmetic that used to be six exported functions survives here as three
 * candidate guesses, and that is the whole difference: a candidate is looked up
 * in the real index on the other side and then checked against the name, so a
 * near miss becomes null instead of becoming a confident answer. Applying any of
 * this to its own output is impossible because the result is an id in the index,
 * not a number handed back for another round.
 *
 * The name check is what makes the Jade spell numbering safe to read. Dropping
 * the leading 7 turns 777 (Revive) into 77, and 77 is Classic Heal -- an id that
 * exists, in the wrong space, with the wrong name. It gets rejected here, where
 * the old range guard let it through.
 */
function verbindCounterparts(
  perSpace: GameCatalog["perSpace"],
  warnings: string[],
): void {
  const koppel = (jade: CatalogEntry, base: CatalogEntry): void => {
    jade.counterpartId = base.id;
    base.counterpartId = jade.id;
  };
  const zelfdeNaam = (a: string, b: string): boolean =>
    a.trim() !== "" && a.trim().toLowerCase() === b.trim().toLowerCase();

  // Champions go by alias first, because Riot gives us one: a Classic champion is
  // Jade_<alias> of a modern one. Two of the sixty-three do not survive that on
  // its own -- Classic spells Fiddlesticks with a small s where the modern roster
  // spells it FiddleSticks, and Wukong is still filed under MonkeyKing over there
  // -- so a failed alias falls back to the derived id confirmed by the name,
  // which is the same class of evidence and settles both.
  //
  // The subtraction is checked rather than trusted: if it ever stops agreeing
  // with the alias, that is the day this numbering convention changed and we
  // want to hear about it rather than read past it.
  const basisPerAlias = new Map(
    [...perSpace.base.champions.values()].map((c) => [c.alias.toLowerCase(), c]),
  );
  for (const champion of perSpace.jade.champions.values()) {
    const afgeleid = champion.id - JADE_CHAMPION_OFFSET;
    const perAlias = basisPerAlias.get(champion.alias.toLowerCase());
    if (perAlias) {
      if (perAlias.id !== afgeleid) {
        warnings.push(
          `Champion ${champion.alias}: ID ${champion.id} - 60000 = ${afgeleid}, maar basis-ID is ${perAlias.id}`,
        );
      }
      koppel(champion, perAlias);
      continue;
    }
    const perId = perSpace.base.champions.get(afgeleid);
    if (perId && zelfdeNaam(champion.name, perId.name)) koppel(champion, perId);
  }

  // Items have no alias, so the name is the whole of the evidence -- and it earns
  // its keep. Measured against the live client: 113 of the 162 Classic items land
  // on an id that exists in the modern space, and 33 of those 113 are a different
  // item wearing the number. 773144 is Bilgewater Cutlass and 3144 is Scout's
  // Slingshot; 773084 is Innervating Locket and 3084 is Heartsteel. Riot reused
  // the numbers Season 3 had freed up.
  //
  // The check also refuses six or so genuine renames -- Boots of Speed is now
  // just Boots, Ninja Tabi is Plated Steelcaps -- and nothing in the data tells a
  // rename apart from a reuse. Null on a rename costs a link nothing reads yet;
  // a link to the wrong item is the sort of thing that gets believed.
  for (const item of perSpace.jade.items.values()) {
    const base = perSpace.base.items.get(item.id - JADE_ITEM_OFFSET);
    if (base && zelfdeNaam(item.name, base.name)) koppel(item, base);
  }

  for (const spell of perSpace.jade.spells.values()) {
    // Classic spells are the base id with a 7 written in front of it, not added
    // to it: Flash 4 is 74 and Teleport 12 is 712.
    const cijfers = String(spell.id);
    const kandidaat = cijfers.length > 1 && cijfers.startsWith("7") ? Number(cijfers.slice(1)) : NaN;
    const base = Number.isFinite(kandidaat) ? perSpace.base.spells.get(kandidaat) : undefined;
    if (base && zelfdeNaam(spell.name, base.name)) koppel(spell, base);
  }
}
