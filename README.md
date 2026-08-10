# Remote Pi

Remote Pi 在开发机上运行 Pi Agent，并通过受 Bearer 配对码保护的 HTTP/WebSocket API 提供 Web UI 和 Android 原生客户端。默认只监听 `127.0.0.1`。

## 作为 npm 全局命令安装

要求 Node.js 20.10 或更高版本：

```bash
npm install -g pi2web
pi2web
```

npm 包名为 `pi2web`，全局命令同名（`pi2web`）。安装时会准备 `better-sqlite3` 和 `node-pty` 两个原生模块：多数平台直接使用预编译产物，没有预编译产物的平台需要本机具备 Python 3 与 C/C++ 工具链（Linux `build-essential`、macOS Xcode Command Line Tools、Windows Visual Studio Build Tools）。

启动后访问终端显示的地址（默认 <http://127.0.0.1:11318>）。服务首次启动只在终端显示一次配对码；Web UI **必须由用户手动输入配对码**，不会从 URL 或服务端自动注入。连接成功后页面会询问是否保存到 localStorage；只有用户明确确认后才会保存，请仅在可信设备上使用。

常用选项：

```bash
pi2web --host 127.0.0.1 --port 11318
pi2web --data-dir ~/.pi/remote-pi
pi2web --rotate-access-token   # 旧配对码立即失效，输出新配对码
pi2web --help
```

服务器会同时提供 API、WebSocket 和 Web UI，无需另起静态文件服务器。请勿直接暴露到公网；远程访问建议使用 SSH tunnel、Tailscale、devtunnel 或配置 HTTPS 的可信反向代理。

配对失败有速率限制：同一来源地址在 60 秒窗口内累计 10 次失败后会被锁定，锁定时间从 60 秒起按次翻倍，最长 15 分钟，HTTP 返回 `429` 与 `Retry-After`，WebSocket 升级同样受限；一次成功配对立即清除该地址的计数。注意限流按 TCP 来源地址统计，通过 devtunnel、Cloudflare Tunnel 或反向代理访问时所有客户端共用同一个计数桶。Remote Pi 不校验 `Origin` / `Host`，因此可以直接配合内网穿透使用。

## Agent 完成邮件通知（MailDispatch）

如果启动时同时配置 MailDispatch 消息 API endpoint、API key 环境变量和通知邮箱，Pi 发出 `agent_settled`（不会再自动重试、自动 compact 或执行排队的 follow-up）后，Remote Pi 可以提交事务邮件。MailDispatch 返回 `202` 后邮件进入其持久队列；实际投递由 MailDispatch worker 完成。

```bash
export REMOTE_PI_MAILDISPATCH_KEY='md_live_...'
pi2web \
  --maildispatch-endpoint https://mail.example.com/api/v1/messages \
  --maildispatch-api-key-env REMOTE_PI_MAILDISPATCH_KEY \
  --maildispatch-notify-to owner@example.com \
  --maildispatch-sender-id system
```

前三个选项必须同时提供，否则 Remote Pi 会拒绝启动。`--maildispatch-sender-id` 可选；省略时由 MailDispatch 按 API key 和服务配置选择 sender。API key 只从指定环境变量读取，避免出现在命令行参数和进程列表中，并且至少需要 MailDispatch 的 `mail:send` scope。邮件通知失败只写入 Remote Pi 标准错误，不会改变 Agent 任务状态。

导航栏的“配置”窗口可以启用或关闭邮件通知，并设置：

- 聚合等待时间：首个任务完成后等待指定秒数，期间完成的其他任务合并到同一封邮件；`0` 表示立即发送。
- 是否包含 Agent 最终回复。
- 是否包含 Session 名称和工作路径。

如果后两项都关闭，邮件正文只说明一个或多个 Agent 任务已经完成。邮件设置保存在 Remote Pi 的 SQLite 元数据数据库中，对所有浏览器客户端和 Agent 生效，服务重启后继续保留。

## 本地语音摘要与语音输入（实验性）

Windows 下的 Speaches 中文语音服务器启动、模型下载和故障排查见 [`VOICE_SERVER_SETUP.md`](VOICE_SERVER_SETUP.md)。只需要在线 TTS 时，也可以使用 [`packages/edge-tts-server`](packages/edge-tts-server/README.md) 中的原生 Python 服务，不需要 Docker。

Remote Pi 可以连接两个 OpenAI-compatible 服务：一个 LLM endpoint 把 Agent 最终输出压缩成适合朗读的短摘要，一个语音 endpoint 负责 TTS，并可选提供 STT。语音默认关闭，只有配置 `--voice-base-url` 才会启用；`--voice-stt-model` 是可选项。

```bash
# 示例模型 ID 需要替换为 Speaches 中实际下载的模型
export SUMMARY_API_KEY=...
pi2web \
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
- Web UI 中点击“启用语音”后，会播放服务端推送的 PCM16 或 MP3 音频；新的 Agent 运行会取消该 Agent 尚未完成的播报。
- 多个 Session 接近同时完成时，语音摘要会进入全局队列依次播放，不会重叠；有 Session 名称时以“会话{name}已完成：”开头。
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

pi2web \
  --voice-base-url http://127.0.0.1:5050/v1 \
  --voice-tts-model edge-tts \
  --voice-tts-voice zh-CN-XiaoxiaoNeural \
  --voice-tts-format mp3 \
  --voice-summary-base-url https://llm.example.com/v1 \
  --voice-summary-model <summary-model-id> \
  --voice-summary-api-key-env SUMMARY_API_KEY
```

语音摘要、语音合成和语音识别的每次请求都有超时保护，默认 120000 毫秒，可用 `--voice-request-timeout <ms>` 调整；超时后播报会降级为文本提示，不会阻塞后续 Agent 的播报队列。

该模式不配置 `--voice-stt-model`，因此只启用 Agent 摘要播报，不启用语音识别。Edge TTS 使用非官方消费者服务，适合本地和实验性使用。

## 本地开发

项目 Review 中发现的问题、修复状态和暂缓的 Android 项目见 [`PROJECT_REVIEW_ISSUES.md`](https://github.com/sxwxs/pi2web/blob/main/PROJECT_REVIEW_ISSUES.md)。

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
npm install -g ./pi2web-0.2.0.tgz
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

## 多 Agent 协作中枢（Collab Hub）

在"人 ↔ 单个 Agent"之上叠加一层协作中枢：多个 Agent 只通过结构化 HTTP API 交互，中枢负责身份、状态机推进、盲评、去重、僵局告警和人工升级。设计文档见 [`COLLAB_PLAN.md`](COLLAB_PLAN.md)。

两个场景：

- **Review Loop**（`kind:"review"`）：提 issue → 回应 → 裁定 → 关闭或升级人工。可选**先开发后评审**（`policy.implementationFirst:true`）：会话先进入 `implementing`，开发 Agent 完工后中枢自动召集全部评审 Agent。
- **Panel Scoring**（`kind:"scoring"`）：提名维度 → 投票锁 rubric → 盲打分 → 辩论收敛 → 出分。

两种凭证：**配对码**代表人，可以建会话、登记参与者、强制推进、裁定升级；**participantToken** 代表一个 Agent，只能操作自己所在的会话。会话和参与者只能由人创建，Agent 无法自助加入。

参与者有两种绑定方式：

- `binding:{"type":"managed","agentId":"agent-..."}`：绑定本机 pi2web Agent。轮到它干活时中枢直接把任务包 prompt 给该 Agent（忙碌时用 follow-up 排队），无需轮询；participantToken 由中枢保管并写进唤醒消息，会话结束后清除保管的明文副本。
- `binding:{"type":"external"}`：外部 Agent（Claude Code / Codex / CI）。用 `GET .../inbox?wait=30` 长轮询领任务（最长 60 秒），`POST .../inbox/ack` 确认。**中枢不会主动唤醒 external 参与者**：如果没有人拿着它的 participantToken 去轮询，事件日志里会出现 `task_assigned` 但没有任何 Agent 开工。登错了可以改绑：
  `POST /sessions/{sessionId}/participants/{participantId}/binding -d '{"agentId":"agent-..."}'`（传空体 `{}` 则改回 external）——改绑会轮换 participantToken，并把已在 inbox 里的任务立即推给新绑定的 Agent。

**中枢是推送式的**：任何一方交完自己的活就应当结束回合，绝不要 sleep 轮询等别人。评审方提交完 findings、开发方要回应时，中枢会主动把任务推给开发 Agent；会话结束时也会推一条 `session_result` 收尾消息，所以没有人需要守着等结果。托管 Agent 的唤醒消息里明确写了这条规则。

> 安全提示：托管参与者的 participantToken 会以明文存在 `remote-pi.db`（0600）并出现在被唤醒 Agent 的会话记录里；它的权限仅限该协作会话，但会话结束后 token 本身仍然有效（只是没有任何待办），需要更严的隔离时请用 `external` 绑定自行分发凭证。

最小流程（review）：

```bash
H="Authorization: Bearer $PAIRING_CODE"; B=http://127.0.0.1:11318/api/v1/collab
curl -H "$H" -X POST $B/sessions -d '{"kind":"review","title":"支付回调评审","workspaceId":"ws-...","subject":{"type":"commit_range","value":"HEAD~1..HEAD"}}'
curl -H "$H" -X POST $B/sessions/$SID/participants -d '{"role":"reviewer","displayName":"reviewer-security","binding":{"type":"external"}}'   # 返回一次性 participantToken
curl -H "$H" -X POST $B/sessions/$SID/participants -d '{"role":"implementer","displayName":"impl","binding":{"type":"managed","agentId":"agent-..."}}'
curl -H "$H" -X POST $B/sessions/$SID/advance -d '{}'                                   # 开闸，中枢开始派活
curl -H "Authorization: Bearer $PTOKEN" $B/sessions/$SID/digest                          # Agent 侧：我现在该干什么
```

### 开发 + 评审闭环（implementationFirst）

```
draft ──advance──▶ implementing ──POST /ready 或托管 Agent 空闲──▶ collecting ──全部评审提交──▶ consolidating
                                                                          │
   finished ◀── 所有 issue 关闭 ── adjudicating ◀── responding ◀───────────┘
      ▲                              │                    ▲
      └─ 人工裁定 ◀── awaiting_human ─┘（拒绝超过 maxIssueRounds / 主动 escalate / 超过 maxTotalRounds）
                                       └── verdict=reject → issue 回到 open，下一轮重新钉基线复审
```

- 开发 Agent 拿到的任务是 `implement`。它收到的是一份**只讲活儿的工单**（目标、工作目录、完工后 `POST /ready`），不含评审协议细节——因为这一步还用不上，而且知道得越多越容易自己 sleep 轮询评审意见。绑定为 `managed` 时，pi2web 收到该 Agent 的 `agent_settled` 且它确实持有本轮 `implement` 任务，就自动视为完工（`policy.autoReviewOnAgentIdle`，默认 true），无需任何人点按钮。
- 中枢在切到 `collecting` 的瞬间钉基线，并给**每个**评审 Agent 派任务；所有评审 Agent 都提交 `reviewComplete=true` 后才推进——这就是"需要所有评审 agent 达成一致"。零 issue 即通过。
- 评审方交完之后，**中枢主动回头叫开发 Agent**：`respond_to_issues` 任务连同 issue 原文一起 prompt 过去。开发方不需要（也不应该）轮询评审结果。
- 有问题时：评审方 `POST /findings` → 中枢转给开发方 → 开发方 `POST /responses`（`fixed` / `partially_fixed` 必须附 changes 和新的 codeRef；不认可就用 `rejected` + rationale）→ **只有提出者**能 `POST /verdicts` 裁定：`accept` 关闭、`reject` 把 issue 打回下一轮（重新钉基线复审）、`escalate` 交人。
- 谈不拢时：单个 issue 被拒超过 `maxIssueRounds`（默认 3）或会话超过 `maxTotalRounds`（默认 6）自动生成 escalation，会话进入 `awaiting_human`，同时发邮件。人裁定后是终局，Agent 不能再改。
- 结束时 `outcome.verdict` 为 `approved` / `closed_after_human_ruling` / `closed_with_open_issues`，`outcome.approval` 记录每个评审 Agent 提了几条、还剩几条未结；同时中枢给所有参与者推一条 `session_result`，托管 Agent 会收到一句"会话结束、无需再等"的收尾消息。

之后评审方 `POST /findings`、实现方 `POST /responses`、评审方 `POST /verdicts`，人用 `GET /report` 收口。校验失败返回 `422` 且带 `fieldErrors`，基线过期返回 `409 STALE_BASELINE`，预算耗尽返回 `429`；所有提交都需要 `clientRequestId` 做幂等。

人工升级（escalation）进入 `GET /api/v1/collab/escalations`，用 `POST /api/v1/collab/escalations/:id/resolve` 裁定。配置了 MailDispatch 时，升级和会话停滞会立即发信（不参与聚合，可在配置对话框关闭；同一会话 5 分钟内最多一封，避免 Agent 连续升级刷爆邮箱）。

Web 看板在 `/collab.html`（首页顶部"协作"入口）：会话列表与创建、参与者登记与一次性 token、issue/维度、待裁定队列与裁定表单、事件时间线，并通过 WebSocket `subscribe_collab` 实时刷新。

## API

除 Web 静态资源、`/health` 和 `/api/v1/auth/login` 外，请求均需 `Authorization: Bearer <token>`。响应为 `{ data }` 或 `{ error: { code, message, requestId } }`。

- `GET /health`
- `POST /api/v1/auth/login`
- `GET /api/v1/system/status`
- `GET/POST /api/v1/mail-notifications`
- `GET/POST /api/v1/workspaces`
- `GET /api/v1/workspaces/:id/tree|file|stat`
- `GET /api/v1/sessions`
- `GET/POST /api/v1/agents`
- `GET/DELETE /api/v1/agents/:id`
- `GET/POST /api/v1/collab/sessions`、`/sessions/:id`、`/participants`、`/advance`、`/ready`、`/policy`、`/events`、`/digest`、`/issues`、`/findings`、`/responses`、`/verdicts`、`/escalations`、`/inbox`（支持 `?wait=` 长轮询）、`/report`，以及 scoring 场景的 `/nominations`、`/votes`、`/criteria`、`/scores`、`/analysis`、`/debates`、`/finalize`
- `GET /api/v1/collab/escalations`、`POST /api/v1/collab/escalations/:id/resolve`
- `GET/POST /api/v1/terminals`
- `GET/DELETE /api/v1/terminals/:id`
- Terminal WebSocket `/api/v1/terminals/:id/ws` 支持输入、窗口 resize、输出快照和退出事件。
- Agent 的 `state`、`messages`、`capabilities`、`session`、`prompt`、`steer`、`follow-up`、`abort`、`compact`、`model`、`thinking`、`session-name`、`navigate`、`fork`、`archive` 和 `extension-response` 接口。
- WebSocket `/api/v1/ws` 支持 sequence、replay、snapshot、`fromNow` 和 Agent command；`subscribe_collab` 推送协作事件。

## Android App

`android/` 是 Kotlin + Jetpack Compose 原生客户端。构建和连接说明见 [`android/README.md`](https://github.com/sxwxs/pi2web/blob/main/android/README.md)，完整功能见 [`ANDROID_APP_FEATURES.md`](ANDROID_APP_FEATURES.md)。

运行时使用真实 `@earendil-works/pi-coding-agent` SDK，并复用 Pi CLI 的 `~/.pi/agent` 模型、认证和设置。`MockBackend` 只用于自动化测试。

## License

MIT © sxwxs。完整条款见 [`LICENSE`](LICENSE)。
