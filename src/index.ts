#!/usr/bin/env node
import { parseConfig, redactConfig } from "./config.js";
import { createLogger } from "./logging.js";
import { MyTubeClient } from "./mytube/client.js";
import { MyTubeApi } from "./mytube/endpoints.js";
import { createMcpServer } from "./server.js";
import { runStdio, startHttp } from "./transport.js";

const main = async (): Promise<void> => {
  const config = parseConfig();
  const logger = createLogger(config);
  logger.info("Starting MyTube MCP server", redactConfig(config));
  const client = new MyTubeClient(config, logger);
  await client.initialize();
  const api = new MyTubeApi(client, config);

  const refreshTimer = setInterval(() => {
    void api.getSystemVersion().catch((error: unknown) => {
      logger.warn("Periodic MyTube capability check failed", { error: error instanceof Error ? error.message : String(error) });
    });
  }, 10 * 60_000);
  refreshTimer.unref();

  if (config.transport === "stdio") {
    const registered = createMcpServer(api, config, logger);
    await runStdio(registered);
    return;
  }

  await startHttp(config, logger, () => createMcpServer(api, config, logger));
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ level: "error", message: "MyTube MCP server failed to start", error: message })}\n`);
  process.exitCode = 1;
});
