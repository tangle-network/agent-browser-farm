/** Browser types the farm supports */
export type BrowserType = "chrome" | "firefox" | "webkit" | "safari" | "ios-safari" | "android-chrome";

/** Desktop browsers handled by Browserless */
export const DESKTOP_BROWSERS = new Set<BrowserType>(["chrome", "firefox", "webkit"]);

/** A session returned by a backend */
export interface BackendSession {
  /** Backend-specific session/connection identifier */
  backendId: string;
  /** Which backend created this session */
  backendType: string;
  /** WebSocket endpoint (CDP/Playwright protocol) — for desktop + Android Chrome */
  wsEndpoint?: string;
  /** WebDriver HTTP URL — for iOS Safari (Appium) or macOS Safari (safaridriver) */
  webdriverUrl?: string;
  /** WebDriver session ID — for iOS Safari (Appium) or macOS Safari (safaridriver) */
  webdriverSessionId?: string;
}

/** Capacity info for a backend pool */
export interface PoolStatus {
  capacity: number;
  active: number;
  backend: string;
  healthy: boolean;
}

/** Interface every backend must implement */
export interface Backend {
  /** Unique instance ID (assigned at registration if not set) */
  readonly id: string;

  /** Backend type name (e.g. "browserless", "appium-android") */
  readonly type: string;

  /** Which browser types this backend handles */
  readonly supports: ReadonlySet<BrowserType>;

  /** Create a browser session. Returns connection info. */
  createSession(opts: {
    browser: BrowserType;
    headless?: boolean;
    device?: string;
  }): Promise<BackendSession>;

  /** Kill a session by its backend-specific ID */
  destroySession(backendId: string): Promise<void>;

  /** Current pool status */
  status(): Promise<PoolStatus>;

  /** Health check — returns true if backend is reachable */
  healthCheck(): Promise<boolean>;

  /** Clean shutdown */
  shutdown(): Promise<void>;
}
