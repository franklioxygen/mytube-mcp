# Security model

This server holds credentials that can invoke MyTube actions. Run it as a single-tenant process and treat MCP client access as trusted operator access.

## Credential handling

- API keys, admin passwords, session cookies, and CSRF tokens are never written to disk.
- Logs go to stderr for stdio mode; known secret-bearing keys and headers are redacted.
- No settings resource is exposed. MyTube settings contain API keys, cloud tokens, and other security-sensitive values.
- Admin login uses MyTube’s documented `/api/settings/password-enabled` and `/api/settings/verify-admin-password` endpoints. The actual MyTube cookie is `mytube_auth_session`; CSRF is the `mytube_csrf` cookie mirrored in `x-csrf-token`.

## Capability boundaries

- API-key mode follows the current MyTube route allowlist and does not attempt privileged endpoints.
- Admin-session tools are hidden in API-key mode rather than advertised and allowed to fail with 403.
- `MCP_ALLOWED_TOOLS` can provide a second allowlist, useful for excluding `delete_video`, `clear_queue`, `clear_history`, or uploads.
- Destructive tools carry `destructiveHint: true`; clients should still ask the operator for confirmation.

## Network and file safeguards

- Remote MyTube URLs must use HTTPS unless insecure TLS is explicitly enabled.
- Tool-supplied download URLs reject localhost, loopback, private IPv4, link-local, and private IPv6 addresses by default. Trusted LAN deployments can opt in with `MYTUBE_ALLOW_INTERNAL_URLS=true`.
- Upload and subtitle paths are disabled unless they are inside `MCP_UPLOAD_ROOTS`. Paths are resolved with `realpath` to prevent symlink escapes.
- HTTP transport binds to loopback by default. Non-loopback binds require `MCP_HTTP_BEARER_TOKEN` and should be placed behind a TLS reverse proxy.
- HTTP requests are rate-limited per source IP and MCP sessions expire after five minutes of inactivity.

## Untrusted MyTube content

Video titles, descriptions, comments, and resource text can contain prompt-injection text. Tool results frame these values as JSON data; the server does not turn them into privileged instructions. Agents and clients must continue to treat downloaded content as untrusted data.

## Deliberate exclusions

The server does not expose MyTube settings, database backup/restore, hooks, passkeys, live-translation WebSockets, cloud-sync streaming, shell commands, or credential rotation. These operations require a separate, narrower design.
