# 上游需求：为 Pi 的 AgentSession 增加公开的 `continue()`

> 交给负责向 Pi（https://github.com/earendil-works/pi）提 PR 的同学。
> 本文所有行为描述基于 `@earendil-works/pi-coding-agent` / `pi-agent-core` **1.1.0**（pi2web 当前锁定版本），并对照过 **1.4.0**。行号会随版本变化，按方法名查找。

## 1. 背景与目标

pi2web 已实现“安全暂停”：在 Agent 的 `finishTurn` 钩子里返回 `{action: 'end'}`，让运行在**当前这批工具执行完、工具结果已写入 session、下一次调用模型之前**结束。暂停后 session 的最后一条消息是 `toolResult`，jsonl 里完整保存，重启也不丢。

缺的是“继续”：从这个状态**不加任何新消息**地让模型接着往下跑，并且要能在**进程重启、重新打开 session 之后**做到。要求：

- **完全透明、无损**：不向 transcript 或模型上下文插入任何额外消息（包括隐藏的 custom message），发给模型的请求与未暂停时逐字节一致（prompt cache 不受影响）。
- **走完整的运行生命周期**：和 `prompt()` 一样有忙碌标志、自动重试、自动压缩、`agent_settled`、扩展钩子等。

## 2. 现状：为什么现在做不到

| 途径 | 问题 |
| --- | --- |
| `AgentSession.prompt(text)` | 必须带一条新的用户消息，不透明。 |
| `AgentSession.sendCustomMessage(msg, {triggerTurn: true})` | 会把一条 custom message 写入 transcript，并被转换成发给模型的 user 消息（可以再用 `context` 扩展事件过滤，但 transcript 里仍多一条，pi2web 认为不可接受）。 |
| `session.agent.continue()`（底层 `Agent`） | 能从 `user` / `toolResult` 结尾的上下文继续，不加消息；但它**绕过了 AgentSession 的运行管理**（见下）。 |

`AgentSession` 的运行管理全在私有方法里（1.1.0 是 `_runAgentPrompt(messages)`，1.4.0 重构为 `_startRun(trigger)` + `_prepareRun(trigger)`），只有 `prompt()` / `sendCustomMessage()` / 少数内部路径能进入。直接调 `agent.continue()` 会丢掉：

- `_isAgentRunActive`（即 `isStreaming` / `isIdle`）——调用方和扩展会以为 session 空闲，`prompt()` 可能并发再起一次运行；
- `_agentRunAbortRequested` 的复位与“启动中被中止”的处理；
- 运行结束后的 `_handlePostAgentRun()`：自动重试（`_prepareRetry`）、溢出/阈值自动压缩（`_checkCompaction`）、扩展 `agent_end` 后排队消息的续跑；
- `_runBeforeSettleBoundary()`（`agent_before_settle` 扩展边界）；
- `finally` 里的 `_flushPendingBashMessages()`、`_flushPendingCustomMessages()`、`_emitAgentSettled()`（`agent_settled` 事件，pi2web 的邮件/语音通知依赖它）；
- 运行前的准备：`_prepareRun` 里的预压缩检查、`before_agent_start`、system prompt / 工具 loadout 的应用（`_runSystemPromptOptions`）、`_recordSelection()`、`_pendingToolNames.clear()` 等。

所以需要 Pi 自己提供一个走同一套生命周期、但不带起始消息的入口。

## 3. 建议的 API

```ts
class AgentSession {
  /**
   * Continue the conversation from the current transcript without adding a message.
   * The last message in context must be a user or tool-result message (for example after a run
   * ended through `finishTurn` returning `{action: "end"}`, or a session reopened in that state).
   * Runs through the same lifecycle as prompt(): busy state, before_agent_start, auto-retry,
   * auto-compaction, agent_before_settle and agent_settled.
   * @throws if the session is already running, or the context cannot be continued
   */
  continue(): Promise<void>;

  /** Whether continue() would be accepted now: idle and the context ends with user/toolResult. */
  readonly canContinue: boolean;
}
```

可选：在 RPC 模式加对应命令（如 `{"type": "continue"}`），在交互模式加 `/continue` 斜杠命令。不是 pi2web 必需的。

## 4. 语义细节（需要在 PR 里定下来）

1. **前置条件**
   - session 空闲（`!isStreaming`），否则抛错，错误信息与 `prompt()` 在忙时一致的风格。
   - 当前上下文（`agent.state.messages`，即 compaction / context_edit 投影后的上下文）非空，且最后一条是 `user` 或 `toolResult`；最后一条是 `assistant` 时抛错（与 `Agent.continue()` 的 "Cannot continue from message role: assistant" 一致）。注意 `Agent.continue()` 在 assistant 结尾时会去消费 steering/follow-up 队列——`AgentSession.continue()` **不应**沿用这个分支，有排队消息时请调用方用 `prompt()`。
   - 与 `prompt()` 一样做模型和鉴权检查（`checkAuth`），失败抛同样的错误。

2. **实现方式**
   - 在 1.4.0 的结构里，最自然的是给 `_startRun` 增加第三种 trigger：`{messageType: "continue"}`。`_prepareRun` 对它不构造起始消息；`_startRun` 里把 `this.agent.prompt(messages)` 换成 `this.agent.continue()`（当 `messages` 为空时）。
   - `_prepareRun` 可能产生需要追加的消息（`_pendingNextTurnMessages`、`before_agent_start` 处理器返回的 messages、system prompt 变化产生的 system patch 消息）。这些消息有内容时，用 `agent.prompt(messages)`——它们本身就是合法的起始消息，transcript 里出现它们与正常 prompt 时完全相同，不属于“额外插入”；没有任何消息时才用 `agent.continue()`。这样在没有扩展、prompt 没变化的常见情况下，请求与未暂停时逐字节一致。
   - 之后的 `while` 循环（`_handlePostAgentRun` / `_runBeforeSettleBoundary` / `agent.continue()`）与 `finally` 完全复用。

3. **`before_agent_start`**
   - 1.2.0 起 `BeforeAgentStartEvent` 是按 `messageType` 区分的联合类型（`"user"` 带 `prompt`/`images`，`"custom"` 带 `message`）。建议新增 `BeforeAgentStartContinueEvent { messageType: "continue" }`，不带消息。
   - 这是扩展可见的类型变化：对联合做穷举判断的扩展需要处理新分支。请在 CHANGELOG 的 Breaking/Changed 里写明，或者与维护者商量是否改为“continue 不触发 `before_agent_start`”（不推荐：collab 一类扩展依赖它在每次运行前注入 system prompt，pi2web 的 collab 扩展就是）。

4. **事件**
   - 发出与正常运行相同的 `agent_start` … `agent_end` … `agent_settled`。
   - 不发出 `message_start/end` 给任何“继续”用的伪消息（因为不存在）。

5. **中止与并发**
   - `abort()` 在 `continue()` 启动阶段（`_prepareRun` 期间）调用时，与 `prompt()` 相同：运行一旦存在就被中止。
   - `continue()` 进行中再次调用 `continue()` / `prompt()`：与现有 `prompt()` 在忙时的行为一致（`prompt()` 走 `streamingBehavior` 排队或报错，`continue()` 报错）。

6. **重开 session**
   - `SessionManager.open(file)` + `createAgentSession` 之后，`agent.state.messages` 由 transcript 投影恢复；只要最后一条是 `toolResult`，`continue()` 就应可用。这是 pi2web “重启后继续”的核心场景，需要测试覆盖。

## 5. 测试建议（Pi 仓库内，用 faux provider）

pi2web 的 `test/sdk-backend-safe-pause.test.ts` 已经演示了如何用 `fauxProvider()` + `ModelRuntime.create({modelsPath: null, refreshOnCreate: false})` + `registerNativeProvider()` 驱动真实的 `AgentSession`，可直接参考。建议的用例：

1. `finishTurn` 返回 `{action: "end"}` 在工具调用后结束运行 → `continue()` → 模型第二次被调用，收到的 messages 与不暂停时第二次请求**完全相同**（断言 faux 收到的 context），transcript 中没有新增条目，只多了模型的新回复。
2. 同上，但先把 session 写到临时目录、`dispose()`、用 `SessionManager.open()` 重新打开再 `continue()`。
3. 最后一条为 assistant 时 `continue()` 抛错，`canContinue === false`。
4. 运行中调用 `continue()` 抛错。
5. `continue()` 后模型返回可重试错误 → 自动重试照常发生；`agent_settled` 恰好一次。
6. `continue()` 后上下文超过阈值 → 自动压缩照常发生。
7. `before_agent_start` 以 `messageType: "continue"` 触发；处理器返回的 message 会作为起始消息发送。
8. 启动阶段调用 `abort()` → 不发生模型请求，`agent_settled` 带 `aborted`。

## 6. 交付物

- Pi 仓库 PR：`AgentSession.continue()`、`canContinue`、`before_agent_start` 新分支、文档（`docs/sdk.md` 的 Prompting 一节、`docs/extensions.md` 的 `before_agent_start` 一节）、CHANGELOG、测试。
- 合并发版后告知 pi2web 维护者版本号。pi2web 侧的后续工作（不在本任务范围）：升级 Pi；在 `SdkBackend` 增加 `resume()` 调用 `session.continue()`；给“安全暂停”过的 session 显示“继续”按钮（判断条件即 `canContinue`，不需要 pi2web 另存状态）；暂停时暂存的排队消息在继续前重新入队。

## 7. 若上游不接受

备选是 pi2web 用 `patch-package` 在本地给 Pi 打同样的补丁，代价是每次升级 Pi 都要重做补丁。请在 PR 讨论中尽量确认维护者对第 4 节第 3 点（`before_agent_start` 类型变化）的态度，这是最可能被要求修改的地方。
