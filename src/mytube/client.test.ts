import { beforeEach, describe, expect, it, vi } from "vitest";
import { MyTubeClient } from "./client.js";
import type { Config } from "../config.js";
import { createLogger } from "../logging.js";

const config = (overrides: Partial<Config> = {}): Config => ({
  baseUrl: "https://mytube.example.com",
  authMode: "api-key",
  apiKey: "api-key-secret",
  requestTimeoutMs: 5000,
  downloadPollIntervalMs: 10,
  downloadPollTimeoutMs: 100,
  allowInsecureTls: false,
  allowInternalUrls: false,
  transport: "stdio",
  httpPort: 3100,
  httpBind: "127.0.0.1",
  httpRateLimitPerMinute: 600,
  logLevel: "error",
  uploadRoots: [],
  maxInFlight: 4,
  serverVersion: "0.1.0",
  ...overrides,
});

describe("MyTubeClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("sends the API key and parses the current raw MyTube response shape", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("x-api-key")).toBe("api-key-secret");
      return new Response(JSON.stringify({ currentVersion: "1.10.11", latestVersion: "1.10.11", releaseUrl: "", hasUpdate: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new MyTubeClient(config(), createLogger(config()));
    await client.initialize();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(client.request("/api/system/version")).resolves.toMatchObject({ currentVersion: "1.10.11" });
  });

  it("logs in with the real MyTube cookie names and sends CSRF on mutations", async () => {
    const responses = [
      new Response(JSON.stringify({ loginRequired: true, enabled: true }), { status: 200 }),
      new Response(JSON.stringify({ success: true, role: "admin" }), {
        status: 200,
        headers: { "set-cookie": "mytube_auth_session=session-secret; Path=/, mytube_csrf=csrf-secret; Path=/", "x-csrf-token": "csrf-secret" },
      }),
      new Response(JSON.stringify({ currentVersion: "1.10.11", latestVersion: "1.10.11", releaseUrl: "", hasUpdate: false }), { status: 200 }),
      new Response(JSON.stringify({ success: true, downloadId: "download-1" }), { status: 200 }),
    ];
    const fetchMock = vi.fn(async () => responses.shift() ?? new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const adminConfig = config({ authMode: "admin-session", apiKey: undefined, adminPassword: "admin-secret" });
    const client = new MyTubeClient(adminConfig, createLogger(adminConfig));
    await client.initialize();
    await client.request("/api/download", { method: "POST", body: JSON.stringify({ youtubeUrl: "https://youtu.be/example" }) });
    const requestCall = fetchMock.mock.calls[3] as unknown as [RequestInfo | URL, RequestInit] | undefined;
    const requestHeaders = new Headers(requestCall?.[1]?.headers);
    expect(requestHeaders.get("cookie")).toContain("mytube_auth_session=session-secret");
    expect(requestHeaders.get("cookie")).toContain("mytube_csrf=csrf-secret");
    expect(requestHeaders.get("x-csrf-token")).toBe("csrf-secret");
  });
});
