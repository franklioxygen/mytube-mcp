import type { Config } from "../config.js";
import type { Logger } from "../logging.js";
import { mapHttpError, mapNetworkError, MyTubeError } from "./errors.js";
import { ApiKeyAuth, AdminSessionAuth, type AuthStrategy, readJson, type RawRequester } from "./auth.js";

export interface RequestOptions extends RequestInit {
  query?: Record<string, string | number | boolean | undefined>;
}

export class MyTubeClient implements RawRequester {
  public readonly auth: AuthStrategy;

  public constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.auth = config.authMode === "api-key"
      ? new ApiKeyAuth(config)
      : new AdminSessionAuth(config, logger);
  }

  public async initialize(): Promise<void> {
    await this.auth.initialize(this);
    await this.request<unknown>("/api/system/version");
  }

  public async rawRequest(path: string, options: RequestInit = {}): Promise<Response> {
    return this.fetch(path, options);
  }

  public async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = (options.method ?? "GET").toUpperCase();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        query.set(key, String(value));
      }
    }
    const queryString = query.toString();
    const requestPath = queryString ? `${path}${path.includes("?") ? "&" : "?"}${queryString}` : path;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const headers = new Headers(this.auth.getHeaders(method));
      for (const [key, value] of new Headers(options.headers).entries()) {
        headers.set(key, value);
      }
      if (options.body && typeof options.body === "string" && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }

      const started = Date.now();
      let response: Response;
      try {
        response = await this.fetch(requestPath, { ...options, method, headers });
      } catch (error) {
        const mapped = error instanceof MyTubeError ? error : mapNetworkError(error, this.config.baseUrl);
        this.logger.error("MyTube request failed", { method, path, code: mapped.code, durationMs: Date.now() - started });
        throw mapped;
      }
      this.auth.observeResponse(response);
      const body = await readJson(response);

      const responseText = typeof body === "string" ? body : JSON.stringify(body ?? "");
      const looksLikeSessionFailure =
        response.status === 401 ||
        response.status === 403 && /(session|csrf|expired|authentication required|login)/i.test(responseText);
      if (looksLikeSessionFailure && attempt === 0) {
        const reauthenticated = await this.auth.reauthenticate(this);
        if (reauthenticated) {
          continue;
        }
      }

      if (!response.ok) {
        const mapped = mapHttpError(
          response.status,
          body,
          this.config.baseUrl,
          response.headers.get("retry-after"),
        );
        this.logger.warn("MyTube request returned an error", { method, path, status: response.status, code: mapped.code });
        throw mapped;
      }

      this.logger.debug("MyTube request completed", { method, path, status: response.status, durationMs: Date.now() - started });
      return body as T;
    }
    throw new MyTubeError("MYTUBE_UNAUTHORIZED", "Authentication required or expired");
  }

  private async fetch(path: string, options: RequestInit): Promise<Response> {
    const url = new URL(path, `${this.config.baseUrl}/`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;
    try {
      return await fetch(url, { ...options, signal });
    } catch (error) {
      throw mapNetworkError(error, this.config.baseUrl);
    } finally {
      clearTimeout(timer);
    }
  }
}
