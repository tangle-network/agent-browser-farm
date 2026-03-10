import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Server } from "node:http";
import { config } from "./config.js";
import { log } from "./log.js";
import { Allocator, AllocatorError, type CreateSessionRequest } from "./allocator.js";
import { SessionProxy } from "./proxy.js";
import { BrowserlessBackend } from "./backends/browserless.js";
import { PlaywrightBackend } from "./backends/playwright.js";
import { AndroidBackend } from "./backends/android.js";
import { AndroidDeviceBackend } from "./backends/android-device.js";
import { IosSafariBackend } from "./backends/ios-safari.js";
import { IosDeviceBackend } from "./backends/ios-device.js";
import { SafariDesktopBackend } from "./backends/safari-desktop.js";
import type { Backend, BrowserType } from "./backends/types.js";
import { captureScreenshot, ScreenshotError } from "./screenshot.js";

export interface AppOptions {
  port?: number;
  /** Inject an allocator (for testing). If omitted, one is created with default config. */
  allocator?: Allocator;
  /** Backends to register. If omitted, creates a Browserless backend from env config. */
  backends?: Backend[];
}

export interface AppInstance {
  app: Hono;
  server: Server;
  allocator: Allocator;
  proxy: SessionProxy;
  /** Actual port the server is listening on (useful when port=0). */
  port: number;
  shutdown: () => Promise<void>;
}

const VALID_BROWSERS = new Set<string>(["chrome", "firefox", "webkit", "safari", "ios-safari", "android-chrome"]);

/**
 * Create and start the farm server. Pure factory — no side effects on import.
 */
export function createApp(opts?: AppOptions): AppInstance {
  const allocator = opts?.allocator ?? new Allocator();
  const proxy = new SessionProxy(allocator);

  // Register backends
  if (opts?.backends) {
    for (const b of opts.backends) allocator.addBackend(b);
  } else {
    allocator.addBackend(new BrowserlessBackend({
      url: config.browserlessUrl,
      token: config.browserlessToken,
    }));
  }

  const app = new Hono();

  // --- Auth middleware ---

  const requireAuth = (c: any, next: () => Promise<void>): Promise<Response | void> => {
    if (!config.apiToken) return next();
    const auth = c.req.header("authorization");
    if (auth === `Bearer ${config.apiToken}`) return next();
    return c.json({ error: "Unauthorized" }, 401) as any;
  };

  // --- Routes ---

  app.get("/health", async (c) => {
    const pools = await allocator.health();
    return c.json({ pools });
  });

  app.post("/sessions", requireAuth, async (c) => {
    try {
      const body = await c.req.json<CreateSessionRequest>();

      if (!body.browser || !VALID_BROWSERS.has(body.browser)) {
        return c.json({ error: `Invalid browser. Must be one of: ${[...VALID_BROWSERS].join(", ")}` }, 400);
      }

      const result = await allocator.createSession({
        browser: body.browser as BrowserType,
        device: body.device,
        headless: body.headless,
        timeout: body.timeout,
        clientId: body.clientId,
        wsRequired: body.wsRequired,
      });

      // Construct full WS URL for WS-based sessions
      if (result.wsEndpoint) {
        const host = c.req.header("host") || `localhost:${port}`;
        const protocol = c.req.header("x-forwarded-proto") === "https" ? "wss" : "ws";
        result.wsEndpoint = `${protocol}://${host}${result.wsEndpoint}?token=${result.token}`;
      }

      return c.json(result, 201);
    } catch (err) {
      if (err instanceof AllocatorError) {
        return c.json({ error: err.message }, err.status as any);
      }
      log.error("POST /sessions error", { error: String(err) });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  app.get("/sessions", requireAuth, async (c) => {
    const clientId = c.req.query("clientId");
    const sessions = allocator.listSessions(clientId).map(formatSession);
    return c.json({ sessions });
  });

  app.get("/sessions/:id", requireAuth, async (c) => {
    const session = allocator.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    return c.json(formatSession(session));
  });

  app.delete("/sessions/:id", requireAuth, async (c) => {
    const session = allocator.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);
    await allocator.destroySession(session.id);
    return c.json({ ok: true });
  });

  app.get("/sessions/:id/screenshot", requireAuth, async (c) => {
    const session = allocator.getSession(c.req.param("id"));
    if (!session) return c.json({ error: "Session not found" }, 404);

    try {
      const png = await captureScreenshot(session);
      allocator.touchSession(session.id);
      const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
      return new Response(ab, {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(png.byteLength),
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      if (err instanceof ScreenshotError) {
        return c.json({ error: err.message }, err.status as any);
      }
      log.error("GET /sessions/:id/screenshot error", { sessionId: session.id, error: String(err) });
      return c.json({ error: "Screenshot failed" }, 500);
    }
  });

  // --- Backend registry ---

  app.get("/backends", requireAuth, async (c) => {
    return c.json({ backends: allocator.listBackends() });
  });

  app.post("/backends", requireAuth, async (c) => {
    try {
      const body = await c.req.json<{ type: string; url: string; token?: string; id?: string }>();

      if (!body.type) {
        return c.json({ error: "Missing required field: type" }, 400);
      }

      let backend: Backend;
      switch (body.type) {
        case "browserless":
          backend = new BrowserlessBackend({ url: body.url, token: body.token, id: body.id });
          break;
        case "playwright":
          backend = new PlaywrightBackend({ id: body.id });
          break;
        case "android":
          backend = new AndroidBackend({
            id: body.id,
            avdName: (body as any).avdName,
            capacity: (body as any).capacity,
          });
          break;
        case "ios-safari":
          backend = new IosSafariBackend({
            id: body.id,
            appiumUrl: body.url,
            templateUdid: (body as any).templateUdid,
            templates: (body as any).templates,
            capacity: (body as any).capacity,
          });
          break;
        case "safari-desktop":
          backend = new SafariDesktopBackend({
            id: body.id,
            capacity: (body as any).capacity,
            basePort: (body as any).basePort,
          });
          break;
        case "android-device":
          backend = new AndroidDeviceBackend({
            id: body.id,
            devices: (body as any).devices,
            cdpStartPort: (body as any).cdpStartPort,
          });
          break;
        case "ios-device":
          backend = new IosDeviceBackend({
            id: body.id,
            appiumUrl: body.url,
            devices: (body as any).devices,
            xcodeOrgId: (body as any).xcodeOrgId,
            xcodeSigningId: (body as any).xcodeSigningId,
          });
          break;
        default:
          return c.json({ error: `Unsupported backend type: ${body.type}` }, 400);
      }

      const id = allocator.addBackend(backend);
      return c.json({ id, type: backend.type, supports: [...backend.supports] }, 201);
    } catch (err) {
      log.error("POST /backends error", { error: String(err) });
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  app.delete("/backends/:id", requireAuth, async (c) => {
    try {
      allocator.removeBackend(c.req.param("id"));
      return c.body(null, 204);
    } catch (err) {
      if (err instanceof AllocatorError) {
        return c.json({ error: err.message }, err.status as any);
      }
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // --- Start ---

  const requestedPort = opts?.port ?? config.port;
  const server = serve({ fetch: app.fetch, port: requestedPort }) as Server;

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : requestedPort;

  log.info(`browser-farm listening on :${port}`);

  // WS upgrade
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    proxy.handleUpgrade(req, socket, head);
  });

  allocator.start();

  const shutdown = async () => {
    log.info("Shutting down...");
    await proxy.shutdown();
    await allocator.shutdown();
    server.close();
  };

  return { app, server, allocator, proxy, port, shutdown };
}

// --- Helpers ---

function formatSession(s: {
  id: string; browser: BrowserType; clientId: string; backendType: string;
  createdAt: number; expiresAt: number; lastActivity: number;
  webdriverUrl?: string; webdriverSessionId?: string;
}) {
  return {
    sessionId: s.id,
    browser: s.browser,
    clientId: s.clientId,
    backendType: s.backendType,
    createdAt: new Date(s.createdAt).toISOString(),
    expiresAt: new Date(s.expiresAt).toISOString(),
    idleSeconds: Math.round((Date.now() - s.lastActivity) / 1000),
    ...(s.webdriverUrl && { webdriverUrl: s.webdriverUrl }),
    ...(s.webdriverSessionId && { webdriverSessionId: s.webdriverSessionId }),
  };
}
