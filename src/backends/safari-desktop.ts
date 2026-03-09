import { ChildProcess, spawn } from "node:child_process";
import { Backend, BackendSession, BrowserType, PoolStatus } from "./types.js";
import { log } from "../log.js";

/**
 * macOS Safari backend — real Safari.app via safaridriver.
 *
 * safaridriver is built into macOS (no install needed) and speaks W3C WebDriver.
 * Each process handles exactly one session, so we spawn one per concurrent session.
 *
 * Flow:
 *   1. Spawn `safaridriver --port PORT`
 *   2. POST /session → Safari.app launches
 *   3. Return WebDriver HTTP URL + session ID
 *   4. On destroy: DELETE session → kill safaridriver process
 *
 * Prerequisites:
 *   - macOS (safaridriver is pre-installed)
 *   - One-time: `safaridriver --enable` (requires sudo)
 *   - Safari > Develop > Allow Remote Automation must be checked
 */

interface SafariSession {
  driverProcess: ChildProcess;
  driverPort: number;
  webdriverSessionId: string;
}

export class SafariDesktopBackend implements Backend {
  readonly id: string;
  readonly type = "safari-desktop";
  readonly supports: ReadonlySet<BrowserType> = new Set(["safari"]);

  private sessions = new Map<string, SafariSession>();
  private maxCapacity: number;
  private basePort: number;
  private usedPorts = new Set<number>();

  constructor(opts?: {
    id?: string;
    /** Max concurrent Safari sessions */
    capacity?: number;
    /** Starting port for safaridriver processes (default 9500) */
    basePort?: number;
  }) {
    this.id = opts?.id || `safari-desktop-${crypto.randomUUID().slice(0, 8)}`;
    this.maxCapacity = opts?.capacity || 4;
    this.basePort = opts?.basePort || 9500;
  }

  async createSession(_opts: { browser: BrowserType }): Promise<BackendSession> {
    if (this.sessions.size >= this.maxCapacity) {
      throw new Error(`Safari pool full (${this.maxCapacity} max)`);
    }

    this.verifyMacOs();

    const backendId = crypto.randomUUID();
    const port = this.allocatePort();

    // 1. Spawn safaridriver
    log.info("safari-desktop: starting safaridriver", { backendId, port });
    const driverProcess = spawn("safaridriver", ["--port", String(port)], {
      stdio: "ignore",
      detached: false,
    });

    // Wait for safaridriver to be ready
    await this.waitForDriver(port);

    try {
      // 2. Create WebDriver session
      log.info("safari-desktop: creating session", { backendId, port });
      const sessionId = await this.createWebDriverSession(port);

      this.sessions.set(backendId, {
        driverProcess,
        driverPort: port,
        webdriverSessionId: sessionId,
      });

      log.info("safari-desktop: session ready", { backendId, sessionId, port });

      return {
        backendId,
        backendType: this.type,
        webdriverUrl: `http://localhost:${port}`,
        webdriverSessionId: sessionId,
      };
    } catch (err) {
      // Cleanup on failure
      this.usedPorts.delete(port);
      driverProcess.kill();
      throw err;
    }
  }

  async destroySession(backendId: string): Promise<void> {
    const session = this.sessions.get(backendId);
    if (!session) return;
    this.sessions.delete(backendId);

    // Delete WebDriver session
    try {
      await fetch(`http://localhost:${session.driverPort}/session/${session.webdriverSessionId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      log.error("safari-desktop: failed to delete session", { backendId, error: String(err) });
    }

    // Kill safaridriver process
    session.driverProcess.kill();
    this.usedPorts.delete(session.driverPort);
    log.info("safari-desktop: session destroyed", { backendId, port: session.driverPort });
  }

  async status(): Promise<PoolStatus> {
    return {
      capacity: this.maxCapacity,
      active: this.sessions.size,
      backend: this.type,
      healthy: await this.healthCheck(),
    };
  }

  async healthCheck(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
      // Verify safaridriver binary exists
      const { execSync } = await import("node:child_process");
      execSync("which safaridriver", { timeout: 5000, encoding: "utf-8" });
      return true;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    for (const [id, session] of this.sessions) {
      try {
        await fetch(`http://localhost:${session.driverPort}/session/${session.webdriverSessionId}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(3000),
        });
      } catch { /* best effort */ }
      session.driverProcess.kill();
      this.usedPorts.delete(session.driverPort);
      log.info("safari-desktop: shutdown session", { backendId: id });
    }
    this.sessions.clear();
    log.info("safari-desktop: shutdown complete");
  }

  // --- Internals ---

  private verifyMacOs(): void {
    if (process.platform !== "darwin") {
      throw new Error("Safari Desktop backend requires macOS");
    }
  }

  private allocatePort(): number {
    for (let port = this.basePort; port < this.basePort + 100; port++) {
      if (!this.usedPorts.has(port)) {
        this.usedPorts.add(port);
        return port;
      }
    }
    throw new Error("No available ports for safaridriver");
  }

  private async waitForDriver(port: number, timeoutMs = 10000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`http://localhost:${port}/status`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) return;
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`safaridriver on port ${port} failed to start within ${timeoutMs}ms`);
  }

  private async createWebDriverSession(port: number): Promise<string> {
    const res = await fetch(`http://localhost:${port}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        capabilities: {
          alwaysMatch: {
            browserName: "safari",
          },
        },
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`safaridriver session creation failed: ${res.status} ${body}`);
    }

    const data = await res.json() as { value: { sessionId: string } };
    return data.value.sessionId;
  }
}
