/**
 * Verbinding met de League Client Update (LCU) API.
 *
 * De client draait een lokale HTTPS-server met een self-signed certificaat.
 * Poort + wachtwoord staan in het lockfile dat de client aanmaakt bij het starten
 * en verwijdert bij het afsluiten. Dit is de officiele, door Riot toegestane route
 * die ook Blitz, Porofessor en OP.GG gebruiken -- geen memory reading, geen injectie.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Agent, fetch as undiciFetch } from "undici";

const execFileAsync = promisify(execFile);

/** Standaard installatielocaties; de cmdline-fallback vangt afwijkende paden af. */
const DEFAULT_LOCKFILES = [
  "C:\Riot Games\League of Legends\lockfile",
  "C:\Program Files\Riot Games\League of Legends\lockfile",
  "C:\Program Files (x86)\Riot Games\League of Legends\lockfile",
];

export interface LcuCredentials {
  port: number;
  password: string;
  protocol: "https";
}

export class LcuNotRunningError extends Error {
  constructor() {
    super("League-client niet gevonden. Start de client en probeer opnieuw.");
    this.name = "LcuNotRunningError";
  }
}

/** Leest poort en wachtwoord uit het lockfile van de draaiende client. */
export async function findCredentials(): Promise<LcuCredentials> {
  for (const path of DEFAULT_LOCKFILES) {
    if (!existsSync(path)) continue;
    const [, , port, password] = (await readFile(path, "utf8")).trim().split(":");
    if (port && password) return { port: Number(port), password, protocol: "https" };
  }
  return findCredentialsViaProcess();
}

/**
 * Fallback voor niet-standaard installaties: de client start met --app-port en
 * --remoting-auth-token op de commandline, dus die lezen we uit het procesobject.
 */
async function findCredentialsViaProcess(): Promise<LcuCredentials> {
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "(Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\").CommandLine",
    ]);
    const port = /--app-port=(\d+)/.exec(stdout)?.[1];
    const token = /--remoting-auth-token=([\w-]+)/.exec(stdout)?.[1];
    if (port && token) return { port: Number(port), password: token, protocol: "https" };
  } catch {
    // powershell niet beschikbaar of proces bestaat niet -- val door naar de fout hieronder
  }
  throw new LcuNotRunningError();
}

/**
 * Dunne HTTP-client rond de LCU.
 *
 * Het certificaat van de client is self-signed en wisselt per installatie, dus
 * verificatie staat uit. Dat is veilig omdat we uitsluitend met 127.0.0.1 praten.
 */
export class LcuClient {
  private readonly agent: Agent;
  private readonly authHeader: string;

  constructor(private readonly creds: LcuCredentials) {
    this.agent = new Agent({ connect: { rejectUnauthorized: false } });
    this.authHeader = "Basic " + Buffer.from(`riot:${creds.password}`).toString("base64");
  }

  static async connect(): Promise<LcuClient> {
    return new LcuClient(await findCredentials());
  }

  get port(): number {
    return this.creds.port;
  }

  get password(): string {
    return this.creds.password;
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PATCH", path, body);
  }

  async delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  /** Zelfde als get(), maar geeft null terug op 404 in plaats van te gooien. */
  async tryGet<T>(path: string): Promise<T | null> {
    try {
      return await this.get<T>(path);
    } catch (err) {
      if (err instanceof LcuHttpError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * Haalt een binair bestand op, zoals een champion-icoon. De assets van de
   * client zitten achter dezelfde authenticatie als de rest van de API.
   */
  async getBinary(path: string): Promise<{ body: ArrayBuffer; contentType: string } | null> {
    const res = await undiciFetch(`https://127.0.0.1:${this.creds.port}${path}`, {
      dispatcher: this.agent,
      headers: { Authorization: this.authHeader },
    });
    if (!res.ok) return null;
    return {
      body: await res.arrayBuffer(),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await undiciFetch(`https://127.0.0.1:${this.creds.port}${path}`, {
      method,
      dispatcher: this.agent,
      headers: {
        Authorization: this.authHeader,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new LcuHttpError(method, path, res.status, await res.text());
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

export class LcuHttpError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${method} ${path} -> ${status}: ${body.slice(0, 200)}`);
    this.name = "LcuHttpError";
  }
}
