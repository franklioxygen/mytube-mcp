# MCP Server for MyTube — Design Document

Status: **Ready for implementation**
Spec baseline: [Model Context Protocol 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18)
Target product: [MyTube](https://github.com/franklioxygen/MyTube) v1.10.x (Express + TypeScript backend)

---

## 1. Summary

This document specifies a **Model Context Protocol (MCP) server** that exposes MyTube's capabilities to AI agents (Claude, ZCode, Cursor, Gemini CLI, any MCP-compatible client). An AI agent connecting to this server gains typed tools, resources, and prompts to **search for videos, enqueue downloads, inspect the library, manage collections, track download progress, and administer subscriptions** — without the agent needing to hand-craft HTTP calls, manage cookies/CSRF tokens, or reverse-engineer the REST surface.

The server is a thin, security-focused **protocol bridge**: it translates MCP primitives into authenticated calls against MyTube's existing HTTP API (`/api/*`). It introduces **no new business logic** in MyTube itself. It is shipped as a standalone Node/TypeScript package that agents run either as a local `stdio` child process or as a remote `Streamable HTTP` service.

**Why MCP over a generic HTTP tool wrapper:**

- MCP gives agents a **discovery mechanism** (`tools/list`, `resources/list`, `prompts/list`), so the agent learns the capabilities at runtime instead of being hardcoded to a schema.
- MCP defines **structured tool output** (typed content blocks) and **progress notifications**, which map cleanly onto MyTube's asynchronous download lifecycle (queue → active → success/failed).
- MCP clients already exist across the agent ecosystem; shipping an MCP server makes MyTube usable from all of them with one integration.

---

## 2. Goals

- Expose MyTube's core capabilities to AI agents through a typed, discoverable MCP interface.
- Support **two operational modes** without code forks:
  1. **API-key mode** — read-only library + download trigger (matches MyTube's existing `apiKeyEnabled` security boundary).
  2. **Admin/session mode** — full write surface (collections CRUD, subscriptions, queue control, video metadata, settings) via admin login.
- Provide clean abstractions for MyTube's asynchronous download model (poll-based progress, mapped to MCP progress notifications).
- Make installation a one-liner for popular MCP clients (Claude Desktop, ZCode, Cursor).
- Ship with a security model that is at least as strict as MyTube's REST surface, and documents every permission decision.

## 3. Non-goals

- **No reimplementation of MyTube logic.** The MCP server is a client of the HTTP API. It does not touch the SQLite DB, the download manager, or the filesystem directly.
- **No live-translation WebSocket exposure.** The Gemini live-translation WS (`/api/live-translation/ws`) is interactive, admin-only, and not API-key reachable; it is a poor fit for the request/response MCP tool model and is explicitly out of scope.
- **No cloud-sync streaming endpoint wrapper.** `POST /api/cloud/sync` is a chunked JSON-lines streaming response; it does not map cleanly to a synchronous tool. (A future "start cloud sync + poll job" wrapper could be added if the backend gains a job-id model.)
- **No browser/cookie automation.** The server will not drive a headless browser to satisfy logins. Admin mode uses the documented password-verification endpoint.
- **No frontend changes in this phase.** No UI is added to MyTube's web app to "configure MCP." Configuration lives in the MCP server's own config/env (the same way any MCP client config works).

---

## 4. Background: MCP Primitives (2025-06-18)

The MCP server exposes three server-side primitives:

| Primitive | Purpose | In MyTube context |
|---|---|---|
| **Tools** | Model-invoked functions with side effects; the agent decides when to call them. | `download_video`, `cancel_download`, `create_collection`, etc. |
| **Resources** | Application-controlled data the agent can read (URI-addressed, low mutation risk). | `mytube://library/videos/{id}`, `mytube://downloads/active`, `mytube://system/version` |
| **Prompts** | User-selected reusable instruction templates. | "Download this playlist and organize it," "Audit my subscriptions." |

Transports supported by the spec (both will be implemented):

- **stdio** — the server runs as a child process of the client (local single-user use; no network surface). Default for desktop clients.
- **Streamable HTTP** — the server is a long-lived HTTP service accepting `POST` JSON-RPC requests and optional SSE streams (remote/multi-user; replaces the deprecated HTTP+SSE transport from the 2025-03-26 draft).

Key spec behaviors the design relies on:

- **Structured tool output** — `CallToolResult` returns `content` blocks (`text`, `image`, `resource`, `audio`) plus an optional structured `data` object.
- **Progress notifications** — `notifications/progress` with `progressToken` for long-running tool calls. Used to stream download progress to the agent.
- **Tool annotations** (readOnlyHint, destructiveHint, idempotentHint, openWorldHint) — clients use these for confirmation gating and UI hints.
- **JSON-RPC 2.0** — request/response with optional batching removed in 2025-06-18.

---

## 5. MyTube Surface Analysis (what the MCP server wraps)

Derived from `backend/src/routes/api.ts`, `backend/src/server/apiRoutes.ts`, `backend/src/middleware/authMiddleware.ts`, and `documents/en/api-endpoints.md`.

### 5.1 Authentication paths in MyTube

MyTube resolves three credential mechanisms in `authMiddleware`:

1. **Session cookie** (`mytube_session`) — primary for the web UI; paired with double-submit CSRF (`x-csrf-token` header mirroring the `mytube_csrf` cookie) for all state-changing requests.
2. **Bearer JWT** (`Authorization: Bearer <token>`) — legacy compatibility.
3. **API key** (`x-api-key: <key>` or `Authorization: ApiKey <key>`) — constant-time compared in `backend/src/utils/apiKeyAuth.ts`; **bypasses CSRF entirely**; only enabled when `settings.apiKeyEnabled === true` and `settings.apiKey` is set.

**API-key scope is deliberately narrow.** Only routes marked `allowApiKey: true` in `apiRouteDefinitions` (`backend/src/routes/api.ts`) are reachable:

- `POST /api/download`
- `GET /api/videos`
- `GET /api/videos/:id`
- `GET /api/mount-video/:id`
- `GET /api/collections`
- `GET /api/system/version`

All other `/api/*` routes return `403` for API-key callers (`roleBasedAuthMiddleware` rejects API-key-authenticated requests outside the allowlist, with the single historical exception of `POST /download`). `/api/settings/*` is blocked entirely from API keys via `roleBasedSettingsMiddleware`.

**Implication for design:** API-key mode is excellent for a safe, read-mostly agent experience (search, browse, enqueue). Anything that mutates library/queue/subscription state requires **admin session mode**. The MCP server will support both, and the tool catalog the agent sees at `tools/list` is **dynamically pruned** based on which mode is configured.

### 5.2 Operations to expose (grouped)

| Group | Capability | Endpoint(s) | API-key? |
|---|---|---|---|
| **Search** | Search YouTube | `GET /api/search?query&limit&offset` | no |
| | Check if a URL is already downloaded | `GET /api/check-video-download?url` | no |
| | Detect Bilibili multi-part | `GET /api/check-bilibili-parts?url` | no |
| | Detect Bilibili collection | `GET /api/check-bilibili-collection?url` | no |
| | Validate playlist | `GET /api/check-playlist?url` | no |
| **Download (trigger)** | Enqueue a download | `POST /api/download` | **yes** |
| **Download (status)** | Active + queued status | `GET /api/download-status` | no |
| | History list | `GET /api/downloads/history` | no |
| | Cancel active/queued | `POST /api/downloads/cancel/:id` | no |
| | Remove queued | `DELETE /api/downloads/queue/:id` | no |
| | Clear queue | `DELETE /api/downloads/queue` | no |
| | Remove history row | `DELETE /api/downloads/history/:id` | no |
| | Clear history | `DELETE /api/downloads/history` | no |
| **Library (read)** | List videos | `GET /api/videos?limit&offset` | **yes** |
| | Get one video | `GET /api/videos/:id` | **yes** |
| | Stream mount video | `GET /api/mount-video/:id` | **yes** |
| | Author channel URL | `GET /api/videos/author-channel-url?sourceUrl` | no |
| | Comments | `GET /api/videos/:id/comments` | no |
| **Library (write)** | Update metadata | `PUT /api/videos/:id` | no |
| | Delete video | `DELETE /api/videos/:id` | no |
| | Upload subtitle | `POST /api/videos/:id/subtitles` | no |
| | Rate | `POST /api/videos/:id/rate` | no |
| | Refresh/redownload/upload thumbnail | `POST /api/videos/:id/{refresh,redownload,upload}-thumbnail` | no |
| | Increment view | `POST /api/videos/:id/view` | no |
| | Save progress | `PUT /api/videos/:id/progress` | no |
| | Upload local file | `POST /api/upload` / `/api/upload/batch` | no |
| **Collections** | List | `GET /api/collections` | **yes** |
| | Create / update / delete | `POST /api/collections`, `PUT /api/collections/:id`, `DELETE /api/collections/:id` | no |
| **Subscriptions** | CRUD + pause/resume | `/api/subscriptions/*` | no |
| | Continuous-download tasks | `/api/subscriptions/tasks/*` | no |
| **Maintenance** | Scan files | `POST /api/scan-files` | no |
| | Cleanup temp | `POST /api/cleanup-temp-files` | no |
| **Cloud** | Signed URL | `GET /api/cloud/signed-url` | no |
| **System** | Version + update check | `GET /api/system/version` | **yes** |

### 5.3 Asynchrony model

MyTube downloads are fire-and-poll: `POST /api/download` returns `{ success, message, downloadId }` immediately; the client observes `GET /api/download-status` (active/queued with progress/speed/totalSize) and `GET /api/downloads/history` (final outcomes, including `pending_retry`, `success`, `failed`, `partial`, `skipped`, `deleted`). There is no push/webhook for completion. The MCP server turns this into a clean agent experience via **progress notifications** (see §9).

---

## 6. High-level Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                      MCP Client (agent)                        │
│   Claude Desktop / ZCode / Cursor / Gemini CLI / custom        │
└──────────────┬───────────────────────────────┬─────────────────┘
               │ JSON-RPC 2.0 over stdio        │ (or Streamable HTTP)
               │  tools/list, tools/call,       │
               │  resources/list, resources/read│
               │  prompts/list, prompts/get     │
               ▼                                ▼
┌──────────────────────────────────────────────────────────────────┐
│                  mytube-mcp server (new)                         │
│  ┌──────────────── ┌───────────────── ┌───────────────────────┐ │
│  │ Transport layer │ Tool registry   │ Resource/Prompt reg.   │ │
│  │ (stdio / HTTP)  │ (capability-     │                        │ │
│  │                 │  gated)          │                        │ │
│  └────────┬──────── └──────┬────────── └───────────┬───────────┘ │
│           │                 │                      │             │
│  ┌────────▼─────────────────▼──────────────────────▼───────────┐ │
│  │              MyTube HTTP client (typed wrapper)             │ │
│  │  • auth strategy resolver (api-key | admin-session)         │ │
│  │  • request/response typing (zod schemas)                    │ │
│  │  • CSRF token handling (admin mode only)                    │ │
│  │  • retry/backoff, timeout, structured error mapping         │ │
│  └────────┬────────────────────────────────────────────────────┘ │
└───────────┼──────────────────────────────────────────────────────┘
            │ HTTPS (default) — Bearer/cookie/api-key headers
            ▼
┌──────────────────────────────────────────────────────────────────┐
│                   MyTube backend (unchanged)                     │
│   /api/* Express routers, existing auth + rate-limit stack       │
└──────────────────────────────────────────────────────────────────┘
```

**Language/runtime:** Node.js 20+ / TypeScript (matches MyTube's existing toolchain: `tsc`, `vitest`). Uses the official `@modelcontextprotocol/sdk` for protocol correctness.

**Package layout (new repo or monorepo workspace `mcp/`):**

```
mcp/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                  # entry: parse config, pick transport, start server
│   ├── config.ts                 # env + file config parsing & validation (zod)
│   ├── transport.ts              # stdio | streamable-http wiring
│   ├── server.ts                 # MCP Server construction, capability gating
│   ├── mytube/
│   │   ├── client.ts             # fetch wrapper, auth strategy, error mapping
│   │   ├── auth.ts               # api-key strategy, admin-session strategy (CSRF dance)
│   │   ├── types.ts              # typed request/response shapes (zod)
│   │   └── endpoints.ts          # typed wrappers per /api/* route
│   ├── tools/
│   │   ├── registry.ts           # capability-gated tool registration
│   │   ├── search.ts
│   │   ├── download.ts
│   │   ├── library.ts
│   │   ├── collections.ts
│   │   ├── subscriptions.ts
│   │   ├── queue.ts
│   │   └── system.ts
│   ├── resources/
│   │   └── registry.ts           # URI templates -> handlers
│   ├── prompts/
│   │   └── registry.ts
│   └── __tests__/
│       └── ...                   # vitest + mcp test fixtures
├── examples/
│   ├── claude-desktop-config.json
│   ├── zcode-mcp.json
│   └── docker-compose.streamable-http.yml
└── Dockerfile
```

---

## 7. Configuration

Resolved from environment variables (with optional `.env`), validated with **zod** so a misconfigured server fails fast with a clear message.

| Env var | Required | Default | Description |
|---|---|---|---|
| `MYTUBE_BASE_URL` | yes | — | Base URL of the MyTube server, e.g. `https://mytube.example.com`. Must include scheme. |
| `MYTUBE_AUTH_MODE` | yes | `api-key` | One of `api-key`, `admin-session`. Selects the auth strategy and prunes the tool catalog. |
| `MYTUBE_API_KEY` | **api-key mode** | — | The MyTube API key (matches `settings.apiKey`). Sent as `x-api-key`. |
| `MYTUBE_ADMIN_PASSWORD` | **admin-session mode** | — | Admin password used to log in at startup via `POST /api/settings/verify-admin-password`. |
| `MYTUBE_REQUEST_TIMEOUT_MS` | no | `30000` | Per-request timeout for HTTP calls to MyTube. |
| `MYTUBE_DOWNLOAD_POLL_INTERVAL_MS` | no | `2000` | Interval for progress polling during `await_download` tool option. |
| `MYTUBE_DOWNLOAD_POLL_TIMEOUT_MS` | no | `600000` | Max time a tool call will wait for a download before returning "still running." |
| `MYTUBE_ALLOW_INSECURE_TLS` | no | `false` | Set `true` only for local HTTP dev (never for remote). Refuses self-signed certs otherwise. |
| `MCP_TRANSPORT` | no | `stdio` | `stdio` or `http`. |
| `MCP_HTTP_PORT` | no | `3100` | Port for streamable-http transport. |
| `MCP_HTTP_BIND` | no | `127.0.0.1` | Bind address. Default loopback — see §12 for remote exposure guidance. |
| `MCP_LOG_LEVEL` | no | `info` | `error`/`warn`/`info`/`debug`. stdio logs go to stderr only (stdout is reserved for JSON-RPC). |

**Config resolution rules:**

- If `MYTUBE_AUTH_MODE=api-key`, `MYTUBE_API_KEY` is required and `MYTUBE_ADMIN_PASSWORD` must be absent (fail if both are set, to avoid accidental privilege bleed).
- If `MYTUBE_AUTH_MODE=admin-session`, `MYTUBE_ADMIN_PASSWORD` is required.
- `MYTUBE_BASE_URL` must pass URL validation; reject if it lacks `https://` **unless** the host is `localhost`/`127.0.0.1`/`*.local` or `MYTUBE_ALLOW_INSECURE_TLS=true`.
- Secrets are never logged. The server redacts `MYTUBE_API_KEY`/`MYTUBE_ADMIN_PASSWORD`/`Cookie`/`x-csrf-token` in all log output.

---

## 8. Authentication Strategy

### 8.1 API-key strategy (default, least-privilege)

Every outbound request to MyTube carries:

```
x-api-key: <MYTUBE_API_KEY>
Accept: application/json
```

No cookies, no CSRF tokens. This matches MyTube's `apiKeyAuth.ts` path, which explicitly bypasses CSRF (`shouldSkipCsrfProtection`). The reachable surface is exactly the `allowApiKey: true` set in §5.1, so the **MCP tool registry in api-key mode only registers the safe subset** (see §10.1). The agent never even sees the unavailable tools — this is a security feature, not just a UX one.

### 8.2 Admin-session strategy (full surface)

At server startup (and on session expiry):

1. `POST /api/settings/verify-admin-password` with body `{ password }`.
2. MyTube responds `200`, sets the `mytube_session` cookie (HTTP-only) and the `X-CSRF-Token` response header, and returns `{ authenticated: true }`.
3. The MCP server persists **in memory only**:
   - the cookie jar (`mytube_session`, `mytube_csrf`),
   - the CSRF token (echoed back as `x-csrf-token` on every mutating request).
4. Every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) includes both the cookie and `x-csrf-token: <stored>`.
5. GETs include the cookie only (CSRF is not enforced on GETs in MyTube).
6. On `401`/`403` responses that look like session expiry, the server re-authenticates once and retries the original request (single retry).

**Security notes:**

- Credentials are held in process memory only; never written to disk.
- The CSRF token is treated as a secret: not logged, not exposed through any tool/resource/prompt output.
- If `loginEnabled === false` on the MyTube server (single-user/owner mode, the default), the admin password may be unset and `verify-admin-password` is a no-op; the MCP server detects this via `GET /api/settings/password-enabled` and degrades gracefully to an unauthenticated session (which still works because owner-mode treats all callers as admin). The server logs a warning in this case.

### 8.3 Capability detection

At startup and periodically (every 10 min), the server calls `GET /api/system/version` (api-key reachable, safe) to confirm connectivity and credentials. A `401`/`403` aborts startup with a clear error: "API key rejected — verify `MYTUBE_API_KEY` and that `apiKeyEnabled` is on in MyTube settings."

---

## 9. Tools

Each tool below specifies: name, description (as seen by the agent), input schema (zod-derived JSON Schema), output, **annotations**, and **required auth mode**. Tool names use `snake_case` per MCP convention.

### 9.1 Search & discovery

#### `search_videos`
- **Description:** Search YouTube (and other supported sources via yt-dlp) for videos matching a query. Returns titles, URLs, durations, and thumbnails.
- **Input:** `{ query: string (required), limit?: number (1–50, default 8), offset?: number (default 1) }`
- **Calls:** `GET /api/search`
- **Output (structured `data`):** `{ results: Array<{ title, url, duration?, thumbnail?, channel? }> }` plus a `text` content block summarizing the list.
- **Annotations:** `{ readOnlyHint: true, openWorldHint: true }` (causes outbound network to YouTube via the backend).

#### `check_video_downloaded`
- **Description:** Check whether a source URL has already been downloaded into this MyTube library. Resolves short URLs.
- **Input:** `{ url: string }`
- **Calls:** `GET /api/check-video-download?url=`
- **Output:** `{ found: boolean, status?: "exists"|"deleted", videoId?: string, title?: string }`
- **Annotations:** `{ readOnlyHint: true }`
- **Mode:** api-key or admin (this endpoint is not in the api-key allowlist, so api-key mode will only expose it if a future MyTube release adds `allowApiKey`; otherwise admin-only — see §10.1 gating).

#### `inspect_url`
- **Description:** Inspect a URL to determine its type (single video, Bilibili multi-part, Bilibili collection, or playlist) before downloading.
- **Input:** `{ url: string }`
- **Calls:** `GET /api/check-bilibili-parts`, `GET /api/check-bilibili-collection`, `GET /api/check-playlist` (the relevant ones based on URL heuristic in `utils/helpers.ts`: `isBilibiliUrl`, `isYouTubeUrl`, `isTwitchVideoUrl`, `isMissAVUrl`).
- **Output:** `{ kind: "video"|"bilibili_parts"|"bilibili_collection"|"playlist"|"unknown", parts?: number, ... }`
- **Annotations:** `{ readOnlyHint: true, openWorldHint: true }`

### 9.2 Download lifecycle

#### `download_video`
- **Description:** Enqueue a video (or playlist/collection) for download. Returns immediately with a `downloadId`; use `await` to block until completion or `get_download_status` to poll.
- **Input:**
  ```jsonc
  {
    "url": "string (required)",
    "download_all_parts"?: "boolean",        // Bilibili multi-part
    "collection_name"?: "string",            // organize into a collection
    "download_collection"?: "boolean",       // download a Bilibili collection
    "collection_info"?: "object",            // advanced collection metadata
    "force_download"?: "boolean",            // bypass dedup
    "await_completion"?: "boolean (default false)",
    "await_timeout_ms"?: "number (default 600000, max MYTUBE_DOWNLOAD_POLL_TIMEOUT_MS)"
  }
  ```
- **Calls:** `POST /api/download` with body `{ youtubeUrl, downloadAllParts, collectionName, downloadCollection, collectionInfo, forceDownload }`.
- **Output (immediate):** `{ downloadId: string, message: string, state: "queued"|"active" }`.
- **Output (if `await_completion=true`):** emits `notifications/progress` with `{ progress, ratio, speed, totalSize }` polled from `GET /api/download-status`, then a final structured result `{ downloadId, state: "success"|"failed"|"partial", videoId?, title?, error? }` derived from `GET /api/downloads/history`.
- **Annotations:** `{ destructiveHint: false, idempotentHint: true (same URL dedups unless force), openWorldHint: true }`
- **Mode:** **api-key or admin.** This is the headline capability.

#### `get_download_status`
- **Description:** List currently active and queued downloads with progress.
- **Input:** `{}` (no params).
- **Calls:** `GET /api/download-status`.
- **Output:** `{ active: DownloadTask[], queued: DownloadTask[] }` where `DownloadTask = { id, title, progress, speed, totalSize, url, type }`.
- **Annotations:** `{ readOnlyHint: true }`

#### `get_download_history`
- **Description:** List past downloads and their final status (success/failed/pending_retry/etc.).
- **Input:** `{ status?: "success"|"failed"|"partial"|"pending_retry"|"skipped"|"deleted", limit?: number }`.
- **Calls:** `GET /api/downloads/history` (client-side filtering since the endpoint returns full history).
- **Output:** `{ history: DownloadHistoryRow[] }`.
- **Annotations:** `{ readOnlyHint: true }`

#### `cancel_download` *(admin only)*
- **Description:** Cancel an active or queued download by id.
- **Input:** `{ download_id: string }`.
- **Calls:** `POST /api/downloads/cancel/:id`.
- **Annotations:** `{ destructiveHint: true, idempotentHint: true }`

#### `remove_from_queue` / `clear_queue` *(admin only)*
- **Input:** `{ download_id: string }` / `{}`.
- **Calls:** `DELETE /api/downloads/queue/:id` / `DELETE /api/downloads/queue`.
- **Annotations:** `{ destructiveHint: true }`

#### `remove_history_row` / `clear_history` *(admin only)*
- **Input:** `{ history_id: string }` / `{}`.
- **Calls:** `DELETE /api/downloads/history/:id` / `DELETE /api/downloads/history`.
- **Note:** MyTube refuses to delete `pending_retry` rows; this is surfaced verbatim to the agent.

### 9.3 Library (read)

#### `list_videos`
- **Description:** List videos in the library (summaries). Supports pagination.
- **Input:** `{ limit?: number, offset?: number, author?: string, tag?: string, collection_id?: string }` (author/tag/collection filters applied client-side since `GET /api/videos` does not currently server-side filter).
- **Calls:** `GET /api/videos?limit&offset`.
- **Output:** `{ videos: VideoSummary[], total: number }`.
- **Annotations:** `{ readOnlyHint: true }`
- **Mode:** **api-key or admin.**

#### `get_video`
- **Description:** Get full details of one video: description, subtitles, file size, duration, progress, source URL.
- **Input:** `{ video_id: string }`.
- **Calls:** `GET /api/videos/:id`.
- **Output:** full `Video` record (per `backend/src/db/schema.ts`).
- **Annotations:** `{ readOnlyHint: true }`
- **Mode:** **api-key or admin.**

### 9.4 Library (write) — admin only

#### `update_video`
- **Input:** `{ video_id, title?, tags?, visibility?, subtitles? }` → `PUT /api/videos/:id`.
- **Annotations:** `{ destructiveHint: false, idempotentHint: true }`.

#### `delete_video`
- **Input:** `{ video_id }` → `DELETE /api/videos/:id`.
- **Annotations:** `{ destructiveHint: true }`.

#### `rate_video`
- **Input:** `{ video_id, rating: 1–5 }` → `POST /api/videos/:id/rate`.

#### `refresh_thumbnail` / `redownload_thumbnail`
- **Input:** `{ video_id }` → `POST /api/videos/:id/{refresh|redownload}-thumbnail`.

#### `upload_subtitle`
- **Input:** `{ video_id, language?, subtitle_path }` → multipart `POST /api/videos/:id/subtitles`. The MCP server reads the local file path supplied by the agent and streams it as multipart. Supported formats: `.vtt/.srt/.ass/.ssa`.
- **Annotations:** `{ destructiveHint: false }`.

#### `upload_video` / `upload_videos_batch`
- **Input:** `{ file_paths: string[], title?, author? }` → `POST /api/upload` or `/api/upload/batch` (multipart). The server validates that paths are within an allow-listed directory (see §12.4).
- **Annotations:** `{ destructiveHint: false, openWorldHint: true }`.

### 9.5 Collections

#### `list_collections`
- **Description:** List all collections (playlists).
- **Calls:** `GET /api/collections`.
- **Annotations:** `{ readOnlyHint: true }`
- **Mode:** **api-key or admin.**

#### `create_collection` / `update_collection` / `delete_collection` *(admin only)*
- `create`: `{ name, video_id? }` → `POST /api/collections`.
- `update`: `{ collection_id, name?, video_id?, action: "add"|"remove" }` → `PUT /api/collections/:id`.
- `delete`: `{ collection_id, delete_videos?: boolean }` → `DELETE /api/collections/:id`.
- **Annotations:** delete is `{ destructiveHint: true }`.

### 9.6 Subscriptions — admin only

- `list_subscriptions` → `GET /api/subscriptions` *(readOnly)*.
- `create_subscription` → `POST /api/subscriptions` body `{ url, interval, author_name?, download_all_previous?, download_shorts?, download_order? }`.
- `update_subscription` → `PUT /api/subscriptions/:id` (interval/retention_days).
- `delete_subscription` → `DELETE /api/subscriptions/:id` *(destructive)*.
- `pause_subscription` / `resume_subscription` → `PUT /api/subscriptions/:id/{pause|resume}`.
- `create_playlist_subscription` → `POST /api/subscriptions/playlist`.
- `subscribe_channel_playlists` → `POST /api/subscriptions/channel-playlists`.
- Continuous-download task lifecycle: `list_tasks`, `cancel_task`, `delete_task`, `pause_task`, `resume_task`, `clear_finished_tasks`, `create_playlist_task` → `/api/subscriptions/tasks/*`.

### 9.7 Queue maintenance — admin only

- `scan_files` → `POST /api/scan-files` body `{ recursive?, mount_mode? }`.
- `cleanup_temp_files` → `POST /api/cleanup-temp-files` *(destructive)*.

### 9.8 System

#### `get_system_version`
- **Description:** Check the installed MyTube version and whether an update is available.
- **Calls:** `GET /api/system/version`.
- **Output:** `{ currentVersion, latestVersion, releaseUrl, hasUpdate }`.
- **Annotations:** `{ readOnlyHint: true, openWorldHint: true }` (backend calls GitHub).
- **Mode:** **api-key or admin.**

---

## 10. Capability Gating

### 10.1 Mode → tool catalog

The `tools/list` response is built dynamically at server startup based on `MYTUBE_AUTH_MODE` and a per-tool `modes` declaration. The agent only sees what it can actually call.

| Tool | api-key mode | admin-session mode |
|---|:---:|:---:|
| `search_videos` | ✓ | ✓ |
| `check_video_downloaded` | ✗ (endpoint blocks api-key) | ✓ |
| `inspect_url` | ✗ | ✓ |
| `download_video` | ✓ | ✓ |
| `get_download_status` | ✗ | ✓ |
| `get_download_history` | ✗ | ✓ |
| `cancel_download` / queue control | ✗ | ✓ |
| `list_videos` / `get_video` | ✓ | ✓ |
| `list_collections` | ✓ | ✓ |
| library write tools | ✗ | ✓ |
| collections write tools | ✗ | ✓ |
| subscriptions tools | ✗ | ✓ |
| maintenance tools | ✗ | ✓ |
| `get_system_version` | ✓ | ✓ |

> **Rationale for hiding rather than erroring:** If a tool is listed but always returns 403, the agent wastes turns attempting it. Hiding unavailable tools is both more honest and safer — the agent cannot even attempt a privileged path it cannot reach.

### 10.2 Runtime downgrade

If an admin-session tool call returns `403` because the MyTube server has tightened permissions (e.g., admin trust level changed), the server returns a typed MCP error with code `MYTUBE_FORBIDDEN` and a human-readable hint, rather than retrying blindly.

---

## 11. Resources

Resources are URI-addressed, read-only data the agent or user can pin into context. They never mutate state. URI scheme: `mytube://`.

| URI template | Handler | Mode |
|---|---|---|
| `mytube://library/videos` | `GET /api/videos` (full list, may be large; paginated via `?cursor=`) | api-key/admin |
| `mytube://library/videos/{id}` | `GET /api/videos/:id` | api-key/admin |
| `mytube://library/collections` | `GET /api/collections` | api-key/admin |
| `mytube://downloads/active` | `GET /api/download-status` | admin |
| `mytube://downloads/history` | `GET /api/downloads/history` | admin |
| `mytube://subscriptions` | `GET /api/subscriptions` | admin |
| `mytube://system/version` | `GET /api/system/version` | api-key/admin |

**Resource content types:**

- Library/video resources return JSON serialized as a `text` content block with `mimeType: application/json`.
- For `mytube://library/videos/{id}`, if a thumbnail is available and the client opts in, an additional `image` content block (base64 JPEG) is attached — useful for multimodal agents.

**Security:** Resources never include secrets (no settings resource exposing `apiKey`, `openListToken`, Telegram bot token, etc.). There is deliberately **no `mytube://settings` resource** in admin mode — settings contain live secrets (API keys, cloud-drive tokens) and exposing them to an agent context window risks leakage. Settings operations are deferred to a future, scoped design (see §17).

---

## 12. Prompts

User-invoked templates that compose multiple tools into a workflow.

#### `download-and-organize`
- **Arguments:** `{ url: string, collection?: string }`
- **Body:** "Use `inspect_url` to classify the URL. If it is a playlist or Bilibili collection, ask the user how to handle parts. Then call `download_video` (with `await_completion=true`). On success, if a `collection` argument was provided, ensure the collection exists and add the resulting video(s) to it via `update_collection`. Report a final summary."

#### `audit-subscriptions` *(admin)*
- **Arguments:** none.
- **Body:** "List all subscriptions via `list_subscriptions`. For each, summarize interval, last downloaded video, and failure streak (if visible). Flag any subscription paused for >7 days or with a high failure streak. Suggest cleanup actions."

#### `library-report` *(admin)*
- **Arguments:** `{ since?: date }`
- **Body:** "Summarize the library: total videos, top authors by count, recent downloads (from `get_download_history`), and any videos missing thumbnails or subtitles."

#### `find-and-download`
- **Arguments:** `{ query: string, max?: number }`
- **Body:** "Search YouTube via `search_videos`. Present the top results to the user. After the user picks one, call `check_video_downloaded` to avoid duplicates, then `download_video`. Confirm completion."

---

## 13. Transports

### 13.1 stdio (default)

The server is spawned by the MCP client as a child process. It reads JSON-RPC from stdin, writes to stdout, and logs to **stderr only** (stdout is the protocol channel — any stray log line on stdout corrupts the stream, a common MCP bug the design avoids by construction).

**Client config example (Claude Desktop / ZCode):**

```json
{
  "mcpServers": {
    "mytube": {
      "command": "npx",
      "args": ["-y", "mytube-mcp"],
      "env": {
        "MYTUBE_BASE_URL": "https://mytube.example.com",
        "MYTUBE_AUTH_MODE": "api-key",
        "MYTUBE_API_KEY": "••••••••"
      }
    }
  }
}
```

### 13.2 Streamable HTTP (remote)

The server runs as a long-lived HTTP service. The single endpoint (e.g. `POST /mcp`) accepts JSON-RPC requests and may upgrade to SSE for streaming responses/notifications. Session management uses the `Mcp-Session-Id` header per spec.

**Security hardening for HTTP transport (mandatory — see §14):**

- Bind to loopback by default (`MCP_HTTP_BIND=127.0.0.1`).
- Require TLS termination at a reverse proxy (nginx/Caddy) in front; refuse plain `http://` for non-loopback hosts.
- Optional bearer-token gate (`MCP_HTTP_BEARER_TOKEN`): if set, every request must carry `Authorization: Bearer <token>`; mismatched → `401`. This protects the HTTP endpoint independently of MyTube credentials (defense in depth — without it, anyone reaching the HTTP endpoint could use the server's stored MyTube credentials).
- Per-IP rate limiting (e.g., 600 req/min) to blunt abuse.
- Session IDs are 256-bit random, single-use per connection, expire after 5 min idle.

---

## 14. Security Design

This section is first-class — an MCP server is a credentials-bearing bridge that turns natural language into privileged actions. The threat model below is explicit.

### 14.1 Threat model

| Threat | Mitigation |
|---|---|
| **Credential leakage** (API key / admin password / CSRF token / session cookie appearing in agent context, logs, or tool output) | Secrets held in memory only; redacted in all logs; **never** returned by any tool, resource, or prompt output. No `settings` resource. |
| **Privilege escalation via the agent** (an agent tricked by a prompt-injection in video metadata into calling `delete_video`) | (a) Destructive tools carry `destructiveHint: true` so confirming clients prompt the user. (b) Optional **destructive-action allowlist** (`MCP_ALLOWED_TOOLS`) — if set, only listed tools are registered; e.g., omit `delete_video`, `clear_queue`. (c) Optional **dry-run/confirmation middleware** that intercepts destructive calls and returns "confirmation required" the first time. |
| **SSRF via the agent supplying arbitrary URLs** to `download_video` | MyTube itself validates URLs (`validateUrl` in `utils/security.ts`) — defense inherited. The MCP server additionally rejects obviously-internal URLs (`localhost`, `169.254.0.0/16`, `10/8`, `172.16/12`, `192.168/16`, `127/8`) at the tool layer before they reach the backend, with an opt-out for self-hosted LAN deployments. |
| **Path traversal via `upload_video`/`upload_subtitle`** (agent passes `/etc/passwd`) | The MCP server resolves supplied paths and **rejects any that escape a configured allowlist** (`MCP_UPLOAD_ROOTS`, default: none — uploads disabled until the operator sets a directory). Symlinks are resolved (`fs.realpath`) before the check. |
| **Prompt injection from downloaded content** (video titles/descriptions containing "ignore previous instructions…") | Tool outputs are framed as **data, not instructions**. The server does not concatenate tool output into any prompt that itself contains privileged instructions. Agents and their clients are responsible for treating resource content as untrusted (per MCP guidance); this is documented in the README. |
| **Replay of stolen session** in admin mode | Session/cookie is process-local; the server does not expose an endpoint to dump it. HTTP transport adds its own bearer gate. |
| **MITM on the MyTube link** | HTTPS required for non-loopback `MYTUBE_BASE_URL`; `MYTUBE_ALLOW_INSECURE_TLS` defaults false. |
| **Denial of service** (agent loops calling expensive tools) | Client-side concurrency cap (max 4 in-flight tool calls); per-call timeout (`MYTUBE_REQUEST_TIMEOUT_MS`); poll loops bounded by `MYTUBE_DOWNLOAD_POLL_TIMEOUT_MS`. |
| **Information disclosure via error messages** | Errors mapped to typed MCP errors with generic messages; full details only at `debug` log level on stderr. |

### 14.2 Principle of least privilege

- The recommended deployment is **api-key mode**: an agent that can search, browse, and enqueue downloads but cannot delete anything. This matches the principle that an AI assistant should not hold more privilege than the task requires.
- Admin-session mode is opt-in and documented as "use only when the agent must manage subscriptions, edit metadata, or control the queue." Operators are warned in the README.

### 14.3 Auditability

Every tool invocation logs (to stderr, structured JSON):

```json
{ "ts": "...", "level": "info", "tool": "download_video",
  "args_summary": { "url": "https://youtu.be/...", "await_completion": true },
  "mytube_status": 200, "duration_ms": 1234, "result_state": "queued" }
```

Arguments are summarized (URLs kept, file paths kept, no secrets ever). This gives operators a record of what the agent did.

### 14.4 What the server deliberately does NOT do

- Does not store MyTube credentials on disk (no credential file, no keychain integration in v1).
- Does not expose `/api/settings/*` (contains live secrets and can change security-critical config like `apiKeyEnabled`, `loginEnabled`, trust level).
- Does not expose database backup/restore, hooks upload, or passkey management — these are high-impact admin operations with no safe agent UX.
- Does not execute hook scripts or shell commands (MyTube hooks are out of scope).
- Does not auto-rotate the API key or session.

---

## 15. Error Handling & Mapping

MyTube HTTP errors are mapped to MCP errors with stable codes so agents can branch on them:

| MyTube response | MCP error code | `message` |
|---|---|---|
| `400` ValidationError | `-32602` (Invalid params) | "Invalid argument: <field>" |
| `401` (auth required) | `-32001` (`MYTUBE_UNAUTHORIZED`) | "Authentication required or expired" |
| `403` (forbidden) | `-32002` (`MYTUBE_FORBIDDEN`) | "Not permitted in current auth mode" |
| `404` | `-32004` (`MYTUBE_NOT_FOUND`) | "Resource not found" |
| `408` / timeout | `-32008` (`MYTUBE_TIMEOUT`) | "MyTube did not respond in time" |
| `409` (e.g., cleanup while downloads active) | `-32009` (`MYTUBE_CONFLICT`) | verbatim backend message |
| `429` (rate limited) | `-32010` (`MYTUBE_RATE_LIMITED`) | "Rate limited; retry after N s" |
| `5xx` | `-32603` (Internal error) | generic; details logged at debug |
| network error | `-32013` (`MYTUBE_UNREACHABLE`) | "Cannot reach MyTube at <base url>" |

`isApiKeyDownloadEndpoint` and similar special cases in MyTube's middleware produce `403` for api-key callers reaching admin endpoints; the server pre-empts this by gating tools (§10), so a well-behaved agent never triggers it.

---

## 16. Implementation Plan

Sequenced for incremental delivery. Each phase is independently shippable.

### Phase 1 — Skeleton & api-key read+download (MVP)
1. Scaffold package, tsconfig, vitest, ESLint config matching MyTube's.
2. `config.ts` with zod validation; `.env.example`.
3. `mytube/client.ts`: fetch wrapper with api-key strategy, timeout, retry-on-network-error, typed error mapping.
4. `mytube/endpoints.ts`: typed wrappers for the api-key-reachable set.
5. Tools: `search_videos`, `download_video` (no await), `list_videos`, `get_video`, `list_collections`, `get_system_version`.
6. stdio transport; structured stderr logging.
7. Tests: unit tests for client + tools using a recorded fixture server.
8. README with Claude Desktop / ZCode config snippets.

### Phase 2 — Progress streaming & admin auth
9. Admin-session strategy: login flow, CSRF token handling, cookie jar, re-auth-on-401.
10. `download_video` `await_completion` option with `notifications/progress`.
11. Tools: `get_download_status`, `get_download_history`, `check_video_downloaded`, `inspect_url`.
12. Resources: `mytube://library/*`, `mytube://system/version`.

### Phase 3 — Full admin surface
13. Library write tools, collections write tools, subscriptions, queue control, maintenance.
14. Capability gating implementation (mode → catalog).
15. Prompts: `download-and-organize`, `audit-subscriptions`, `library-report`, `find-and-download`.

### Phase 4 — Streamable HTTP transport & hardening
16. HTTP transport with `Mcp-Session-Id`, SSE upgrade.
17. Bearer gate, rate limit, loopback default.
18. Dockerfile + `docker-compose.streamable-http.yml`.
19. Destructive-tool confirmation middleware; `MCP_ALLOWED_TOOLS` allowlist; upload-path allowlist.

### Phase 5 — Polish
20. Typed SDK usage verified against `@modelcontextprotocol/sdk` current version.
21. Integration test harness spinning up a real MyTube container.
22. Documentation: README, security model, client config cookbook.

---

## 17. Testing Plan

### 17.1 Unit tests (vitest)
- `config.ts`: every validation rule (missing required, conflicting modes, insecure URL rejection, secret redaction).
- `mytube/client.ts`: error mapping for each status code; retry-on-network-error; timeout enforcement; api-key header presence; CSRF header on mutating requests only.
- `auth.ts` (admin): login success/failure, CSRF token extraction from `X-CSRF-Token`, re-auth-on-401 single-retry.
- Tool registry: mode gating — assert which tools appear under api-key vs admin.
- Each tool: input validation, correct endpoint + body shape, output shaping, annotation values.

### 17.2 Contract tests
- A recorded-fixture HTTP server (e.g., `msw` or `nock`) replaying captured MyTube responses, asserting the tool produces the documented structured output.

### 17.3 Integration tests
- Spin up the MyTube Docker image (`ghcr.io/franklioxygen/mytube:latest`) in CI, configure api-key mode, and exercise the full MCP server end-to-end: `tools/list` → `download_video` (a short, public test video) → poll → `list_videos` shows it. Use a tiny sample video to keep CI fast.
- Repeat in admin-session mode for write tools.

### 17.4 Security tests
- Assert no tool/resource/prompt output ever contains the API key, admin password, CSRF token, or cookie.
- Assert `upload_video` rejects paths outside `MCP_UPLOAD_ROOTS` (including symlink escapes).
- Assert HTTP transport rejects requests without bearer token when configured.
- Assert destructive tools carry `destructiveHint: true`.
- fuzzer: random tool inputs (property-based) must not crash the server or produce unhandled promise rejections.

### 17.5 Validation commands (mirroring MyTube conventions)

```bash
npm run build       # tsc --noEmit (typecheck)
npm run test        # vitest run
npm run test:coverage
npm run lint
```

---

## 18. Packaging & Distribution

- **npm package:** `mytube-mcp`, published with `bin: { "mytube-mcp": "dist/index.js" }` so `npx mytube-mcp` works.
- **Docker image:** `ghcr.io/franklioxygen/mytube-mcp:latest`, multi-arch (amd64/arm64), non-root user, read-only root filesystem, `HEALTHCHECK` hitting a local `/healthz`.
- **Versioning:** independent SemVer; the MCP protocol version advertised is `2025-06-18`. A compatibility matrix in the README tracks which MyTube backend versions are supported.
- **No bundling of secrets** in the image; all config via env.

---

## 19. Documentation Deliverables

- `README.md` — quickstart, two config snippets (api-key + admin), security warnings.
- `SECURITY.md` — full threat model from §14, operator checklist.
- `docs/tools.md` — auto-generated tool catalog (name, schema, annotations, mode).
- `docs/transport.md` — stdio vs streamable-HTTP setup, reverse-proxy TLS example.
- A PR adding a cross-link from MyTube's `documents/en/` to the MCP server repo (no backend code changes required for v1).

---

## 20. Open Questions

1. **Repo location.** Should `mytube-mcp` live as a workspace in the MyTube monorepo (`mcp/`) or as a separate repo? Recommendation: **separate repo** — it has its own release cadence and dependency tree (the MCP SDK), and keeps the "0 lines of manual code" claim in MyTube's README intact. Revisit if tight coupling emerges.

2. **Future settings tooling.** If operators want the agent to manage settings (e.g., "raise max concurrent downloads to 5"), is there a safe subset of `/api/settings` to expose? Recommendation: defer; settings contain secrets and security toggles. A future "safe settings" tool could expose only non-sensitive numeric/toggle keys with an explicit allowlist.

3. **Webhook/callback for downloads.** MyTube has no completion webhook. If one were added, the MCP server could push `notifications/progress` without polling. Out of scope here but worth a follow-up issue on MyTube.

4. **Multi-tenant streamable HTTP.** If multiple agents share one HTTP MCP server, should each carry its own MyTube credentials (per-request auth) rather than the server holding one set? Defer to v2; v1 is single-tenant per process.

5. **i18n of tool descriptions.** MyTube ships 10 languages. Tool descriptions are English-only in v1 (matches MCP ecosystem norm); localize later if demand exists.

---

## 21. Alternatives Considered

### A. Expose MyTube as a raw OpenAPI spec + generic HTTP tool
- **Pros:** zero custom code; any agent with an OpenAPI loader works.
- **Cons:** no capability gating (agent sees and tries admin endpoints → 403 noise); no typed progress for downloads; no prompts/resources; CSRF/cookie handling left to the agent (fragile); no security hardening. Rejected.

### B. Add MCP support inside the MyTube backend itself (new `/api/mcp` route)
- **Pros:** no separate process; could share the DB directly.
- **Cons:** couples MCP release cadence to MyTube; adds a long-lived JSON-RPC endpoint to the security-critical backend; breaks the existing architecture (controllers/services/DB). The bridge pattern keeps concerns separated and is the standard MCP deployment shape. Rejected for v1; could be revisited if deployment simplicity demands it.

### C. Wait for MyTube to broaden the API-key allowlist before building
- **Pros:** api-key mode would cover more read endpoints (history, status).
- **Cons:** the current allowlist is already sufficient for a useful MVP (search, download, browse, version). The server is designed so broadened api-key access is a config flip, not a rewrite. Rejected — build now.

### D. Selected approach
A standalone TypeScript MCP server acting as a protocol bridge to MyTube's HTTP API, with dual auth modes, capability-gated tool catalog, resources, prompts, and both stdio + streamable-HTTP transports, hardened per §14. This maximizes agent ergonomics, matches the MCP ecosystem norm, and requires no changes to the MyTube backend.

---

## 22. Glossary

- **MCP** — Model Context Protocol, an open JSON-RPC 2.0 protocol for connecting LLM applications to external tools/data. Spec version `2025-06-18`.
- **Tool** — server-side function an agent may invoke; has side effects.
- **Resource** — server-side, URI-addressed, read-only data.
- **Prompt** — reusable, user-selected instruction template.
- **stdio transport** — MCP over a process's stdin/stdout.
- **Streamable HTTP** — MCP over HTTP with optional SSE upgrade (replaces HTTP+SSE from older drafts).
- **api-key mode** — MCP server uses a MyTube API key; limited to MyTube's `allowApiKey: true` endpoints.
- **admin-session mode** — MCP server logs in as admin; full surface; handles CSRF.

---

## Appendix A — Tool catalog at a glance (api-key mode)

```
search_videos          (read-only)
download_video         (enqueue; idempotent; open-world)
list_videos            (read-only)
get_video              (read-only)
list_collections       (read-only)
get_system_version     (read-only)
```

## Appendix B — Tool catalog at a glance (admin-session mode)

All api-key tools **plus:**

```
check_video_downloaded         inspect_url
get_download_status            get_download_history
cancel_download                remove_from_queue        clear_queue
remove_history_row             clear_history
update_video                   delete_video             rate_video
refresh_thumbnail              redownload_thumbnail     upload_subtitle
upload_video                   upload_videos_batch
create_collection              update_collection        delete_collection
list_subscriptions             create_subscription      update_subscription
delete_subscription            pause_subscription       resume_subscription
create_playlist_subscription   subscribe_channel_playlists
list_tasks                     cancel_task              delete_task
pause_task                     resume_task              clear_finished_tasks
create_playlist_task
scan_files                     cleanup_temp_files
```

## Appendix C — References

- MCP Specification (2025-06-18): https://modelcontextprotocol.io/specification/2025-06-18
- MCP Tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- MyTube API docs: `documents/en/api-endpoints.md`
- MyTube route table: `backend/src/routes/api.ts`
- MyTube API-key auth: `backend/src/utils/apiKeyAuth.ts`
- MyTube auth middleware: `backend/src/middleware/authMiddleware.ts`
