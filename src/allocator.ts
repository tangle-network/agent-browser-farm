import { config } from "./config.js";
import { log } from "./log.js";
import { Backend, BrowserType } from "./backends/types.js";

/** Session record tracked by the allocator */
export interface Session {
  id: string;
  browser: BrowserType;
  clientId: string;
  token: string;
  backendId: string;
  backendType: string;
  /** Which registered backend instance owns this session */
  registryId: string;
  /** WS endpoint for CDP/Playwright browsers (desktop + Android) */
  wsEndpoint?: string;
  /** WebDriver HTTP URL for Appium-backed sessions (iOS Safari) */
  webdriverUrl?: string;
  /** WebDriver session ID for Appium sessions */
  webdriverSessionId?: string;
  createdAt: number;
  expiresAt: number;
  lastActivity: number;
}

export interface CreateSessionRequest {
  browser: BrowserType;
  device?: string;
  headless?: boolean;
  timeout?: number;
  clientId?: string;
}

export interface CreateSessionResponse {
  sessionId: string;
  browser: BrowserType;
  token: string;
  expiresAt: string;
  /** WS endpoint for CDP/Playwright browsers — use with playwright.connect() or connectOverCDP() */
  wsEndpoint?: string;
  /** WebDriver HTTP URL for Appium sessions — use with Selenium/WebDriver client */
  webdriverUrl?: string;
  /** WebDriver session ID (for direct Appium interaction) */
  webdriverSessionId?: string;
}

export interface AllocatorOptions {
  maxSessions?: number;
  maxPerClient?: number;
  defaultTimeout?: number;
  idleTimeout?: number;
  reaperInterval?: number;
  healthCheckInterval?: number;
}

export interface BackendInfo {
  id: string;
  type: string;
  supports: string[];
  healthy: boolean;
}

/**
 * Allocator — the core brain.
 *
 * Routes session requests to the right backend, enforces per-client limits,
 * tracks session lifecycle, auto-reaps expired/idle sessions, monitors
 * backend health.
 */
export class Allocator {
  private sessions = new Map<string, Session>();
  private backends = new Map<string, Backend>();
  private backendHealth = new Map<string, boolean>();
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private opts: Required<AllocatorOptions>;

  constructor(opts?: AllocatorOptions) {
    this.opts = {
      maxSessions: opts?.maxSessions ?? config.maxSessions,
      maxPerClient: opts?.maxPerClient ?? config.maxPerClient,
      defaultTimeout: opts?.defaultTimeout ?? config.defaultTimeout,
      idleTimeout: opts?.idleTimeout ?? config.idleTimeout,
      reaperInterval: opts?.reaperInterval ?? config.reaperInterval,
      healthCheckInterval: opts?.healthCheckInterval ?? config.healthCheckInterval,
    };
  }

  /** Register a backend. Returns its ID. */
  addBackend(backend: Backend): string {
    this.backends.set(backend.id, backend);
    this.backendHealth.set(backend.id, true); // assume healthy until checked
    log.info("allocator: backend registered", { id: backend.id, type: backend.type });
    return backend.id;
  }

  /** Remove a backend by ID. Throws if it has active sessions. */
  removeBackend(id: string): void {
    const backend = this.backends.get(id);
    if (!backend) throw new AllocatorError("Backend not found", 404);

    const activeSessions = [...this.sessions.values()].filter((s) => s.registryId === id);
    if (activeSessions.length > 0) {
      throw new AllocatorError(`Backend '${id}' has ${activeSessions.length} active sessions`, 409);
    }

    this.backends.delete(id);
    this.backendHealth.delete(id);
    log.info("allocator: backend removed", { id, type: backend.type });
  }

  /** List all registered backends with health status. */
  listBackends(): BackendInfo[] {
    return [...this.backends.entries()].map(([id, b]) => ({
      id,
      type: b.type,
      supports: [...b.supports],
      healthy: this.backendHealth.get(id) ?? false,
    }));
  }

  /** Start the reaper and health check loops. */
  start(): void {
    this.reaperTimer = setInterval(() => this.reap(), this.opts.reaperInterval * 1000);
    this.healthTimer = setInterval(() => this.checkHealth(), this.opts.healthCheckInterval * 1000);
    log.info("allocator: started", {
      reaperInterval: this.opts.reaperInterval,
      healthCheckInterval: this.opts.healthCheckInterval,
    });
  }

  /** Graceful shutdown — destroy all sessions, stop timers. */
  async shutdown(): Promise<void> {
    if (this.reaperTimer) { clearInterval(this.reaperTimer); this.reaperTimer = null; }
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }

    const destroyPromises = [...this.sessions.values()].map((s) =>
      this.destroySession(s.id).catch((err) =>
        log.error("allocator: error destroying session during shutdown", { sessionId: s.id, error: String(err) })
      )
    );
    await Promise.all(destroyPromises);

    for (const backend of this.backends.values()) {
      await backend.shutdown();
    }
    log.info("allocator: shutdown complete");
  }

  /** Create a new browser session. */
  async createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
    const clientId = req.clientId || "anonymous";
    const browser = req.browser;
    const timeout = req.timeout || this.opts.defaultTimeout;

    if (this.sessions.size >= this.opts.maxSessions) {
      throw new AllocatorError("Global session limit reached", 429);
    }

    const clientCount = this.countClientSessions(clientId);
    if (clientCount >= this.opts.maxPerClient) {
      throw new AllocatorError(`Client '${clientId}' has reached max concurrent sessions (${this.opts.maxPerClient})`, 429);
    }

    const backend = this.findBackend(browser);
    if (!backend) {
      throw new AllocatorError(`No backend available for browser '${browser}'`, 503);
    }

    const backendSession = await backend.createSession({
      browser,
      headless: req.headless,
      device: req.device,
    });

    const now = Date.now();
    const sessionId = `bf-${crypto.randomUUID().slice(0, 8)}`;
    const token = crypto.randomUUID();

    const session: Session = {
      id: sessionId,
      browser,
      clientId,
      token,
      backendId: backendSession.backendId,
      backendType: backendSession.backendType,
      registryId: backend.id,
      wsEndpoint: backendSession.wsEndpoint,
      webdriverUrl: backendSession.webdriverUrl,
      webdriverSessionId: backendSession.webdriverSessionId,
      createdAt: now,
      expiresAt: now + timeout * 1000,
      lastActivity: now,
    };

    this.sessions.set(sessionId, session);
    log.info("allocator: session created", { sessionId, browser, clientId, backendId: backend.id });

    const response: CreateSessionResponse = {
      sessionId,
      browser,
      token,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };

    // WS-based sessions (desktop + Android) get a proxy endpoint
    if (backendSession.wsEndpoint) {
      response.wsEndpoint = `/session/${sessionId}`;
    }

    // WebDriver sessions (iOS Safari) get direct Appium URL + session ID
    if (backendSession.webdriverUrl) {
      response.webdriverUrl = backendSession.webdriverUrl;
      response.webdriverSessionId = backendSession.webdriverSessionId;
    }

    return response;
  }

  /** Destroy a session. */
  async destroySession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);

    const backend = this.backends.get(session.registryId);
    if (backend) {
      try {
        await backend.destroySession(session.backendId);
      } catch (err) {
        log.error("allocator: backend destroy failed", { sessionId, error: String(err) });
      }
    }

    log.info("allocator: session destroyed", { sessionId, clientId: session.clientId });
  }

  /** Get a session by ID. */
  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /** Validate a session token. */
  validateToken(sessionId: string, token: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.token === token;
  }

  /** Update last activity timestamp (called on WS proxy activity). */
  touchSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.lastActivity = Date.now();
  }

  /** List all sessions, optionally filtered by clientId. */
  listSessions(clientId?: string): Session[] {
    const all = [...this.sessions.values()];
    return clientId ? all.filter((s) => s.clientId === clientId) : all;
  }

  /** Health status across all backends. */
  async health(): Promise<Record<string, { capacity: number; active: number; backend: string; healthy: boolean }>> {
    const result: Record<string, { capacity: number; active: number; backend: string; healthy: boolean }> = {};
    for (const [id, backend] of this.backends) {
      result[id] = await backend.status();
    }
    return result;
  }

  /** Reap expired and idle sessions. */
  private async reap(): Promise<void> {
    const now = Date.now();
    const toReap: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now > session.expiresAt) {
        log.info("reaper: session expired", { sessionId: id });
        toReap.push(id);
      } else if (now - session.lastActivity > this.opts.idleTimeout * 1000) {
        log.info("reaper: session idle", { sessionId: id, idleSeconds: Math.round((now - session.lastActivity) / 1000) });
        toReap.push(id);
      }
    }

    for (const id of toReap) {
      await this.destroySession(id).catch((err) =>
        log.error("reaper: destroy failed", { sessionId: id, error: String(err) })
      );
    }

    if (toReap.length > 0) {
      log.info("reaper: sweep complete", { reaped: toReap.length, remaining: this.sessions.size });
    }
  }

  /** Check health of all backends periodically. */
  private async checkHealth(): Promise<void> {
    for (const [id, backend] of this.backends) {
      const wasHealthy = this.backendHealth.get(id) ?? true;
      try {
        const healthy = await backend.healthCheck();
        this.backendHealth.set(id, healthy);
        if (wasHealthy && !healthy) {
          log.warn("health: backend became unhealthy", { id, type: backend.type });
        } else if (!wasHealthy && healthy) {
          log.info("health: backend recovered", { id, type: backend.type });
        }
      } catch {
        this.backendHealth.set(id, false);
        if (wasHealthy) {
          log.warn("health: backend check failed", { id, type: backend.type });
        }
      }
    }
  }

  private countClientSessions(clientId: string): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.clientId === clientId) count++;
    }
    return count;
  }

  /** Find a healthy backend that supports this browser. Falls back to unhealthy if none healthy. */
  private findBackend(browser: BrowserType): Backend | undefined {
    let fallback: Backend | undefined;
    for (const [id, backend] of this.backends) {
      if (!backend.supports.has(browser)) continue;
      if (this.backendHealth.get(id)) return backend;
      if (!fallback) fallback = backend;
    }
    return fallback;
  }
}

export class AllocatorError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = "AllocatorError";
  }
}
