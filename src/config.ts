import "dotenv/config";
import { z } from "zod";

export type AuthMode = "api-key" | "admin-session";
export type McpTransport = "stdio" | "http";
export type LogLevel = "error" | "warn" | "info" | "debug";

export interface Config {
  baseUrl: string;
  authMode: AuthMode;
  apiKey?: string;
  adminPassword?: string;
  requestTimeoutMs: number;
  downloadPollIntervalMs: number;
  downloadPollTimeoutMs: number;
  allowInsecureTls: boolean;
  allowInternalUrls: boolean;
  transport: McpTransport;
  httpPort: number;
  httpBind: string;
  httpBearerToken?: string;
  httpRateLimitPerMinute: number;
  logLevel: LogLevel;
  allowedTools?: Set<string>;
  uploadRoots: string[];
  maxInFlight: number;
  serverVersion: string;
}

const optionalString = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);

const rawEnvSchema = z.object({
  MYTUBE_BASE_URL: z.string().trim().min(1),
  MYTUBE_AUTH_MODE: z.enum(["api-key", "admin-session"]).default("api-key"),
  MYTUBE_API_KEY: optionalString,
  MYTUBE_ADMIN_PASSWORD: z.string().optional(),
  MYTUBE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  MYTUBE_DOWNLOAD_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  MYTUBE_DOWNLOAD_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  MYTUBE_ALLOW_INSECURE_TLS: z.enum(["true", "false"]).default("false"),
  MYTUBE_ALLOW_INTERNAL_URLS: z.enum(["true", "false"]).default("false"),
  MCP_TRANSPORT: z.enum(["stdio", "http"]).default("stdio"),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3_100),
  MCP_HTTP_BIND: z.string().trim().min(1).default("127.0.0.1"),
  MCP_HTTP_BEARER_TOKEN: optionalString,
  MCP_HTTP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
  MCP_LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  MCP_ALLOWED_TOOLS: z.string().optional(),
  MCP_UPLOAD_ROOTS: z.string().optional(),
  MCP_MAX_IN_FLIGHT: z.coerce.number().int().positive().max(64).default(4),
  MYTUBE_MCP_VERSION: z.string().trim().min(1).default("0.1.0"),
});

const isLoopbackOrLocalHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".local")
  );
};

export const isAllowedBaseUrl = (value: string, allowInsecureTls: boolean): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
    return false;
  }

  if (parsed.protocol === "https:") {
    return true;
  }

  return allowInsecureTls || isLoopbackOrLocalHost(parsed.hostname);
};

const parseCsv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export const parseConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const raw = rawEnvSchema.parse(env);
  const apiKey = raw.MYTUBE_API_KEY;
  const adminPassword = raw.MYTUBE_ADMIN_PASSWORD?.trim() || undefined;

  if (!isAllowedBaseUrl(raw.MYTUBE_BASE_URL, raw.MYTUBE_ALLOW_INSECURE_TLS === "true")) {
    throw new Error(
      "MYTUBE_BASE_URL must be an absolute https URL, or a local/private http URL, unless MYTUBE_ALLOW_INSECURE_TLS=true.",
    );
  }

  if (raw.MYTUBE_AUTH_MODE === "api-key") {
    if (!apiKey) {
      throw new Error("MYTUBE_API_KEY is required when MYTUBE_AUTH_MODE=api-key.");
    }
    if (adminPassword) {
      throw new Error(
        "MYTUBE_ADMIN_PASSWORD must be unset when MYTUBE_AUTH_MODE=api-key to prevent privilege bleed.",
      );
    }
  }

  const allowedTools = parseCsv(raw.MCP_ALLOWED_TOOLS);
  const parsedUrl = new URL(raw.MYTUBE_BASE_URL);
  const baseUrl = parsedUrl.toString().replace(/\/$/, "");

  return {
    baseUrl,
    authMode: raw.MYTUBE_AUTH_MODE,
    apiKey,
    adminPassword,
    requestTimeoutMs: raw.MYTUBE_REQUEST_TIMEOUT_MS,
    downloadPollIntervalMs: raw.MYTUBE_DOWNLOAD_POLL_INTERVAL_MS,
    downloadPollTimeoutMs: raw.MYTUBE_DOWNLOAD_POLL_TIMEOUT_MS,
    allowInsecureTls: raw.MYTUBE_ALLOW_INSECURE_TLS === "true",
    allowInternalUrls: raw.MYTUBE_ALLOW_INTERNAL_URLS === "true",
    transport: raw.MCP_TRANSPORT,
    httpPort: raw.MCP_HTTP_PORT,
    httpBind: raw.MCP_HTTP_BIND,
    httpBearerToken: raw.MCP_HTTP_BEARER_TOKEN,
    httpRateLimitPerMinute: raw.MCP_HTTP_RATE_LIMIT_PER_MINUTE,
    logLevel: raw.MCP_LOG_LEVEL,
    allowedTools: allowedTools.length > 0 ? new Set(allowedTools) : undefined,
    uploadRoots: parseCsv(raw.MCP_UPLOAD_ROOTS),
    maxInFlight: raw.MCP_MAX_IN_FLIGHT,
    serverVersion: raw.MYTUBE_MCP_VERSION,
  };
};

export const redactConfig = (config: Config): Record<string, unknown> => ({
  baseUrl: config.baseUrl,
  authMode: config.authMode,
  requestTimeoutMs: config.requestTimeoutMs,
  downloadPollIntervalMs: config.downloadPollIntervalMs,
  downloadPollTimeoutMs: config.downloadPollTimeoutMs,
  allowInsecureTls: config.allowInsecureTls,
  allowInternalUrls: config.allowInternalUrls,
  transport: config.transport,
  httpPort: config.httpPort,
  httpBind: config.httpBind,
  hasHttpBearerToken: Boolean(config.httpBearerToken),
  logLevel: config.logLevel,
  allowedTools: config.allowedTools ? [...config.allowedTools] : undefined,
  uploadRoots: config.uploadRoots,
  maxInFlight: config.maxInFlight,
  serverVersion: config.serverVersion,
});
