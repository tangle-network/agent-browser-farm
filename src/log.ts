import { config } from "./config.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;

function shouldLog(level: keyof typeof LEVELS): boolean {
  return LEVELS[level] >= LEVELS[config.logLevel];
}

function fmt(level: string, msg: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] ${msg}`;
  return data ? `${base} ${JSON.stringify(data)}` : base;
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => {
    if (shouldLog("debug")) console.debug(fmt("debug", msg, data));
  },
  info: (msg: string, data?: Record<string, unknown>) => {
    if (shouldLog("info")) console.info(fmt("info", msg, data));
  },
  warn: (msg: string, data?: Record<string, unknown>) => {
    if (shouldLog("warn")) console.warn(fmt("warn", msg, data));
  },
  error: (msg: string, data?: Record<string, unknown>) => {
    if (shouldLog("error")) console.error(fmt("error", msg, data));
  },
};
