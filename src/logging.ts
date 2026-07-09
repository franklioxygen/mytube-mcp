import type { Config, LogLevel } from "./config.js";

const rank: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const secretKeyPattern = /(api[-_]?key|password|cookie|csrf|authorization|token|secret)/i;

const redact = (value: unknown, key?: string): unknown => {
  if (key && secretKeyPattern.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redact(entryValue, entryKey)]),
    );
  }
  return value;
};

export interface Logger {
  error(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  debug(message: string, context?: unknown): void;
}

export const createLogger = (config: Pick<Config, "logLevel">): Logger => {
  const write = (level: LogLevel, message: string, context?: unknown): void => {
    if (rank[level] > rank[config.logLevel]) {
      return;
    }
    const payload = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(context === undefined ? {} : { context: redact(context) }),
    };
    process.stderr.write(`${JSON.stringify(payload)}\n`);
  };

  return {
    error: (message, context) => write("error", message, context),
    warn: (message, context) => write("warn", message, context),
    info: (message, context) => write("info", message, context),
    debug: (message, context) => write("debug", message, context),
  };
};

export const summarizeArgs = (args: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      secretKeyPattern.test(key) ? "[REDACTED]" : value,
    ]),
  );
