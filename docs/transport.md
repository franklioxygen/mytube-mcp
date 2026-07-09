# Transport setup

## stdio

stdio is the default and is intended for Claude Desktop, ZCode, Cursor, and other clients that spawn a local process. Logs are written to stderr so stdout remains a pure MCP JSON-RPC channel.

```json
{
  "mcpServers": {
    "mytube": {
      "command": "npx",
      "args": ["-y", "mytube-mcp"],
      "env": {
        "MYTUBE_BASE_URL": "https://mytube.example.com",
        "MYTUBE_AUTH_MODE": "api-key",
        "MYTUBE_API_KEY": "replace-me"
      }
    }
  }
}
```

## Streamable HTTP

```bash
MCP_TRANSPORT=http \
MCP_HTTP_BIND=127.0.0.1 \
MCP_HTTP_PORT=3100 \
MCP_HTTP_BEARER_TOKEN='replace-with-a-long-random-token' \
npx -y mytube-mcp
```

- MCP endpoint: `POST /mcp`
- Health endpoint: `GET /healthz`
- Session header: `Mcp-Session-Id`
- Auth header when configured: `Authorization: Bearer ...`

For remote access, terminate TLS in Caddy, nginx, or an equivalent reverse proxy. Keep the MCP process on a private network, set a long random bearer token, and restrict the proxy route to the intended clients. The server uses in-memory session state; it is single-tenant per process and expires idle sessions after five minutes.

Example Caddy route:

```caddyfile
mcp.example.com {
  reverse_proxy 127.0.0.1:3100
}
```

Do not expose the unencrypted service directly to the public internet.
