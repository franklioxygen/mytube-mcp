import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import type { Logger } from "./logging.js";
import type { RegisteredMcpServer } from "./server.js";

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const getHeader = (request: IncomingMessage, name: string): string | undefined => {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const isLoopbackBind = (bind: string): boolean => ["127.0.0.1", "localhost", "::1"].includes(bind.toLowerCase());

interface Session {
  registered: RegisteredMcpServer;
  transport: StreamableHTTPServerTransport;
  lastUsed: number;
}

class IpRateLimiter {
  private readonly counters = new Map<string, { startedAt: number; count: number }>();

  public constructor(private readonly limit: number) {}

  public allow(ip: string): boolean {
    const now = Date.now();
    const current = this.counters.get(ip);
    if (!current || now - current.startedAt >= 60_000) {
      this.counters.set(ip, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= this.limit;
  }
}

export const runStdio = async (registered: RegisteredMcpServer): Promise<void> => {
  const transport = new StdioServerTransport();
  await registered.server.connect(transport);
};

export const startHttp = async (
  config: Config,
  logger: Logger,
  createSessionServer: () => RegisteredMcpServer,
): Promise<Server> => {
  if (!isLoopbackBind(config.httpBind) && !config.httpBearerToken) {
    throw new Error("MCP_HTTP_BEARER_TOKEN is required when MCP_HTTP_BIND is not loopback.");
  }
  const sessions = new Map<string, Session>();
  const limiter = new IpRateLimiter(config.httpRateLimitPerMinute);

  const httpServer = createHttpServer(async (request, response) => {
    const requestPath = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname;
    if (requestPath === "/healthz" && request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (requestPath !== "/mcp") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    const ip = request.socket.remoteAddress ?? "unknown";
    if (!limiter.allow(ip)) {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "60" });
      response.end(JSON.stringify({ error: "Rate limited" }));
      return;
    }
    if (config.httpBearerToken && getHeader(request, "authorization") !== `Bearer ${config.httpBearerToken}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const sessionId = getHeader(request, "mcp-session-id");
    const body = request.method === "POST" ? await readBody(request) : undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      const isInitialize = body && typeof body === "object" && !Array.isArray(body) && (body as { method?: unknown }).method === "initialize";
      if (!isInitialize) {
        response.writeHead(400, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "A valid Mcp-Session-Id is required after initialization" }));
        return;
      }
      const registered = createSessionServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      session = { registered, transport, lastUsed: Date.now() };
      await registered.server.connect(transport);
    }

    session.lastUsed = Date.now();
    try {
      await session.transport.handleRequest(request, response, body);
      const assignedSessionId = session.transport.sessionId;
      if (assignedSessionId) {
        sessions.set(assignedSessionId, session);
      }
    } catch (error) {
      logger.error("MCP HTTP request failed", { error: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "MCP transport failure" }));
      }
    }
  });

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000;
    for (const [sessionId, session] of sessions) {
      if (session.lastUsed < cutoff) {
        void session.transport.close().catch(() => undefined);
        sessions.delete(sessionId);
      }
    }
  }, 60_000);
  cleanupTimer.unref();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.httpPort, config.httpBind, () => resolve());
  });
  logger.info("MCP Streamable HTTP server listening", { bind: config.httpBind, port: config.httpPort, health: "/healthz" });
  httpServer.once("close", () => clearInterval(cleanupTimer));
  return httpServer;
};
