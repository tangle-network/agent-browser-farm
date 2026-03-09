import { Backend, BackendSession, BrowserType, DESKTOP_BROWSERS, PoolStatus } from "./types.js";
import { log } from "../log.js";

/**
 * Browserless backend for desktop browsers (Chrome, Firefox, WebKit).
 *
 * Browserless v2 exposes Playwright-compatible WS endpoints:
 *   ws://host:3000/chromium/playwright
 *   ws://host:3000/firefox/playwright
 *   ws://host:3000/webkit/playwright
 *
 * Each WS connection is a fresh browser context with isolated profile.
 * Browserless handles process management, cleanup, and crash recovery.
 *
 * We don't create/track sessions via REST — each WS connection IS the session.
 * Our allocator tracks the mapping and proxies the WS connection.
 */
export class BrowserlessBackend implements Backend {
  readonly id: string;
  readonly type = "browserless";
  readonly supports: ReadonlySet<BrowserType> = DESKTOP_BROWSERS;

  private baseUrl: string;
  private wsBaseUrl: string;
  private token: string;
  private activeSessions = new Map<string, { browser: BrowserType; wsEndpoint: string }>();

  constructor(opts: { url: string; token?: string; id?: string }) {
    this.id = opts.id || `browserless-${crypto.randomUUID().slice(0, 8)}`;
    this.baseUrl = opts.url.replace(/\/$/, "");
    this.wsBaseUrl = this.baseUrl.replace(/^http/, "ws");
    this.token = opts.token || "";
  }

  private browserPath(browser: BrowserType): string {
    switch (browser) {
      case "chrome": return "chromium";
      case "firefox": return "firefox";
      case "webkit": return "webkit";
      default: throw new Error(`Unsupported browser: ${browser}`);
    }
  }

  async createSession(opts: { browser: BrowserType; headless?: boolean }): Promise<BackendSession> {
    const path = this.browserPath(opts.browser);
    const params = new URLSearchParams();
    if (this.token) params.set("token", this.token);
    if (opts.headless === false) params.set("headless", "false");

    const qs = params.toString();
    const wsEndpoint = `${this.wsBaseUrl}/${path}/playwright${qs ? `?${qs}` : ""}`;

    const backendId = crypto.randomUUID();
    this.activeSessions.set(backendId, { browser: opts.browser, wsEndpoint });

    log.info("browserless: session created", { backendId, browser: opts.browser, wsEndpoint });

    return { backendId, wsEndpoint, backendType: this.type };
  }

  async destroySession(backendId: string): Promise<void> {
    const session = this.activeSessions.get(backendId);
    if (!session) return;
    this.activeSessions.delete(backendId);
    log.info("browserless: session destroyed", { backendId });
    // Browserless auto-cleans when the WS connection closes.
    // The proxy layer handles closing the upstream WS.
  }

  async status(): Promise<PoolStatus> {
    try {
      const url = this.token ? `${this.baseUrl}/pressure?token=${this.token}` : `${this.baseUrl}/pressure`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) {
        return { capacity: 0, active: this.activeSessions.size, backend: this.type, healthy: false };
      }
      // Pressure endpoint returns { cpu, memory, queued, recentlyCreated, date, isAvailable }
      const data = await res.json() as { isAvailable: boolean };
      // Also fetch config for capacity info
      const configUrl = this.token ? `${this.baseUrl}/config?token=${this.token}` : `${this.baseUrl}/config`;
      const configRes = await fetch(configUrl, { signal: AbortSignal.timeout(5000) });
      const configData = configRes.ok ? (await configRes.json() as { concurrent: number }) : { concurrent: 10 };
      return {
        capacity: configData.concurrent || 10,
        active: this.activeSessions.size,
        backend: this.type,
        healthy: data.isAvailable !== false,
      };
    } catch {
      return { capacity: 0, active: this.activeSessions.size, backend: this.type, healthy: false };
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = this.token ? `${this.baseUrl}/pressure?token=${this.token}` : `${this.baseUrl}/pressure`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return false;
      const data = await res.json() as { isAvailable: boolean };
      return data.isAvailable !== false;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    this.activeSessions.clear();
    log.info("browserless: shutdown");
  }
}
