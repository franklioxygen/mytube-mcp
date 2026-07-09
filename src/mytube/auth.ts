import type { Config } from "../config.js";
import type { Logger } from "../logging.js";
import { mapHttpError, MyTubeConfigurationError } from "./errors.js";
import type { PasswordEnabledResponse } from "./types.js";

export interface RawRequester {
  rawRequest(path: string, options?: RequestInit): Promise<Response>;
}

export interface AuthStrategy {
  initialize(client: RawRequester): Promise<void>;
  getHeaders(method: string): Record<string, string>;
  observeResponse(response: Response): void;
  reauthenticate(client: RawRequester): Promise<boolean>;
}

export class ApiKeyAuth implements AuthStrategy {
  public constructor(private readonly config: Config) {}

  public async initialize(_client: RawRequester): Promise<void> {
    return;
  }

  public getHeaders(_method: string): Record<string, string> {
    return {
      Accept: "application/json",
      "x-api-key": this.config.apiKey ?? "",
    };
  }

  public observeResponse(_response: Response): void {
    return;
  }

  public async reauthenticate(_client: RawRequester): Promise<boolean> {
    return false;
  }
}

const AUTH_COOKIE = "mytube_auth_session";
const CSRF_COOKIE = "mytube_csrf";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const getSetCookies = (headers: Headers): string[] => {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  const values = withGetSetCookie.getSetCookie?.();
  if (values && values.length > 0) {
    return values.flatMap((value) => value.split(/,(?=[^;,=]+=[^;,]+)/));
  }
  const combined = headers.get("set-cookie");
  if (!combined) {
    return [];
  }
  return combined.split(/,(?=[^;,=]+=[^;,]+)/);
};

const cookiePair = (setCookie: string): [string, string] | undefined => {
  const first = setCookie.split(";", 1)[0];
  if (!first) {
    return undefined;
  }
  const separator = first.indexOf("=");
  if (separator <= 0) {
    return undefined;
  }
  return [first.slice(0, separator).trim(), first.slice(separator + 1).trim()];
};

export class AdminSessionAuth implements AuthStrategy {
  private readonly cookies = new Map<string, string>();
  private csrfToken?: string;
  private sessionLoginEnabled = true;

  public constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  public async initialize(client: RawRequester): Promise<void> {
    const passwordResponse = await client.rawRequest("/api/settings/password-enabled");
    const passwordBody = await readJson(passwordResponse);
    if (!passwordResponse.ok) {
      throw mapHttpError(passwordResponse.status, passwordBody, this.config.baseUrl);
    }
    const passwordStatus = (passwordBody ?? {}) as PasswordEnabledResponse;
    this.sessionLoginEnabled = passwordStatus.loginRequired === true || passwordStatus.enabled === true;

    if (!this.sessionLoginEnabled) {
      this.logger.warn("MyTube password login is disabled; admin-session mode will use owner-mode access.");
      return;
    }

    if (!this.config.adminPassword) {
      throw new MyTubeConfigurationError(
        "MYTUBE_ADMIN_PASSWORD is required because the MyTube server reports that password login is enabled.",
      );
    }
    await this.login(client);
  }

  public getHeaders(method: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const cookie = [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    if (cookie) {
      headers.Cookie = cookie;
    }
    if (MUTATING_METHODS.has(method.toUpperCase()) && this.csrfToken) {
      headers["x-csrf-token"] = this.csrfToken;
    }
    return headers;
  }

  public observeResponse(response: Response): void {
    const csrfHeader = response.headers.get("x-csrf-token");
    if (csrfHeader) {
      this.csrfToken = csrfHeader;
    }
    for (const value of getSetCookies(response.headers)) {
      const pair = cookiePair(value);
      if (!pair) {
        continue;
      }
      const [name, cookieValue] = pair;
      if (cookieValue) {
        this.cookies.set(name, cookieValue);
      }
      if (name === CSRF_COOKIE && cookieValue) {
        this.csrfToken = cookieValue;
      }
    }
  }

  public async reauthenticate(client: RawRequester): Promise<boolean> {
    if (!this.sessionLoginEnabled || !this.config.adminPassword) {
      return false;
    }
    await this.login(client);
    return true;
  }

  private async login(client: RawRequester): Promise<void> {
    const response = await client.rawRequest("/api/settings/verify-admin-password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ password: this.config.adminPassword }),
    });
    const body = await readJson(response);
    this.observeResponse(response);
    if (!response.ok) {
      throw mapHttpError(response.status, body, this.config.baseUrl);
    }
    if (!this.cookies.has(AUTH_COOKIE)) {
      throw new MyTubeConfigurationError(
        "MyTube admin login succeeded without returning the expected mytube_auth_session cookie.",
      );
    }
    if (!this.csrfToken) {
      throw new MyTubeConfigurationError(
        "MyTube admin login succeeded without returning the expected CSRF token.",
      );
    }
  }
}

export const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

export const getAuthCookieName = (): string => AUTH_COOKIE;
export const getCsrfCookieName = (): string => CSRF_COOKIE;
