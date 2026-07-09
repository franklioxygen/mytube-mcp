import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Config } from "./config.js";

const isPrivateIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = octets;
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
};

export const assertSafeExternalUrl = (value: string, config: Pick<Config, "allowInternalUrls">): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("URL must be absolute and include a scheme.");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are supported.");
  }
  if (config.allowInternalUrls) {
    return parsed;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const isBlocked =
    hostname === "localhost" ||
    hostname === "::1" ||
    net.isIP(hostname) === 4 && (hostname.startsWith("127.") || isPrivateIpv4(hostname)) ||
    net.isIP(hostname) === 6 && (hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe8") || hostname.startsWith("fe9") || hostname.startsWith("fea") || hostname.startsWith("feb"));
  if (isBlocked) {
    throw new Error("Internal and private network URLs are blocked; set MYTUBE_ALLOW_INTERNAL_URLS=true for trusted LAN use.");
  }
  return parsed;
};

const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
};

export const resolveAllowedPath = async (filePath: string, roots: string[]): Promise<string> => {
  if (roots.length === 0) {
    throw new Error("Local uploads are disabled. Set MCP_UPLOAD_ROOTS to an allow-listed directory.");
  }
  const resolved = await fs.realpath(filePath).catch(() => {
    throw new Error("The supplied file path does not exist.");
  });
  const resolvedRoots = await Promise.all(
    roots.map(async (root) => fs.realpath(root).catch(() => path.resolve(root))),
  );
  if (!resolvedRoots.some((root) => isWithin(root, resolved))) {
    throw new Error("The supplied file path is outside MCP_UPLOAD_ROOTS.");
  }
  return resolved;
};

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(private readonly max: number) {}

  public async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}
