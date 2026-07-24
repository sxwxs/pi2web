# Remote Pi

Remote Pi 在开发机上运行 Pi Agent，并通过受 Bearer 配对码保护的 HTTP/WebSocket API 提供 Web UI 和 Android 原生客户端。默认只监听 `127.0.0.1`。

## 作为 npm 全局命令安装

要求 Node.js 20.10 或更高版本：

```bash
npm install -g remote-pi
remote-pi
```

启动后访问终端显示的地址（默认 <http://127.0.0.1:11318>）。服务首次启动只在终端显示一次配对码；Web UI **必须由用户手动输入配对码**，不会从 URL 或服务端自动注入。连接成功后页面会询问是否保存到 localStorage；只有用户明确确认后才会保存，请仅在可信设备上使用。

常用选项：

```bash
remote-pi --host 127.0.0.1 --port 11318
remote-pi --data-dir ~/.pi/remote-pi
remote-pi --rotate-access-token   # 旧配对码立即失效，输出新配对码
remote-pi --help
```

服务器会同时提供 API、WebSocket 和 Web UI，无需另起静态文件服务器。请勿直接暴露到公网；远程访问建议使用 SSH tunnel、Tailscale 或配置 HTTPS 的可信反向代理。

## 本地语音摘要与语音输入（实验性）

Windows 下的 Speaches 中文语音服务器启动、模型下载和故障排查见 [`VOICE_SERVER_SETUP.md`](VOICE_SERVER_SETUP.md)。只需要在线 TTS 时，也可以使用 [`packages/edge-tts-server`](packages/edge-tts-server/README.md) 中的原生 Python 服务，不需要 Docker。

Remote Pi 可以连接两个 OpenAI-compatible 服务：一个 LLM endpoint 把 Agent 最终输出压缩成适合朗读的短摘要，一个语音 endpoint 负责 TTS，并可选提供 STT。语音默认关闭，只有配置 `--voice-base-url` 才会启用；`--voice-stt-model` 是可选项。

```bash
# 示例模型 ID 需要替换为 Speaches 中实际下载的模型
export SUMMARY_API_KEY=...
remote-pi \
  --voice-base-url http://127.0.0.1:8000/v1 \
  --voice-stt-model <stt-model-id> \
  --voice-tts-model <tts-model-id> \
  --voice-tts-voice <voice-id> \
  --voice-summary-base-url https://llm.example.com/v1 \
  --voice-summary-model <summary-model-id> \
  --voice-summary-api-key-env SUMMARY_API_KEY \
  --voice-language zh-CN
```

工作方式：

- Pi 发出 `agent_settled` 后，Remote Pi 取得最后一条 Assistant 文本，移除代码块、长链接和 Markdown，再限制摘要输入长度。
- 摘要 LLM 使用流式 Chat Completions；Remote Pi 在完整句子出现后立即调用流式 TTS，因此无需等待整段摘要完成。
- Web UI 中点击“启用语音”后，会播放服务端推送的 24 kHz 单声道 PCM16；新的 Agent 运行会取消旧播报。
- 只有配置 `--voice-stt-model` 时，Web UI 才显示麦克风按钮；识别文字只插入输入框，不会自动发送。
- API key 通过 `--voice-api-key-env` 和 `--voice-summary-api-key-env` 指定环境变量名，避免把密钥放入命令行参数。

语音流目前通过已认证的 Agent WebSocket 发送，只会实时投递，不写入 Session 或事件 replay。浏览器麦克风通常要求 HTTPS 安全上下文（`localhost` 例外）。Android 客户端的流式 PCM 播放和录音 UI 尚未接入。

### Edge TTS（仅语音合成）

项目提供了一个基于 Python `edge-tts` 和 `aiohttp` 的轻量本地服务。它直接返回 MP3，不需要 Docker 或 FFmpeg：

```bash
cd packages/edge-tts-server
python -m venv .venv
# Windows: .venv\\Scripts\\Activate.ps1
# Linux/macOS: source .venv/bin/activate
python -m pip install -e .
remote-pi-edge-tts

remote-pi \
  --voice-base-url http://127.0.0.1:5050/v1 \
  --voice-tts-model edge-tts \
  --voice-tts-voice zh-CN-XiaoxiaoNeural \
  --voice-tts-format mp3 \
  --voice-summary-base-url https://llm.example.com/v1 \
  --voice-summary-model <summary-model-id> \
  --voice-summary-api-key-env SUMMARY_API_KEY
```

该模式不配置 `--voice-stt-model`，因此只启用 Agent 摘要播报，不启用语音识别。Edge TTS 使用非官方消费者服务，适合本地和实验性使用。

## 本地开发

项目 Review 中发现的问题、修复状态和暂缓的 Android 项目见 [`PROJECT_REVIEW_ISSUES.md`](PROJECT_REVIEW_ISSUES.md)。

```bash
npm install
npm run check
npm test
npm run dev -- --port 11318
```

## 数据持久化

Remote Pi 的服务端元数据保存在 `~/.pi/remote-pi/remote-pi.db` SQLite 数据库中：

- `workspaces`：Workspace ID、名称、根目录和创建时间。
- `agents`：Agent 与 Workspace/Session 的映射、cwd、状态、创建/最后活动时间以及 Archive 状态。
- `sessions`：用于 Session 列表、排序和分页的轻量索引，包括名称、文件路径、消息数量、文件 mtime/size 和最后活动时间。
- `auth.json`：配对码的 SHA-256 hash、创建和轮换时间；认证数据仍单独保存，不保存配对码明文，文件权限为 `0600`。

数据库使用 WAL、短事务、部分索引和批量延迟更新。Session 活动时间不会随每个 streaming token 写入，而是在完整消息、Agent 完成和 Session 信息变化时合并持久化。旧版 `workspaces.json`、`agents.json` 和 `agents_archive.json` 不会被读取、迁移或继续写入。

Terminal 只保存在服务进程内存中，不写入数据库。刷新浏览器可以重新连接仍在运行的 Terminal；Remote Pi 服务退出或重启时会终止全部 Terminal。

完整对话由 Pi 的 `SessionManager` 以 JSONL 管理，默认位于 `~/.pi/agent/sessions/<编码后的-cwd>/`，其中包含会话消息、分支、模型及 thinking level 等 Session 条目。SQLite 只保存可重建的 Session 索引，不复制完整消息。模型配置、Provider 认证和 Pi 设置也继续复用 `~/.pi/agent`。浏览器选择的服务地址、Workspace/Agent 和事件游标另存在浏览器 `localStorage`；配对码仅在用户明确同意后才会存入其中。

Remote Pi 启动时从 SQLite 恢复 Agent 元数据，恢复后的 Agent 状态为 `unloaded`，不会创建 Pi `AgentSession` 或初始化扩展。读取该 Agent 的消息、Session、能力，或者向其发送命令时才按需启动；并发请求共享同一次启动。“停止 Agent”只释放运行中的 Session 并保留 Agent 元数据，再次使用时会按需启动。

Web UI 的 Agent 列表支持右键 `Archive`。Archive 只设置数据库记录的 `archived_at`，不会移动、重命名或删除 Pi 的任何 Session 文件；归档记录不会在当前 UI 中显示。

发布包可本地检查：

```bash
npm pack --dry-run
npm install -g ./remote-pi-0.2.0.tgz
```

## Web UI

Web 端覆盖 Android 客户端的主要浏览器可实现能力：

- Workspace 添加、目录浏览、文本文件分页及二进制提示。
- Workspace 目录右键在交互式 Terminal 中打开；Terminal 与 Agent 显示在同一列表，支持刷新重连、清屏和关闭。
- 创建/恢复 Session、Agent 列表、停止与 abort；Agent 右键 Archive。
- Prompt、steer、follow-up 和流式对话。
- 折叠消息、Thinking、Tool、Retry 和 Extension UI 事件。
- Session 命名、Tree Navigate、Undo/Fork、Compact。
- 模型和 Thinking level 切换。
- 输入 `@` 浏览并引用 Workspace 文件或目录。
- WebSocket sequence 去重、断线指数退避、增量 replay/snapshot 恢复。
- 浏览器允许通知时，对所有已知 Agent 提供完成通知。

Terminal 是以 Remote Pi 进程用户身份运行的完整宿主机 Shell。Workspace 路径只决定初始 cwd，并不是安全沙箱；Shell 可以访问 Workspace 之外的文件及继承到的环境变量。获得配对码的人实际上也获得了该用户的 Shell 权限，请勿将服务直接暴露到不可信网络。每个服务进程最多同时运行 8 个 Terminal，每个 Terminal 只保留最近 512 KiB 输出用于浏览器重连。

浏览器安全模型与 Android 不同：配对码默认仅保存在当前页面的 JS 内存中；连接成功后会询问是否保存，只有用户确认才写入 localStorage。服务地址、当前 Workspace/Agent 和事件 sequence cursor 会保存在 localStorage。浏览器通知要求 HTTPS 安全上下文（`localhost` 可使用 HTTP）；通过局域网 IP 的 HTTP 地址访问时无法启用。自定义 Pi TUI Component 无法在浏览器通用渲染。

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
- `GET/POST /api/v1/terminals`
- `GET/DELETE /api/v1/terminals/:id`
- Terminal WebSocket `/api/v1/terminals/:id/ws` 支持输入、窗口 resize、输出快照和退出事件。
- Agent 的 `state`、`messages`、`capabilities`、`session`、`prompt`、`steer`、`follow-up`、`abort`、`compact`、`model`、`thinking`、`session-name`、`navigate`、`fork`、`archive` 和 `extension-response` 接口。
- WebSocket `/api/v1/ws` 支持 sequence、replay、snapshot、`fromNow` 和 Agent command。

## Android App

`android/` 是 Kotlin + Jetpack Compose 原生客户端。构建和连接说明见 [`android/README.md`](android/README.md)，完整功能见 [`ANDROID_APP_FEATURES.md`](ANDROID_APP_FEATURES.md)。

运行时使用真实 `@earendil-works/pi-coding-agent` SDK，并复用 Pi CLI 的 `~/.pi/agent` 模型、认证和设置。`MockBackend` 只用于自动化测试。
