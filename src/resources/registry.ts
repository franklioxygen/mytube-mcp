import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config.js";
import { MyTubeApi } from "../mytube/endpoints.js";

type ResourceMode = "api-key" | "admin-session";

const jsonResource = (uri: URL, value: unknown) => ({
  contents: [{ uri: uri.toString(), mimeType: "application/json", text: JSON.stringify(value, null, 2) }],
});

export const registerResources = (server: McpServer, api: MyTubeApi, config: Config): string[] => {
  const registered: string[] = [];
  const canUse = (modes: ResourceMode[]): boolean => modes.includes(config.authMode);

  if (canUse(["api-key", "admin-session"])) {
    server.registerResource("library-videos", "mytube://library/videos", {
      title: "MyTube library videos",
      description: "The current MyTube library video summaries.",
      mimeType: "application/json",
    }, async (uri) => jsonResource(uri, await api.listVideos()));
    registered.push("mytube://library/videos");

    server.registerResource("library-video", new ResourceTemplate("mytube://library/videos/{id}", { list: undefined }), {
      title: "MyTube video",
      description: "Full metadata for one MyTube library video.",
      mimeType: "application/json",
    }, async (uri, variables) => jsonResource(uri, await api.getVideo(String(variables.id))));
    registered.push("mytube://library/videos/{id}");

    server.registerResource("library-collections", "mytube://library/collections", {
      title: "MyTube collections",
      description: "MyTube collections and their memberships.",
      mimeType: "application/json",
    }, async (uri) => jsonResource(uri, { collections: await api.getCollections() }));
    registered.push("mytube://library/collections");
  }

  if (canUse(["admin-session"])) {
    server.registerResource("active-downloads", "mytube://downloads/active", {
      title: "Active MyTube downloads",
      description: "Active and queued downloads with progress.",
      mimeType: "application/json",
    }, async (uri) => jsonResource(uri, await api.getDownloadStatus()));
    registered.push("mytube://downloads/active");

    server.registerResource("download-history", "mytube://downloads/history", {
      title: "MyTube download history",
      description: "Final outcomes for past downloads.",
      mimeType: "application/json",
    }, async (uri) => jsonResource(uri, await api.getDownloadHistory()));
    registered.push("mytube://downloads/history");

    server.registerResource("subscriptions", "mytube://subscriptions", {
      title: "MyTube subscriptions",
      description: "Configured channel and playlist subscriptions.",
      mimeType: "application/json",
    }, async (uri) => jsonResource(uri, { subscriptions: await api.getSubscriptions() }));
    registered.push("mytube://subscriptions");
  }

  server.registerResource("system-version", "mytube://system/version", {
    title: "MyTube system version",
    description: "Installed and latest MyTube version information.",
    mimeType: "application/json",
  }, async (uri) => jsonResource(uri, await api.getSystemVersion()));
  registered.push("mytube://system/version");

  return registered;
};
