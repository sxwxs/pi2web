# Remote Pi 实现要点、当前状态与 Android App 实施计划

> 更新时间：2026-07-18  
> 当前阶段：Web Server + Native HTML5 Web UI + Android 原生 App 可用；protocol v1、snapshot、Session/Model/Thinking/Extension UI 已接入

## 1. 当前实现概览

Remote Pi 当前已经形成一个可人工使用的最小闭环：

```text
Native HTML5 Web UI
        │
        ├── HTTP/JSON
        └── WebSocket
                │
                ▼
Remote Pi Node.js Server
        │
        ├── Bearer Token Authentication
        ├── Workspace / Read-only File API
        ├── Agent Manager
        ├── Event Sequence / Replay Cache
        ├── Metadata Persistence
        └── Pi SDK Backend
                │
                ▼
@earendil-works/pi-coding-agent
```

用户现在可以完成：

1. 启动 Remote Pi Server。
2. 使用首次生成的 Access Token 登录。
3. 添加主机上的 Workspace。
4. 在浏览器中递归浏览 Workspace 目录和查看文件。
5. 从目录树选择 Agent 工作目录。
6. 创建真实 Pi Agent。
7. 发送 prompt，并实时查看文本和工具事件。
8. 使用 `@相对路径` 或 `@绝对路径` 引用文件、目录。
9. Abort 当前任务。
10. 页面重新连接后恢复 Agent 列表和历史消息。
11. Server 重启后从 Pi session 文件恢复 Agent。

## 2. 主要实现要点

### 2.1 真实 Pi SDK Backend

运行时默认使用：

```ts
createAgentSession({ cwd, sessionManager })
```

实现位于：

```text
src/sdk-backend.ts
```

`SdkBackend` 实现统一的 `AgentBackend` 接口：

```ts
interface AgentBackend {
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  followUp(message: string): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<AgentState>;
  getMessages(): Promise<unknown[]>;
  subscribe(listener: AgentEventListener): () => void;
  dispose(): Promise<void>;
}
```

真实 Backend 会复用 Pi CLI 的配置：

- `~/.pi/agent/auth.json`
- Pi 模型配置
- Provider 登录及 API Key
- Skills
- Extensions
- 项目上下文文件
- Pi 默认工具
- Pi session 文件

Agent 默认拥有 Pi 正常提供的 `read`、`bash`、`edit`、`write` 等能力。

`MockBackend` 仍保留，但只允许自动化测试显式注入，Server 默认运行路径不会使用 Mock response。

### 2.2 Agent Manager

实现位于：

```text
src/agents.ts
```

当前职责包括：

- 创建和保存多个 Agent。
- 将 Agent 绑定到 Workspace 和经过校验的 cwd。
- 调用 prompt、steer、follow-up 和 abort。
- 获取 state 和 messages。
- 订阅 Pi 的完整事件对象。
- 为每个 Agent 生成递增 sequence。
- 缓存最近 1000 个事件。
- 向多个监听者分发事件。
- 停止和释放 Agent。
- 从持久化元数据恢复 Agent。

每条远程事件的基本结构为：

```json
{
  "type": "agent_event",
  "agentId": "agent-...",
  "eventId": "...",
  "sequence": 42,
  "event": {
    "type": "message_update"
  }
}
```

### 2.3 Workspace 与主机文件访问

实现位于：

```text
src/workspaces.ts
```

Remote Pi 不直接提供任意文件路径读取接口。客户端首先添加 Workspace，之后的文件和 cwd 操作必须在 Workspace 内完成。

已实现的安全校验：

- 将 Workspace 根路径转换为绝对路径。
- 使用 `realpath` 获取实际路径。
- 拒绝 `../` 路径逃逸。
- 拒绝符号链接逃逸 Workspace。
- Agent cwd 必须存在且必须是目录。
- 文件路径必须存在且必须是普通文件。
- 单次文件读取上限为 1 MiB。
- 文件总大小默认上限为 10 MiB。
- 支持 offset/limit 分页读取。
- 包含 NUL 字节的内容按二进制文件处理。
- 目录列表默认隐藏以 `.` 开头的项目。

当前文件 API 是只读的。Web Server 没有额外提供编辑、删除、重命名、上传或独立终端 API。Pi Agent 自身仍然可以通过 Pi 工具修改文件。

### 2.4 Access Token 与认证

实现位于：

```text
src/auth.ts
```

配置文件默认保存在：

```text
~/.pi/remote-pi/auth.json
```

当前行为：

- 首次启动使用系统安全随机数生成 Token。
- 明文 Token 只在首次启动时输出。
- 配置文件只保存 SHA-256 hash。
- 使用 timing-safe comparison 校验 hash。
- `auth.json` 权限设置为 `0600`。
- 支持 Token 轮换。
- HTTP API 支持 Bearer Token。
- WebSocket 支持 Authorization header。
- 浏览器无法设置 WebSocket Authorization header，因此 Native Web UI 使用 `access-token.<token>` subprotocol 认证。
- Token 不放在 URL query string 中。

### 2.5 HTTP API

当前接口包括：

```text
GET    /health
POST   /api/v1/auth/login

GET    /api/v1/workspaces
POST   /api/v1/workspaces
GET    /api/v1/workspaces/:id/tree
GET    /api/v1/workspaces/:id/file

GET    /api/v1/agents
POST   /api/v1/agents
GET    /api/v1/agents/:id
DELETE /api/v1/agents/:id
GET    /api/v1/agents/:id/state
GET    /api/v1/agents/:id/messages
POST   /api/v1/agents/:id/prompt
POST   /api/v1/agents/:id/steer
POST   /api/v1/agents/:id/follow-up
POST   /api/v1/agents/:id/abort

GET    /api/v1/ws
```

HTTP 返回格式统一为：

```json
{
  "data": {}
}
```

或：

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Error message",
    "requestId": "..."
  }
}
```

每个 HTTP 请求都有 `x-request-id` 响应头。

### 2.6 WebSocket

当前 WebSocket 支持：

- Token 认证。
- 订阅指定 Agent。
- prompt 命令。
- steer 命令。
- follow-up 命令。
- abort 命令。
- command result。
- Agent 实时事件。
- sequence。
- eventId。
- 使用 `lastSequence` 回放缓存事件。
- 一个连接订阅多个 Agent 的服务端基础能力。

WebSocket 断开不会自动停止 Agent，Agent 在 Server 中继续运行。

### 2.7 Session 与元数据持久化

Remote Pi 元数据默认存放在：

```text
~/.pi/remote-pi/
├── auth.json
├── workspaces.json
└── agents.json
```

其中：

- `workspaces.json` 保存 Workspace allowlist。
- `agents.json` 保存 Remote Pi Agent ID、Workspace、cwd、sessionId、sessionFile、创建时间和最后活动时间。
- 完整消息不复制到 Remote Pi 元数据中。
- 完整会话历史继续由 Pi session 文件保存。

Server 重启时：

1. 读取 Workspace 元数据。
2. 读取 Agent 元数据。
3. 校验保存的 cwd 仍位于 Workspace 中。
4. 使用 `SessionManager.open(sessionFile)` 恢复 Pi session。
5. 恢复 Agent ID 和历史 messages。
6. 不重新执行上一次 prompt。

当前实现会在 Server 启动时恢复保存的 Agent，而不是计划中更理想的按需懒加载。Agent 数量较少时可接受，后续应改成历史元数据立即可见、用户打开时再创建 SDK runtime。

### 2.8 Native HTML5 Web UI

实现位于：

```text
web/
├── index.html
├── app.js
└── styles.css
```

Web UI 不使用任何前端 npm 第三方依赖，仅使用：

- HTML5
- CSS
- Fetch API
- WebSocket API
- DOM API
- LocalStorage

当前功能：

- API 地址和 Token 登录。
- Workspace 添加及选择。
- 主机目录递归浏览。
- 文件内容预览。
- Agent 工作路径字段。
- 右键目录设置 Agent cwd。
- 右键文件或目录插入 `@路径`。
- cwd 内使用相对路径，cwd 外使用绝对路径。
- Agent 创建和列表。
- 自动选择上次打开的 Agent。
- 历史消息加载。
- 实时文本增量。
- 工具开始和完成提示。
- Abort。
- 页面刷新后重新加载已有 Agent。

## 3. 当前测试状态

执行命令：

```bash
npm run check
npm test
node --check web/app.js
```

当前自动化测试覆盖：

- Token 首次生成。
- Token 不以明文保存。
- Token 校验和轮换。
- 未认证 API 拒绝。
- Login 和 health。
- Workspace 文件列表。
- 隐藏文件过滤。
- 文件分页读取。
- 路径穿越拒绝。
- 符号链接逃逸拒绝。
- 大文件读取限制。
- Agent 事件 sequence。
- Agent prompt、dispose 和 stopped 状态。
- Workspace 和 Agent 元数据在 Server 重启后的恢复。

自动化测试通过显式注入 MockBackend，因此不需要真实 Provider Key，也不会消耗 LLM Token。

真实 Pi SDK 已进行过不发送 prompt 的 session 创建冒烟测试。正式发布前还需要增加可由开发者手动开启的真实 Provider 集成测试。

## 4. 当前限制和待完成项

当前版本是可用原型，但还没有达到 `PLAN.md` 中“完整 Web 第一阶段”的 Definition of Done。

### 4.1 协议与类型

- 已提供 `packages/protocol/openapi.yaml`。
- 已提供 `packages/protocol/websocket.schema.json`。
- HTTP body 尚未使用完整 schema 校验。
- Web UI 仍手写请求和响应字段。
- Android 开发前必须固定协议版本和错误码。

### 4.2 Agent 与 Session

- 已提供 session 列表、创建/打开、fork 和 tree navigation API。
- 已提供 compact API。
- 已提供 model 列表和 model 切换 API。
- 已提供 thinking level 查询和修改 API。
- 当前恢复是启动时恢复，不是懒加载。
- Agent 运行时错误状态和崩溃恢复还不完整。
- Agent 元数据尚未在每个事件后立即持久化 lastActiveAt。
- Agent 空闲超时尚未实现。
- 并发 Agent 数量限制尚未实现。

### 4.3 并发控制

- 尚未实现一个控制者、多个只读客户端策略。
- streaming 时 prompt 冲突规则需要进一步固定。
- steer/follow-up 队列状态尚未完整展示。
- WebSocket 命令尚未执行严格 schema 白名单校验。

### 4.4 事件恢复

- Server 内存中只缓存最近 1000 个事件。
- 缓存不足时 Server 会返回 `agent_snapshot` 完整 state/messages 快照。
- Server 重启后 Remote Pi 事件 sequence 仍会重新开始。
- Android 客户端会持久化每个 Agent 的最后 sequence 并进行去重/gap 检测。
- Android 客户端已实现 WebSocket 指数退避自动重连；Native Web UI 尚未实现。

### 4.5 Extension UI

Android 已实现以下 Pi Extension UI 转换：

- select
- confirm
- input
- editor
- notify
- setStatus
- setWidget
- setTitle
- extension response

Native Web UI 仍待接入这些事件。

### 4.6 文件和附件

- 尚未实现 `/stat` API。
- UTF-8 检测目前较简单。
- 尚未实现图片消息。
- 尚未实现 Workspace 文件附件的结构化协议。
- `@路径` 当前只是插入 prompt 文本，不是独立 attachment 对象。

### 4.7 安全和运维

- 登录失败限速尚未实现。
- API 总体限流尚未实现。
- WebSocket Origin 校验尚未实现。
- CORS 当前为便于开发设置成 `*`，正式部署前必须改成配置 allowlist。
- 审计日志尚未实现。
- 结构化日志尚未完整实现。
- 请求体限制按字符串长度计算，需改成字节级流式限制。
- 尚未提供 HTTPS，生产访问必须使用 VPN、SSH tunnel 或反向代理。
- Token revoke 尚未独立实现，目前通过 rotate 使旧 Token 失效。

## 5. Android 开发前必须完成的 Server 工作

Android 不应直接依赖当前原型中未固定的 JSON 细节。在开始主要 UI 开发前，建议先完成以下协议冻结工作。

### 5.1 发布协议 v1

新增：

```text
packages/protocol/
├── openapi.yaml
├── websocket.schema.json
└── examples/
```

至少固定：

- Server 配置和健康检查。
- Token 登录和认证失败语义。
- Workspace 数据结构。
- TreeEntry 和 FileContent 数据结构。
- AgentSummary、AgentState 和 AgentMessage。
- WebSocket subscribe、resume、command_result 和 agent_event。
- sequence 恢复规则。
- 通用错误码。
- 最大请求和响应大小。
- ISO 8601 时间格式。

### 5.2 增加 Server 能力

Android MVP 前至少补充：

1. `GET /api/v1/system/status`
2. `GET /api/v1/workspaces/:id/stat`
3. Session 列表和打开接口
4. Model、thinking level 查询和修改接口
5. WebSocket 快照恢复事件
6. WebSocket Origin/客户端类型策略
7. 登录和命令限流
8. Agent 并发限制
9. WebSocket 自动重连测试
10. 稳定的 tool event 展示字段

### 5.3 Android 兼容性约定

- Android 使用 HTTPS/WSS 访问远程 Server。
- OkHttp WebSocket 可以直接设置 `Authorization: Bearer ...`，不需要浏览器 subprotocol workaround。
- Access Token 不放在 URL、日志或通知 payload 中。
- Server URL 与 Token 分开保存。
- Android 客户端必须支持协议版本检查。
- Server 应返回自身版本和协议版本。

## 6. Android App 技术方案

### 6.1 技术栈

建议固定为：

- Kotlin
- Jetpack Compose
- Material 3
- Kotlin Coroutines + Flow
- OkHttp WebSocket
- Retrofit，或基于 OkHttp 的轻量 HTTP Client
- Kotlinx Serialization
- Room
- AndroidX DataStore
- WorkManager
- Hilt（如果项目规模需要依赖注入）
- Coil（图片消息阶段再引入）
- Firebase Cloud Messaging（第二阶段通知）

最低 Android 版本建议先定为 API 26，目标版本使用开发时最新稳定 SDK。

### 6.2 推荐 Android 目录结构

```text
android/
├── app/
│   └── src/main/java/.../
│       ├── RemotePiApplication.kt
│       ├── MainActivity.kt
│       ├── navigation/
│       └── ui/
├── core/
│   ├── model/
│   ├── network/
│   ├── database/
│   ├── security/
│   └── testing/
├── feature/
│   ├── servers/
│   ├── workspaces/
│   ├── files/
│   ├── agents/
│   ├── conversation/
│   ├── sessions/
│   └── settings/
└── build-logic/
```

第一版也可以先采用单 app module，但 package 仍按上述边界组织，避免网络、数据库和 Compose UI 混在一起。

### 6.3 核心数据模型

Android 本地至少需要：

```kotlin
data class ServerProfile(
    val id: String,
    val name: String,
    val baseUrl: String,
    val certificatePolicy: CertificatePolicy,
    val lastConnectedAt: Instant?,
)

data class AgentSummary(
    val id: String,
    val workspaceId: String,
    val cwd: String,
    val sessionId: String,
    val status: AgentStatus,
    val lastActiveAt: Instant,
)

data class AgentCursor(
    val serverId: String,
    val agentId: String,
    val lastSequence: Long,
)
```

Access Token 不应放进 `ServerProfile` 普通数据库记录，而应使用 Android Keystore 加密保存。

### 6.4 网络层

实现两个客户端：

```text
RemotePiHttpClient
RemotePiWebSocketClient
```

HTTP Client 负责：

- 自动添加 Bearer Token。
- 设置协议版本 header。
- requestId 日志关联。
- 401 统一触发认证失效。
- 错误码转换为领域异常。
- 超时和网络切换处理。

WebSocket Client 负责：

- 使用 WSS。
- Bearer header 认证。
- subscribe 和 resume。
- command requestId 跟踪。
- sequence 去重。
- sequence gap 检测。
- 指数退避重连。
- 网络恢复后立即重连。
- App 前后台状态处理。

建议重连延迟：

```text
1s → 2s → 4s → 8s → 15s → 30s
```

成功稳定连接一段时间后重置 backoff。

### 6.5 本地缓存

Room 保存：

- Server Profile 非敏感部分。
- Workspace 摘要。
- Agent 摘要。
- 最近消息展示缓存。
- 每个 Agent 的 lastSequence。
- 未读事件计数。
- 最近访问文件。

Android 不需要复制完整 Pi session。Server 仍然是 Agent 和 Session 的唯一事实来源。Room 只用于快速启动、离线占位和断线恢复。

## 7. Android App 分阶段计划

### Phase A：项目骨架和 Server 配置

任务：

- 初始化 Gradle 和 Compose 项目。
- 设置 Kotlin、Compose、lint 和单元测试。
- 实现 Server Profile 列表。
- 实现添加、编辑和删除 Server。
- 输入 base URL 和 Access Token。
- 使用 Android Keystore 保存 Token。
- 调用 `/health` 和 `/api/v1/auth/login` 测试连接。
- 明确 HTTP 明文流量仅允许 debug build。
- Release build 默认要求 HTTPS。

页面：

```text
ServerListScreen
ServerEditScreen
```

验收：

- 可以保存多个 Remote Pi Server。
- Token 不出现在日志、URL、Room 明文数据库中。
- 无效 Token 有明确错误提示。
- TLS 错误不会被静默忽略。

### Phase B：Workspace 和文件浏览

任务：

- Workspace 列表。
- 目录懒加载。
- 面包屑导航。
- 文件内容分页。
- 文本与二进制状态展示。
- 代码等宽字体。
- 最近文件。
- 选择目录作为 Agent cwd。
- 长按文件或目录生成 `@路径`。

页面：

```text
WorkspaceListScreen
FileBrowserScreen
FilePreviewScreen
```

验收：

- 可以递归浏览 Workspace。
- 大文件不会一次加载到内存。
- 旋转屏幕后保留目录位置和文件滚动位置。
- Workspace 外路径错误被正确显示。

### Phase C：Agent 列表和创建

任务：

- Agent 列表。
- Agent 状态 badge。
- 创建 Agent。
- 选择 Workspace 和 cwd。
- 显示 session、model、thinking level。
- 停止 Agent。
- 最近活动时间。
- 下拉刷新。

页面：

```text
AgentListScreen
CreateAgentScreen
```

验收：

- Server 重启后历史 Agent 仍可见。
- 创建 Agent 不能越过 Workspace。
- stopped/error 状态明确显示。
- 创建失败不会留下本地幽灵 Agent。

### Phase D：对话和实时事件

任务：

- Agent Conversation 页面。
- 初始 HTTP messages 加载。
- WebSocket subscribe/resume。
- 流式文本增量合并。
- thinking block。
- tool call 卡片。
- tool result 卡片。
- bash streaming 卡片。
- retry、error、compaction 状态。
- prompt。
- abort。
- steer。
- follow-up。
- `@文件` 和 `@目录` 输入辅助。

页面：

```text
AgentConversationScreen
ToolCallCard
ThinkingBlock
PromptComposer
```

状态建议使用单向数据流：

```text
HTTP snapshot + ordered WebSocket events
                    │
                    ▼
             ConversationReducer
                    │
                    ▼
              ConversationUiState
```

验收：

- 断开重连不重复显示消息。
- sequence gap 会请求完整 snapshot。
- 切换 Agent 不会串流事件。
- 屏幕旋转不丢失正在流式输出的内容。
- Abort 能立即改变 UI 状态并最终与 Server 对齐。

### Phase E：Session、Model 和 Pi 完整控制

任务：

- Session 列表。
- 新建和恢复 Session。
- Fork。
- Session tree。
- Compact。
- Model 选择。
- Thinking level。
- 图片消息。
- 结构化文件附件。
- Slash command 补全。
- Export。

验收：

- 所有操作由 Server API 完成，Android 不包含 Agent 执行逻辑。
- Session 切换后旧 WebSocket 事件不会污染新 Session。
- Model 不可用和 Provider 未登录有明确提示。

### Phase F：Extension UI

任务：

将 Server 的 extension UI request 映射为 Compose 组件：

| Pi 请求 | Android UI |
|---|---|
| select | ModalBottomSheet / Dialog |
| confirm | AlertDialog |
| input | TextField Dialog |
| editor | Full-screen editor |
| notify | Snackbar / system notification |
| setStatus | Agent 顶部状态区 |
| setWidget | 可折叠 Widget 卡片 |
| setTitle | 页面标题 |

要求：

- 每个请求带唯一 requestId。
- App 旋转和进程重建后不会重复响应。
- 超时和 Agent 取消会自动关闭对应 UI。
- 同一时间多个请求按队列处理。

### Phase G：后台和通知

仅在 Web MVP 和 Android 前台功能稳定后开始。

Server 新增：

```text
POST   /api/v1/devices
GET    /api/v1/devices
DELETE /api/v1/devices/:id
```

Android 实现：

- FCM Token 注册和更新。
- 通知渠道。
- Agent 完成通知。
- Agent 错误通知。
- 等待用户确认通知。
- Extension UI 请求通知。
- Deep Link：`pi://agent/:agentId`。
- eventId 去重。
- 注销 Server 时撤销设备注册。

通知 payload 不包含 Token、完整 prompt、模型输出或文件内容。

### Phase H：发布与安全加固

任务：

- Release build 禁止明文 HTTP。
- Network Security Config。
- 可选自签名证书指纹固定。
- 数据库迁移测试。
- Android Backup 排除 Token。
- 崩溃日志敏感信息脱敏。
- ProGuard/R8。
- 无障碍检查。
- 深色模式。
- 平板和横屏布局。
- 电池和网络消耗测试。

## 8. Android 测试计划

### 8.1 单元测试

- API DTO 到领域模型转换。
- HTTP 错误码转换。
- Conversation reducer。
- text delta 合并。
- sequence 去重。
- sequence gap 检测。
- 重连 backoff。
- `@路径` 相对/绝对计算。
- Agent 状态机。
- Notification eventId 去重。

### 8.2 集成测试

使用本地 Fake Remote Pi Server，不调用真实 LLM：

- 登录成功和失败。
- Workspace 和目录分页。
- Agent 创建。
- WebSocket subscribe。
- 流式事件。
- 断线恢复。
- 401 Token 失效。
- Server 500。
- command_result 超时。
- sequence cache miss 和 snapshot 恢复。

### 8.3 Compose UI 测试

- Server 添加流程。
- Workspace 浏览。
- 目录选择 cwd。
- Agent 创建。
- Prompt 发送。
- Tool 卡片展开。
- Abort。
- Extension Dialog。
- 窄屏、横屏和字体放大。

### 8.4 真机测试

至少覆盖：

- Wi-Fi 与移动网络切换。
- App 切后台和恢复。
- 系统杀进程后恢复。
- VPN/Tailscale 场景。
- 自签名 TLS 错误。
- 长时间流式响应。
- 大量 tool output。
- 多个 Agent 同时运行。

## 9. 推荐实施顺序

建议严格按以下顺序继续：

1. 固定 OpenAPI 和 WebSocket Schema。
2. 补 Server snapshot/resume 和严格请求校验。
3. 补安全限流、Origin 和 CORS allowlist。
4. 建立 Android 项目骨架。
5. 完成 Server 配置和安全 Token 存储。
6. 完成 Workspace/文件浏览。
7. 完成 Agent 列表和创建。
8. 完成对话/WebSocket 最小闭环。
9. 完成断线恢复和序号去重。
10. 补 Session、Model、Thinking 和 Extension UI。
11. 最后实现 FCM 后台通知。

不要在 WebSocket 恢复协议固定前实现复杂 Conversation UI，也不要在前台 Agent 功能稳定前接入 FCM。

## 10. Android MVP Definition of Done

Android MVP 需要同时满足：

- 可以保存和切换多个 Server。
- Token 使用 Android Keystore 安全保存。
- Release 模式默认只允许 HTTPS/WSS。
- 可以登录并显示认证失败原因。
- 可以浏览 Workspace 和文件。
- 可以从选定目录创建 Agent。
- 可以加载已有 Agent 和历史 messages。
- 可以发送 prompt。
- 可以实时显示文本和工具事件。
- 可以 abort。
- WebSocket 断线后自动 resume。
- 不重复显示相同 sequence/eventId。
- App 重启后能恢复上次 Server 和 Agent 页面。
- 自动化测试不依赖真实 LLM Key。
- 通知 payload 和日志中不包含 Token 或敏感文件内容。

完成上述 MVP 后，再将 steer/follow-up、完整 Session 控制、Extension UI、图片附件和 FCM 作为后续增量交付。
