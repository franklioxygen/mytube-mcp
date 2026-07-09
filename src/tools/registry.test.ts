import { describe, expect, it } from "vitest";
import type { Config } from "../config.js";
import { createMcpServer } from "../server.js";
import { MyTubeApi } from "../mytube/endpoints.js";

const config = (authMode: Config["authMode"]): Config => ({
  baseUrl: "https://mytube.example.com",
  authMode,
  apiKey: authMode === "api-key" ? "key" : undefined,
  adminPassword: authMode === "admin-session" ? "password" : undefined,
  requestTimeoutMs: 30_000,
  downloadPollIntervalMs: 2000,
  downloadPollTimeoutMs: 600_000,
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
});

const fakeApi = {} as MyTubeApi;

describe("MCP capability gating", () => {
  it("only exposes the current MyTube API-key allowlist in API-key mode", () => {
    const registered = createMcpServer(fakeApi, config("api-key"));
    expect(registered.toolNames).toEqual([
      "download_video",
      "list_videos",
      "get_video",
      "list_collections",
      "get_system_version",
    ]);
    expect(registered.toolNames).not.toContain("search_videos");
    expect(registered.resourceNames).toContain("mytube://system/version");
    expect(registered.resourceNames).not.toContain("mytube://downloads/active");
  });

  it("exposes the full tool/resource/prompt surface in admin mode", () => {
    const registered = createMcpServer(fakeApi, config("admin-session"));
    expect(registered.toolNames).toContain("search_videos");
    expect(registered.toolNames).toContain("delete_video");
    expect(registered.toolNames).toContain("create_playlist_task");
    expect(registered.resourceNames).toContain("mytube://downloads/history");
    expect(registered.promptNames).toEqual([
      "download-and-organize",
      "audit-subscriptions",
      "library-report",
      "find-and-download",
    ]);
  });

  it("applies the destructive tool allowlist after mode gating", () => {
    const adminConfig = { ...config("admin-session"), allowedTools: new Set(["delete_video", "get_system_version"]) };
    const registered = createMcpServer(fakeApi, adminConfig);
    expect(registered.toolNames).toEqual(["delete_video", "get_system_version"]);
  });
});
