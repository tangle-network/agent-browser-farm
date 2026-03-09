import { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { Allocator } from "./allocator.js";
import { log } from "./log.js";

const MAX_PENDING = 128;

/**
 * Thin WebSocket relay.
 *
 * Maps: ws://farm/session/{id}?token={token} → backend WS endpoint
 *
 * - Validates session exists and token matches
 * - Opens upstream WS to the backend (Browserless)
 * - Buffers client messages until upstream is connected
 * - Relays frames bidirectionally
 * - On either side close/error → closes both + triggers session cleanup (once)
 * - Touches session on activity for idle timeout tracking
 */
export class SessionProxy {
  private wss: WebSocketServer;
  private allocator: Allocator;
  private connections = new Map<string, { client: WebSocket; upstream: WebSocket }>();

  constructor(allocator: Allocator) {
    this.allocator = allocator;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", this.handleConnection.bind(this));
  }

  /** Handle HTTP upgrade — extract session ID, validate, then upgrade. */
  handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
    const url = new URL(req.url || "/", "http://localhost");
    const match = url.pathname.match(/^\/session\/([^/]+)$/);

    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const sessionId = match[1];
    const token = url.searchParams.get("token") || req.headers["authorization"]?.replace("Bearer ", "");

    if (!token || !this.allocator.validateToken(sessionId, token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit("connection", ws, req, sessionId);
    });
  }

  private handleConnection(client: WebSocket, _req: IncomingMessage, sessionId: string): void {
    const session = this.allocator.getSession(sessionId);
    if (!session) {
      client.close(4004, "Session not found");
      return;
    }

    if (!session.wsEndpoint) {
      client.close(4005, "Session is WebDriver-based, not WebSocket. Use the webdriverUrl instead.");
      return;
    }

    log.info("proxy: client connected", { sessionId });

    const upstream = new WebSocket(session.wsEndpoint);
    this.connections.set(sessionId, { client, upstream });

    // Buffer client messages until upstream is ready
    let pending: { data: any; isBinary: boolean }[] | null = [];
    let cleaned = false;

    upstream.on("open", () => {
      log.debug("proxy: upstream connected", { sessionId });
      // Flush buffered messages
      if (pending) {
        for (const msg of pending) {
          upstream.send(msg.data, { binary: msg.isBinary });
        }
        pending = null;
      }
    });

    // Relay: upstream → client
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
        this.allocator.touchSession(sessionId);
      }
    });

    // Relay: client → upstream (with buffering)
    client.on("message", (data, isBinary) => {
      this.allocator.touchSession(sessionId);
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
      } else if (pending) {
        if (pending.length >= MAX_PENDING) {
          log.warn("proxy: pending buffer full, dropping client", { sessionId });
          client.close(4008, "Buffer overflow");
          return;
        }
        pending.push({ data, isBinary });
      }
    });

    // Run-once cleanup
    const cleanup = (source: string) => {
      if (cleaned) return;
      cleaned = true;
      pending = null;

      log.info("proxy: disconnected", { sessionId, source });
      this.connections.delete(sessionId);

      if (client.readyState !== WebSocket.CLOSED) client.close();
      if (upstream.readyState !== WebSocket.CLOSED) upstream.close();

      this.allocator.destroySession(sessionId).catch((err) =>
        log.error("proxy: session destroy failed", { sessionId, error: String(err) })
      );
    };

    client.on("close", () => cleanup("client"));
    client.on("error", (err) => {
      log.error("proxy: client error", { sessionId, error: String(err) });
      cleanup("client-error");
    });

    upstream.on("close", () => cleanup("upstream"));
    upstream.on("error", (err) => {
      log.error("proxy: upstream error", { sessionId, error: String(err) });
      cleanup("upstream-error");
    });
  }

  /** Graceful shutdown — close all proxy connections. */
  async shutdown(): Promise<void> {
    for (const [sessionId, { client, upstream }] of this.connections) {
      log.info("proxy: closing connection on shutdown", { sessionId });
      if (client.readyState !== WebSocket.CLOSED) client.close(1001, "Server shutting down");
      if (upstream.readyState !== WebSocket.CLOSED) upstream.close(1001, "Server shutting down");
    }
    this.connections.clear();
    this.wss.close();
    log.info("proxy: shutdown complete");
  }
}
