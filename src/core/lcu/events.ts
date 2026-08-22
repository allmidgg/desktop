/**
 * Live event-stream van de client.
 *
 * De LCU zendt elke wijziging van elke resource uit over een websocket. Dat is
 * hoe we merken dat champ select begint zonder elke seconde te pollen: we
 * abonneren ons op alles en filteren op de URI's die ons interesseren.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { LcuClient } from "./connector";

export interface LcuEvent<T = unknown> {
  uri: string;
  eventType: "Create" | "Update" | "Delete";
  data: T;
}

type Handler = (event: LcuEvent) => void;

interface Subscription {
  pattern: RegExp;
  handler: Handler;
}

/** WAMP-opcode waarmee de LCU-websocket abonnementen accepteert. */
const WAMP_SUBSCRIBE = 5;

export class LcuEventStream extends EventEmitter {
  private socket: WebSocket | null = null;
  private readonly subscriptions: Subscription[] = [];
  private closed = false;
  /** Zodat een socket die zowel foutmeldt als sluit maar één keer meldt. */
  private notifiedDisconnect = false;

  constructor(private readonly client: LcuClient) {
    super();
  }

  /**
   * Roept `handler` aan bij elke wijziging op een URI die matcht.
   *
   * @param pattern bijv. /lol-champ-select\/v1\/session/
   */
  on_(pattern: RegExp, handler: Handler): this {
    this.subscriptions.push({ pattern, handler });
    return this;
  }

  connect(): void {
    if (this.closed) return;
    const auth = Buffer.from(`riot:${this.client.password}`).toString("base64");
    const socket = new WebSocket(`wss://127.0.0.1:${this.client.port}/`, "wamp", {
      headers: { Authorization: `Basic ${auth}` },
      rejectUnauthorized: false,
    });
    this.socket = socket;

    socket.on("open", () => {
      socket.send(JSON.stringify([WAMP_SUBSCRIBE, "OnJsonApiEvent"]));
      this.emit("connected");
    });

    socket.on("message", (raw: Buffer) => {
      const text = raw.toString();
      if (!text) return; // de client stuurt af en toe lege frames als keep-alive
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      if (!Array.isArray(parsed) || parsed.length !== 3) return;
      const event = parsed[2] as LcuEvent;
      if (!event?.uri) return;
      for (const sub of this.subscriptions) {
        if (sub.pattern.test(event.uri)) {
          try {
            sub.handler(event);
          } catch (err) {
            this.emit("error", err);
          }
        }
      }
    });

    // De websocket valt weg zodra de speler de client afsluit.
    //
    // We proberen hier bewust *niet* zelf opnieuw te verbinden: bij een herstart
    // krijgt de client een nieuwe poort en een nieuw wachtwoord, dus opnieuw
    // verbinden met dezelfde gegevens kan per definitie niet lukken. De service
    // leest het lockfile opnieuw en bouwt een verse stream.
    socket.on("close", () => this.handleDisconnect());

    // Een geweigerde verbinding is hier normaal, geen uitzondering. Zonder deze
    // afhandeling zou een EventEmitter zijn 'error' doorgooien en daarmee het
    // hele main-proces omleggen.
    socket.on("error", (err) => {
      if (this.listenerCount("error") > 0) this.emit("error", err);
      this.handleDisconnect();
    });
  }

  private handleDisconnect(): void {
    this.socket = null;
    if (this.closed || this.notifiedDisconnect) return;
    this.notifiedDisconnect = true;
    this.emit("disconnected");
  }

  close(): void {
    this.closed = true;
    this.socket?.removeAllListeners();
    this.socket?.close();
    this.socket = null;
  }
}
