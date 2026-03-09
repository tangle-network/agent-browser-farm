import { execSync } from "node:child_process";
import { Backend, BackendSession, BrowserType, PoolStatus } from "./types.js";
import { log } from "../log.js";

/**
 * Physical Android device backend — real devices connected via USB/ADB.
 *
 * Same CDP protocol as the emulator backend, but no emulator lifecycle:
 *   1. Device is already connected and booted
 *   2. Launch Chrome on device
 *   3. `adb -s SERIAL forward tcp:PORT localabstract:chrome_devtools_remote`
 *   4. Return WS endpoint — identical to desktop Chrome / emulator CDP
 *
 * Each device supports one session at a time (Chrome's CDP socket is per-device).
 *
 * Prerequisites:
 *   - Android SDK (ANDROID_HOME set, adb available)
 *   - Device connected via USB with USB debugging enabled
 *   - Chrome installed on device
 */

interface DeviceSession {
  serial: string;
  cdpPort: number;
}

export class AndroidDeviceBackend implements Backend {
  readonly id: string;
  readonly type = "android-device";
  readonly supports: ReadonlySet<BrowserType> = new Set(["android-chrome"]);

  private deviceSerials: string[];
  private sessions = new Map<string, DeviceSession>();
  private busyDevices = new Set<string>();
  private nextCdpPort: number;
  private autoDiscover: boolean;

  constructor(opts: {
    id?: string;
    /** Explicit device serials. If omitted, discovers via `adb devices`. */
    devices?: string[];
    /** Starting port for CDP forwarding (default 9400) */
    cdpStartPort?: number;
  } = {}) {
    this.id = opts.id || `android-device-${crypto.randomUUID().slice(0, 8)}`;
    this.deviceSerials = opts.devices || [];
    this.autoDiscover = !opts.devices || opts.devices.length === 0;
    this.nextCdpPort = opts.cdpStartPort || 9400;
  }

  async createSession(opts: { browser: BrowserType }): Promise<BackendSession> {
    this.verifyAndroidSdk();

    const available = this.getAvailableDevices();
    if (available.length === 0) {
      throw new Error("No available Android devices (all busy or none connected)");
    }

    const serial = available[0];
    const cdpPort = this.nextCdpPort++;
    const backendId = crypto.randomUUID();

    log.info("android-device: creating session", { backendId, serial, cdpPort });

    try {
      // 1. Launch Chrome
      this.adb(serial, ["shell", "am", "start", "-n",
        "com.android.chrome/com.google.android.apps.chrome.Main",
        "-d", "about:blank",
      ]);

      await new Promise((r) => setTimeout(r, 2000));

      // 2. Forward CDP port
      this.adb(serial, ["forward", `tcp:${cdpPort}`, "localabstract:chrome_devtools_remote"]);

      // 3. Get WS endpoint
      const wsEndpoint = await this.getCdpWsEndpoint(cdpPort);

      this.sessions.set(backendId, { serial, cdpPort });
      this.busyDevices.add(serial);

      log.info("android-device: session ready", { backendId, serial, cdpPort, wsEndpoint });
      return { backendId, wsEndpoint, backendType: this.type };
    } catch (err) {
      this.cleanupForwarding(serial, cdpPort);
      throw err;
    }
  }

  async destroySession(backendId: string): Promise<void> {
    const session = this.sessions.get(backendId);
    if (!session) return;
    this.sessions.delete(backendId);
    this.busyDevices.delete(session.serial);

    this.cleanupForwarding(session.serial, session.cdpPort);

    // Close Chrome tabs (don't kill Chrome entirely — user may want it)
    try {
      this.adb(session.serial, ["shell", "am", "force-stop", "com.android.chrome"]);
    } catch { /* best effort */ }

    log.info("android-device: session destroyed", { backendId, serial: session.serial });
  }

  async status(): Promise<PoolStatus> {
    const devices = this.getConnectedDevices();
    return {
      capacity: devices.length,
      active: this.sessions.size,
      backend: this.type,
      healthy: await this.healthCheck(),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.verifyAndroidSdk();
      return this.getConnectedDevices().length > 0;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    for (const [id, session] of this.sessions) {
      this.cleanupForwarding(session.serial, session.cdpPort);
      try {
        this.adb(session.serial, ["shell", "am", "force-stop", "com.android.chrome"]);
      } catch { /* best effort */ }
      log.info("android-device: shutdown session", { backendId: id, serial: session.serial });
    }
    this.sessions.clear();
    this.busyDevices.clear();
    log.info("android-device: shutdown complete");
  }

  // --- Internals ---

  private verifyAndroidSdk(): void {
    const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
    if (!home) throw new Error("ANDROID_HOME not set. Install Android SDK.");
  }

  private sdkPath(relative: string): string {
    const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
    return `${home}/${relative}`;
  }

  private adb(serial: string, args: string[]): string {
    const adbBin = this.sdkPath("platform-tools/adb");
    return execSync(`${adbBin} -s ${serial} ${args.join(" ")}`, {
      timeout: 30000,
      encoding: "utf-8",
    }).trim();
  }

  /** Get all connected physical devices (excludes emulators). */
  private getConnectedDevices(): string[] {
    try {
      const adbBin = this.sdkPath("platform-tools/adb");
      const output = execSync(`${adbBin} devices`, { timeout: 10000, encoding: "utf-8" });
      return output
        .split("\n")
        .slice(1) // skip header
        .map((line) => line.trim().split("\t"))
        .filter(([serial, state]) => serial && state === "device" && !serial.startsWith("emulator-"))
        .map(([serial]) => serial);
    } catch {
      return [];
    }
  }

  /** Get devices available for new sessions. */
  private getAvailableDevices(): string[] {
    const connected = this.autoDiscover
      ? this.getConnectedDevices()
      : this.deviceSerials.filter((s) => this.getConnectedDevices().includes(s));

    return connected.filter((s) => !this.busyDevices.has(s));
  }

  private async getCdpWsEndpoint(port: number, retries = 5): Promise<string> {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(3000),
        });
        const data = await res.json() as { webSocketDebuggerUrl: string };
        if (data.webSocketDebuggerUrl) {
          return data.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`);
        }
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Failed to get CDP endpoint on port ${port}`);
  }

  private cleanupForwarding(serial: string, cdpPort: number): void {
    try {
      const adbBin = this.sdkPath("platform-tools/adb");
      execSync(`${adbBin} -s ${serial} forward --remove tcp:${cdpPort}`, {
        timeout: 5000, stdio: "ignore",
      });
    } catch { /* best effort */ }
  }
}
