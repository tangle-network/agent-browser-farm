/** Environment-driven configuration. Minimal surface — env vars only. */
export const config = {
  /** Validate critical config at startup. Logs warnings for suspicious values. */
  validate(): string[] {
    const warnings: string[] = [];
    if (config.port < 1 || config.port > 65535) warnings.push(`Invalid PORT: ${config.port}`);
    if (config.maxSessions < 1) warnings.push(`MAX_SESSIONS must be >= 1`);
    if (config.maxPerClient < 1) warnings.push(`MAX_PER_CLIENT must be >= 1`);
    if (config.defaultTimeout < 10) warnings.push(`SESSION_TIMEOUT < 10s is likely too short`);
    if (config.idleTimeout < 10) warnings.push(`IDLE_TIMEOUT < 10s is likely too short`);
    if (!config.apiToken) warnings.push(`API_TOKEN not set — API is unauthenticated`);
    return warnings;
  },

  /** Server port */
  port: parseInt(process.env.PORT || "9222", 10),

  /** Browserless backend URL */
  browserlessUrl: process.env.BROWSERLESS_URL || "http://localhost:3000",

  /** Browserless auth token (if configured) */
  browserlessToken: process.env.BROWSERLESS_TOKEN || "",

  /** API auth token for farm clients. Empty = no auth. */
  apiToken: process.env.API_TOKEN || "",

  /** Default session timeout in seconds */
  defaultTimeout: parseInt(process.env.SESSION_TIMEOUT || "300", 10),

  /** Max concurrent sessions per client */
  maxPerClient: parseInt(process.env.MAX_PER_CLIENT || "5", 10),

  /** Global max concurrent sessions */
  maxSessions: parseInt(process.env.MAX_SESSIONS || "20", 10),

  /** Session idle timeout before reaping (seconds) */
  idleTimeout: parseInt(process.env.IDLE_TIMEOUT || "300", 10),

  /** Reaper sweep interval (seconds) */
  reaperInterval: parseInt(process.env.REAPER_INTERVAL || "30", 10),

  /** Health check interval for backends (seconds) */
  healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL || "30", 10),

  /** Log level */
  logLevel: (process.env.LOG_LEVEL || "info") as "debug" | "info" | "warn" | "error",
} as const;

export type Config = typeof config;
