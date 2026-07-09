import { z } from "zod";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export const downloadStatusSchema = z.object({
  activeDownloads: z.array(z.record(z.string(), z.unknown())).default([]),
  queuedDownloads: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const downloadHistorySchema = z.array(z.record(z.string(), z.unknown()));
export const videoSchema = z.record(z.string(), z.unknown());
export const videoListSchema = z.array(videoSchema);
export const collectionSchema = z.record(z.string(), z.unknown());
export const collectionListSchema = z.array(collectionSchema);
export const subscriptionSchema = z.record(z.string(), z.unknown());
export const subscriptionListSchema = z.array(subscriptionSchema);
export const taskListSchema = z.array(z.record(z.string(), z.unknown()));

export interface SearchResult {
  title: string;
  url: string;
  duration?: string | number;
  thumbnail?: string;
  channel?: string;
  [key: string]: unknown;
}

export interface DownloadRequest {
  youtubeUrl: string;
  downloadAllParts?: boolean;
  collectionName?: string;
  downloadCollection?: boolean;
  collectionInfo?: Record<string, unknown>;
  forceDownload?: boolean;
}

export interface DownloadStartResult {
  success?: boolean;
  message?: string;
  downloadId?: string;
  [key: string]: unknown;
}

export interface PasswordEnabledResponse {
  enabled?: boolean;
  loginRequired?: boolean;
  passwordLoginAllowed?: boolean;
  [key: string]: unknown;
}

export interface VersionResponse {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  hasUpdate: boolean;
  [key: string]: unknown;
}

export type DownloadTerminalStatus = "success" | "failed" | "partial";
