# Remote Pi

第一阶段的单机、单用户 Remote Pi 服务端实现。默认只监听 `127.0.0.1`，使用 Bearer access token，并提供 workspace 只读文件 API、agent 生命周期 API 以及带事件序号的 WebSocket 协议。

## 开发

```bash
npm install
npm run check
npm test
npm run dev -- --port 8787
```

首次启动会在 `~/.pi/remote-pi/auth.json` 保存 SHA-256 token hash（权限 `0600`），并只在终端显示一次明文 token。可用 `--data-dir` 修改配置目录，`--rotate-access-token` 轮换 token。不要将服务直接暴露到公网，远程访问请使用 SSH tunnel、Tailscale 或反向代理。

## API

请求除 `/health` 和 `/api/v1/auth/login` 外均需 `Authorization: Bearer <token>`。返回格式统一为 `{ data }` 或 `{ error: { code, message, requestId } }`。

- `GET /health`
- `POST /api/v1/auth/login` body `{ "token": "..." }`
- `GET/POST /api/v1/workspaces`
- `GET /api/v1/workspaces/:id/tree?path=.`
- `GET /api/v1/workspaces/:id/file?path=src/index.ts&offset=0&limit=...`
- `GET/POST /api/v1/agents`
- `GET/DELETE /api/v1/agents/:id`
- `GET /api/v1/agents/:id/state|messages`
- `POST /api/v1/agents/:id/prompt|steer|follow-up|abort`
- WebSocket `GET /api/v1/ws`，连接时带 Bearer header，发送 `subscribe`、`prompt`、`steer`、`follow-up` 或 `abort`。

## 纯 Native HTML5 UI

`web/` 目录是无第三方 npm 依赖的静态页面（`index.html`、`app.js`、`styles.css`），可直接部署到任意静态服务器。例如：

```bash
cd web
python3 -m http.server 8080
```

浏览器访问 `http://127.0.0.1:8080`，输入 API 地址和首次启动显示的 Token，即可测试 workspace、文件浏览、agent、prompt、流式事件和 abort。目录树支持右键设为新 Agent 的 cwd，文件和目录支持右键添加 `@路径`；页面重新连接后会加载并重新选择已有 Agent。workspace/agent 元数据保存在 `workspaces.json` 和 `agents.json`，服务重启后从原 Pi session 文件恢复，不会重放未完成的 prompt。页面使用 `fetch` 和原生 `WebSocket`，WebSocket Token 通过 subprotocol 发送，不放入 URL。服务端已提供基础 CORS 响应头，便于静态页面跨端口访问。

## Android App

`android/` 包含 Kotlin + Jetpack Compose 原生客户端，支持多 Server、Keystore Token、Workspace/文件浏览、Agent 创建与列表、实时对话、abort、sequence 去重及 WebSocket 自动重连。构建和连接说明见 [`android/README.md`](android/README.md)，完整功能和交互说明见 [`ANDROID_APP_FEATURES.md`](ANDROID_APP_FEATURES.md)。

运行时默认使用真实 `@earendil-works/pi-coding-agent` SDK，并复用 Pi CLI 的 `~/.pi/agent` 模型、认证和设置；agent 可正常使用 read/bash/edit/write 工具并持久化 Pi session。`MockBackend` 仅由自动化测试显式注入，运行服务器不会使用 mock response。测试覆盖 token hash/轮换、路径穿越、符号链接逃逸、分页、大小限制、agent 事件顺序和停止行为，且不依赖真实 LLM key。
