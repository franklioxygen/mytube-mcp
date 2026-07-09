# MyTube MCP 服务器

`mytube-mcp` 是面向 [MyTube](https://github.com/franklioxygen/MyTube) 的独立 [Model Context Protocol](https://modelcontextprotocol.io/) 服务器。它把 MCP 工具、资源和提示转换为对 MyTube 现有 `/api/*` HTTP API 的鉴权调用，不直接访问 MyTube 的数据库或文件系统。

## 快速开始

要求：Node.js 20 或更高版本，以及一个可访问的 MyTube 1.10.x 服务。

发布到 npm 后，最简安装方式是：

```bash
npx -y mytube-mcp
```

如果要立即从公开仓库源码运行：

```bash
git clone https://github.com/franklioxygen/mytube-mcp.git
cd mytube-mcp
npm install
npm run build
npm start
```

在 MCP 客户端进程环境中设置配置。推荐使用权限最小的 API key 模式：

```json
{
  "mcpServers": {
    "mytube": {
      "command": "npx",
      "args": ["-y", "mytube-mcp"],
      "env": {
        "MYTUBE_BASE_URL": "https://mytube.example.com",
        "MYTUBE_AUTH_MODE": "api-key",
        "MYTUBE_API_KEY": "替换为你的 MyTube API key"
      }
    }
  }
}
```

如果需要管理收藏夹、订阅、下载队列、视频元数据或上传文件，请使用管理员会话模式：

```json
{
  "mcpServers": {
    "mytube": {
      "command": "npx",
      "args": ["-y", "mytube-mcp"],
      "env": {
        "MYTUBE_BASE_URL": "https://mytube.example.com",
        "MYTUBE_AUTH_MODE": "admin-session",
        "MYTUBE_ADMIN_PASSWORD": "替换为你的管理员密码"
      }
    }
  }
}
```

管理员 Cookie 和 CSRF token 只保存在进程内存中。如果 MyTube 已关闭密码登录，服务器会检测到单用户 owner 模式并在没有密码时继续工作；否则必须设置 `MYTUBE_ADMIN_PASSWORD`。

## 功能范围

API key 模式只暴露 MyTube 当前 `allowApiKey: true` 的路由：`download_video`、`list_videos`、`get_video`、`list_collections` 和 `get_system_version`。当前 MyTube 后端不允许 API key 访问 `/api/search`，因此 `search_videos` 会被限制为管理员模式；这是对设计文档中 API key MVP 列表与实际路由表差异的安全处理。

管理员会话模式还提供搜索、URL 检查、下载进度/历史、队列控制、视频元数据修改、上传、收藏夹、订阅、连续下载任务、维护操作、云存储签名 URL、资源和提示。破坏性工具带有 MCP 注解，也可以通过 `MCP_ALLOWED_TOOLS` 进一步限制。

`download_video` 默认立即返回。设置 `await_completion: true` 后，服务器会轮询 MyTube 的活动队列、等待队列和历史接口；当客户端提供 progress token 时，会发送 MCP `notifications/progress`。轮询会受到 `MYTUBE_DOWNLOAD_POLL_TIMEOUT_MS` 限制。

## 配置

完整配置请参考 [.env.example](.env.example)。重点配置如下：

- `MYTUBE_BASE_URL` 必填。远程服务器必须使用 HTTPS；localhost、127.0.0.1、`*.local` 可使用本地 HTTP，也可以显式设置 `MYTUBE_ALLOW_INSECURE_TLS=true`。
- `MYTUBE_AUTH_MODE` 默认为 `api-key`，也可以设置为 `admin-session`。
- `MCP_TRANSPORT` 默认为 `stdio`；需要 Streamable HTTP 时设置为 `http`。
- 使用上传工具前必须设置 `MCP_UPLOAD_ROOTS`。服务器会拒绝超出目录的路径以及通过符号链接逃逸的路径。
- 只有在确实需要向 MyTube 发送可信的局域网/私有地址时，才设置 `MYTUBE_ALLOW_INTERNAL_URLS=true`。

## Streamable HTTP

```bash
MCP_TRANSPORT=http \
MCP_HTTP_BIND=127.0.0.1 \
MCP_HTTP_PORT=3100 \
MCP_HTTP_BEARER_TOKEN='使用足够长的随机 token' \
npx -y mytube-mcp
```

端点为 `POST /mcp`，健康检查为 `GET /healthz`。默认绑定回环地址。远程使用时应在 TLS 反向代理后运行并设置 `MCP_HTTP_BEARER_TOKEN`；非回环绑定没有 bearer token 会被拒绝。详见 [docs/transport.md](docs/transport.md)。

## 开发与检查

```bash
npm install
npm run build
npm run lint
npm test
```

安全模型见 [SECURITY.md](SECURITY.md)，工具目录见 [docs/tools.md](docs/tools.md)。

## 兼容性说明

本实现对照 MyTube v1.10.11 完成。MyTube 的部分兼容接口返回原始数组/对象，因此客户端同时兼容这种返回格式以及文档中的 `{ success, data }` 包装格式。管理员登录使用 MyTube 实际的 `mytube_auth_session`、`mytube_csrf` Cookie 和 `X-CSRF-Token` header。

## 许可证

MIT。如果本仓库包含许可证文件，请参阅 [LICENSE](LICENSE)。
