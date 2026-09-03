# Remote Pi

Remote Pi 在开发机上运行 Pi Agent，并通过受 Bearer 配对码保护的 HTTP/WebSocket API 提供 Web UI。默认只监听 `127.0.0.1`。

## 作为 npm 全局命令安装

要求 Node.js 22.19.0 或更高版本（由 `@earendil-works/pi-coding-agent` 0.84.x 决定）：

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

语音流目前通过已认证的 Agent WebSocket 发送，只会实时投递，不写入 Session 或事件 replay。浏览器麦克风通常要求 HTTPS 安全上下文（`localhost` 例外）。

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

## 自动 Session 命名

自动命名是独立于语音的功能，**默认开启**：Agent 每次任务结束（`agent_settled`）后，如果 Session 还没有名字，就用一个 OpenAI 兼容的接口生成简短标题并写入 Session。不开语音时只生成标题，不会产生任何语音；开了语音播报时仍然只由命名器负责命名，语音负责朗读摘要。

默认值：`--session-name-base-url http://localhost:8313/`、`--session-name-model gpt-5-mini`、无 API Key。可用参数：

```
--session-naming <on|off>            关闭或开启自动命名（默认 on）
--session-name-base-url <url>        OpenAI 兼容的命名接口
--session-name-model <id>            命名模型 ID
--session-name-api-key-env <name>    存放 API Key 的环境变量名（默认不带 Key）
--session-name-language <tag>        标题语言（默认 zh-CN）
--session-name-request-timeout <ms>  命名请求超时（默认 60000）
--session-name-max-output-tokens <n> 命名输出 token 上限（默认 2000，推理模型需要较大预算）
```

命名失败不会影响 Agent，本次失败会通过 WebSocket 的 `session_namer_event`（`session_name_error`）上报。`GET /api/v1/system/status` 的 `sessionNamingEnabled` 可以确认是否开启。

## 本地开发

项目 Review 中发现的问题和修复状态见 [`PROJECT_REVIEW_ISSUES.md`](https://github.com/sxwxs/pi2web/blob/main/PROJECT_REVIEW_ISSUES.md)。

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

Web 端能力：

- Workspace 添加、目录浏览、文本文件分页及二进制提示。
- Workspace 目录右键在交互式 Terminal 中打开；Terminal 与 Agent 显示在同一列表，支持刷新重连、清屏和关闭。
- 创建/恢复 Session、Agent 列表、停止与 abort；Agent 右键 Archive。
- Prompt、steer、follow-up 和流式对话。
- 对话区只保留用户输入、Agent 输出、Thinking、Extension 对话框和错误；Tool call、Session bash 输出、Retry、Summarization retry 等过程事件自动折叠成一张"活动"卡片，卡片标题实时显示最新一项的名称和时间，展开后逐条查看，再点击单条查看内容。
- 同一次 Tool call 的 start / update / end 合并为一张卡片（参数 + 输出 + 结果）。
- 输入 `/` 浏览并补全当前目录可用的 prompt template 和 skill（由 Pi session 自行展开）。
- 输入 `!命令` 在 Agent Session 内执行 Shell 并把输出写入上下文，`!!命令` 只执行不写入上下文。
- Session 命名、Tree Navigate、Undo/Fork、Compact。
- 模型和 Thinking level 切换。
- 输入 `@` 浏览并引用 Workspace 文件或目录。
- WebSocket sequence 去重、断线指数退避、增量 replay/snapshot 恢复。
- 浏览器允许通知时，对所有已知 Agent 提供完成通知。

Terminal 是以 Remote Pi 进程用户身份运行的完整宿主机 Shell。Workspace 路径只决定初始 cwd，并不是安全沙箱；Shell 可以访问 Workspace 之外的文件及继承到的环境变量。获得配对码的人实际上也获得了该用户的 Shell 权限，请勿将服务直接暴露到不可信网络。每个服务进程最多同时运行 8 个 Terminal，每个 Terminal 只保留最近 512 KiB 输出用于浏览器重连。

配对码默认仅保存在当前页面的 JS 内存中；连接成功后会询问是否保存，只有用户确认才写入 localStorage。服务地址、当前 Workspace/Agent 和事件 sequence cursor 会保存在 localStorage。浏览器通知要求 HTTPS 安全上下文（`localhost` 可使用 HTTP）；通过局域网 IP 的 HTTP 地址访问时无法启用。自定义 Pi TUI Component 无法在浏览器通用渲染。

## 多 Agent 协作中枢（Collab Hub）

在"人 ↔ 单个 Agent"之上叠加一层协作中枢：多个 Agent 只通过结构化 HTTP API 交互，中枢负责身份、状态机推进、盲评、去重、僵局告警和人工升级。设计文档见 [`COLLAB_PLAN.md`](COLLAB_PLAN.md)。

两个场景：

- **Review Loop**（`kind:"review"`）：盲审提 Issue → 全体交叉投票 / 重复项合并投票 → 分轮讨论收敛 → 直接输出报告。确认的问题成为 `confirmed` Action Items；人可从 finished 状态直接复核，或指定开发 Agent 先修复再由原 Reviewer 复核。Web 看板新建的 Review 默认开启 `policy.consensusReview:true`；首次流程可选**先开发后评审**（`policy.implementationFirst:true`）。
- **Panel Scoring**（`kind:"scoring"`）：盲提名维度 → 确定性重复项归并 → 投票锁 rubric → 盲打分 → 辩论与争议维度复评分 → 出分。下一轮会带回上一轮 tally/amendment；rubric、分数分布和辩论上下文通过强类型工具完整交给 Agent。投票时 **reject 必须带理由，否则整批 422、一票不写**（旧行为是在 200 里把这一票标成 rejected，而 Agent 的回合已经结束，面板会永远等它）。

两种凭证：**配对码**代表人，可以建会话、登记参与者、强制推进、裁定升级；**participantToken** 代表一个 Agent，只能操作自己所在的会话。会话和参与者只能由人创建，Agent 无法自助加入。

参与者通常只在 `draft` / `implementing` / `collecting`——scoring 会话则是 `nominating`——阶段登记，中枢会当场派发当前任务。Review finished 后还允许追加 `implementer`，为下一次“修复后复核”做准备；Reviewer Panel 保持不变。`role` 只能是 `implementer` / `reviewer`，人使用配对码而不是参与者席位。

每个座位都绑定一个**本机 pi2web Agent**（`agentId` 必填，且必须是一个已存在的 `profile=collab` Agent——中枢唤不醒的座位只会卡住整个阶段，因此登记/改绑时直接 403）；同一个协作 Agent 在任意时刻只能占一个 active seat，避免进程内工具无法确定它代表哪个会话。每个 implementation wave 也只允许一个 implementer，因为所有 Agent 仍共享同一工作区。轮到它干活时，中枢直接 prompt（忙碌时用 follow-up 排队）。任务会一直保留在持久化队列中，直到 Agent 真正调用 `collab_get_task` 领取，而不是在 follow-up 刚入队时就当成已送达。

协作座位要用**协作 Agent**：`POST /api/v1/agents -d '{...,"profile":"collab"}'`（看板新建 Agent 时自动带上）。它先调用 `collab_get_task`，扩展再按当前任务只激活一个强类型提交工具，例如 `collab_submit_findings`、`collab_submit_votes` 或 `collab_submit_scores`。工具在进程内直连中枢，自动补全 baseline 与幂等键，模型上下文里不会出现 URL、令牌或内部 ID。Review/Scoring 不按工具名称做武断的“只读”限制：`bash`、`edit`、`write` 都保留，因为禁用其中两个并不能阻止另一个写文件，必要的工作区外临时操作也不应被误伤。任务与系统提示会明确要求不得在工作目录内创建、删除、重命名或修改任何内容，包括重定向输出、临时文件、生成物、缓存和格式化结果；提交时中枢再用 pinned baseline 校验工作区身份，任何实际变化都会得到 `STALE_BASELINE`。只有 `implement` 任务被允许修改工作区。`profile` 缺省是 `default`，普通 Agent 不受影响。

绑错了 Agent（或该 Agent 被删了、卡死了）就改绑：`POST /sessions/{sessionId}/participants/{participantId}/binding -d '{"agentId":"agent-..."}'`——改绑会轮换 participantToken，并把这个座位当前欠的任务重新推给新 Agent（即使旧 Agent 已经收到过）。任务队列在中枢侧持久化，且只有 Agent 实际调用 `collab_get_task` 领取后条目才会销掉；所以看板上的“N 未送达”表示任务尚未被扩展领取，超过两分钟会直接报警。

**中枢是推送式的**：任何一方交完自己的活就应当结束回合，绝不要 sleep 轮询。正常 Review 不会回头要求开发方逐条回应；会话结束时中枢推送 `session_result`。人启动 `fix_then_review` 后，中枢才把全部 confirmed Action Items 推给选定开发 Agent；开发 `/ready` 后再主动唤醒原 Reviewer。

> 凭证说明：participantToken 只以 SHA-256 hash 存储，明文只在登记（`/participants`）、改绑（`/binding`）和复核重开（`/recheck` 返回的 `participantTokens`）的 **API 响应**里出现一次，数据库里没有任何明文副本。内置 Pi 协作扩展根本不使用它：它走进程内 bridge，按 `agentId` 认领任务，token 不会进入模型上下文或 Agent 会话。看板也不展示它——人用配对码操作，没人需要把一个长期凭证贴到页面上；要拿就直接读接口响应。

最小流程（review）：

```bash
H="Authorization: Bearer $PAIRING_CODE"; B=http://127.0.0.1:11318/api/v1/collab
curl -H "$H" -X POST $B/sessions -d '{"kind":"review","title":"支付回调评审","workspaceId":"ws-...","subject":{"type":"commit_range","value":"HEAD~1..HEAD"}}'
curl -H "$H" -X POST $B/sessions/$SID/participants -d '{"role":"reviewer","displayName":"reviewer-security","agentId":"agent-..."}'   # 返回一次性 participantToken
curl -H "$H" -X POST $B/sessions/$SID/participants -d '{"role":"implementer","displayName":"impl","agentId":"agent-..."}'
curl -H "$H" -X POST $B/sessions/$SID/advance -d '{}'                                   # 开闸，中枢开始派活
curl -H "Authorization: Bearer $PTOKEN" $B/sessions/$SID/digest                          # Agent 侧：我现在该干什么
```

### Review 与人工触发的修复—复核

```
draft ──advance──▶ [implementing] ──显式 POST /ready──▶ collecting ──▶ validating / merge / discussion ──▶ finished
                                                                                                                       │
finished ── recheck(review_only) ───────────────────────────────────────────────────────────────────────▶ collecting ◀─┤
finished ── recheck(fix_then_review) ──▶ implementing ──POST /ready─────────────────────────────────────▶ collecting   │
                                                                                                                       └─ round+1
```

- 首次勾选 `implementationFirst` 时，唯一的开发 Agent 先收到 `implement` 工单；只有强类型工具显式提交 `/ready` 才会固定 baseline 并召集 Reviewer。Agent 进入 idle 不再被当作完成，避免失败或漏交被误判为可评审。
- `collecting` 是盲审。每个 Reviewer 必须提交 `reviewComplete=true`；新 Finding 强制带 `location.path`、evidence 和当前 baselineId。
- 共识阶段中，每个 Reviewer 对本轮其他人的新 Finding 投 approve/reject，可提出重复项合并；合并必须全票通过。争议经过 `issue_discussing ↔ issue_reconsidering` 收敛。**争议的终局不再一律甩给人**：讨论结束（用满 `maxConsensusRounds`，或某条 Finding 的票型连续两轮完全没变而提前判定“已经吵不动了”）后，中枢按严重度裁决——除报告人外全员 reject 的问题直接 `wontfix`（`blocker`/`critical` 除外）、panel 分裂的 `major` 及以上升级人工、`minor`/`nit` 按多数决，平票保留。只有真正需要判断的分歧才进人工队列。
- 报告人随时可以撤回自己不再坚持的 Finding：`collab_withdraw_issue`，或在 `collab_submit_issue_discussions` 的 `withdrawals[]` 里和其余答辩一次提交（提交工具会结束回合，所以两者必须同一次调用）。撤回是正常动作，不是失败。
- Reviewer 的投票允许**分批**：只投当前工单列出的那些 Finding 即可，别人后来才提交的 Finding 会由中枢重新派工单回来，不会因为“集合在你读代码时变大了”而整批 422。反过来，**没有任何可投票的 Finding 时，这个座位不会被派工单，阶段也不会等它**（单 Reviewer 会话，或它欠的 Finding 都被撤回/合并了）——强类型提交工具没有“空票”这种提交。
- 共识完成后直接 `finished`。有效 Finding 从临时 `open` 转成 `confirmed`，不会触发开发方回应；报告结论为 `approved`、`follow_up_required` 或 `changes_required`。
- finished 看板提供两个入口：**复核当前代码**调用 `POST /recheck {"mode":"review_only"}`；**推进到修复 → 复核**先选择一个已存在或新添加的 implementer，再调用 `POST /recheck {"mode":"fix_then_review","implementerParticipantIds":[...]}`。
- 修复 Agent 收到全部 confirmed Action Items，完成后统一 `/ready`。原 Reviewer 在新 baseline 上收到 `issuesToRecheck`，并在 `/findings` 中提交 `rechecks:[{"issueId":"...","outcome":"resolved|still_present","rationale":"..."}]`；同时仍可发现新的 Finding。
- 每个工单都带上**panel 名单、评分/严重度口径、共识与撤回规则、以及本次评审的 `baseline.changedFiles` 范围**：Reviewer 不知道同伴是谁、不知道 `major` 和 `minor` 的界线、不知道一票 reject 的后果时，投出来的票就没有共同标准。工单里的指令只出现工具名，不出现 HTTP 端点。
- 每多一轮复核就多一段档案：`GET /sessions/:id/review-rounds`（**仅人**）按轮返回该轮复核了哪些老问题（`resolved` / `still_present` / 尚未回报的 `pending`）、该轮新发现了哪些问题，以及该轮的 baseline 与结论。看板把它渲染成“各轮评审 / 复核结果”，最新一轮在最上面。
- 每轮 finished 都发送 `session_result`。重新开启时，中枢会轮换参与者凭证并主动推送新任务，旧的结束消息不会污染新一轮。

人用 `GET /report` 查看每轮结果。校验失败返回 `422` 且带 `fieldErrors`，基线过期返回 `409 STALE_BASELINE`，预算耗尽返回 `429`；所有 Agent 提交都需要 `clientRequestId` 做幂等。

人工升级（escalation）进入 `GET /api/v1/collab/escalations`，用 `POST /api/v1/collab/escalations/:id/resolve` 裁定；裁定会真的落地：`issue_dispute` 必须给 `issueDecision`，`budget_exhausted` 传 `extra.tokenBudget` 就提额并解封该参与者，`other`（轮次封顶死锁）传 `extra.maxTotalRounds` 就抬高轮次上限——参数不合法（字符串、比已用量还小、没比现有上限高）直接 422，不会“看似成功实则什么都没做”地用掉那一次机会；裁定事件里的 `applied` 记录实际生效的变更。预算也可以事后单独提：`POST /sessions/:id/participants/:pid/budget -d '{"tokenBudget":600000}'`。`score_dispute` 不走裁定接口，而是用 `POST /sessions/:id/finalize` 一次性给出每个争议维度的分数（该调用同时关掉这条升级；若人工强推跳过了结算，中枢也会自动关掉它，并把这些维度标为 `method:"forced"` 而不是“已收敛”）。**评分会话里只要还有未裁定的升级，面板就停在当前阶段**（不会被下一阶段越过，否则会出现“会话已结束、问题还挂在人手上”），裁定后自动继续；不想等就用 `POST /advance -d '{"force":true,"reason":"..."}'`。配置了 MailDispatch 时，升级和会话停滞会立即发信（不参与聚合，可在配置对话框关闭；同一会话 5 分钟内最多一封，避免 Agent 连续升级刷爆邮箱）。

Web 看板在 `/collab.html`（首页顶部"协作"入口）：会话列表与创建、参与者登记、Review 动态流程图、逐轮复核档案（每轮一个 section：老问题修好了没有、有没有新问题）、Issue 投票 / 合并 / discussion、待裁定队列、事件时间线，以及 finished 后的“直接复核”和“开发修复后复核”入口，并通过 WebSocket `subscribe_collab` 实时刷新。Review 总结按严重程度列出 confirmed Action Items、文件位置和修复建议。等待状态会同时显示本机 Agent 生命周期：`streaming` / `starting` 表示仍在执行，超过提醒阈值也不判为漏交；只有 `idle` / `unloaded` / `error` 且阶段 API 尚未提交时才适合用 `/retry-waiting` 重新唤醒。`waiting_for_user` 要先处理 Agent 交互；`advance force=true` 会真正跳过未提交结果。

## API

除 Web 静态资源、`/health` 和 `/api/v1/auth/login` 外，请求均需 `Authorization: Bearer <token>`。响应为 `{ data }` 或 `{ error: { code, message, requestId } }`。

- `GET /health`
- `POST /api/v1/auth/login`
- `GET /api/v1/system/status`
- `GET/POST /api/v1/mail-notifications`
- `GET/POST /api/v1/workspaces`
- `GET /api/v1/workspaces/:id/tree|file|stat`
- `GET /api/v1/sessions`
- `GET/POST /api/v1/agents`（创建时可带 `profile`：`default`（默认）或 `collab`；`collab` 会加载协作工具，供协作看板占座使用）
- `GET/DELETE /api/v1/agents/:id`
- `GET/POST /api/v1/collab/sessions`、`/sessions/:id`、`/participants`（含 `/participants/:pid/binding`、`/participants/:pid/budget`）、`/advance`、`/ready`、`/recheck`（**仅人**，重开时轮换每个座位的 token 并在响应 `participantTokens` 里返回一次）、`/policy`、`/events`（`?since=` 游标或 `?tail=` 取最新若干条）、`/digest`、`/issues`、`/findings`、`/issue-votes`、`/merge-votes`、`/issue-discussions`、`/review-consensus`、`/review-rounds`（**仅人**）、`/retry-waiting`、`/escalations`、`/report`（**仅人**），以及 scoring 场景的 `/nominations`、`/votes`、`/criteria`、`/scores`、`/analysis`、`/debates`、`/finalize`（**仅人**，且只在 `awaiting_human` 阶段接受，必须为每个争议维度给一个合刻度的分数）
- `GET /api/v1/collab/escalations`、`POST /api/v1/collab/escalations/:id/resolve`
- `GET/POST /api/v1/terminals`
- `GET/DELETE /api/v1/terminals/:id`
- Terminal WebSocket `/api/v1/terminals/:id/ws` 支持输入、窗口 resize、输出快照和退出事件。
- Agent 的 `state`、`messages`、`capabilities`、`session`、`prompt`、`steer`、`follow-up`、`abort`、`compact`、`model`、`thinking`、`session-name`、`navigate`、`fork`、`archive`、`extension-response`、`commands`、`bash` 和 `bash-abort` 接口。
- `GET /api/v1/agents/:id/commands` 返回该 Agent cwd 下可用的 prompt template 和 skill（`{name, description, argumentHint, source}`）。`prompt` 接口本身会展开 `/命令`、skill 和 prompt template。
- `POST /api/v1/agents/:id/bash` 在 Agent Session 内执行命令（`{command, excludeFromContext}`），输出通过 `bash_execution_update` 事件流式推送并记录到 Session；`POST /api/v1/agents/:id/bash-abort` 取消。
- WebSocket `/api/v1/ws` 支持 sequence、replay、snapshot、`fromNow` 和 Agent command；`subscribe_collab` 推送协作事件。

运行时使用真实 `@earendil-works/pi-coding-agent` SDK，并复用 Pi CLI 的 `~/.pi/agent` 模型、认证和设置。`MockBackend` 只用于自动化测试。

## License

MIT © sxwxs。完整条款见 [`LICENSE`](LICENSE)。
