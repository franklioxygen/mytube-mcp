import fs from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import { assertSafeExternalUrl, resolveAllowedPath } from "../security.js";
import { MyTubeClient } from "./client.js";
import {
  collectionListSchema,
  downloadHistorySchema,
  downloadStatusSchema,
  subscriptionListSchema,
  taskListSchema,
  videoListSchema,
  type DownloadRequest,
  type SearchResult,
  type VersionResponse,
} from "./types.js";

const unwrap = <T>(value: unknown): T => {
  if (value && typeof value === "object" && "success" in value && "data" in value) {
    return (value as { data: T }).data;
  }
  return value as T;
};

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export class MyTubeApi {
  public constructor(
    private readonly client: MyTubeClient,
    private readonly config: Config,
  ) {}

  public async searchVideos(query: string, limit = 8, offset = 1): Promise<{ results: SearchResult[] }> {
    const response = await this.client.request<unknown>("/api/search", { query: { query, limit, offset } });
    const results = asObject(response).results;
    return { results: Array.isArray(results) ? results as SearchResult[] : [] };
  }

  public async downloadVideo(request: DownloadRequest): Promise<Record<string, unknown>> {
    assertSafeExternalUrl(request.youtubeUrl, this.config);
    const response = await this.client.request<unknown>("/api/download", {
      method: "POST",
      body: JSON.stringify(request),
    });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async listVideos(options: {
    limit?: number;
    offset?: number;
    author?: string;
    tag?: string;
    collectionId?: string;
  } = {}): Promise<{ videos: Record<string, unknown>[]; total: number }> {
    const response = await this.client.request<unknown>("/api/videos", {
      query: { limit: options.limit, offset: options.offset },
    });
    let videos = videoListSchema.parse(unwrap<unknown>(response));
    if (options.author) {
      const author = options.author.toLowerCase();
      videos = videos.filter((video) => String(video.author ?? "").toLowerCase().includes(author));
    }
    if (options.tag) {
      const tag = options.tag.toLowerCase();
      videos = videos.filter((video) => Array.isArray(video.tags) && video.tags.some((item) => String(item).toLowerCase() === tag));
    }
    if (options.collectionId) {
      const collection = await this.getCollection(options.collectionId);
      const ids = new Set(Array.isArray(collection.videos) ? collection.videos.map(String) : []);
      videos = videos.filter((video) => ids.has(String(video.id)));
    }
    return { videos, total: videos.length };
  }

  public async getVideo(videoId: string): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>(`/api/videos/${encodeURIComponent(videoId)}`);
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async getAuthorChannelUrl(sourceUrl: string): Promise<Record<string, unknown>> {
    assertSafeExternalUrl(sourceUrl, this.config);
    const response = await this.client.request<unknown>("/api/videos/author-channel-url", { query: { sourceUrl } });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async getCollections(): Promise<Record<string, unknown>[]> {
    const response = await this.client.request<unknown>("/api/collections");
    return collectionListSchema.parse(unwrap<unknown>(response));
  }

  public async getCollection(collectionId: string): Promise<Record<string, unknown>> {
    const collections = await this.getCollections();
    const collection = collections.find((item) => String(item.id) === collectionId);
    if (!collection) {
      throw new Error(`Collection ${collectionId} was not found.`);
    }
    return collection;
  }

  public async getSystemVersion(): Promise<VersionResponse> {
    const response = await this.client.request<unknown>("/api/system/version");
    return asObject(response) as VersionResponse;
  }

  public async getDownloadStatus(): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>("/api/download-status");
    const parsed = downloadStatusSchema.parse(unwrap<unknown>(response));
    return parsed as Record<string, unknown>;
  }

  public async getDownloadHistory(status?: string, limit?: number): Promise<{ history: Record<string, unknown>[] }> {
    const response = await this.client.request<unknown>("/api/downloads/history");
    let history = downloadHistorySchema.parse(unwrap<unknown>(response));
    if (status) {
      history = history.filter((item) => item.status === status);
    }
    if (limit !== undefined) {
      history = history.slice(0, limit);
    }
    return { history };
  }

  public async checkVideoDownloaded(url: string): Promise<Record<string, unknown>> {
    assertSafeExternalUrl(url, this.config);
    const response = await this.client.request<unknown>("/api/check-video-download", { query: { url } });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async inspectUrl(url: string): Promise<Record<string, unknown>> {
    const parsed = assertSafeExternalUrl(url, this.config);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname.includes("bilibili")) {
      const parts = asObject(unwrap(await this.client.request<unknown>("/api/check-bilibili-parts", { query: { url } })));
      const collection = asObject(unwrap(await this.client.request<unknown>("/api/check-bilibili-collection", { query: { url } })));
      if (collection.isCollection === true || collection.isSeries === true || collection.found === true) {
        return { kind: "bilibili_collection", ...collection };
      }
      if (parts.isMultiPart === true || parts.parts !== undefined || parts.totalParts !== undefined) {
        return { kind: "bilibili_parts", ...parts };
      }
      return { kind: "video" };
    }
    if (hostname.includes("youtube") || hostname === "youtu.be") {
      const playlist = asObject(unwrap(await this.client.request<unknown>("/api/check-playlist", { query: { url } })));
      if (playlist.isPlaylist === true || playlist.playlistId || playlist.found === true) {
        return { kind: "playlist", ...playlist };
      }
    }
    return { kind: "video" };
  }

  public async updateVideo(videoId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>(`/api/videos/${encodeURIComponent(videoId)}`, { method: "PUT", body: JSON.stringify(body) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async deleteVideo(videoId: string): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>(`/api/videos/${encodeURIComponent(videoId)}`, { method: "DELETE" });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async rateVideo(videoId: string, rating: number): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>(`/api/videos/${encodeURIComponent(videoId)}/rate`, { method: "POST", body: JSON.stringify({ rating }) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async refreshThumbnail(videoId: string, redownload = false): Promise<Record<string, unknown>> {
    const action = redownload ? "redownload-thumbnail" : "refresh-thumbnail";
    const response = await this.client.request<unknown>(`/api/videos/${encodeURIComponent(videoId)}/${action}`, { method: "POST" });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async uploadThumbnail(videoId: string, thumbnailPath: string): Promise<Record<string, unknown>> {
    const safePath = await resolveAllowedPath(thumbnailPath, this.config.uploadRoots);
    const form = new FormData();
    form.append("thumbnail", new Blob([await fs.readFile(safePath)]), path.basename(safePath) || "thumbnail.jpg");
    const response = await this.client.request<unknown>(`/api/videos/${encodeURIComponent(videoId)}/upload-thumbnail`, { method: "POST", body: form });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async incrementView(videoId: string): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>(`/api/videos/${encodeURIComponent(videoId)}/view`, { method: "POST" });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async saveProgress(videoId: string, progress: number): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>(`/api/videos/${encodeURIComponent(videoId)}/progress`, { method: "PUT", body: JSON.stringify({ progress }) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async uploadSubtitle(videoId: string, subtitlePath: string, language?: string): Promise<Record<string, unknown>> {
    const safePath = await resolveAllowedPath(subtitlePath, this.config.uploadRoots);
    const form = new FormData();
    form.append("subtitle", new Blob([await fs.readFile(safePath)]), path.basename(safePath) || "subtitle.vtt");
    if (language) form.append("language", language);
    const response = await this.client.request<unknown>(`/api/videos/${encodeURIComponent(videoId)}/subtitles`, { method: "POST", body: form });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async uploadVideo(filePath: string, title?: string, author?: string): Promise<Record<string, unknown>> {
    const safePath = await resolveAllowedPath(filePath, this.config.uploadRoots);
    const form = new FormData();
    form.append("video", new Blob([await fs.readFile(safePath)]), path.basename(safePath) || "video");
    if (title) form.append("title", title);
    if (author) form.append("author", author);
    const response = await this.client.request<unknown>("/api/upload", { method: "POST", body: form });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async uploadVideosBatch(filePaths: string[], title?: string, author?: string): Promise<Record<string, unknown>> {
    const form = new FormData();
    for (const filePath of filePaths) {
      const safePath = await resolveAllowedPath(filePath, this.config.uploadRoots);
      form.append("videos", new Blob([await fs.readFile(safePath)]), path.basename(safePath) || "video");
    }
    if (title) form.append("title", title);
    if (author) form.append("author", author);
    const response = await this.client.request<unknown>("/api/upload/batch", { method: "POST", body: form });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async createCollection(name: string, videoId?: string): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>("/api/collections", { method: "POST", body: JSON.stringify({ name, videoId }) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async updateCollection(collectionId: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>(`/api/collections/${encodeURIComponent(collectionId)}`, { method: "PUT", body: JSON.stringify(body) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async deleteCollection(collectionId: string, deleteVideos = false): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>(`/api/collections/${encodeURIComponent(collectionId)}`, { method: "DELETE", query: { deleteVideos } });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async getSubscriptions(): Promise<Record<string, unknown>[]> {
    const response = await this.client.request<unknown>("/api/subscriptions");
    return subscriptionListSchema.parse(unwrap<unknown>(response));
  }

  public async createSubscription(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>("/api/subscriptions", { method: "POST", body: JSON.stringify(body) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async updateSubscription(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>(`/api/subscriptions/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async subscriptionAction(id: string, action: "pause" | "resume" | "delete"): Promise<Record<string, unknown>> {
    const method = action === "delete" ? "DELETE" : "PUT";
    const response = await this.client.request<unknown>(`/api/subscriptions/${encodeURIComponent(id)}${action === "delete" ? "" : `/${action}`}`, { method });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async createPlaylistSubscription(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>("/api/subscriptions/playlist", { method: "POST", body: JSON.stringify(body) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async subscribeChannelPlaylists(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>("/api/subscriptions/channel-playlists", { method: "POST", body: JSON.stringify(body) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async downloadChannelPlaylists(url: string): Promise<Record<string, unknown>> {
    assertSafeExternalUrl(url, this.config);
    const response = await this.client.request<unknown>("/api/downloads/channel-playlists", { method: "POST", body: JSON.stringify({ url }) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async getTasks(): Promise<Record<string, unknown>[]> {
    const response = await this.client.request<unknown>("/api/subscriptions/tasks");
    return taskListSchema.parse(unwrap<unknown>(response));
  }

  public async taskAction(id: string, action: "pause" | "resume" | "cancel" | "delete"): Promise<Record<string, unknown>> {
    const method = action === "pause" || action === "resume" ? "PUT" : "DELETE";
    const suffix = action === "cancel" ? "" : action === "delete" ? "/delete" : `/${action}`;
    const response = await this.client.request<unknown>(`/api/subscriptions/tasks/${encodeURIComponent(id)}${suffix}`, { method });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async clearFinishedTasks(): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>("/api/subscriptions/tasks/clear-finished", { method: "DELETE" });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async createPlaylistTask(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>("/api/subscriptions/tasks/playlist", { method: "POST", body: JSON.stringify(body) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async queueAction(action: "cancel" | "remove" | "clear", id?: string): Promise<Record<string, unknown>> {
    const path = action === "cancel" ? `/api/downloads/cancel/${encodeURIComponent(id ?? "")}` : action === "remove" ? `/api/downloads/queue/${encodeURIComponent(id ?? "")}` : "/api/downloads/queue";
    const method = action === "cancel" ? "POST" : "DELETE";
    const response = await this.client.request<unknown>(path, { method });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async historyAction(action: "remove" | "clear", id?: string): Promise<Record<string, unknown>> {
    const path = action === "remove" ? `/api/downloads/history/${encodeURIComponent(id ?? "")}` : "/api/downloads/history";
    const response = await this.client.request<unknown>(path, { method: "DELETE" });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async maintenance(action: "scan-files" | "cleanup-temp-files", body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>(`/api/${action}`, { method: "POST", ...(action === "scan-files" ? { body: JSON.stringify(body ?? {}) } : {}) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async scanMountDirectories(directories: string[]): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>("/api/scan-mount-directories", { method: "POST", body: JSON.stringify({ directories }) });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async getCloudSignedUrl(filename: string, type?: "video" | "thumbnail"): Promise<Record<string, unknown>> {
    const response = await this.client.request<unknown>("/api/cloud/signed-url", { query: { filename, type } });
    return asObject(unwrap<Record<string, unknown>>(response));
  }

  public async getComments(videoId: string): Promise<unknown> {
    const response = await this.client.request<unknown>(`/api/videos/${encodeURIComponent(videoId)}/comments`);
    return unwrap(response);
  }
}
