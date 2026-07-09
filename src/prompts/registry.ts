import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";

const userMessage = (text: string) => ({ role: "user" as const, content: { type: "text" as const, text } });

export const registerPrompts = (server: McpServer, config: Config): string[] => {
  if (config.authMode !== "admin-session") {
    return [];
  }

  server.registerPrompt("download-and-organize", {
    description: "Classify a URL, download it, and optionally organize the result in a collection.",
    argsSchema: { url: z.string().url(), collection: z.string().optional() },
  }, ({ url, collection }) => ({
    messages: [userMessage(`Use inspect_url for ${url}. If it is a playlist or Bilibili collection, ask how to handle its parts. Then call download_video with await_completion=true. ${collection ? `After success, ensure the ${collection} collection exists and add the resulting videos with update_collection.` : "Report the final download summary."}`)],
  }));

  server.registerPrompt("audit-subscriptions", {
    description: "Review subscription health and suggest cleanup actions.",
  }, () => ({
    messages: [userMessage("List all subscriptions with list_subscriptions. Summarize interval, last downloaded video, and failure streak where visible. Flag subscriptions paused for more than seven days or with a high failure streak, then suggest cleanup actions.")],
  }));

  server.registerPrompt("library-report", {
    description: "Summarize library size, authors, recent downloads, and missing metadata.",
    argsSchema: { since: z.string().optional() },
  }, ({ since }) => ({
    messages: [userMessage(`Summarize the MyTube library using list_videos and get_download_history: total videos, top authors, recent downloads${since ? ` since ${since}` : ""}, and videos missing thumbnails or subtitles.`)],
  }));

  server.registerPrompt("find-and-download", {
    description: "Search for a video, confirm the selection, then download it without duplicates.",
    argsSchema: { query: z.string().trim().min(1), max: z.number().int().min(1).max(50).optional() },
  }, ({ query, max }) => ({
    messages: [userMessage(`Search YouTube for ${query} with search_videos (limit ${max ?? 8}). Present the results and wait for the user to choose one. Then call check_video_downloaded and, if needed, download_video. Confirm the final state.`)],
  }));

  return ["download-and-organize", "audit-subscriptions", "library-report", "find-and-download"];
};
