import { spawn, execSync, type ChildProcess } from "node:child_process";
import { Backend, BackendSession, BrowserType, PoolStatus } from "./types.js";
import { log } from "../log.js";

/**
 * Android Chrome backend — direct emulator + ADB + CDP.
 *
 * No Appium. No Chromedriver. Just:
 *   1. Boot emulator from AVD snapshot (~5-10s)
 *   2. Launch Chrome
 *   3. `adb forward` to expose CDP on host
 *   4. Return WS endpoint — same protocol as desktop Chrome
 *
 * The farm's WS proxy relays CDP connections identically to Browserless.
 *
 * Prerequisites:
 *   - Android SDK (ANDROID_HOME set)
 *   - AVD created with Chrome installed (use scripts/setup-android.sh)
 *   - For Apple Silicon Macs: ARM64 system images + ARM64 Chrome APK
 */

interface EmulatorInstance {
  process: ChildProcess;
  serial: string;       // e.g. "emulator-5554"
  consolePort: number;  // e.g. 5554
  cdpPort: number;      // host port forwarded to Chrome CDP
}

export class AndroidBackend implements Backend {
  readonly id: string;
  readonly type = "android";
  readonly supports: ReadonlySet<BrowserType> = new Set(["android-chrome"]);

  private avdName: string;
  private instances = new Map<string, EmulatorInstance>();
  private nextConsolePort: number;
  private nextCdpPort: number;
  private maxCapacity: number;

  constructor(opts: {
    id?: string;
    /** AVD name to boot from (must exist, with snapshot) */
    avdName?: string;
    /** Starting port for emulator console (pairs: 5554/5555, 5556/5557, ...) */
    startPort?: number;
    /** Starting port for CDP forwarding */
    cdpStartPort?: number;
    /** Max concurrent emulators */
    capacity?: number;
  } = {}) {
    this.id = opts.id || `android-${crypto.randomUUID().slice(0, 8)}`;
    this.avdName = opts.avdName || "chrome-farm";
    this.nextConsolePort = opts.startPort || 5554;
    this.nextCdpPort = opts.cdpStartPort || 9300;
    this.maxCapacity = opts.capacity || 4;
  }

  async createSession(opts: { browser: BrowserType; headless?: boolean }): Promise<BackendSession> {
    if (this.instances.size >= this.maxCapacity) {
      throw new Error(`Android pool full (${this.maxCapacity} max)`);
    }

    this.verifyAndroidSdk();

    const consolePort = this.allocateConsolePort();
    const cdpPort = this.allocateCdpPort();
    const serial = `emulator-${consolePort}`;
    const backendId = crypto.randomUUID();

    log.info("android: booting emulator", { backendId, avd: this.avdName, serial, cdpPort });

    // 1. Boot emulator from snapshot
    const emulatorBin = this.sdkPath("emulator/emulator");
    const proc = spawn(emulatorBin, [
      `@${this.avdName}`,
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-port", String(consolePort),
      "-read-only",
      "-no-snapshot-save",
    ], {
      stdio: "ignore",
      detached: true,
    });
    proc.unref();

    const instance: EmulatorInstance = { process: proc, serial, consolePort, cdpPort };

    try {
      // 2. Wait for boot
      await this.waitForBoot(serial);

      // 3. Launch Chrome
      this.adb(serial, ["shell", "am", "start", "-n",
        "com.android.chrome/com.google.android.apps.chrome.Main",
        "-d", "about:blank",
      ]);

      // Give Chrome a moment to initialize CDP socket
      await new Promise((r) => setTimeout(r, 2000));

      // 4. Forward CDP
      this.adb(serial, ["forward", `tcp:${cdpPort}`, "localabstract:chrome_devtools_remote"]);

      // 5. Get the WS endpoint from CDP
      const wsEndpoint = await this.getCdpWsEndpoint(cdpPort);

      this.instances.set(backendId, instance);

      log.info("android: session ready", { backendId, serial, cdpPort, wsEndpoint });
      return { backendId, wsEndpoint, backendType: this.type };
    } catch (err) {
      // Cleanup on failure
      this.killEmulator(instance);
      throw err;
    }
  }

  async destroySession(backendId: string): Promise<void> {
    const instance = this.instances.get(backendId);
    if (!instance) return;
    this.instances.delete(backendId);
    this.killEmulator(instance);
    log.info("android: session destroyed", { backendId, serial: instance.serial });
  }

  async status(): Promise<PoolStatus> {
    return {
      capacity: this.maxCapacity,
      active: this.instances.size,
      backend: this.type,
      healthy: await this.healthCheck(),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      this.verifyAndroidSdk();
      return true;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<void> {
    for (const [id, instance] of this.instances) {
      this.killEmulator(instance);
      log.info("android: shutdown emulator", { backendId: id, serial: instance.serial });
    }
    this.instances.clear();
    log.info("android: shutdown complete");
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

  private async waitForBoot(serial: string, timeoutMs = 120000): Promise<void> {
    const adbBin = this.sdkPath("platform-tools/adb");
    const start = Date.now();

    // Wait for device to appear
    execSync(`${adbBin} -s ${serial} wait-for-device`, { timeout: 60000 });

    // Wait for boot_completed
    while (Date.now() - start < timeoutMs) {
      try {
        const result = this.adb(serial, ["shell", "getprop", "sys.boot_completed"]);
        if (result === "1") return;
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Emulator ${serial} boot timeout after ${timeoutMs}ms`);
  }

  private async getCdpWsEndpoint(port: number, retries = 5): Promise<string> {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(3000),
        });
        const data = await res.json() as { webSocketDebuggerUrl: string };
        if (data.webSocketDebuggerUrl) {
          // Rewrite the host to ensure it points to our forwarded port
          return data.webSocketDebuggerUrl.replace(/ws:\/\/[^/]+/, `ws://127.0.0.1:${port}`);
        }
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Failed to get CDP endpoint on port ${port}`);
  }

  private killEmulator(instance: EmulatorInstance): void {
    try {
      // Remove port forwarding
      const adbBin = this.sdkPath("platform-tools/adb");
      execSync(`${adbBin} -s ${instance.serial} forward --remove tcp:${instance.cdpPort}`, {
        timeout: 5000, stdio: "ignore",
      });
    } catch { /* best effort */ }

    try {
      // Kill emulator via adb
      const adbBin = this.sdkPath("platform-tools/adb");
      execSync(`${adbBin} -s ${instance.serial} emu kill`, { timeout: 10000, stdio: "ignore" });
    } catch { /* best effort */ }

    try {
      instance.process.kill("SIGKILL");
    } catch { /* best effort */ }
  }

  private allocateConsolePort(): number {
    const port = this.nextConsolePort;
    this.nextConsolePort += 2; // emulator uses pairs: console=5554, adb=5555
    return port;
  }

  private allocateCdpPort(): number {
    return this.nextCdpPort++;
  }
}
