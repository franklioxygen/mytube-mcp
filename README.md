# MyTube MCP Server

[中文](README.zh-CN.md)

`mytube-mcp` is a standalone [Model Context Protocol](https://modelcontextprotocol.io/) server for [MyTube](https://github.com/franklioxygen/MyTube). It translates MCP tools, resources, and prompts into authenticated calls to MyTube’s existing `/api/*` HTTP API. It does not access MyTube’s database or filesystem directly.

## Quick start

Requirements: Node.js 20 or newer and a reachable MyTube 1.10.x server.

After this package is published to npm, the shortest installation is:

```bash
npx -y mytube-mcp
```

To run the public repository immediately from source:

```bash
git clone https://github.com/franklioxygen/mytube-mcp.git
cd mytube-mcp
npm install
npm run build
npm start
```

Set the configuration in the MCP client process environment. The recommended least-privilege setup uses an API key:

```json
{
  "mcpServers": {
    "mytube": {
      "command": "npx",
      "args": ["-y", "mytube-mcp"],
      "env": {
        "MYTUBE_BASE_URL": "https://mytube.example.com",
        "MYTUBE_AUTH_MODE": "api-key",
        "MYTUBE_API_KEY": "replace-with-your-mytube-api-key"
      }
    }
  }
}
```

For collection management, subscriptions, queue control, metadata edits, or uploads, use admin-session mode:

```json
{
  "mcpServers": {
    "mytube": {
      "command": "npx",
      "args": ["-y", "mytube-mcp"],
      "env": {
        "MYTUBE_BASE_URL": "https://mytube.example.com",
        "MYTUBE_AUTH_MODE": "admin-session",
        "MYTUBE_ADMIN_PASSWORD": "replace-with-your-admin-password"
      }
    }
  }
}
```

The server keeps admin cookies and CSRF tokens in memory only. If MyTube has password login disabled, admin-session mode detects owner mode and proceeds without a password; otherwise `MYTUBE_ADMIN_PASSWORD` is required.

## What is available

API-key mode exposes only the routes MyTube currently marks `allowApiKey: true`: `download_video`, `list_videos`, `get_video`, `list_collections`, and `get_system_version`. The current MyTube backend does not allow API-key access to `/api/search`, so `search_videos` is intentionally admin-only even though the design document’s MVP appendix listed it in the API-key catalog.

Admin-session mode adds search, URL inspection, progress/history, queue control, library mutations, uploads, collections, subscriptions, continuous-download tasks, maintenance, cloud signed URLs, resources, and prompts. Destructive tools are annotated and can be further restricted with `MCP_ALLOWED_TOOLS`.

`download_video` returns immediately by default. Set `await_completion: true` to poll MyTube’s active/queued/history endpoints and emit MCP `notifications/progress` when the client supplies a progress token. Polling is bounded by `MYTUBE_DOWNLOAD_POLL_TIMEOUT_MS`.

## Configuration

Copy [.env.example](.env.example) for the complete list. Important settings:

- `MYTUBE_BASE_URL` is required. HTTPS is required for remote MyTube servers; local HTTP is allowed for localhost/127.0.0.1/`*.local`, or explicitly with `MYTUBE_ALLOW_INSECURE_TLS=true`.
- `MYTUBE_AUTH_MODE` is `api-key` by default or `admin-session`.
- `MCP_TRANSPORT` is `stdio` by default. Set it to `http` for Streamable HTTP.
- `MCP_UPLOAD_ROOTS` must contain one or more directories before upload tools are enabled operationally. Symlink escapes are rejected.
- `MYTUBE_ALLOW_INTERNAL_URLS=true` is required if trusted LAN/private URLs must be sent to MyTube.

## Streamable HTTP

```bash
MCP_TRANSPORT=http \
MCP_HTTP_BIND=127.0.0.1 \
MCP_HTTP_PORT=3100 \
MCP_HTTP_BEARER_TOKEN='use-a-long-random-token' \
npx -y mytube-mcp
```

The endpoint is `POST /mcp` and the health check is `GET /healthz`. Bind to loopback by default. For remote access, put the server behind TLS termination and set `MCP_HTTP_BEARER_TOKEN`; non-loopback binds without a bearer token are rejected. See [docs/transport.md](docs/transport.md).

## Docker

A multi-arch image (`linux/amd64`, `linux/arm64`) is published to the GitHub Container Registry on every release:

```bash
docker pull ghcr.io/franklioxygen/mytube-mcp:latest
```

Run it in Streamable HTTP mode (Docker only makes sense for the HTTP transport, not stdio):

```bash
docker run --rm -p 127.0.0.1:3100:3100 \
  -e MYTUBE_BASE_URL=https://mytube.example.com \
  -e MYTUBE_AUTH_MODE=api-key \
  -e MYTUBE_API_KEY=replace-with-your-mytube-api-key \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_BIND=0.0.0.0 \
  -e MCP_HTTP_PORT=3100 \
  -e MCP_HTTP_BEARER_TOKEN=use-a-long-random-token \
  ghcr.io/franklioxygen/mytube-mcp:latest
```

Tags follow semantic versioning (`0`, `0.1`, `0.1.0`) plus `latest`. See [examples/docker-compose.streamable-http.yml](examples/docker-compose.streamable-http.yml) for a Compose setup, or build locally with `docker build -t mytube-mcp .`.

## Development

```bash
npm install
npm run build
npm run lint
npm test
```

See [SECURITY.md](SECURITY.md) for the threat model and [docs/tools.md](docs/tools.md) for the tool catalog.

## Compatibility note

The implementation was compared with MyTube v1.10.11 at the time of this release. MyTube returns raw arrays/objects on several legacy-compatible endpoints, so the client accepts both those responses and the documented `{ success, data }` envelope. It uses MyTube’s actual `mytube_auth_session` and `mytube_csrf` cookie names and `X-CSRF-Token` header.

## License

MIT. See [LICENSE](LICENSE) if this repository is distributed with a license file.
