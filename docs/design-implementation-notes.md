# Design comparison

The implementation follows the standalone bridge architecture in `documents/mcp-server-design.md`: TypeScript, the official MCP SDK, typed endpoint wrappers, two auth modes, dynamic capability gating, resources, prompts, stdio, Streamable HTTP, progress polling, redacted logs, upload-root checks, and bounded concurrency.

The design was compared with MyTube v1.10.11 before implementation. The following intentional adjustments preserve the design intent while matching the current backend:

1. MyTube’s actual session cookie is `mytube_auth_session`, not `mytube_session`. The CSRF middleware requires the `mytube_csrf` cookie and matching `x-csrf-token` header.
2. MyTube’s current API-key route table does not mark `/api/search`, `/api/check-video-download`, or the download-status/history routes as API-key reachable. Those tools are admin-session only. The implementation therefore favors the current security boundary over the conflicting MVP appendix.
3. Several MyTube endpoints return raw arrays or objects for frontend backward compatibility. The client accepts both raw responses and `{ success, data }` envelopes.
4. Admin-session configuration permits an omitted password until startup checks `/api/settings/password-enabled`. This supports MyTube owner mode, where login is disabled; a password is still required when the backend reports password login enabled.
5. Uploads are implemented through multipart requests, but remain disabled until `MCP_UPLOAD_ROOTS` is explicitly configured.

The server deliberately does not expose the design’s out-of-scope settings, live-translation WebSocket, cloud-sync stream, database backup, hooks, passkeys, or shell operations.
