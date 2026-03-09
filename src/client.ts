/**
 * Zero-dependency client SDK for agent-browser-farm.
 *
 * Works in Node.js, Deno, Bun, and browsers. Uses native fetch + WebSocket.
 *
 * Usage:
 *   import { BrowserFarmClient } from 'agent-browser-farm/client';
 *   const client = new BrowserFarmClient('http://localhost:9222', { token: '...' });
 *
 *   // Desktop Chrome via CDP
 *   const session = await client.createSession({ browser: 'chrome' });
 *   const browser = await playwright.chromium.connectOverCDP(session.wsEndpoint!);
 *
 *   // iOS Safari via WebDriver
 *   const ios = await client.createSession({ browser: 'ios-safari', device: 'iPhone 15' });
 *   // Use ios.webdriverUrl + ios.webdriverSessionId with Selenium/WebDriver client
 *
 *   await client.destroySession(session.sessionId);
 */

export interface CreateSessionOpts {
  browser: "chrome" | "firefox" | "webkit" | "safari" | "ios-safari" | "android-chrome";
  device?: string;
  headless?: boolean;
  timeout?: number;
  clientId?: string;
}

export interface SessionInfo {
  sessionId: string;
  browser: string;
  token: string;
  expiresAt: string;
  /** WebSocket endpoint — connect with Playwright or CDP client */
  wsEndpoint?: string;
  /** WebDriver HTTP URL — connect with Selenium/WebDriver client */
  webdriverUrl?: string;
  /** WebDriver session ID for direct Appium/safaridriver interaction */
  webdriverSessionId?: string;
}

export interface SessionDetails {
  sessionId: string;
  browser: string;
  clientId: string;
  backendType: string;
  createdAt: string;
  expiresAt: string;
  idleSeconds: number;
  webdriverUrl?: string;
  webdriverSessionId?: string;
}

export interface BackendInfo {
  id: string;
  type: string;
  supports: string[];
  healthy: boolean;
}

export interface HealthStatus {
  pools: Record<string, {
    capacity: number;
    active: number;
    backend: string;
    healthy: boolean;
  }>;
}

export class BrowserFarmClient {
  private baseUrl: string;
  private token?: string;

  constructor(baseUrl: string, opts?: { token?: string }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = opts?.token;
  }

  /** Create a new browser session. */
  async createSession(opts: CreateSessionOpts): Promise<SessionInfo> {
    return this.post<SessionInfo>("/sessions", opts);
  }

  /** Get session details by ID. */
  async getSession(sessionId: string): Promise<SessionDetails> {
    return this.get<SessionDetails>(`/sessions/${sessionId}`);
  }

  /** List active sessions, optionally filtered by clientId. */
  async listSessions(clientId?: string): Promise<SessionDetails[]> {
    const qs = clientId ? `?clientId=${encodeURIComponent(clientId)}` : "";
    const res = await this.get<{ sessions: SessionDetails[] }>(`/sessions${qs}`);
    return res.sessions;
  }

  /** Destroy a session. */
  async destroySession(sessionId: string): Promise<void> {
    await this.del(`/sessions/${sessionId}`);
  }

  /** Health check — returns pool status for all backends. */
  async health(): Promise<HealthStatus> {
    return this.get<HealthStatus>("/health");
  }

  /** List registered backends. */
  async listBackends(): Promise<BackendInfo[]> {
    const res = await this.get<{ backends: BackendInfo[] }>("/backends");
    return res.backends;
  }

  // --- Internal ---

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new BrowserFarmError(`GET ${path} failed: ${res.status}`, res.status, body);
    }
    return res.json() as Promise<T>;
  }

  private async post<T>(path: string, data: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new BrowserFarmError(`POST ${path} failed: ${res.status}`, res.status, body);
    }
    return res.json() as Promise<T>;
  }

  private async del(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => "");
      throw new BrowserFarmError(`DELETE ${path} failed: ${res.status}`, res.status, body);
    }
  }
}

export class BrowserFarmError extends Error {
  constructor(message: string, public status: number, public body: string) {
    super(message);
    this.name = "BrowserFarmError";
  }
}
