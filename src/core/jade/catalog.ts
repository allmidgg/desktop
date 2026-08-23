/**
 * Catalogus van alles wat in League Classic bestaat: champions, items en spells.
 *
 * De client serveert deze data zelf op /lol-game-data/assets, inclusief iconen.
 * We halen die eenmalig op en bouwen er lookup-tabellen van. Dat betekent dat de
 * app automatisch meegroeit als Riot champions of items aan Classic toevoegt --
 * er is geen handmatig bijgehouden lijst die kan verouderen.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LcuClient } from "../lcu/connector";
import {
  isJadeChampionId, isJadeItemId, toBaseChampionId, toBaseItemId, toBaseSpellId,
} from "./ids";

interface RawChampion { id: number; name: string; alias: string; squarePortraitPath?: string; roles?: string[] }
interface RawItem { id: number; name: string; description?: string; priceTotal?: number; iconPath?: string; from?: number[]; to?: number[]; categories?: string[] }
interface RawSpell { id: number; name: string; description?: string; iconPath?: string; summonerLevel?: number }

export interface JadeChampion {
  /** ID zoals de game het gebruikt, bijv. 60022. */
  jadeId: number;
  /** ID zoals de rest van de wereld Ashe kent: 22. Handig voor externe data. */
  baseId: number;
  name: string;
  /** Alias zonder Jade_-prefix, bijv. "Ashe" -- matcht de normale Riot-alias. */
  alias: string;
  iconPath: string;
  /** Full-bleed splash, subject roughly centred. For backdrops. */
  splashPath: string;
  /** The wide crop, better where a strip of art is wanted rather than a scene. */
  tilePath: string;
  roles: string[];
}

export interface JadeItem {
  jadeId: number;
  baseId: number;
  name: string;
  price: number;
  iconPath: string;
  /** Componenten waaruit dit item wordt gebouwd, als JADE-ID's. */
  buildsFrom: number[];
  buildsInto: number[];
}

export interface JadeSpell {
  jadeId: number;
  baseId: number;
  name: string;
  iconPath: string;
}

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
 * Deliberately forgiving: a champion whose file will not load keeps the guess.
 * Losing a background is not worth failing to build a catalogue over.
 */
async function vulSplashPaden(
  champions: Map<number, JadeChampion>,
  fetchAsset: (path: string) => Promise<unknown>,
): Promise<void> {
  const ids = [...champions.keys()];
  // In batches, so a cold client does not get sixty-three requests at once.
  const grootte = 12;
  for (let i = 0; i < ids.length; i += grootte) {
    await Promise.all(
      ids.slice(i, i + grootte).map(async (id) => {
        try {
          const detail = (await fetchAsset(`/lol-game-data/assets/v1/champions/${id}.json`)) as RawChampionDetail;
          const skin = detail?.skins?.[0];
          const champion = champions.get(id);
          if (!champion || !skin) return;
          if (skin.splashPath) champion.splashPath = skin.splashPath;
          if (skin.tilePath) champion.tilePath = skin.tilePath;
        } catch {
          // Keep the guess.
        }
      }),
    );
  }
}

export class JadeCatalog {
  private constructor(
    readonly champions: Map<number, JadeChampion>,
    readonly items: Map<number, JadeItem>,
    readonly spells: Map<number, JadeSpell>,
    readonly warnings: string[],
  ) {}

  static async load(client: LcuClient): Promise<JadeCatalog> {
    return JadeCatalog.build((path) => client.get(path));
  }

  /**
   * Zelfde catalogus, maar opgehaald bij Community Dragon in plaats van bij de
   * client. Die spiegelt exact dezelfde bestanden, dus dit werkt ook als League
   * dicht staat -- handig voor de statistiek-tools.
   */
  static async fromCommunityDragon(): Promise<JadeCatalog> {
    const base = "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/";
    return JadeCatalog.build(async (path) => {
      const res = await fetch(base + path.replace("/lol-game-data/assets/v1/", ""));
      if (!res.ok) throw new Error(`Community Dragon ${res.status} voor ${path}`);
      return res.json();
    });
  }

  private static async build(fetchAsset: (path: string) => Promise<unknown>): Promise<JadeCatalog> {
    const [rawChampions, rawItems, rawSpells] = (await Promise.all([
      fetchAsset("/lol-game-data/assets/v1/champion-summary.json"),
      fetchAsset("/lol-game-data/assets/v1/items.json"),
      fetchAsset("/lol-game-data/assets/v1/summoner-spells.json"),
    ])) as [RawChampion[], RawItem[], RawSpell[]];
    const warnings: string[] = [];

    // De normale champions dienen als controlegroep: elke Jade_X moet exact
    // overeenkomen met basis-ID X. Wijkt dat af, dan klopt onze aanname niet meer.
    const baseByAlias = new Map(rawChampions.filter((c) => !isJadeChampionId(c.id)).map((c) => [c.alias, c]));
    const champions = new Map<number, JadeChampion>();
    for (const raw of rawChampions) {
      if (!isJadeChampionId(raw.id)) continue;
      const alias = raw.alias.replace(/^Jade_/, "");
      const base = baseByAlias.get(alias);
      const derived = toBaseChampionId(raw.id);
      if (base && base.id !== derived) {
        warnings.push(`Champion ${alias}: ID ${raw.id} - 60000 = ${derived}, maar basis-ID is ${base.id}`);
      }
      champions.set(raw.id, {
        jadeId: raw.id,
        baseId: base?.id ?? derived,
        name: raw.name,
        alias,
        iconPath: assetPath(raw.squarePortraitPath),
        // Derived rather than fetched. The per-champion JSON carries these paths,
        // but that is 63 extra requests to learn a naming convention that holds
        // for every one of them: Jade_Nasus_splash_centered_0.project_jade.jpg.
        // Checked against Nasus, Ezreal, Miss Fortune and Cho'Gath.
        splashPath: jadeSplashGok(alias, "centered"),
        tilePath: jadeSplashGok(alias, "tile"),
        roles: raw.roles ?? [],
      });
    }

    const items = new Map<number, JadeItem>();
    for (const raw of rawItems) {
      if (!isJadeItemId(raw.id)) continue;
      items.set(raw.id, {
        jadeId: raw.id,
        baseId: toBaseItemId(raw.id),
        name: raw.name,
        price: raw.priceTotal ?? 0,
        iconPath: assetPath(raw.iconPath),
        buildsFrom: raw.from?.map(Number) ?? [],
        buildsInto: raw.to?.map(Number) ?? [],
      });
    }

    // Spells hebben geen eigen Jade-variant in de assets: de game stuurt 74 terug
    // waar de asset 4 heet. We indexeren daarom op het vertaalde ID.
    const spells = new Map<number, JadeSpell>();
    for (const raw of rawSpells) {
      spells.set(raw.id, {
        jadeId: Number(`7${raw.id}`),
        baseId: raw.id,
        name: raw.name,
        iconPath: assetPath(raw.iconPath),
      });
    }

    if (champions.size === 0) warnings.push("Geen enkele JADE-champion gevonden -- is League Classic nog actief?");
    await vulSplashPaden(champions, fetchAsset);
    return new JadeCatalog(champions, items, spells, warnings);
  }

  /**
   * Bewaart de catalogus op schijf. De namen en iconen veranderen alleen bij een
   * patch, dus tools die geen live client nodig hebben (statistiek bijvoorbeeld)
   * kunnen er prima uit lezen terwijl League dicht staat.
   */
  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const data = {
      champions: [...this.champions.values()],
      items: [...this.items.values()],
      spells: [...this.spells.values()],
    };
    await writeFile(path, JSON.stringify(data), "utf8");
  }

  static async fromCache(path: string): Promise<JadeCatalog | null> {
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(await readFile(path, "utf8")) as {
        champions: JadeChampion[];
        items: JadeItem[];
        spells: JadeSpell[];
      };
      return new JadeCatalog(
        new Map(data.champions.map((c) => [c.jadeId, c])),
        new Map(data.items.map((i) => [i.jadeId, i])),
        new Map(data.spells.map((s) => [s.baseId, s])),
        [],
      );
    } catch {
      return null; // kapotte cache is geen fout; we halen hem gewoon opnieuw op
    }
  }

  /**
   * Haalt de catalogus bij de client op als die draait, en anders uit de cache.
   * Gooit alleen als beide ontbreken.
   */
  static async loadOrCached(clientFactory: () => Promise<LcuClient>, cachePath: string): Promise<JadeCatalog> {
    try {
      const client = await clientFactory();
      const catalog = await JadeCatalog.load(client);
      await catalog.save(cachePath);
      return catalog;
    } catch {
      const cached = await JadeCatalog.fromCache(cachePath);
      if (cached) return cached;
      // Laatste redmiddel: dezelfde bestanden van Community Dragon.
      const remote = await JadeCatalog.fromCommunityDragon();
      await remote.save(cachePath);
      return remote;
    }
  }

  champion(jadeId: number): JadeChampion | undefined {
    return this.champions.get(jadeId);
  }

  championName(jadeId: number): string {
    return this.champions.get(jadeId)?.name ?? `Champion ${jadeId}`;
  }

  item(jadeId: number): JadeItem | undefined {
    return this.items.get(jadeId);
  }

  itemName(jadeId: number): string {
    if (jadeId === 0) return "";
    return this.items.get(jadeId)?.name ?? `Item ${jadeId}`;
  }

  spell(jadeId: number): JadeSpell | undefined {
    return this.spells.get(toBaseSpellId(jadeId));
  }

  spellName(jadeId: number): string {
    return this.spell(jadeId)?.name ?? `Spell ${jadeId}`;
  }
}
