import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { Channel, RelayStatus, SubscribeRequest } from "../shared/wire.ts";
import type { Backend } from "./backend.ts";

const CHANNELS: ReadonlySet<Channel> = new Set(["INSTRUMENT", "EBBO", "DEPTH", "TRADE", "AUCTION", "INDEX", "DROPCOPY", "HEARTBEAT"]);

// Serves /ws to the browser. Each browser socket gets its own exchange connection; the browser
// sends unsigned SUBSCRIBE requests and the backend signs them, so credentials stay on the server.
// Exchange messages are passed through untouched.
export function attachRelay(server: Server, backend: Backend): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    const status = (s: RelayStatus) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(s));
    const feed = backend.openFeed({
      message: (text) => {
        if (ws.readyState === ws.OPEN) ws.send(text);
      },
      closed: (reason) => {
        status({ channel: "RELAY", status: "upstream_closed", message: reason });
        ws.close(1011, "upstream closed");
      },
    });
    status({ channel: "RELAY", status: "connected" });

    ws.on("message", (data) => {
      const req = parse(data.toString());
      if (!req) {
        status({ channel: "RELAY", status: "error", message: "expected { type: SUBSCRIBE|UNSUBSCRIBE, channels: [...], item_names: [...] }" });
        return;
      }
      feed.subscribe(req);
    });
    ws.on("close", () => feed.close());
    ws.on("error", () => feed.close());
  });

  return wss;
}

function parse(text: string): SubscribeRequest | undefined {
  try {
    const m = JSON.parse(text) as Partial<SubscribeRequest>;
    if (m.type !== "SUBSCRIBE" && m.type !== "UNSUBSCRIBE") return undefined;
    if (!Array.isArray(m.channels) || !m.channels.every((c) => CHANNELS.has(c))) return undefined;
    const items = Array.isArray(m.item_names) ? m.item_names.filter((i): i is string => typeof i === "string") : [];
    return { type: m.type, channels: m.channels, item_names: items };
  } catch {
    return undefined;
  }
}
