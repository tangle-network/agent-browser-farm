import { execSync } from "node:child_process";
import { Backend, BackendSession, BrowserType, PoolStatus } from "./types.js";
import { log } from "../log.js";

/**
 * iOS Safari backend — real Safari on real iOS simulators via Appium.
 *
 * Manages the full lifecycle:
 *   1. Clone simulator from template (pre-warmed, WDA pre-installed)
 *   2. Boot simulator (~5-10s from clone)
 *   3. Create Appium WebDriver session → Safari launches
 *   4. Return WebDriver HTTP URL + session ID (NOT a WS endpoint)
 *   5. On destroy: kill Appium session → shutdown + delete simulator
 *
 * Clients use WebDriver (Selenium) API, not Playwright, for iOS Safari.
 * This is the only real path — Safari doesn't speak CDP.
 *
 * Prerequisites:
 *   - macOS with Xcode CLI tools
 *   - Appium 3.x + XCUITest driver
 *   - Template simulator with WDA pre-installed (use scripts/setup-mac-host.sh)
 */

interface SimulatorSession {
  simulatorUdid: string;
  appiumSessionId: string;
  clonedFromTemplate: boolean;
}

/**
 * Template resolution: maps device name to the right simulator template.
 *
 * Accepts either:
 *   - Single `templateUdid` (backward compat — used for all devices)
 *   - `templates` map with category keys: `{ "iPhone": "UDID1", "iPad": "UDID2" }`
 *
 * Device matching uses prefix: "iPad Pro 11" → looks for "iPad" key, etc.
 */
interface TemplateMap {
  [prefix: string]: string; // device prefix → template UDID
}

export class IosSafariBackend implements Backend {
  readonly id: string;
  readonly type = "ios-safari";
  readonly supports: ReadonlySet<BrowserType> = new Set(["ios-safari"]);

  private appiumUrl: string;
  private templates: TemplateMap;
  private defaultTemplate: string;
  private sessions = new Map<string, SimulatorSession>();
  private maxCapacity: number;

  constructor(opts: {
    id?: string;
    /** Appium server URL (must be running separately) */
    appiumUrl?: string;
    /** Single template UDID (used for all devices). Mutually exclusive with `templates`. */
    templateUdid?: string;
    /** Map of device prefix → template UDID (e.g. { "iPhone": "...", "iPad": "..." }) */
    templates?: Record<string, string>;
    /** Max concurrent simulators */
    capacity?: number;
  }) {
    this.id = opts.id || `ios-safari-${crypto.randomUUID().slice(0, 8)}`;
    this.appiumUrl = (opts.appiumUrl || "http://localhost:4723").replace(/\/$/, "");
    this.maxCapacity = opts.capacity || 4;

    if (opts.templates && Object.keys(opts.templates).length > 0) {
      this.templates = opts.templates;
      this.defaultTemplate = Object.values(opts.templates)[0];
    } else if (opts.templateUdid) {
      this.templates = { iPhone: opts.templateUdid };
      this.defaultTemplate = opts.templateUdid;
    } else {
      throw new Error("IosSafariBackend requires either templateUdid or templates");
    }
  }

  async createSession(opts: { browser: BrowserType; device?: string }): Promise<BackendSession> {
    if (this.sessions.size >= this.maxCapacity) {
      throw new Error(`iOS pool full (${this.maxCapacity} max)`);
    }

    this.verifyMacOs();

    const backendId = crypto.randomUUID();
    const cloneName = `farm-${backendId.slice(0, 8)}`;
    const templateUdid = this.resolveTemplate(opts.device);

    // 1. Clone simulator from template
    log.info("ios-safari: cloning simulator", { backendId, template: templateUdid, device: opts.device });
    const simulatorUdid = this.simctl(["clone", templateUdid, cloneName]).trim();

    try {
      // 2. Boot the clone
      log.info("ios-safari: booting simulator", { backendId, udid: simulatorUdid });
      this.simctl(["boot", simulatorUdid]);
      await this.waitForSimBoot(simulatorUdid);

      // 3. Create Appium session
      log.info("ios-safari: creating Appium session", { backendId, udid: simulatorUdid });
      const appiumSession = await this.createAppiumSession(simulatorUdid, opts.device);

      this.sessions.set(backendId, {
        simulatorUdid,
        appiumSessionId: appiumSession.sessionId,
        clonedFromTemplate: true,
      });

      log.info("ios-safari: session ready", {
        backendId,
        udid: simulatorUdid,
        appiumSessionId: appiumSession.sessionId,
      });

      return {
        backendId,
        backendType: this.type,
        webdriverUrl: `${this.appiumUrl}`,
        webdriverSessionId: appiumSession.sessionId,
      };
    } catch (err) {
      // Cleanup on failure
      this.cleanupSimulator(simulatorUdid);
      throw err;
    }
  }

  async destroySession(backendId: string): Promise<void> {
    const session = this.sessions.get(backendId);
    if (!session) return;
    this.sessions.delete(backendId);

    // Kill Appium session
    try {
      await fetch(`${this.appiumUrl}/session/${session.appiumSessionId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      log.error("ios-safari: failed to delete Appium session", { backendId, error: String(err) });
    }

    // Shutdown + delete the cloned simulator
    this.cleanupSimulator(session.simulatorUdid);
    log.info("ios-safari: session destroyed", { backendId, udid: session.simulatorUdid });
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
    try {
      this.verifyMacOs();
      // Check Appium is running
      const res = await fetch(`${this.appiumUrl}/status`, { signal: AbortSignal.timeout(5000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    for (const [id, session] of this.sessions) {
      try {
        await fetch(`${this.appiumUrl}/session/${session.appiumSessionId}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(5000),
        });
      } catch { /* best effort */ }
      this.cleanupSimulator(session.simulatorUdid);
      log.info("ios-safari: shutdown simulator", { backendId: id, udid: session.simulatorUdid });
    }
    this.sessions.clear();
    log.info("ios-safari: shutdown complete");
  }

  // --- Internals ---

  private verifyMacOs(): void {
    if (process.platform !== "darwin") {
      throw new Error("iOS Safari backend requires macOS");
    }
  }

  private simctl(args: string[]): string {
    return execSync(`xcrun simctl ${args.join(" ")}`, {
      timeout: 60000,
      encoding: "utf-8",
    }).trim();
  }

  private async waitForSimBoot(udid: string, timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const output = this.simctl(["list", "devices", "-j"]);
        const data = JSON.parse(output);
        for (const runtime of Object.values(data.devices) as any[]) {
          const device = runtime.find((d: any) => d.udid === udid);
          if (device?.state === "Booted") return;
        }
      } catch { /* parsing error, retry */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Simulator ${udid} boot timeout after ${timeoutMs}ms`);
  }

  private async createAppiumSession(
    simulatorUdid: string,
    deviceName?: string,
  ): Promise<{ sessionId: string }> {
    const capabilities = {
      capabilities: {
        alwaysMatch: {
          platformName: "iOS",
          "appium:automationName": "XCUITest",
          browserName: "Safari",
          "appium:udid": simulatorUdid,
          "appium:deviceName": deviceName || "iPhone",
          "appium:usePreinstalledWDA": true,
          "appium:noReset": true,
          // Speed optimizations
          "appium:waitForQuiescence": false,
          "appium:skipLogCapture": true,
          "appium:reduceMotion": true,
        },
      },
    };

    const res = await fetch(`${this.appiumUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(capabilities),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Appium session creation failed: ${res.status} ${body}`);
    }

    const data = await res.json() as { value: { sessionId: string } };
    return { sessionId: data.value.sessionId };
  }

  /** Match device name to the right template UDID by prefix. */
  private resolveTemplate(device?: string): string {
    if (!device) return this.defaultTemplate;

    // Exact match first
    if (this.templates[device]) return this.templates[device];

    // Prefix match: "iPad Pro 11" → "iPad", "iPhone 15 Pro" → "iPhone"
    for (const [prefix, udid] of Object.entries(this.templates)) {
      if (device.toLowerCase().startsWith(prefix.toLowerCase())) return udid;
    }

    // Fall back to default
    log.warn("ios-safari: no template for device, using default", {
      device,
      available: Object.keys(this.templates),
    });
    return this.defaultTemplate;
  }

  private cleanupSimulator(udid: string): void {
    try {
      this.simctl(["shutdown", udid]);
    } catch { /* may already be shutdown */ }
    try {
      this.simctl(["delete", udid]);
    } catch (err) {
      log.error("ios-safari: failed to delete simulator", { udid, error: String(err) });
    }
  }
}
