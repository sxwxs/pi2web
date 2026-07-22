# Remote Pi 实施计划

## 1. 项目目标

Remote Pi 的目标是让运行在本地机器上的 Pi coding agent 通过 Web 浏览器和 Android App 远程访问。

本地机器负责：

- 运行 Web Server
- 运行 Pi agent
- 访问本地文件系统
- 执行 Pi 内置工具和扩展工具
- 保存 Pi session
- 调用 LLM provider

远程设备负责：

- 查看 agent 状态
- 浏览项目文件
- 发送 prompt 和控制命令
- 查看完整的 agent 输出
- 在 Android 上接收任务完成、错误和等待确认等通知

总体架构：

```text
Browser / Android App
        │
        │ HTTPS + WebSocket
        ▼
Remote Pi Web Server
        │
        ├── Authentication
        ├── Workspace/File API
        ├── Agent Manager
        ├── Session Manager
        ├── WebSocket Event Bus
        └── Notification Adapter
                │
                ├── Pi SDK AgentSession
                │
                └── pi --mode rpc
```

## 2. 开发原则

1. Web Server 是唯一的远程入口，浏览器和 Android 不直接连接 Pi agent。
2. Web UI 和 Android App 使用同一套 HTTP/WebSocket 协议。
3. Agent 事件必须完整转发，不能只转发最终文本。
4. 第一阶段优先使用 Pi SDK，保留 RPC backend 作为隔离和兼容方案。
5. 文件访问必须基于 workspace allowlist，不能直接暴露任意本地路径。
6. 默认只监听 `127.0.0.1`，远程监听必须显式开启。
7. Android App 只做 API 客户端，不复制 Agent 运行逻辑。
8. 通知功能通过独立 adapter 实现，不耦合 Agent Manager。

## 3. 与 Pi 的集成点

Pi 当前已经提供两种适合 Remote Pi 的能力：

### 3.1 SDK

使用 `@earendil-works/pi-coding-agent` 的 SDK 和 runtime：

- `createAgentSession()`
- `createAgentSessionRuntime()`
- `AgentSession.subscribe()`
- `AgentSession.prompt()`
- `AgentSession.steer()`
- `AgentSession.followUp()`
- `AgentSession.abort()`
- session 新建、恢复、fork 和 tree navigation

SDK 适合作为第一版默认 backend，因为 Web Server 可以直接订阅完整事件并管理多个 agent。

### 3.2 RPC

Pi 的 `--mode rpc` 提供 JSONL 协议，支持：

- prompt、steer、follow-up
- abort
- get_state、get_messages
- session 操作
- model 和 thinking level 操作
- tool 和 bash 事件
- extension UI 请求

RPC 是 stdin/stdout 协议，不是 TCP/HTTP 服务。Remote Pi 可以通过子进程方式使用它：

```text
Remote Pi Web Server → spawn pi --mode rpc → stdin/stdout JSONL
```

RPC backend 适合后续实现进程隔离、独立重启和 CLI 行为兼容。

## 4. 推荐目录结构

Remote Pi 建议作为独立项目开发，不直接把 Web Server 和 Web UI 代码加入 pi 仓库：

```text
remote-pi/
  PLAN.md
  README.md
  package.json
  tsconfig.json
  apps/
    server/
      src/
        main.ts
        config.ts
        http/
        auth/
        websocket/
        workspaces/
        filesystem/
        agents/
        sessions/
        events/
        notifications/
    web/
      src/
        api/
        websocket/
        state/
        pages/
        components/
  packages/
    protocol/
      src/
        http-schema.ts
        websocket-schema.ts
        events.ts
    agent-backend/
      src/
        backend.ts
        sdk-backend.ts
        rpc-backend.ts
  android/
    # 第二阶段加入 Android 工程
  test/
```

推荐定义独立的 `AgentBackend` 抽象：

```ts
interface AgentBackend {
  prompt(message: string, options?: PromptOptions): Promise<void>;
  steer(message: string, options?: PromptOptions): Promise<void>;
  followUp(message: string, options?: PromptOptions): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<AgentState>;
  getMessages(): Promise<AgentMessage[]>;
  subscribe(listener: AgentEventListener): () => void;
  dispose(): Promise<void>;
}
```

这样 Web Server 不依赖 SDK 或 RPC 的具体细节。

## 5. 第一阶段：Web Server 和 Web UI

### 5.1 第一阶段交付范围

#### Web Server

- 首次启动生成 access token
- token 认证和轮换
- HTTP API
- WebSocket 实时连接
- workspace 管理
- 本地目录浏览
- 文件内容查看
- 在指定 workspace/cwd 创建 Pi agent
- agent 状态和 session 管理
- prompt、steer、follow-up、abort
- 全量 Pi 事件转发
- 多 agent 管理
- 服务重启后的 session 恢复

#### Web UI

- 登录页
- workspace 列表
- 文件树和文件内容预览
- agent 列表
- 创建和关闭 agent
- 对话界面
- 流式输出
- thinking block
- tool call 和 tool result
- bash 输出
- abort、steer、follow-up
- model 和 thinking level 设置
- session 切换和恢复
- Pi extension UI 的基础 Web 适配

### 5.2 Access Token

默认配置目录：

```text
~/.pi/remote-pi/
  auth.json
```

首次启动流程：

1. 检查 `auth.json` 是否存在。
2. 不存在时使用系统安全随机数生成 token。
3. 只在终端输出一次明文 token。
4. 配置文件只保存 token hash，不保存明文 token。
5. 文件权限设置为 `0600`。
6. 后续启动不自动生成新 token。

管理命令：

```bash
remote-pi --print-access-token
remote-pi --rotate-access-token
remote-pi --host 127.0.0.1 --port 11318
```

认证接口：

```http
POST /api/v1/auth/login
Authorization: Bearer <access-token>
```

需要支持：

- token 校验
- token 轮换
- token 撤销
- 登录失败限速
- 不在日志中打印 token
- WebSocket 连接认证

第一版可以使用 Bearer token。后续可以增加短期 session cookie，但长期 access token 不应直接作为普通 cookie 使用。

### 5.3 Workspace 模型

不要允许客户端任意指定绝对路径。使用 workspace allowlist：

```ts
interface Workspace {
  id: string;
  label: string;
  rootPath: string;
  createdAt: string;
}
```

所有以下操作都必须经过 workspace 校验：

- 文件列表
- 文件读取
- agent cwd
- 文件附件
- 后续文件编辑

创建 agent 时，客户端只能选择 workspace 内的目录：

```json
{
  "workspaceId": "project-a",
  "relativeCwd": "packages/coding-agent",
  "model": "anthropic/claude-sonnet-4",
  "thinkingLevel": "medium"
}
```

服务端计算最终 cwd，并校验：

- 路径存在
- 路径是目录
- 路径位于 workspace root 内
- 符号链接不会逃逸 workspace
- 客户端不能通过参数覆盖安全配置

### 5.4 文件系统 API

第一版只读：

```http
GET /api/v1/workspaces
POST /api/v1/workspaces
GET /api/v1/workspaces/:id/tree?path=.
GET /api/v1/workspaces/:id/file?path=src/index.ts
GET /api/v1/workspaces/:id/stat?path=src/index.ts
```

文件读取需要支持：

- 最大文件大小限制
- offset/limit 分页
- UTF-8 检测
- 二进制文件识别
- 文件大小和修改时间
- 目录排序
- 隐藏文件策略
- 符号链接策略

禁止：

- `../` 路径穿越
- 读取 workspace 外文件
- 读取任意系统文件
- 未限制地读取超大文件

### 5.5 Agent API

```http
GET    /api/v1/agents
POST   /api/v1/agents
GET    /api/v1/agents/:id
DELETE /api/v1/agents/:id
POST   /api/v1/agents/:id/prompt
POST   /api/v1/agents/:id/steer
POST   /api/v1/agents/:id/follow-up
POST   /api/v1/agents/:id/abort
GET    /api/v1/agents/:id/state
GET    /api/v1/agents/:id/messages
```

创建 agent：

```json
{
  "workspaceId": "project-a",
  "relativeCwd": ".",
  "sessionId": null,
  "model": "anthropic/claude-sonnet-4",
  "thinkingLevel": "medium"
}
```

返回：

```json
{
  "id": "agent-123",
  "workspaceId": "project-a",
  "cwd": "/home/user/project-a",
  "sessionId": "session-123",
  "status": "idle"
}
```

Agent Manager 负责：

- agent 生命周期
- backend 创建和销毁
- session 绑定
- 事件订阅
- WebSocket 客户端订阅
- 并发控制
- 空闲超时
- 服务关闭时清理
- agent 崩溃后的错误状态

### 5.6 WebSocket 协议

入口：

```text
GET /api/v1/ws
```

客户端订阅：

```json
{
  "type": "subscribe",
  "agentId": "agent-123"
}
```

客户端命令：

```json
{
  "requestId": "req-1",
  "type": "prompt",
  "agentId": "agent-123",
  "message": "检查项目中的测试失败原因"
}
```

服务端命令响应：

```json
{
  "type": "command_result",
  "requestId": "req-1",
  "success": true
}
```

服务端事件：

```json
{
  "type": "agent_event",
  "eventId": "event-123",
  "sequence": 42,
  "agentId": "agent-123",
  "event": {
    "type": "message_update",
    "assistantMessageEvent": {
      "type": "text_delta",
      "delta": "正在检查..."
    }
  }
}
```

每个 agent 的事件必须包含递增 `sequence`。客户端重连时可以携带最后收到的序号：

```json
{
  "type": "resume",
  "agentId": "agent-123",
  "lastSequence": 42
}
```

如果事件缓存不足，服务端返回当前完整 state 和 messages。

### 5.7 需要完整转发的 Pi 能力

| Pi 能力 | Web 支持方式 |
|---|---|
| prompt | 输入框和 WebSocket command |
| steer | steering queue |
| follow-up | follow-up queue |
| abort | 中止按钮 |
| get_state | 状态面板 |
| get_messages | 对话恢复 |
| new session | 新建 session |
| resume | session 列表 |
| fork | session 分支 |
| tree navigation | 消息树导航 |
| compact | 上下文压缩操作 |
| set model | 模型选择器 |
| thinking level | thinking 设置 |
| tool call | 工具执行卡片 |
| tool result | 工具结果卡片 |
| bash streaming | 实时命令输出 |
| thinking output | 可展开 thinking block |
| retry | 重试状态展示 |
| images | 图片上传/粘贴 |
| file attachments | workspace 内文件附件 |
| slash commands | 命令输入和补全 |
| extension UI | Web dialog/select/input/editor |
| setStatus | agent 状态栏 |
| setWidget | Web 状态组件 |
| notify | Web notification |
| export | 下载 HTML/session |
| errors | 错误卡片和恢复操作 |

### 5.8 Extension UI

RPC/SDK 的 extension UI 不能在 Web 端丢失。需要转换为浏览器交互：

```text
extension_ui_request
        │
        ▼
Web modal / select / input / editor
        │
        ▼
extension_ui_response
```

第一版至少支持：

- select
- confirm
- input
- editor
- notify
- setStatus
- setWidget
- setTitle

### 5.9 Web UI 页面

#### 登录页

- access token 输入
- 连接测试
- token 过期/无效提示
- 注销

#### Workspace 页面

- workspace 列表
- 添加 workspace
- 文件树
- 文件内容预览
- 当前 cwd
- 最近修改文件
- 启动 agent

#### Agent 页面

左侧：

- agent/session 列表
- agent 状态
- cwd
- model
- thinking level

中间：

- 对话消息
- thinking block
- tool call
- tool output
- bash streaming
- compaction
- retry
- error

底部：

- prompt 输入框
- steer/follow-up 模式
- abort
- 图片和文件附件
- slash command 补全

右侧可选：

- 文件树
- session tree
- token/cost 信息
- 当前工具状态

## 6. 第一阶段实施顺序

### Phase 1A：服务骨架

- 初始化项目和 TypeScript 配置
- HTTP Server
- 配置加载
- `/health`
- access token 初始化
- `/api/v1/auth`
- WebSocket 建连、认证和关闭
- 基础日志

验收：

- 第一次启动生成 token
- 未认证请求被拒绝
- 已认证客户端可以建立 WebSocket

### Phase 1B：Agent Manager

- `AgentBackend` 抽象
- SDK backend
- agent 创建、查询、停止
- workspace/cwd 校验
- session 元数据保存
- 服务重启后的 session 恢复策略
- agent 错误和退出处理

验收：

- API 创建 agent
- API 获取 state/messages
- API 发送 prompt
- API 停止 agent
- 服务退出时不残留 agent 进程或请求

### Phase 1C：事件总线

- Pi event 到 Remote Pi event 的映射
- WebSocket 订阅
- 事件序号
- 断线重连
- 状态恢复
- 多客户端订阅
- 控制者/只读客户端策略

### Phase 1D：文件系统

- workspace 管理
- 目录树 API
- 文件内容 API
- 路径安全校验
- 文件大小和编码限制
- Web 文件树

### Phase 1E：基础 Web UI

- 登录
- workspace 选择
- 文件浏览
- agent 列表
- 对话界面
- 流式输出
- tool call 展示
- abort、steer、follow-up

### Phase 1F：完整 Pi 交互能力

- session 新建、恢复、fork
- session tree
- compact
- model/thinking 设置
- 图片和文件附件
- slash commands
- extension UI
- widgets/status
- export
- retry 和错误恢复

### Phase 1G：安全和发布

- 认证审计
- 限流
- 资源限制
- HTTPS/反向代理文档
- 安全测试
- 部署脚本
- 用户文档

## 7. 安全要求

Pi 默认拥有启动用户权限，包括文件系统、shell、网络和本地凭据访问权限。Remote Pi 不能把服务直接裸露到公网。

### 访问层

- 默认监听 `127.0.0.1`
- 远程监听必须通过显式参数开启
- 推荐通过 Tailscale、VPN 或反向代理访问
- 生产环境使用 HTTPS
- WebSocket 校验 Origin
- 所有 API 和 WebSocket 需要认证

### 文件系统

- workspace allowlist
- 规范化路径后再校验 root
- 防止符号链接逃逸
- 文件读取大小限制
- 限制二进制文件读取
- 不默认开放 `/`、home 或敏感目录

### Agent

- 限制可使用的 cwd
- 限制并发 agent 数量
- 限制 prompt 和附件大小
- agent 空闲超时
- 服务关闭时优雅停止
- 不允许客户端任意传 CLI 参数

### 并发

同一个 agent 在 streaming 时：

- 普通 prompt：拒绝，或要求指定 queue 行为
- steer：进入 steering queue
- follow-up：进入 follow-up queue
- abort：立即执行
- 多个浏览器连接：默认一个控制者，其余只读

## 8. 第一阶段持久化

当前实现使用：

```text
~/.pi/remote-pi/
  auth.json
  remote-pi.db
```

SQLite 保存 Workspace、Agent、Archive 状态和可重建的 Session 列表索引。数据库使用 WAL、短事务、部分索引以及合并后的活动时间更新；旧版 Remote Pi 元数据 JSON 不读取也不迁移。

第一版仍不复制完整消息历史。完整对话、分支和 Compact 数据继续由 Pi JSONL Session 文件保存，SQLite 仅保存列表、排序、分页和恢复映射所需的轻量元数据。

## 9. 第二阶段：Android App

Android App 是第一阶段 API 的原生客户端，不直接连接 Pi agent。

### 9.1 Android 技术栈

建议：

- Kotlin
- Jetpack Compose
- Retrofit 或 Ktor Client
- OkHttp WebSocket
- Room 或 DataStore
- WorkManager
- Firebase Cloud Messaging

如果需要支持没有 Google Play Services 的设备，再评估 UnifiedPush 或厂商推送。

### 9.2 Android 页面

#### Server 配置

- 输入服务器地址
- 输入 access token
- 测试连接
- 保存多个服务器
- TLS 证书错误提示

#### Agent 列表

- 当前运行状态
- 最近一条消息
- 最后活动时间
- 未读事件数量
- 快速进入会话

#### Agent 对话

- 流式文本
- thinking 展开/折叠
- 工具执行状态
- bash 输出
- 图片消息
- 文件引用
- prompt、steer、follow-up
- abort
- 横竖屏适配

#### 文件浏览

- workspace
- 文件树
- 文件内容预览
- 搜索
- 最近文件
- 代码高亮

### 9.3 Android 复用能力

Android 必须复用第一阶段协议中的：

- 认证
- workspace
- 文件浏览
- agent 创建
- prompt
- steer/follow-up
- abort
- model 设置
- thinking 设置
- tool 输出
- extension UI
- 图片附件
- session 管理

第一阶段完成后应冻结并发布协议 schema，Android 根据同一份 schema 开发。

## 10. 通知推送

Android 进入后台后，WebSocket 可能被系统暂停或终止，不能依赖 WebSocket 实现后台通知。

架构：

```text
Android App
    │ 注册 push token
    ▼
Remote Pi Web Server
    │ Agent 重要事件
    ▼
Push Provider / FCM
    ▼
Android Notification
```

设备接口：

```http
POST   /api/v1/devices
GET    /api/v1/devices
DELETE /api/v1/devices/:id
```

设备注册信息：

```json
{
  "platform": "android",
  "pushProvider": "fcm",
  "pushToken": "...",
  "deviceName": "Pixel",
  "appVersion": "..."
}
```

通知类型：

- agent 完成任务
- agent 发生错误
- agent 等待用户确认
- extension UI 请求
- 工具调用失败
- agent 被中止
- agent 长时间无输出
- session 被其他设备操作

通知 payload 不要直接包含敏感文件内容：

```json
{
  "eventId": "event-123",
  "type": "agent_finished",
  "serverId": "server-1",
  "agentId": "agent-123",
  "sessionId": "session-123",
  "title": "Agent task finished",
  "preview": "任务已完成",
  "deepLink": "pi://agent/agent-123"
}
```

Android 端需要根据 `eventId` 去重，避免 push 重试造成重复通知。

## 11. 通知抽象

第一阶段就预留通知接口：

```ts
interface AgentNotificationSink {
  onAgentStarted(event: AgentStartedEvent): Promise<void>;
  onAgentFinished(event: AgentFinishedEvent): Promise<void>;
  onAgentError(event: AgentErrorEvent): Promise<void>;
  onUserActionRequired(event: UserActionRequiredEvent): Promise<void>;
}
```

第一阶段实现：

```text
WebSocketNotificationSink
```

第二阶段增加：

```text
PushNotificationSink
```

Agent Manager 不应直接依赖 FCM、Android 或浏览器实现。

## 12. 测试计划

### 服务端

- token 首次生成
- token 校验失败
- token 轮换和撤销
- WebSocket 认证
- WebSocket 重连
- workspace 路径逃逸
- 符号链接逃逸
- 大文件限制
- 多 agent 并发
- agent 崩溃恢复
- session 恢复
- prompt/steer/follow-up 排队
- abort
- 事件顺序和序号
- extension UI 请求响应
- 服务关闭时 agent 清理

### Web UI

- 登录
- workspace 和文件树
- 文件内容查看
- 流式消息
- tool output
- 断线重连
- 多标签页
- 窄屏布局
- 认证失效
- extension dialog

### Android

- WebSocket 断线重连
- App 切后台
- App 被杀后恢复
- 通知点击跳转 agent
- push token 更新
- 通知去重
- 网络切换
- 多服务器配置

## 13. 分阶段验收标准

### MVP

- 首次启动生成 access token
- 浏览器登录
- 添加 workspace
- 查看目录和文件内容
- 从指定目录启动 agent
- 发送 prompt
- 实时显示文本和工具输出
- abort 当前任务
- 服务重启后恢复 session

### 完整 Web 版

- 所有主要 RPC 命令
- 所有 AgentSession 事件
- steer/follow-up
- session tree
- compact
- model/thinking 控制
- 图片和文件附件
- extension UI
- slash commands
- widgets/status
- export
- 重连和事件恢复

### Android 版

- 完整复用 Web API
- 原生文件和对话界面
- 后台同步
- FCM 推送
- deep link
- 多设备状态同步
- 通知去重

## 14. 第一阶段最优先的五个基础模块

实现顺序建议固定为：

1. `AgentBackend` 抽象
2. WebSocket 事件协议
3. workspace 和安全路径模型
4. Agent/session 生命周期管理
5. 认证和 token 管理

这五个模块稳定后，Web UI 和 Android App 都可以作为独立客户端迭代，不需要重复实现 agent 逻辑。

## 15. 实现前必须固定的技术决策

实现者不应在这些问题上自行改变架构；如确需改变，应先更新本计划。

### 15.1 第一版只支持单机单用户

第一版的安全边界是：

- 一台本地机器
- 一个 access token
- 一个可信用户
- 多个 agent/session
- 不实现用户注册、角色、团队和多租户

后续的多用户系统不能通过简单增加一个用户表解决，需要重新设计 workspace、agent、session 和凭据权限模型。

### 15.2 Agent backend 默认使用 SDK

第一版使用 Pi SDK 创建和管理 agent，不直接 spawn RPC 子进程。RPC backend 只保留接口和后续实现位置。

原因：

- 直接获得 `AgentSession` 事件
- 更容易实现 session runtime 操作
- 避免 JSONL 子进程生命周期复杂度
- 便于测试

如果 SDK 进程内隔离不足，后续再增加 RPC backend，不能因此修改 Web API。

### 15.3 第一版只读文件系统

Web UI 第一版不提供文件编辑、删除、重命名、上传和执行任意终端命令的独立 API。Agent 自身的 Pi 工具仍然按 Pi 的正常能力运行，但 Web Server 不额外扩大权限。

### 15.4 第一版只支持一个 Web Server 实例

不实现多实例共享 agent 状态、分布式锁和集群部署。持久化文件按单进程使用设计。

### 15.5 第一版部署方式

优先支持以下方式：

```bash
remote-pi --host 127.0.0.1 --port 11318
```

远程访问通过 SSH tunnel、Tailscale 或反向代理实现。暂不把公网直连、自动证书和云端部署作为 MVP 目标。

## 16. MVP 明确不做的功能

以下内容不能进入第一版验收范围：

- 多用户和 RBAC
- 公网账号注册
- 文件编辑 API
- 文件上传和下载
- 内置终端模拟器
- 多人同时控制同一个 agent
- agent 容器化和 sandbox
- 云端 session 存储
- Android App
- FCM 推送
- 自动 HTTPS 证书申请
- 跨机器 agent 调度
- LLM provider 配置管理 UI

这些功能可以在 MVP 完成后分别立项。

## 17. 建议的首批任务拆分

实现者可以按以下顺序建立 issue 或任务，不要一开始同时开发前后端所有功能。

### Task 1：项目和开发基础设施

- 初始化 Node.js/TypeScript 项目
- 固定包管理器和 Node 版本
- 配置 lint、format、typecheck
- 配置单元测试和集成测试
- 添加最小 README
- 添加 `.env.example`
- 添加开发启动命令

验收命令应至少包括：

```bash
npm install
npm run check
npm test
npm run dev
```

如果项目选择不同命令，必须在 README 中明确记录。

### Task 2：配置和认证

- 配置目录解析
- host/port 配置
- token 首次生成
- token hash 保存
- Bearer token middleware
- token rotation
- `/health`
- `/api/v1/auth/login`

验收：

- 删除配置目录后首次启动能生成 token
- token 不出现在普通日志中
- 错误 token 得到 `401`
- 未认证 WebSocket 被拒绝
- token 文件权限正确

### Task 3：Workspace 和文件 API

- workspace 配置文件
- workspace CRUD 的最小集合
- 路径规范化
- root containment 校验
- 符号链接测试
- 目录列表
- 文件内容分页读取
- 大文件和二进制文件限制

必须先写路径安全测试，再实现 UI。

### Task 4：AgentBackend 和 SDK backend

- 定义 backend 类型
- 创建 SDK agent
- 指定 workspace/cwd
- agent 状态
- prompt、steer、follow-up、abort
- dispose 和错误处理
- agent 元数据持久化

### Task 5：事件协议和 WebSocket

- 定义 JSON schema 或 TypeScript discriminated union
- 命令 request/response
- agent event envelope
- eventId 和 sequence
- subscribe/unsubscribe
- reconnect/resume
- 多客户端只读策略

### Task 6：Web UI 最小闭环

只实现一条完整链路：

```text
登录 → 选择 workspace → 创建 agent → 发送 prompt → 查看流式输出
```

在这条链路稳定前，不实现完整设置页和复杂视觉效果。

### Task 7：Pi 交互能力补齐

按以下优先级实现：

1. abort
2. steer/follow-up
3. tool call/result
4. bash streaming
5. thinking block
6. session resume/new/fork
7. model/thinking level
8. compact
9. 图片和文件附件
10. extension UI
11. slash commands、widgets、status、export

### Task 8：安全、恢复和发布

- 限流
- 请求大小限制
- 并发 agent 限制
- 空闲超时
- 优雅关闭
- agent 崩溃恢复
- WebSocket 重连
- 审计日志
- 部署文档
- 安全回归测试

## 18. HTTP API 契约要求

所有 HTTP API 都必须统一返回格式。成功示例：

```json
{
  "data": {}
}
```

错误示例：

```json
{
  "error": {
    "code": "WORKSPACE_PATH_OUTSIDE_ROOT",
    "message": "Path is outside the workspace root",
    "requestId": "req-123"
  }
}
```

要求：

- 每个请求生成 `requestId`
- 错误使用稳定的 machine-readable `code`
- 不把堆栈、token、API key 或本地敏感路径返回给客户端
- 明确 `400`、`401`、`403`、`404`、`409`、`413`、`429`、`500` 的使用规则
- API 路径统一使用 `/api/v1`
- 日期统一使用 ISO 8601 UTC
- 所有可变 API 写入审计日志

建议在项目中维护：

```text
packages/protocol/openapi.yaml
packages/protocol/websocket.schema.json
```

Web UI 和 Android App 都应依赖协议类型，而不是各自手写 JSON 字段。

## 19. WebSocket 状态和并发规则

每个 agent 需要明确以下状态：

```text
starting
idle
streaming
waiting_for_user
error
stopping
stopped
```

命令冲突规则：

| 当前状态 | 命令 | 行为 |
|---|---|---|
| idle | prompt | 执行 |
| streaming | prompt | 返回冲突错误，除非指定 queue 行为 |
| streaming | steer | 进入 steering queue |
| streaming | follow-up | 进入 follow-up queue |
| streaming | abort | 立即中止 |
| waiting_for_user | extension response | 执行响应 |
| stopped | 任意 agent 命令 | 返回 `AGENT_NOT_RUNNING` |

WebSocket 连接断开不能自动停止 agent。agent 默认继续运行，重新连接的客户端通过 state、messages 和 sequence 恢复显示。

## 20. Session 恢复策略

服务启动时不要自动恢复所有历史 agent。采用懒加载策略：

1. 从 SQLite `agents` 表读取未归档的 Agent 元数据。
2. 将恢复的 Agent 标记为 `unloaded`。
3. 客户端请求打开 agent 时重新创建 runtime。
4. 通过 sessionId/sessionFile 恢复 Pi session。
5. 如果恢复失败，保留错误状态和原始 session 信息。
6. 不自动重复执行上一次未完成的 prompt。

服务退出时：

- 停止接受新请求
- 关闭 WebSocket 新连接
- 等待短时间内的命令完成
- abort 正在运行的 agent
- flush session 和元数据
- 退出进程

## 21. 可观测性和运维

第一版至少提供：

- 结构化日志
- requestId
- agentId
- sessionId
- eventId
- 启动/停止日志
- agent 错误日志
- WebSocket 连接日志
- 审计日志

不得记录：

- access token
- API key
- OAuth token
- 完整文件内容
- 默认情况下的完整 prompt 和模型响应

建议增加诊断接口，但只允许认证用户访问：

```http
GET /api/v1/system/status
```

返回：

- Remote Pi 版本
- Node 版本
- Pi 版本
- 运行时间
- agent 数量
- WebSocket 连接数量
- 存储目录状态

## 22. 最小安全威胁模型

实现者在提交 MVP 前必须回答以下问题：

1. 未认证用户能否读取 workspace 文件？
2. 未认证用户能否建立 WebSocket？
3. `../` 是否能逃逸 workspace？
4. 符号链接是否能读取 workspace 外文件？
5. 客户端能否通过 cwd 或 CLI 参数访问任意目录？
6. 客户端能否调用未公开的 agent 命令？
7. token 是否会写入访问日志、错误日志或浏览器 URL？
8. WebSocket 重连是否会重复执行 prompt？
9. 两个客户端同时控制 agent 时是否有明确行为？
10. 服务重启是否会重复执行未完成任务？
11. 大文件、超长 prompt 和大量 WebSocket 消息是否会耗尽内存？
12. agent 退出后是否仍然能被错误地认为正在运行？

## 23. Definition of Done

MVP 只有在以下条件全部满足后才算完成：

- `npm run check` 通过
- 单元测试通过
- 集成测试覆盖认证、路径安全和 agent 生命周期
- 浏览器可以完成登录到 prompt 的完整流程
- agent 流式文本和工具事件可以实时显示
- WebSocket 断开重连后状态正确
- 服务重启后 session 可以手动恢复
- 任意 workspace 外路径访问被拒绝
- token 不出现在日志和 URL 中
- 服务默认只监听 localhost
- 文档包含启动、配置、远程访问和安全说明
- 没有依赖真实 LLM key 的自动化测试

## 24. 需要在实现开始前确认的开放问题

这些问题不会阻塞架构，但应在第一批任务开始前记录答案：

- Web Server 是否必须复用现有 pi 的发布包，还是允许直接依赖本地源码？
- Remote Pi 是否和 pi 仓库放在同一个 monorepo？
- Web UI 使用哪一个前端框架？
- 第一版是否要求 Bun 支持，还是只支持 Node.js？
- workspace 是否通过配置文件管理，还是允许 UI 添加？
- 是否需要支持多个本地用户？MVP 默认不支持。
- 是否需要暴露 Pi 登录、模型切换和 provider 配置？MVP 默认不暴露凭据管理。
- 是否允许多个浏览器同时查看同一个 agent？默认允许只读订阅，但只允许一个控制者。
- 是否需要保存完整审计日志？建议第一版保存操作元数据，不保存完整内容。

所有开放问题都应记录在 issue 或 `DECISIONS.md`，不要只存在口头讨论中。
