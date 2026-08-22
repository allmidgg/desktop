/**
 * Instellingen die tussen sessies bewaard blijven.
 *
 * Bewust een klein, plat bestand: je moet het met een teksteditor kunnen openen
 * en begrijpen. Een onleesbaar bestand is geen fout maar een reden om terug te
 * vallen op de standaardwaarden.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Settings {
  /** Zet automatisch de beste masteries zodra je een champion pickt. */
  autoMasteries: boolean;
}

const DEFAULTS: Settings = {
  autoMasteries: false,
};

export class SettingsStore {
  private current: Settings = { ...DEFAULTS };

  constructor(private readonly path: string) {}

  get value(): Settings {
    return this.current;
  }

  async load(): Promise<Settings> {
    if (!existsSync(this.path)) return this.current;
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<Settings>;
      this.current = { ...DEFAULTS, ...raw };
    } catch {
      this.current = { ...DEFAULTS };
    }
    return this.current;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    this.current = { ...this.current, ...patch };
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.current, null, 2), "utf8");
    return this.current;
  }
}

export const defaultSettingsPath = (root: string): string => join(root, "data", "settings.json");
