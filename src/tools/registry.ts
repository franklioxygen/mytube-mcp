import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Config } from "../config.js";
import { createLogger, summarizeArgs, type Logger } from "../logging.js";
import { ConcurrencyLimiter } from "../security.js";
import { MyTubeError } from "../mytube/errors.js";
import { MyTubeApi } from "../mytube/endpoints.js";

type Mode = "api-key" | "admin-session";

type ToolExtra = {
  signal: AbortSignal;
  requestId: string | number;
  _meta?: Record<string, unknown>;
  sendNotification: (notification: { method: string; params?: Record<string, unknown> }) => Promise<void>;
};

type ToolHandler = (api: MyTubeApi, args: Record<string, unknown>, extra: ToolExtra, config: Config) => Promise<Record<string, unknown>>;

interface ToolDefinition {
  name: string;
  description: string;
  modes: Mode[];
  schema: z.ZodTypeAny;
  annotations: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  handler: ToolHandler;
}

const empty = z.object({});
const id = z.string().trim().min(1);
const url = z.string().trim().url();
const record = z.record(z.string(), z.unknown());

const result = (data: Record<string, unknown>): Record<string, unknown> => data;

const sleep = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Tool call was cancelled by the MCP client."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
};

const awaitDownload = async (
  api: MyTubeApi,
  downloadId: string,
  timeoutMs: number,
  intervalMs: number,
  extra: ToolExtra,
): Promise<Record<string, unknown>> => {
  const startedAt = Date.now();
  const progressToken = extra._meta?.progressToken;
  while (Date.now() - startedAt <= timeoutMs) {
    const status = await api.getDownloadStatus();
    const active = Array.isArray(status.activeDownloads) ? status.activeDownloads : [];
    const queued = Array.isArray(status.queuedDownloads) ? status.queuedDownloads : [];
    const task = [...active, ...queued].find((item) => String(item.id) === downloadId);
    if (task) {
      const rawProgress = Number(task.progress);
      const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.min(100, rawProgress)) : 0;
      if (typeof progressToken === "string" || typeof progressToken === "number") {
        await extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            total: 100,
            message: `${String(task.title ?? "Download")} ${progress.toFixed(0)}%${task.speed ? ` at ${String(task.speed)}` : ""}`,
          },
        });
      }
    } else {
      const history = await api.getDownloadHistory();
      const matching = history.history.find((item) => String(item.id) === downloadId || String(item.videoId ?? "") === downloadId);
      if (matching) {
        return result({
          downloadId,
          state: matching.status,
          videoId: matching.videoId,
          title: matching.title,
          error: matching.error,
        });
      }
    }
    await sleep(intervalMs, extra.signal);
  }
  return result({ downloadId, state: "still_running", message: "The download is still running; use get_download_status to continue polling." });
};

const makeToolResult = (data: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const makeToolError = (error: unknown): CallToolResult => {
  const code = error instanceof MyTubeError ? error.code : "MCP_TOOL_ERROR";
  const message = error instanceof Error ? error.message : "Tool call failed";
  const data = { code, message };
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    structuredContent: data,
    isError: true,
  };
};

const runTool = async (
  definition: ToolDefinition,
  api: MyTubeApi,
  args: Record<string, unknown>,
  extra: ToolExtra,
  config: Config,
  limiter: ConcurrencyLimiter,
  logger: Logger,
): Promise<CallToolResult> => {
  const startedAt = Date.now();
  logger.info("MCP tool invocation", { tool: definition.name, argsSummary: summarizeArgs(args) });
  try {
    const data = await limiter.run(() => definition.handler(api, args, extra, config));
    logger.info("MCP tool completed", { tool: definition.name, durationMs: Date.now() - startedAt, resultState: data.state });
    return makeToolResult(data);
  } catch (error) {
    logger.warn("MCP tool failed", { tool: definition.name, durationMs: Date.now() - startedAt, error: error instanceof Error ? error.message : String(error) });
    return makeToolError(error);
  }
};

const definitions: ToolDefinition[] = [
  {
    name: "search_videos",
    description: "Search YouTube and other MyTube-supported sources. The current MyTube route requires an admin session.",
    modes: ["admin-session"],
    schema: z.object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(50).default(8), offset: z.number().int().min(1).default(1) }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (api, args) => api.searchVideos(String(args.query), Number(args.limit), Number(args.offset)),
  },
  {
    name: "check_video_downloaded",
    description: "Check whether a source URL already exists in the MyTube library.",
    modes: ["admin-session"],
    schema: z.object({ url }),
    annotations: { readOnlyHint: true },
    handler: async (api, args) => api.checkVideoDownloaded(String(args.url)),
  },
  {
    name: "inspect_url",
    description: "Classify a URL as a video, playlist, Bilibili multipart video, or Bilibili collection.",
    modes: ["admin-session"],
    schema: z.object({ url }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (api, args) => api.inspectUrl(String(args.url)),
  },
  {
    name: "download_video",
    description: "Enqueue a video, playlist, or collection for download. Optionally wait for completion and receive progress notifications.",
    modes: ["api-key", "admin-session"],
    schema: z.object({
      url,
      download_all_parts: z.boolean().optional(),
      collection_name: z.string().trim().min(1).optional(),
      download_collection: z.boolean().optional(),
      collection_info: record.optional(),
      force_download: z.boolean().optional(),
      await_completion: z.boolean().default(false),
      await_timeout_ms: z.number().int().positive().optional(),
    }),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (api, args, extra, config) => {
      const request = {
        youtubeUrl: String(args.url),
        downloadAllParts: args.download_all_parts as boolean | undefined,
        collectionName: args.collection_name as string | undefined,
        downloadCollection: args.download_collection as boolean | undefined,
        collectionInfo: args.collection_info as Record<string, unknown> | undefined,
        forceDownload: args.force_download as boolean | undefined,
      };
      const started = await api.downloadVideo(request);
      const downloadId = typeof started.downloadId === "string" ? started.downloadId : undefined;
      if (args.await_completion !== true || !downloadId) {
        return result({ ...started, downloadId, state: "queued" });
      }
      const timeout = Math.min(Number(args.await_timeout_ms ?? config.downloadPollTimeoutMs), config.downloadPollTimeoutMs);
      return await awaitDownload(api, downloadId, timeout, config.downloadPollIntervalMs, extra);
    },
  },
  {
    name: "get_download_status",
    description: "List active and queued downloads with current progress.",
    modes: ["admin-session"],
    schema: empty,
    annotations: { readOnlyHint: true },
    handler: async (api) => api.getDownloadStatus(),
  },
  {
    name: "get_download_history",
    description: "List download history, optionally filtered by final status.",
    modes: ["admin-session"],
    schema: z.object({ status: z.enum(["success", "failed", "partial", "pending_retry", "skipped", "deleted"]).optional(), limit: z.number().int().min(1).max(1000).optional() }),
    annotations: { readOnlyHint: true },
    handler: async (api, args) => api.getDownloadHistory(args.status as string | undefined, args.limit as number | undefined),
  },
  {
    name: "cancel_download",
    description: "Cancel an active download by id.",
    modes: ["admin-session"],
    schema: z.object({ download_id: id }),
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (api, args) => api.queueAction("cancel", String(args.download_id)),
  },
  {
    name: "remove_from_queue",
    description: "Remove a queued download by id.",
    modes: ["admin-session"],
    schema: z.object({ download_id: id }),
    annotations: { destructiveHint: true },
    handler: async (api, args) => api.queueAction("remove", String(args.download_id)),
  },
  {
    name: "clear_queue",
    description: "Clear all queued downloads.",
    modes: ["admin-session"],
    schema: empty,
    annotations: { destructiveHint: true },
    handler: async (api) => api.queueAction("clear"),
  },
  {
    name: "remove_history_row",
    description: "Remove one download history row. MyTube refuses pending_retry rows and returns that reason.",
    modes: ["admin-session"],
    schema: z.object({ history_id: id }),
    annotations: { destructiveHint: true },
    handler: async (api, args) => api.historyAction("remove", String(args.history_id)),
  },
  {
    name: "clear_history",
    description: "Clear the MyTube download history.",
    modes: ["admin-session"],
    schema: empty,
    annotations: { destructiveHint: true },
    handler: async (api) => api.historyAction("clear"),
  },
  {
    name: "list_videos",
    description: "List videos in the MyTube library with pagination and client-side author, tag, or collection filters.",
    modes: ["api-key", "admin-session"],
    schema: z.object({ limit: z.number().int().min(1).max(500).optional(), offset: z.number().int().min(0).optional(), author: z.string().optional(), tag: z.string().optional(), collection_id: z.string().optional() }),
    annotations: { readOnlyHint: true },
    handler: async (api, args) => api.listVideos({ limit: args.limit as number | undefined, offset: args.offset as number | undefined, author: args.author as string | undefined, tag: args.tag as string | undefined, collectionId: args.collection_id as string | undefined }),
  },
  {
    name: "get_video",
    description: "Get full metadata for one MyTube library video.",
    modes: ["api-key", "admin-session"],
    schema: z.object({ video_id: id }),
    annotations: { readOnlyHint: true },
    handler: async (api, args) => result({ video: await api.getVideo(String(args.video_id)) }),
  },
  {
    name: "get_author_channel_url",
    description: "Resolve the channel or author URL for a source URL.",
    modes: ["admin-session"],
    schema: z.object({ source_url: url }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (api, args) => api.getAuthorChannelUrl(String(args.source_url)),
  },
  {
    name: "get_video_comments",
    description: "Get available comments for a library video.",
    modes: ["admin-session"],
    schema: z.object({ video_id: id }),
    annotations: { readOnlyHint: true },
    handler: async (api, args) => result({ comments: await api.getComments(String(args.video_id)) }),
  },
  {
    name: "update_video",
    description: "Update title, tags, visibility, or subtitles metadata for a video.",
    modes: ["admin-session"],
    schema: z.object({ video_id: id, title: z.string().optional(), tags: z.array(z.string()).optional(), visibility: z.number().int().min(0).max(1).optional(), subtitles: z.unknown().optional() }),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (api, args) => {
      const { video_id, ...body } = args;
      return api.updateVideo(String(video_id), body);
    },
  },
  {
    name: "delete_video",
    description: "Delete a video record and its related files from MyTube.",
    modes: ["admin-session"],
    schema: z.object({ video_id: id }),
    annotations: { destructiveHint: true },
    handler: async (api, args) => api.deleteVideo(String(args.video_id)),
  },
  {
    name: "rate_video",
    description: "Set a 1–5 rating for a video.",
    modes: ["admin-session"],
    schema: z.object({ video_id: id, rating: z.number().int().min(1).max(5) }),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (api, args) => api.rateVideo(String(args.video_id), Number(args.rating)),
  },
  {
    name: "refresh_thumbnail",
    description: "Refresh a video thumbnail from a local frame when possible.",
    modes: ["admin-session"],
    schema: z.object({ video_id: id }),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (api, args) => api.refreshThumbnail(String(args.video_id)),
  },
  {
    name: "redownload_thumbnail",
    description: "Re-download a video thumbnail from its source URL.",
    modes: ["admin-session"],
    schema: z.object({ video_id: id }),
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
    handler: async (api, args) => api.refreshThumbnail(String(args.video_id), true),
  },
  {
    name: "upload_thumbnail",
    description: "Upload a local thumbnail file from an MCP_UPLOAD_ROOTS allow-listed path.",
    modes: ["admin-session"],
    schema: z.object({ video_id: id, thumbnail_path: z.string().trim().min(1) }),
    annotations: { destructiveHint: false },
    handler: async (api, args) => api.uploadThumbnail(String(args.video_id), String(args.thumbnail_path)),
  },
  {
    name: "increment_video_view",
    description: "Increment the MyTube view count for a video.",
    modes: ["admin-session"],
    schema: z.object({ video_id: id }),
    annotations: { destructiveHint: false },
    handler: async (api, args) => api.incrementView(String(args.video_id)),
  },
  {
    name: "save_video_progress",
    description: "Save playback progress for a video.",
    modes: ["admin-session"],
    schema: z.object({ video_id: id, progress: z.number().min(0) }),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (api, args) => api.saveProgress(String(args.video_id), Number(args.progress)),
  },
  {
    name: "upload_subtitle",
    description: "Upload a local VTT, SRT, ASS, or SSA subtitle file from an allowed path.",
    modes: ["admin-session"],
    schema: z.object({ video_id: id, language: z.string().optional(), subtitle_path: z.string().trim().min(1) }),
    annotations: { destructiveHint: false },
    handler: async (api, args) => api.uploadSubtitle(String(args.video_id), String(args.subtitle_path), args.language as string | undefined),
  },
  {
    name: "upload_video",
    description: "Upload one local video file from an MCP_UPLOAD_ROOTS allow-listed path.",
    modes: ["admin-session"],
    schema: z.object({ file_path: z.string().trim().min(1), title: z.string().optional(), author: z.string().optional() }),
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: async (api, args) => api.uploadVideo(String(args.file_path), args.title as string | undefined, args.author as string | undefined),
  },
  {
    name: "upload_videos_batch",
    description: "Upload multiple local video files from MCP_UPLOAD_ROOTS allow-listed paths.",
    modes: ["admin-session"],
    schema: z.object({ file_paths: z.array(z.string().trim().min(1)).min(1), title: z.string().optional(), author: z.string().optional() }),
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: async (api, args) => api.uploadVideosBatch(args.file_paths as string[], args.title as string | undefined, args.author as string | undefined),
  },
  {
    name: "list_collections",
    description: "List MyTube collections and their video memberships.",
    modes: ["api-key", "admin-session"],
    schema: empty,
    annotations: { readOnlyHint: true },
    handler: async (api) => result({ collections: await api.getCollections() }),
  },
  {
    name: "create_collection",
    description: "Create a collection, optionally adding one video.",
    modes: ["admin-session"],
    schema: z.object({ name: z.string().trim().min(1), video_id: z.string().optional() }),
    annotations: { destructiveHint: false, idempotentHint: false },
    handler: async (api, args) => api.createCollection(String(args.name), args.video_id as string | undefined),
  },
  {
    name: "update_collection",
    description: "Rename a collection or add/remove a video membership.",
    modes: ["admin-session"],
    schema: z.object({ collection_id: id, name: z.string().optional(), video_id: z.string().optional(), action: z.enum(["add", "remove"]).optional() }),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (api, args) => {
      const { collection_id, ...body } = args;
      return api.updateCollection(String(collection_id), { name: body.name, videoId: body.video_id, action: body.action });
    },
  },
  {
    name: "delete_collection",
    description: "Delete a collection, optionally deleting its videos too.",
    modes: ["admin-session"],
    schema: z.object({ collection_id: id, delete_videos: z.boolean().default(false) }),
    annotations: { destructiveHint: true },
    handler: async (api, args) => api.deleteCollection(String(args.collection_id), Boolean(args.delete_videos)),
  },
  {
    name: "list_subscriptions",
    description: "List channel, playlist, and Twitch subscriptions.",
    modes: ["admin-session"],
    schema: empty,
    annotations: { readOnlyHint: true },
    handler: async (api) => result({ subscriptions: await api.getSubscriptions() }),
  },
  {
    name: "create_subscription",
    description: "Create a channel subscription with an interval and optional initial download task.",
    modes: ["admin-session"],
    schema: z.object({ url, interval: z.number().int().positive(), author_name: z.string().optional(), download_all_previous: z.boolean().optional(), download_shorts: z.boolean().optional(), download_order: z.enum(["dateDesc", "dateAsc", "viewsDesc", "viewsAsc"]).optional() }),
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: async (api, args) => api.createSubscription({ url: args.url, interval: args.interval, authorName: args.author_name, downloadAllPrevious: args.download_all_previous, downloadShorts: args.download_shorts, downloadOrder: args.download_order }),
  },
  {
    name: "update_subscription",
    description: "Update a subscription interval or retention policy.",
    modes: ["admin-session"],
    schema: z.object({ subscription_id: id, interval: z.number().int().positive().optional(), retention_days: z.number().int().positive().nullable().optional() }).refine((value) => value.interval !== undefined || value.retention_days !== undefined, "At least one setting is required"),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (api, args) => api.updateSubscription(String(args.subscription_id), { interval: args.interval, retentionDays: args.retention_days }),
  },
  {
    name: "delete_subscription",
    description: "Delete a subscription.",
    modes: ["admin-session"],
    schema: z.object({ subscription_id: id }),
    annotations: { destructiveHint: true },
    handler: async (api, args) => api.subscriptionAction(String(args.subscription_id), "delete"),
  },
  {
    name: "pause_subscription",
    description: "Pause a subscription.",
    modes: ["admin-session"],
    schema: z.object({ subscription_id: id }),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (api, args) => api.subscriptionAction(String(args.subscription_id), "pause"),
  },
  {
    name: "resume_subscription",
    description: "Resume a paused subscription.",
    modes: ["admin-session"],
    schema: z.object({ subscription_id: id }),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (api, args) => api.subscriptionAction(String(args.subscription_id), "resume"),
  },
  {
    name: "create_playlist_subscription",
    description: "Create a playlist subscription and optional collection policy.",
    modes: ["admin-session"],
    schema: z.object({ playlist_url: url, interval: z.number().int().positive(), collection_name: z.string().trim().min(1), download_all: z.boolean().optional(), collection_info: record.optional() }),
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: async (api, args) => api.createPlaylistSubscription({ playlistUrl: args.playlist_url, interval: args.interval, collectionName: args.collection_name, downloadAll: args.download_all, collectionInfo: args.collection_info }),
  },
  {
    name: "subscribe_channel_playlists",
    description: "Subscribe to all playlists from a channel.",
    modes: ["admin-session"],
    schema: z.object({ url, interval: z.number().int().positive(), download_all_previous: z.boolean().optional() }),
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: async (api, args) => api.subscribeChannelPlaylists({ url: args.url, interval: args.interval, downloadAllPrevious: args.download_all_previous }),
  },
  {
    name: "download_channel_playlists",
    description: "Process and enqueue all playlists from a channel once.",
    modes: ["admin-session"],
    schema: z.object({ url }),
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: async (api, args) => api.downloadChannelPlaylists(String(args.url)),
  },
  {
    name: "list_tasks",
    description: "List continuous-download tasks.",
    modes: ["admin-session"],
    schema: empty,
    annotations: { readOnlyHint: true },
    handler: async (api) => result({ tasks: await api.getTasks() }),
  },
  {
    name: "cancel_task",
    description: "Cancel a continuous-download task.",
    modes: ["admin-session"],
    schema: z.object({ task_id: id }),
    annotations: { destructiveHint: true, idempotentHint: true },
    handler: async (api, args) => api.taskAction(String(args.task_id), "cancel"),
  },
  {
    name: "delete_task",
    description: "Delete a continuous-download task record.",
    modes: ["admin-session"],
    schema: z.object({ task_id: id }),
    annotations: { destructiveHint: true },
    handler: async (api, args) => api.taskAction(String(args.task_id), "delete"),
  },
  {
    name: "pause_task",
    description: "Pause a continuous-download task.",
    modes: ["admin-session"],
    schema: z.object({ task_id: id }),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (api, args) => api.taskAction(String(args.task_id), "pause"),
  },
  {
    name: "resume_task",
    description: "Resume a paused continuous-download task.",
    modes: ["admin-session"],
    schema: z.object({ task_id: id }),
    annotations: { destructiveHint: false, idempotentHint: true },
    handler: async (api, args) => api.taskAction(String(args.task_id), "resume"),
  },
  {
    name: "clear_finished_tasks",
    description: "Clear finished continuous-download task records.",
    modes: ["admin-session"],
    schema: empty,
    annotations: { destructiveHint: true },
    handler: async (api) => api.clearFinishedTasks(),
  },
  {
    name: "create_playlist_task",
    description: "Create a continuous-download task for one playlist.",
    modes: ["admin-session"],
    schema: z.object({ playlist_url: url, collection_name: z.string().trim().min(1) }),
    annotations: { destructiveHint: false, openWorldHint: true },
    handler: async (api, args) => api.createPlaylistTask({ playlistUrl: args.playlist_url, collectionName: args.collection_name }),
  },
  {
    name: "scan_files",
    description: "Scan MyTube’s configured uploads directory and synchronize files with the library.",
    modes: ["admin-session"],
    schema: z.object({ recursive: z.boolean().optional(), mount_mode: z.boolean().optional() }),
    annotations: { destructiveHint: false },
    handler: async (api, args) => api.maintenance("scan-files", { recursive: args.recursive, mount_mode: args.mount_mode }),
  },
  {
    name: "scan_mount_directories",
    description: "Scan explicitly named configured mount directories and synchronize them with MyTube.",
    modes: ["admin-session"],
    schema: z.object({ directories: z.array(z.string().trim().min(1)).min(1) }),
    annotations: { destructiveHint: false },
    handler: async (api, args) => api.scanMountDirectories(args.directories as string[]),
  },
  {
    name: "cleanup_temp_files",
    description: "Remove temporary MyTube download files.",
    modes: ["admin-session"],
    schema: empty,
    annotations: { destructiveHint: true },
    handler: async (api) => api.maintenance("cleanup-temp-files"),
  },
  {
    name: "get_system_version",
    description: "Check the installed MyTube version and whether an update is available.",
    modes: ["api-key", "admin-session"],
    schema: empty,
    annotations: { readOnlyHint: true, openWorldHint: true },
    handler: async (api) => api.getSystemVersion(),
  },
  {
    name: "get_cloud_signed_url",
    description: "Get a short-lived MyTube cloud-storage signed URL. Treat the returned URL as a bearer secret.",
    modes: ["admin-session"],
    schema: z.object({ filename: z.string().trim().min(1), type: z.enum(["video", "thumbnail"]).optional() }),
    annotations: { readOnlyHint: true },
    handler: async (api, args) => api.getCloudSignedUrl(String(args.filename), args.type as "video" | "thumbnail" | undefined),
  },
];

export const getToolDefinitions = (): readonly ToolDefinition[] => definitions;

export const registerTools = (
  server: McpServer,
  api: MyTubeApi,
  config: Config,
  logger = createLogger(config),
): string[] => {
  const limiter = new ConcurrencyLimiter(config.maxInFlight);
  const active = definitions.filter((definition) =>
    definition.modes.includes(config.authMode) &&
    (!config.allowedTools || config.allowedTools.has(definition.name)),
  );
  for (const definition of active) {
    server.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.schema as any,
        annotations: definition.annotations,
      },
      async (args: any, extra: any) => runTool(definition, api, args as Record<string, unknown>, extra as ToolExtra, config, limiter, logger),
    );
  }
  return active.map((definition) => definition.name);
};
