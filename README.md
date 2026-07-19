# Remote Pi

Remote Pi 在开发机上运行 Pi Agent，并通过受 Bearer 配对码保护的 HTTP/WebSocket API 提供 Web UI 和 Android 原生客户端。默认只监听 `127.0.0.1`。

## 作为 npm 全局命令安装

要求 Node.js 20.10 或更高版本：

```bash
npm install -g remote-pi
remote-pi
```

启动后访问终端显示的地址（默认 <http://127.0.0.1:8787>）。服务首次启动只在终端显示一次配对码；Web UI **必须由用户手动输入配对码**，不会从 URL 或服务端自动注入。连接成功后页面会询问是否保存到 localStorage；只有用户明确确认后才会保存，请仅在可信设备上使用。

常用选项：

```bash
remote-pi --host 127.0.0.1 --port 8787
remote-pi --data-dir ~/.pi/remote-pi
remote-pi --rotate-access-token   # 旧配对码立即失效，输出新配对码
remote-pi --help
```

服务器会同时提供 API、WebSocket 和 Web UI，无需另起静态文件服务器。请勿直接暴露到公网；远程访问建议使用 SSH tunnel、Tailscale 或配置 HTTPS 的可信反向代理。

## 本地开发

```bash
npm install
npm run check
npm test
npm run dev -- --port 8787
```

元数据默认保存在 `~/.pi/remote-pi`。`auth.json` 只保存配对码的 SHA-256 hash，权限为 `0600`。Workspace/Agent 元数据分别保存在 `workspaces.json` 和 `agents.json`；完整 Session 仍由 Pi 管理。

发布包可本地检查：

```bash
npm pack --dry-run
npm install -g ./remote-pi-0.1.0.tgz
```

## Web UI

Web 端覆盖 Android 客户端的主要浏览器可实现能力：

- Workspace 添加、目录浏览、文本文件分页及二进制提示。
- 创建/恢复 Session、Agent 列表、停止与 abort。
- Prompt、steer、follow-up 和流式对话。
- 折叠消息、Thinking、Tool、Retry 和 Extension UI 事件。
- Session 命名、Tree Navigate、Undo/Fork、Compact。
- 模型和 Thinking level 切换。
- 输入 `@` 浏览并引用 Workspace 文件或目录。
- WebSocket sequence 去重、断线指数退避、增量 replay/snapshot 恢复。
- 浏览器允许通知时，对所有已知 Agent 提供完成通知。

浏览器安全模型与 Android 不同：配对码默认仅保存在当前页面的 JS 内存中；连接成功后会询问是否保存，只有用户确认才写入 localStorage。服务地址、当前 Workspace/Agent 和事件 sequence cursor 会保存在 localStorage。自定义 Pi TUI Component 无法在浏览器通用渲染。

## API

除 Web 静态资源、`/health` 和 `/api/v1/auth/login` 外，请求均需 `Authorization: Bearer <token>`。响应为 `{ data }` 或 `{ error: { code, message, requestId } }`。

- `GET /health`
- `POST /api/v1/auth/login`
- `GET /api/v1/system/status`
- `GET/POST /api/v1/workspaces`
- `GET /api/v1/workspaces/:id/tree|file|stat`
- `GET /api/v1/sessions`
- `GET/POST /api/v1/agents`
- `GET/DELETE /api/v1/agents/:id`
- Agent 的 `state`、`messages`、`capabilities`、`session`、`prompt`、`steer`、`follow-up`、`abort`、`compact`、`model`、`thinking`、`session-name`、`navigate`、`fork` 和 `extension-response` 接口。
- WebSocket `/api/v1/ws` 支持 sequence、replay、snapshot、`fromNow` 和 Agent command。

## Android App

`android/` 是 Kotlin + Jetpack Compose 原生客户端。构建和连接说明见 [`android/README.md`](android/README.md)，完整功能见 [`ANDROID_APP_FEATURES.md`](ANDROID_APP_FEATURES.md)。

运行时使用真实 `@earendil-works/pi-coding-agent` SDK，并复用 Pi CLI 的 `~/.pi/agent` 模型、认证和设置。`MockBackend` 只用于自动化测试。
