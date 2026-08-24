/**
 * Which window mode League is set to.
 *
 * This exists for one reason: an overlay cannot be drawn over true exclusive
 * fullscreen. Not by us, not by Discord, not by anything that does not inject
 * code into the game process -- and injecting is both against Riot's rules and
 * blocked by Vanguard on purpose. So the honest thing is to notice the setting
 * and say so, rather than showing an empty screen and letting people conclude
 * the app is broken.
 *
 * Read from League's own config rather than guessed from window geometry: the
 * game window collapses to 1x1 whenever it loses focus in fullscreen, so
 * measuring it from outside tells you about focus, not about the setting.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type Beeldmodus = "fullscreen" | "borderless" | "windowed";

/**
 * game.cfg stores WindowMode as a number.
 *
 * The mapping is community knowledge -- Riot documents none of it -- so an
 * unrecognised value returns null and the app stays quiet rather than telling
 * someone to change a setting that may already be right.
 */
const MODI: Record<string, Beeldmodus> = {
  "0": "fullscreen",
  "1": "borderless",
  "2": "windowed",
};

/** The usual places, tried before asking Windows anything. */
const GOKJES = [
  "C:\Riot Games\League of Legends",
  "D:\Riot Games\League of Legends",
  "C:\Program Files\Riot Games\League of Legends",
  "C:\Program Files (x86)\Riot Games\League of Legends",
];

/** Where League is installed, from the client's own command line. */
async function installatieMap(): Promise<string | null> {
  for (const gok of GOKJES) {
    if (existsSync(join(gok, "Config", "game.cfg"))) return gok;
  }
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\").CommandLine",
    ]);
    // The path is quoted when it contains spaces, which it usually does.
    const map = /--install-directory=(?:"([^"]+)"|(\S+))/.exec(stdout);
    const pad = map?.[1] ?? map?.[2];
    if (pad && existsSync(join(pad, "Config", "game.cfg"))) return pad;
  } catch {
    // No client running, or no PowerShell. Not knowing is a fine outcome here.
  }
  return null;
}

/** League's window mode, or null when we cannot tell. */
export async function leesBeeldmodus(): Promise<Beeldmodus | null> {
  const map = await installatieMap();
  if (!map) return null;
  try {
    const cfg = readFileSync(join(map, "Config", "game.cfg"), "utf8");
    const waarde = /^\s*WindowMode\s*=\s*(\d+)\s*$/m.exec(cfg)?.[1];
    return waarde ? (MODI[waarde] ?? null) : null;
  } catch {
    return null;
  }
}
