# Remote Pi Android App 功能说明

> 本文描述当前仓库中 `android/` 原生客户端已经实现的功能、交互方式、数据安全设计、协议依赖和已知边界。

## 1. 定位和架构

Android App 是 Remote Pi Server 的原生客户端，不在手机上运行 Agent，也不直接访问开发主机文件系统。Agent、模型调用、工具执行和 Pi session 都运行并保存在 Remote Pi Server 所在机器。

```text
Android App
  ├── HTTP/JSON：认证、Workspace、文件、Agent、Session 和设置
  ├── WebSocket：流式事件、断线恢复和任务完成监听
  └── Android Notification：Agent 完成提醒
            │
            ▼
Remote Pi Server → Pi SDK → LLM / 本地工具 / Session 文件
```

最低系统版本为 Android 8.0（API 26）。Debug 构建允许 HTTP，Release 构建只接受 HTTPS，WebSocket 由 OkHttp 自动升级为 WS/WSS。

## 2. Server 管理和认证

- 可以保存多个 Remote Pi Server。
- Server 配置包括显示名称、Base URL 和 Access Token。
- 登录时调用认证接口并读取 `/api/v1/system/status`。
- App 只接受 protocol version 1，不兼容时显示明确错误。
- 支持编辑、删除和切换 Server。
- Android 13 及以上首次启动会请求通知权限。

Access Token 不保存在普通 Profile 中。App 使用 Android Keystore 中不可导出的 AES 密钥，以 AES-GCM 加密 Token 后保存到独立 SharedPreferences；该文件排除于 Android Backup。Token 不写入 URL 和应用日志。

## 3. Workspace 和文件浏览

主页可以：

- 添加 Workspace，填写 Remote 主机上的名称和绝对路径。
- 查看 Workspace 列表和根路径。
- 进入任意 Workspace 浏览目录。
- 返回上级目录。
- 分页读取文本文件，避免一次载入大文件。
- 对二进制文件显示不可预览提示。
- 从 Workspace 根目录或当前浏览目录创建 Agent。

所有路径安全校验由 Server 执行，包括路径穿越和符号链接逃逸检查。

## 4. Agent 管理

主页显示当前 Server 上的 Agent：

- Session 有名称时优先显示名称，否则显示 Agent ID。
- 显示 Agent ID、运行状态和 cwd。
- 支持创建、打开和停止 Agent。
- 创建时可选择 Workspace、cwd、新 Session 或已有 Session。
- 多 Workspace 场景会先显示 Workspace 选择器。

Agent 状态包括 idle、streaming、error 和 stopped 等。

## 5. Session 功能

当前支持：

- 创建新 Session。
- 列出并恢复 cwd 对应的历史 Session。
- 给 Session 命名。
- 随时修改 Session 名称。
- Session 名称持久化到 Pi session，并显示在对话标题和 Agent 列表。
- 查看 Session tree 条目。
- Navigate 到指定 tree entry。
- Fork / Revert。
- Compact。

### Revert 行为

对话页工具栏的 Undo 按钮对应 Pi CLI 双击 Escape 在 `doubleEscapeAction=fork` 时打开的用户消息选择器：

1. App 显示当前 Session 中的历史用户消息，最近消息在前。
2. 选择一条消息后，Server 从该用户消息之前的父节点创建新 Session。
3. 原 Session 不被修改。
4. 新 Agent 打开 fork 后的 Session。
5. 被选择的用户消息自动放回输入框，用户可以修改后重新发送。

这与普通 tree navigation 不同：Revert 会创建新的 Session 分支，不覆盖原历史。

## 6. 对话和实时事件

进入 Agent 后，App 先通过 HTTP 加载历史消息和 Session 状态，再通过 WebSocket 订阅实时事件。

支持显示：

- 用户消息。
- Assistant 文本增量。
- Thinking 增量。
- Tool execution start/end。
- Tool 参数和完成状态。
- Retry 和系统状态。
- Extension notify/status/widget/title。

支持发送：

- prompt。
- steer。
- follow-up。
- abort。

长时间 prompt 使用不设置 read timeout 的独立 OkHttp Client，避免 Agent 正常运行超过 30 秒时出现错误弹窗。普通 API 仍保留网络超时。

### 折叠卡片

对话中的每个消息或事件块默认折叠：

- Tool 折叠后显示工具/操作名称。
- Thinking 折叠后显示 `Thinking`。
- 系统事件显示标题或第一行。
- 用户和 Assistant 消息显示前 60 个字符。
- 点击卡片可展开完整内容，再次点击折叠。
- 展开状态通过 Compose saveable state 保留，屏幕旋转时不会立即丢失。

## 7. `@` 文件和目录引用

在输入框输入 `@` 会在输入框上方打开路径选择器：

- 初始位置是 Agent cwd。
- 显示当前目录中的文件和子目录。
- 点击目录进入目录。
- 可以引用当前目录或子目录。
- 点击文件直接插入引用。
- 可以返回上级目录，最高到 Workspace 根目录。
- 可以随时取消。
- cwd 内目标生成相对路径。
- cwd 外但 Workspace 内目标生成绝对路径。
- 含空格的路径自动加双引号。

例如：

```text
@src/Main.kt
@"docs/design notes.md"
@/repo/shared/config.json
```

## 8. WebSocket 恢复

每个 Agent 事件包含 eventId、递增 sequence 和 Unix 秒级 timestamp。

客户端会：

- 持久化每个 Agent 的最后 sequence。
- 丢弃重复 sequence。
- 检测 sequence gap。
- 按 1、2、4、8、15、30 秒指数退避重连。
- 缓存仍存在时请求增量 replay。
- 缓存不足时接收 `agent_snapshot`，恢复完整 state/messages。
- snapshot 不可用时重新请求 HTTP messages。

切换 Agent 会关闭旧对话订阅，避免不同 Agent 的事件混入。

## 9. 完成通知

App 为当前连接的 Server 维护一个独立、多 Agent WebSocket 连接。即使用户正在查看另一个 Agent，也会订阅该 Server 上所有已知 Agent 的完成事件。

当 Agent 发出 `agent_end` 并转为空闲状态时：

- Android 创建“Agent 完成”系统通知。
- 通知标题使用 Session 标识。
- Server 事件携带 Unix 秒级时间戳。
- Android 使用设备当前时区转换成本地时间。
- 通知同时显示本地时间和原始 Unix 时间戳。
- 通知 `when` 使用事件真实发生时间，而不是手机收到通知的时间。
- 每个 Agent 保存独立通知 sequence，重连时补收事件并避免重复通知。
- 首次订阅使用 `fromNow`，不会把缓存中的旧完成事件全部重新通知。

示例：

```text
Session 已转为空闲状态
本地时间：2026-07-18 22:20:00 CST
Unix 时间戳：1784370000
```

当前通知依赖 App 进程中的 WebSocket。App 退到后台后，系统通常仍可在一段时间内保持连接；如果进程被系统彻底终止，则无法保证实时通知。需要进程被杀后仍可靠送达时，应按计划增加 Server 设备注册接口和 FCM/UnifiedPush，而不是依赖永久后台 WebSocket。

## 10. Extension UI

Pi Extension UI 请求可映射为 Compose 组件：

- select：选择对话框。
- confirm：确认对话框。
- input：单行输入。
- editor：多行输入。
- notify：对话系统事件。
- setStatus：页面状态。
- setWidget：对话顶部 Widget。
- setTitle：页面标题。
- extension response：把用户结果返回 Server。

自定义 TUI Component 无法直接在 Android 渲染，Server 会返回不支持错误。

## 11. Model 和 Thinking

Agent 控制对话框支持：

- 查询当前模型。
- 查看当前 Provider 可用模型。
- 切换模型。
- 查询当前 thinking level。
- 查看模型支持的 thinking levels。
- 修改 thinking level。

模型凭据仍由 Server 复用 Pi CLI 配置，Android 不存储 Provider API Key。

## 12. 本地数据

当前本地持久化内容：

- Server Profile 非敏感信息。
- Keystore 加密后的 Token。
- 当前选择的 Server。
- 对话 WebSocket sequence cursor。
- 通知 WebSocket sequence cursor。

完整消息和 Session 不复制到 Android 数据库；Server/Pi session 文件是唯一事实来源。

## 13. 测试和构建

Server：

```bash
npm run check
npm test
```

Android：

```bash
cd android
./gradlew testDebugUnitTest assembleDebug assembleRelease
```

测试覆盖认证和协议解析、Workspace、安全路径、Agent 生命周期、Session 命名、fork/revert 管理、事件 sequence、snapshot、fromNow、Unix 时间转换、`@` 路径计算、折叠标题、长任务超时策略及 HTTP 错误映射。

构建产物：

```text
android/app/build/outputs/apk/debug/app-debug.apk
android/app/build/outputs/apk/release/app-release-unsigned.apk
```

## 14. 当前边界

- 单机、单用户和单 Access Token。
- Release 默认要求 HTTPS/WSS。
- 文件 API 只读；Agent 本身仍可通过 Pi 工具修改文件。
- 没有内置终端模拟器。
- 没有 FCM，因此进程被系统杀死后不保证通知。
- 没有多用户 RBAC。
- 没有把 Pi 自定义 TUI Component 自动转换成 Compose 的通用方案。
