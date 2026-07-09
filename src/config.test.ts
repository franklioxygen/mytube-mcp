import { describe, expect, it } from "vitest";
import { parseConfig, redactConfig } from "./config.js";

describe("parseConfig", () => {
  it("requires the API key in API-key mode and normalizes the base URL", () => {
    expect(() => parseConfig({ MYTUBE_BASE_URL: "https://mytube.example.com" })).toThrow("MYTUBE_API_KEY");
    const config = parseConfig({
      MYTUBE_BASE_URL: "https://mytube.example.com/",
      MYTUBE_API_KEY: "secret-api-key",
    });
    expect(config.baseUrl).toBe("https://mytube.example.com");
    expect(config.authMode).toBe("api-key");
  });

  it("rejects API-key and admin credentials together", () => {
    expect(() => parseConfig({
      MYTUBE_BASE_URL: "https://mytube.example.com",
      MYTUBE_API_KEY: "key",
      MYTUBE_ADMIN_PASSWORD: "password",
    })).toThrow("privilege bleed");
  });

  it("allows admin mode without a password so owner-mode MyTube can be detected at startup", () => {
    const config = parseConfig({
      MYTUBE_BASE_URL: "http://127.0.0.1:3000",
      MYTUBE_AUTH_MODE: "admin-session",
    });
    expect(config.adminPassword).toBeUndefined();
  });

  it("does not expose secrets in the startup summary", () => {
    const config = parseConfig({
      MYTUBE_BASE_URL: "https://mytube.example.com",
      MYTUBE_API_KEY: "secret-api-key",
      MCP_HTTP_BEARER_TOKEN: "secret-http-token",
    });
    const redacted = redactConfig(config);
    expect(JSON.stringify(redacted)).not.toContain("secret-api-key");
    expect(JSON.stringify(redacted)).not.toContain("secret-http-token");
    expect(redacted).toMatchObject({ hasHttpBearerToken: true });
  });
});
