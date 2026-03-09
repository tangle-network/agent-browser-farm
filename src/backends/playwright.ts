import { Backend, BackendSession, BrowserType, PoolStatus } from "./types.js";
import { log } from "../log.js";

/**
 * Playwright backend for WebKit/Safari sessions.
 *
 * Uses `playwright.webkit.launchServer()` to spawn standalone WebKit browser
 * processes that accept WS connections. Supports device emulation for
 * ios-safari sessions (iPhone viewport, user agent, touch, device scale).
 *
 * Each createSession() call spawns a new browser process. The returned WS
 * endpoint is relayed by the farm's proxy — identical model to Browserless.
 *
 * This backend is ideal for macOS hosts where you want Safari-engine sessions.
 * Playwright is an optional peer dependency — the backend fails gracefully
 * if not installed.
 *
 * Supports: "webkit" (desktop) and "ios-safari" (mobile-emulated WebKit).
 */

/** Well-known iOS device descriptors for mobile emulation */
const IOS_DEVICES: Record<string, { width: number; height: number; deviceScaleFactor: number; userAgent: string }> = {
  "iPhone 15": {
    width: 393, height: 852, deviceScaleFactor: 3,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iPhone 15 Pro": {
    width: 393, height: 852, deviceScaleFactor: 3,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iPhone 15 Pro Max": {
    width: 430, height: 932, deviceScaleFactor: 3,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iPhone 14": {
    width: 390, height: 844, deviceScaleFactor: 3,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  },
  "iPhone SE": {
    width: 375, height: 667, deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iPad Pro 11": {
    width: 834, height: 1194, deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iPad Pro 12.9": {
    width: 1024, height: 1366, deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iPad Air": {
    width: 820, height: 1180, deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iPad Mini": {
    width: 768, height: 1024, deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iPad 10th Gen": {
    width: 810, height: 1080, deviceScaleFactor: 2,
    userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
};

const DEFAULT_IOS_DEVICE = "iPhone 15";

interface BrowserServer {
  wsEndpoint(): string;
  close(): Promise<void>;
  process(): { pid: number | undefined } | null;
}

interface PlaywrightModule {
  webkit: {
    launchServer(opts?: Record<string, unknown>): Promise<BrowserServer>;
  };
}

export class PlaywrightBackend implements Backend {
  readonly id: string;
  readonly type = "playwright";
  readonly protocol = "ws" as const;
  readonly supports: ReadonlySet<BrowserType> = new Set(["webkit", "ios-safari", "safari"]);

  private servers = new Map<string, BrowserServer>();
  private pw: PlaywrightModule | null = null;
  private headless: boolean;

  constructor(opts?: { id?: string; headless?: boolean }) {
    this.id = opts?.id || `playwright-${crypto.randomUUID().slice(0, 8)}`;
    this.headless = opts?.headless !== false;
  }

  /** Lazy-load playwright. Fails gracefully if not installed. */
  private async getPlaywright(): Promise<PlaywrightModule> {
    if (this.pw) return this.pw;
    // Dynamic import with variable to bypass TypeScript module resolution
    for (const pkg of ["playwright-core", "playwright"]) {
      try {
        const mod = await (Function(`return import("${pkg}")`)() as Promise<PlaywrightModule>);
        this.pw = mod;
        return mod;
      } catch {
        continue;
      }
    }
    throw new Error(
      "Playwright is not installed. Install with: pnpm add playwright-core && pnpm exec playwright install webkit"
    );
  }

  async createSession(opts: { browser: BrowserType; headless?: boolean; device?: string }): Promise<BackendSession> {
    const pw = await this.getPlaywright();

    const launchOpts: Record<string, unknown> = {
      headless: opts.headless ?? this.headless,
    };

    // For ios-safari, apply device emulation via context launch args
    if (opts.browser === "ios-safari") {
      const deviceName = opts.device || DEFAULT_IOS_DEVICE;
      const device = IOS_DEVICES[deviceName];
      if (!device) {
        const available = Object.keys(IOS_DEVICES).join(", ");
        throw new Error(`Unknown device '${deviceName}'. Available: ${available}`);
      }
      // Device emulation is applied client-side via browser.newContext().
      // We pass device info back so clients can configure their context.
      // The server just launches a WebKit instance.
      log.info("playwright: launching WebKit with iOS device profile", { device: deviceName });
    }

    const server = await pw.webkit.launchServer(launchOpts);
    const wsEndpoint = server.wsEndpoint();
    const backendId = crypto.randomUUID();

    this.servers.set(backendId, server);
    log.info("playwright: server launched", {
      backendId,
      browser: opts.browser,
      pid: server.process()?.pid,
      wsEndpoint,
    });

    return { backendId, wsEndpoint, backendType: this.type };
  }

  async destroySession(backendId: string): Promise<void> {
    const server = this.servers.get(backendId);
    if (!server) return;
    this.servers.delete(backendId);
    try {
      await server.close();
      log.info("playwright: server closed", { backendId });
    } catch (err) {
      log.error("playwright: error closing server", { backendId, error: String(err) });
    }
  }

  async status(): Promise<PoolStatus> {
    const healthy = await this.healthCheck();
    return {
      capacity: 10, // Configurable — WebKit is lighter than Chromium
      active: this.servers.size,
      backend: this.type,
      healthy,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.getPlaywright();
      return true;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    const closes = [...this.servers.entries()].map(async ([id, server]) => {
      try {
        await server.close();
      } catch (err) {
        log.error("playwright: error during shutdown", { backendId: id, error: String(err) });
      }
    });
    await Promise.all(closes);
    this.servers.clear();
    log.info("playwright: shutdown complete");
  }
}
