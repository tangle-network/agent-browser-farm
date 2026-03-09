import { Backend, BackendSession, BrowserType, PoolStatus } from "./types.js";
import { log } from "../log.js";

/**
 * Physical iOS device backend — real Safari on real devices via Appium.
 *
 * Same Appium/WebDriver protocol as the simulator backend, but:
 *   - No simulator cloning — targets real hardware UDIDs
 *   - Requires code signing (Xcode team ID) for WebDriverAgent
 *   - Each device supports one session at a time
 *
 * Flow:
 *   1. Pick an available device from the pool
 *   2. Create Appium XCUITest session targeting device UDID
 *   3. Return WebDriver HTTP URL + session ID
 *   4. On destroy: DELETE Appium session
 *
 * Prerequisites:
 *   - macOS with Xcode
 *   - Appium 3.x + XCUITest driver
 *   - Device connected via USB, trusted, developer mode enabled
 *   - Apple Developer account for WDA code signing
 *   - Device UDID (find via: `xcrun xctrace list devices`)
 */

interface PhysicalDeviceSession {
  deviceUdid: string;
  appiumSessionId: string;
}

export class IosDeviceBackend implements Backend {
  readonly id: string;
  readonly type = "ios-device";
  readonly supports: ReadonlySet<BrowserType> = new Set(["ios-safari"]);

  private appiumUrl: string;
  private devices: { udid: string; name?: string }[];
  private sessions = new Map<string, PhysicalDeviceSession>();
  private busyDevices = new Set<string>();

  /** Code signing config for WebDriverAgent */
  private xcodeOrgId?: string;
  private xcodeSigningId: string;

  constructor(opts: {
    id?: string;
    /** Appium server URL */
    appiumUrl?: string;
    /** Physical device UDIDs to manage */
    devices: { udid: string; name?: string }[];
    /** Apple Developer Team ID (for WDA code signing) */
    xcodeOrgId?: string;
    /** Signing identity (default: "iPhone Developer") */
    xcodeSigningId?: string;
  }) {
    this.id = opts.id || `ios-device-${crypto.randomUUID().slice(0, 8)}`;
    this.appiumUrl = (opts.appiumUrl || "http://localhost:4723").replace(/\/$/, "");
    this.devices = opts.devices;
    this.xcodeOrgId = opts.xcodeOrgId;
    this.xcodeSigningId = opts.xcodeSigningId || "iPhone Developer";

    if (!opts.devices || opts.devices.length === 0) {
      throw new Error("IosDeviceBackend requires at least one device UDID");
    }
  }

  async createSession(opts: { browser: BrowserType; device?: string }): Promise<BackendSession> {
    if (process.platform !== "darwin") {
      throw new Error("iOS Device backend requires macOS");
    }

    const available = this.devices.filter((d) => !this.busyDevices.has(d.udid));
    if (available.length === 0) {
      throw new Error(`All ${this.devices.length} iOS devices are busy`);
    }

    // If a specific device name was requested, try to match
    let target = available[0];
    if (opts.device) {
      const match = available.find((d) =>
        d.name?.toLowerCase().includes(opts.device!.toLowerCase()) ||
        d.udid === opts.device
      );
      if (match) target = match;
    }

    const backendId = crypto.randomUUID();
    log.info("ios-device: creating session", { backendId, udid: target.udid, name: target.name });

    try {
      const appiumSession = await this.createAppiumSession(target.udid, opts.device);

      this.sessions.set(backendId, {
        deviceUdid: target.udid,
        appiumSessionId: appiumSession.sessionId,
      });
      this.busyDevices.add(target.udid);

      log.info("ios-device: session ready", {
        backendId,
        udid: target.udid,
        appiumSessionId: appiumSession.sessionId,
      });

      return {
        backendId,
        backendType: this.type,
        webdriverUrl: this.appiumUrl,
        webdriverSessionId: appiumSession.sessionId,
      };
    } catch (err) {
      throw err;
    }
  }

  async destroySession(backendId: string): Promise<void> {
    const session = this.sessions.get(backendId);
    if (!session) return;
    this.sessions.delete(backendId);
    this.busyDevices.delete(session.deviceUdid);

    try {
      await fetch(`${this.appiumUrl}/session/${session.appiumSessionId}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      log.error("ios-device: failed to delete Appium session", { backendId, error: String(err) });
    }

    log.info("ios-device: session destroyed", { backendId, udid: session.deviceUdid });
  }

  async status(): Promise<PoolStatus> {
    return {
      capacity: this.devices.length,
      active: this.sessions.size,
      backend: this.type,
      healthy: await this.healthCheck(),
    };
  }

  async healthCheck(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
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
      log.info("ios-device: shutdown session", { backendId: id, udid: session.deviceUdid });
    }
    this.sessions.clear();
    this.busyDevices.clear();
    log.info("ios-device: shutdown complete");
  }

  // --- Internals ---

  private async createAppiumSession(
    deviceUdid: string,
    deviceName?: string,
  ): Promise<{ sessionId: string }> {
    const caps: Record<string, unknown> = {
      platformName: "iOS",
      "appium:automationName": "XCUITest",
      browserName: "Safari",
      "appium:udid": deviceUdid,
      "appium:deviceName": deviceName || "iPhone",
      // Real device requires code signing for WDA
      ...(this.xcodeOrgId && { "appium:xcodeOrgId": this.xcodeOrgId }),
      "appium:xcodeSigningId": this.xcodeSigningId,
      // Real device flags
      "appium:noReset": true,
      "appium:waitForQuiescence": false,
      "appium:skipLogCapture": true,
    };

    const res = await fetch(`${this.appiumUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: caps } }),
      signal: AbortSignal.timeout(120000), // real devices can take longer for WDA
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Appium session creation failed (real device): ${res.status} ${body}`);
    }

    const data = await res.json() as { value: { sessionId: string } };
    return { sessionId: data.value.sessionId };
  }
}
