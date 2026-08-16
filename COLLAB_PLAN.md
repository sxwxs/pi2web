# pi2web 多 Agent 协作中枢（Collaboration Hub）方案 v0.3

> 状态：**已实现并进入扩展整合阶段**（M0–M8；openapi.yaml 仍需继续补齐）。决策记录见 §10。
>
> 实现补记：Review 已改为 **review-only + 人工触发 remediation**。正常评审在盲审、Issue 共识和人工争议裁定后直接 `finished`，不再经过 `responding/adjudicating`。确认的问题以 `confirmed` 保留。人可对 finished Review 调 `POST /sessions/{id}/recheck`：直接复核当前代码，或指定 implementer 先修复；开发 `/ready` 后自动召集原 Reviewer，Reviewer 在下一轮 findings 提交中逐项回报 `resolved/still_present`。
>
> 实现补记：支持 **build-then-review**（`policy.implementationFirst`）——首次会话可先进入 `implementing` 阶段，由唯一的开发 Agent 施工；只有显式 `POST /sessions/{id}/ready` 才触发中枢召集 Reviewer。`agent_settled` 不再等同于完成，避免失败或漏交被误判为可评审。
>
> 实现补记：participantToken 的 HTTP 兼容路径仍保留 `collab_participants.dispatch_token` 明文副本；内置 Pi 扩展改走进程内 bridge，不把 URL、token 或内部 ID 放进模型上下文。会话结束后中枢丢弃明文副本。
>
> 实现补记：中枢**全程推送**。唤醒消息只要求先调用 `collab_get_task`；扩展按任务激活一个强类型提交工具，并在 Agent 实际领取后才确认持久化队列。Review/Scoring 禁用直接 edit/write，只有 implement 可写；会话结束仍发送 `session_result`。
>
> v0.3 相对 v0.2 的变更（全部来自决策）：超时改为**阻塞不推进**、评审改为**对称**（允许反向评审）、evidence **强制且不可关**、session/participant **仅人可创建**、新增**每参与者 600K token 预算**、邮件**永远只是通知**。
>
> v0.2 相对 v0.1 的补充：代码基线锚定与再验证（§3.5）、盲评/防锚定（§4.3）、评分场景的资格与利益回避（§4.4）、测试策略（§12）、决策清单给出推荐默认值（§10）。

## 0. 目标与定位

pi2web 现在是"人 ↔ 单个 Agent"的远程网关。本方案在其上叠加一层 **协作中枢（Collab Hub）**：

- 中枢是**唯一事实来源**：所有跨 Agent 的交互都必须经由结构化 API，Agent 之间不直接对话。
- Agent 之间只交换**结构化数据（JSON）**，不是自由文本聊天；自由文本只作为结构化字段里的 `rationale` / `body`。
- 中枢负责：身份与权限、汇总与分发、状态机推进、去重、僵局告警、收敛判定、**人工升级（escalation）**。
- 两个首发场景：
  - **场景一 Review Loop**：N 个评审 Agent 盲审 → Issue 共识 → 输出报告；人可另行启动“开发修复 → 原 Reviewer 复核”的循环。
  - **场景二 Panel Scoring**：N 个评审 Agent 协商评分维度（提名 → 归并 → 投票 → 锁定 rubric）→ 独立打分 → 辩论收敛 → 出分 / 升级人工。

两个场景共享同一套底座：`CollabSession`（协作会话）+ `Participant`（参与者）+ `EventLog`（追加日志）+ `Escalation`（人工介入）。

---

## 1. 总体架构

```
                    ┌────────────────────────── pi2web 进程 ─────────────────────────┐
  实现 Agent  ──┐   │                                                                │
  评审 Agent A ─┤   │  HTTP /api/v1/collab/*        WS  /api/v1/ws (collab_event)    │
  评审 Agent B ─┼──▶│        │                             │                         │
  (外部 Agent) ─┘   │        ▼                             ▼                         │
                    │   CollabHub  ──▶ ReviewFlow / ScoringFlow (纯状态机)           │
                    │        │                                                       │
                    │        ├──▶ CollabStore (SQLite, 与 metadata-store 同库)       │
                    │        ├──▶ Dispatcher ──▶ AgentManager.command()  (托管 Agent)│
                    │        │              └──▶ Inbox long-poll        (外部 Agent) │
                    │        └──▶ EscalationQueue ──▶ Web UI + MailNotifier          │
                    └────────────────────────────────────────────────────────────────┘
                                              ▲
                                        人（Web UI / Android）
```

新增源码（沿用现有平铺紧凑风格）：

| 文件 | 职责 |
|---|---|
| `src/collab/types.ts` | 全部 JSON 契约类型 + 常量枚举 |
| `src/collab/validate.ts` | 轻量 schema 校验器（零依赖），返回 `fieldErrors` |
| `src/collab/store.ts` | SQLite 读写（复用 `MetadataStore` 的 db 句柄） |
| `src/collab/review-flow.ts` | 场景一状态机（纯函数，可单测） |
| `src/collab/scoring-flow.ts` | 场景二状态机（纯函数，可单测） |
| `src/collab/hub.ts` | 编排：鉴权、事务、事件广播、分发、僵局告警与 token 计量 |
| `src/collab/dispatcher.ts` | 唤醒托管 Agent / 维护外部 Agent 的 inbox |
| `src/collab/routes.ts` | HTTP 路由表（从 `server.ts` 拆出，避免 `handle()` 继续膨胀） |
| `web/collab.js` + UI | 协作看板 |

---

## 2. 核心对象模型

### 2.1 CollabSession

```jsonc
{
  "sessionId": "collab-<uuid>",
  "kind": "review" | "scoring",
  "title": "PR #123 支付重构评审",
  "workspaceId": "...", "relativeCwd": "services/pay",
  "subject": {                       // 评审对象，纯描述，中枢不做 diff
    "type": "diff" | "paths" | "commit_range" | "free",
    "value": "HEAD~3..HEAD",
    "notes": "重点看并发与幂等"
  },
  "phase": "...",                    // 见状态机
  "round": 1,
  "policy": { /* 见 2.4 */ },
  "status": "active" | "finished" | "aborted",
  "outcome": { /* 结束时写入 */ },
  "createdAt": "...", "updatedAt": "..."
}
```

### 2.2 Participant

```jsonc
{
  "participantId": "p-<uuid>",
  "sessionId": "collab-...",
  "role": "implementer" | "reviewer" | "moderator" | "human",
  "displayName": "reviewer-security",
  "model": "anthropic/claude-sonnet-4",                      // 如实登记，用于模型多样性提示
  "binding": { "type": "managed", "agentId": "agent-..." },  // 或 {"type":"external"}
  "token": "<仅在人工登记时返回一次，DB 存 sha256>",
  "state": "active" | "left" | "budget_exhausted",
  "tokenBudget": 600000,
  "tokensUsed": 0,
  "lastSeenAt": "..."
}
```

**参与者只能由人登记**（`POST /sessions/{id}/participants`，需 pairing code）。没有 Agent 自助 join，Agent 拿到的只是人交给它的 `participantToken`。

**权限按 capability 判定，而不是角色硬编码**——这是支持对称评审的基础：

| capability | implementer | reviewer | moderator |
|---|---|---|---|
| `file_finding`（提 issue） | ✅ | ✅ | ✅ |
| `ready`（开发完成，交给 Reviewer） | ✅ | ❌ | ❌ |
| `nominate` / `vote` / `score` | ❌（利益回避，§4.4） | ✅ | ❌ |
| `debate` | 仅 `stance:"clarify"` | ✅ | ❌ |
| `merge` / `advance` | ❌ | ❌ | ❌（`advance` 仅人） |
| `escalate` | ✅ | ✅ | ✅ |

- **managed**：该参与者绑定 pi2web 自己托管的 Agent。中枢有新任务时**直接 `AgentManager.command(agentId,'follow-up'|'prompt', <结构化任务包>)` 主动唤醒**，无需 Agent 轮询。
- **external**：外部 Agent（Claude Code / Codex / CI 机器人）。通过 `GET /inbox?wait=30`（长轮询，最长 60s）拉取任务。
- 两者的**提交接口完全相同**，只有"如何被通知"不同。

### 2.3 事件日志

每个 session 一条 append-only `collab_events`（`sequence` 单调递增），承担三件事：
1. Web UI 增量刷新（WS `collab_event`，断线用 `?since=<seq>` 补齐，与现有 agent 事件 replay 语义一致）。
2. 审计与复盘（谁在第几轮说了什么、为什么升级人工）。
3. Agent 拉取上下文（`GET /sessions/{id}/events?since=`）。

### 2.4 Policy（每个 session 可配，含默认值）

```jsonc
{
  "maxIssueRounds": 3,              // 同一 issue 往返超过 3 轮 → 自动 escalate
  "maxTotalRounds": 6,              // 会话总轮次上限，到顶强制出报告
  "overdueWarningSec": 1800,        // 仅告警，不推进（见下）
  "autoEscalateOnDeadlock": true,
  "severityGate": "major",          // 低于该严重度不阻塞 session 结束
  "tokenBudgetPerParticipant": 600000,
  "scoring": {
    "minCriteria": 4, "maxCriteria": 8,
    "approvalThreshold": 0.67,      // 类目通过所需赞成比例
    "maxVotingRounds": 3,
    "scale": { "min": 0, "max": 10, "step": 0.5 },
    "convergenceRange": 2.0,        // 同一类目极差 ≤ 2 视为收敛
    "maxDebateRounds": 2,
    "blindScoring": true
  }
}
```

### 2.5 超时语义：**超时绝不自动推进**（决策 3）

阶段必须等齐所有应交付的参与者。`overdueWarningSec` 只做三件事，绝不改变流程：

1. 会话打上 `stalled: { since, waitingOn: [participantId…] }` 标记；
2. 写 `participant_overdue` 事件（WS 推给 Web UI，看板高亮）；
3. 触发邮件**通知**（邮件永远只是通知，不含任何操作链接或 token）。

打破僵局只有两条路：迟到方补交，或**人**调 `POST /sessions/{id}/advance` 显式强推——强推者、被跳过者、理由全部记入事件日志与最终报告。中枢自身没有任何"视作弃权"的自动逻辑。

### 2.6 Token 预算：每参与者默认 600K（决策 7）

- **managed**：登记时记录该 agent 的 `stats.tokens.total` 作为基线，每次提交后取增量累加（复用 `AgentManager.sessionInfo()`）。
- **external**：提交体可带 `usage:{inputTokens,outputTokens}` 自报；未自报则按请求体字节数 `bytes/4` 粗估，并在报告中标注 `estimated:true`。
- 超限：参与者置 `budget_exhausted`，**已提交内容全部保留**，后续写接口返回 `429 TOKEN_BUDGET_EXHAUSTED`，读接口（digest/events）仍可用，便于人工接管后恢复。
- 因为超时不推进，超限必然导致 `stalled` → 中枢自动开一个 `budget_exhausted` escalation 交人处理（加预算 / 换 Agent / 强推）。

---

## 3. 场景一：Review Loop

### 3.1 Session 阶段机

```
draft ──open_round──▶ [implementing] ──ready──▶ collecting（固定 baseline，Reviewer 盲审）
collecting ──全员提交 | 人工 advance──▶ consolidating
consolidating ─▶ validating ─▶ [merge_voting] ─▶ [issue_discussing ↔ issue_reconsidering]
              └────────────────────── 共识完成 ───────────────────▶ finished
未收敛争议 ─▶ awaiting_human ──裁定完成──▶ consolidating ─▶ finished

finished ──人工 recheck(review_only)──────────────▶ collecting（round+1）
finished ──人工 recheck(fix_then_review)──▶ implementing ──ready──▶ collecting（round+1）

任何阶段超过 overdueWarningSec 仍有人未交 ──▶ 叠加 stalled 标记（**不改变阶段**，见 §2.5）
```

`responding/adjudicating` 已从现行状态机任务和 HTTP 路由移除；类型中只保留旧数据库恢复所需的 legacy phase 名称。

### 3.2 Issue 状态机

```
open（本轮新 Finding） ──Panel 共识通过──▶ confirmed（评审输出，需要处理但不阻塞 finished）
open ──提出者 withdraw─────────────────▶ withdrawn
open ──共识无法收敛────────────────────▶ escalated ──人工裁决──▶ confirmed | wontfix | closed
confirmed ──下一轮原提出者复核 resolved──────▶ resolved
confirmed ──下一轮原提出者复核 still_present──▶ confirmed
```

开发 Agent 不再逐条回应 Issue。人工启动 `fix_then_review` 后，选定开发 Agent 收到全部 `confirmed` Action Items，完成代码修改并统一调用 `/ready`；随后原 Reviewer 在新 baseline 上复核自己提出的旧问题，同时可以提交新 Finding。

> **对称评审（决策 4）**仍保留：任何参与者都可以在盲审阶段提 Finding，并指定 `targetParticipantId` 作为报告归属信息；它不再产生强制回应任务。
>
> 修复—复核循环只由人从 finished 状态显式启动，不会因为报告中存在问题而自动消耗下一轮。
>
> `location.path` **必填**（决策 5）：缺失返回 `422 EVIDENCE_REQUIRED`。确实无法定位到文件的意见（如架构性建议）必须用 `location.path` 指向最相关的文件并把范围说明写进 `evidence`。

### 3.3 结构化契约（节选）

Reviewer 提交（一次批量提交，中枢原子接收，避免半截状态）：

```jsonc
POST /api/v1/collab/sessions/{id}/findings
{
  "clientRequestId": "uuid",            // 幂等键
  "round": 1,
  "findings": [{
    "externalId": "sec-1",              // 评审方自己的编号，回执里做映射
    "title": "支付回调未校验签名",
    "severity": "blocker|critical|major|minor|nit",
    "category": "security|correctness|performance|maintainability|style|test|docs",
    "confidence": 0.9,
    "location": { "path": "src/pay/callback.ts", "startLine": 42, "endLine": 58 },
    "evidence": "……代码片段或调用链……",
    "impact": "伪造回调可导致订单被置为已支付",
    "suggestion": "使用商户密钥做 HMAC 校验并加时间窗",
    "requiredAction": "must_fix|should_fix|discuss|fyi",
    "targetParticipantId": "p-2",       // 可选，缺省=session 的 implementer；反向评审时指向某个 reviewer
    "baselineId": "b-1"                 // 必填，见 §3.5
  }],
  "reviewComplete": true                 // 本轮我提完了
}
→ 201 { "accepted": [{ "externalId":"sec-1", "issueId":"i-7" }],
        "rejected": [{ "externalId":"...", "code":"INVALID_SEVERITY", "message":"..." }],
        "possibleDuplicates": [{ "issueId":"i-7", "similarTo":"i-3", "score":0.82 }] }
```

人工启动 `fix_then_review` 后，选定开发 Agent 拿到的任务包（`GET /sessions/{id}/digest`）：

```jsonc
{
  "sessionId":"...", "round":2, "phase":"implementing", "task":"implement",
  "issues": [ { "issueId":"i-7", "status":"confirmed", "title":"...", "severity":"critical",
                "location":{...}, "evidence":"...", "suggestion":"...", "history":[...] } ],
  "instructions": "修复确认的问题；完成后统一 POST /ready，随后中枢召集 Reviewer"
}
```

Reviewer 在复核轮次的 digest 中会收到 `issuesToRecheck`，每项都必须在最终 `/findings` 请求的 `rechecks[]` 中标记为 `resolved` 或 `still_present`。

后续轮次的 Reviewer 在同一个 `/findings` 请求里提交 `rechecks:[{issueId,outcome:"resolved|still_present",rationale}]`。
人启动复核：`POST /sessions/{id}/recheck {mode:"review_only|fix_then_review", implementerParticipantIds?:[]}`。
任一方在评审共识阶段升级：`POST /sessions/{id}/escalations`。

### 3.4 去重策略

中枢**不自动合并**，只标注 `possibleDuplicates`：同 `path` 且行区间重叠 → 权重 0.5；标题/建议的词集合 Jaccard 相似度 → 权重 0.5；`score ≥ 0.7` 提示。合并由 moderator/人工调 `POST /issues/{id}/merge-into` 完成（被合并方状态 `duplicate`，裁定权归主 issue）。理由：误合并会丢掉真实缺陷，代价高于重复处理。

### 3.5 代码基线锚定与再验证（v0.2 新增，关键）

v0.1 把 `subject` 当成纯描述，这会在第 2 轮出问题：实现 Agent 改完代码后，评审 Agent 裁定时看到的可能已经是**另一份代码**，却按第 1 轮的记忆做判断。因此：

- 每个 round 有一个不可变的 **baseline**：

```jsonc
{ "round": 1,
  "baselineId": "b-1",
  "vcs": "git",
  "commit": "9f2c1ab…",           // 由中枢在 session 的 cwd 执行 `git rev-parse HEAD` 解析并冻结
  "range": "HEAD~3..HEAD",
  "dirtyHash": "sha256:…",        // 有未提交改动时对工作区改动文件内容做的 sha256
  "paths": ["src/pay/**"],
  "capturedAt": "…" }
```

- **所有 finding 必须携带 `baselineId`**；针对旧 baseline 的提交返回 `409 STALE_BASELINE`，回执带当前 baseline，Agent 自行重新取代码。
- `fix_then_review` 中开发 Agent 的 `/ready` 携带 `codeRef`（新 commit / dirtyHash）与变更文件；中枢随后重新捕获 baseline，并在 Reviewer 任务包中明确列出待复核的 `confirmed` Issues。
- 中枢**不做语义判断**（不判断修复是否正确），只保证"大家在同一份代码上说话"，判断权仍属评审 Agent 与人。

---

## 4. 场景二：Panel Scoring

### 4.1 阶段机

```
nominating ─▶ consolidating ─▶ voting ─┬─(未达标且 round<max)─▶ nominating/voting (round+1)
                                        └─(达标)─▶ rubric_locked ─▶ scoring ─▶ analysis
analysis ─┬─(全部类目收敛)──────────────────────────────▶ finalized
          └─(有分歧类目)─▶ debating ─▶ rescoring ─▶ analysis (debateRound+1)
                                     └─(超轮次仍分歧)─▶ awaiting_human ─▶ finalized

每个阶段的推进条件均为「全员提交」或「人工 advance」；超时只标 stalled，不推进（§2.5）
```

### 4.2 契约

**提名**：`POST /sessions/{id}/criteria/nominations`

```jsonc
{ "nominations": [{
    "externalId":"c1",
    "name":"安全性",
    "definition":"是否存在可被利用的漏洞、鉴权与输入校验是否完备",
    "weightSuggestion": 0.25,
    "anchors": { "0":"存在可直接利用的高危漏洞", "5":"无高危但校验不完整", "10":"威胁建模完整且有测试覆盖" },
    "rationale":"本次改动涉及支付回调" }] }
```

**归并**：中枢按名称/定义相似度聚类，产出候选集 `criteriaCandidates`（保留每个候选的来源提名、合并后的定义草案）。归并只做**建议**，最终由投票决定；候选项 ID 稳定，便于多轮引用。

**投票**：`POST /sessions/{id}/criteria/votes`

```jsonc
{ "round": 1,
  "votes": [{ "candidateId":"cc-2", "stance":"approve|reject|abstain",
              "weight": 0.2,                       // 归一化前的建议权重
              "amendment": "建议把'安全性'拆成'鉴权'和'输入校验'",  // 可选
              "rationale":"..." }] }
```

收敛判定（中枢自动）：
- 类目通过：`approve / (approve+reject) ≥ approvalThreshold` 且 approve 数 ≥ 2（单人不能拍板）。
- 通过类目数落在 `[minCriteria, maxCriteria]` → 进入 `rubric_locked`；否则按赞成率排序截断并开下一轮（携带上一轮的 `amendment` 汇总）。
- 权重 = 通过者建议权重的中位数，再归一化到和为 1。
- 达到 `maxVotingRounds` 仍不达标 → 用赞成率排序取前 `maxCriteria` 强制锁定，并记 `lockedBy:"policy"`（记入 outcome，人可复议）。

**打分**：`POST /sessions/{id}/scores`

```jsonc
{ "round":1, "scores":[{ "criterionId":"cr-1", "score": 6.5,
    "rationale":"回调缺签名校验，但其余路径鉴权完整",
    "evidence":[{"path":"src/pay/callback.ts","startLine":42}],
    "confidence":0.8 }] }
```

**分析**：中枢对每个类目算 `min/max/mean/median/stdev/range`；`range > convergenceRange` 标记为 `contested`，自动开辩论帖。

**辩论**：`POST /sessions/{id}/debates/{debateId}/arguments`

```jsonc
{ "stance":"raise|lower|hold", "argument":"...", "evidence":[...], "respondingTo":"arg-3" }
```
辩论一轮后进入 `rescoring`：各 Agent 可改分（必须给 `changeReason`，不改也要显式 `hold`）。

**收敛/升级**：连续 `maxDebateRounds` 仍 `contested` → `awaiting_human`，人工可：指定最终分 / 采纳某方 / 直接取中位数。

**最终输出**：

```jsonc
{ "criteria":[{ "criterionId":"cr-1","name":"安全性","weight":0.25,
   "finalScore":6.0,"method":"converged|debated|human_ruled|median_fallback",
   "spread":1.5,"perReviewer":{"p-1":6.5,"p-2":5.5} }],
  "totalScore": 7.2, "scale":{"min":0,"max":10},
  "agreement": 0.86,           // 1 - 归一化平均极差
  "dissents":[{ "participantId":"p-2","criterionId":"cr-1","note":"..." }] }
```

保留 dissent（少数意见）是刻意设计：强行收敛会掩盖真实风险。

### 4.3 盲评与防锚定（v0.2 新增，关键）

LLM 极易被先看到的内容锚定。如果 A 先提名 6 个类目、先打了 8 分，B 大概率跟着走，那么"多 Agent 评审"退化成"一个 Agent 评审 + N 个复读机"，整套机制就没有价值了。所以：

| 阶段 | 可见性规则 |
|---|---|
| 提名 criteria | **盲提名**：提交前 `GET /criteria` 只返回自己的提名；**全员提交**或**人工 advance** 后统一揭晓（不再有"超时揭晓"） |
| 投票 | **盲投票**：本轮票不可见，本轮结束后公布分布（含谁投的，便于追责/复盘） |
| 打分 | **盲打分**：`policy.scoring.blindScoring=true`（默认开）时，未全部提交前 `GET /analysis` 返回 `403 SCORES_SEALED` |
| 辩论 | **公开**：辩论本来就要看到对方论据 |
| 改分 | **公开**：改分必须给 `changeReason`，且记录"从 X 改到 Y"，防止无理由跟风 |

实现上是一条 `visibility` 规则表 + 一个 `sealed` 标记，不是散落在各处的 if。**揭晓只由"全员提交"或"人工 advance"触发**（决策 3：超时不推进，因此也不揭晓）。

### 4.4 评审资格与利益回避（v0.2 新增）

- 场景二里 `implementer` 角色**不得**提名、投票、打分，只能在辩论阶段以 `stance:"clarify"` 提供事实澄清（不带倾向）。中枢按角色强制，不靠提示词自觉。
- 同一 `agentId` 不能在一个 session 里注册两个 reviewer participant（防止一个模型灌两票）。同一底层模型可以多份，但要在 `participant.model` 里如实登记，最终报告里会显示"模型多样性"提示——评审团全是同一个模型时，一致性高是没有意义的。
- 打分必须带 `evidence[]`（至少一条含 `path`），无证据的分数一律 `422 EVIDENCE_REQUIRED`。**这是硬约束，没有 policy 开关可以关掉**（决策 5）——无证据的分数等同于幻觉，允许关掉就等于允许整套机制失效。

---

## 5. 人工介入（两个场景共用）

```
POST /api/v1/collab/escalations
{ "sessionId":"...", "kind":"issue_dispute|rubric_dispute|score_dispute|other",
  "refId":"i-7", "summary":"...", "positions":[{"participantId":"p-1","stance":"...","rationale":"..."}],
  "question":"请裁决：回调签名校验是否本次必须做？",
  "options":["必须本轮修复","可延后到下个迭代","不是问题"],
  "urgency":"low|normal|high" }
→ 202 { "escalationId":"e-3", "status":"pending" }
```

- 中枢把它放进**全局待裁决队列**：`GET /api/v1/collab/escalations?status=pending`，Web UI 顶栏红点 + 列表；同时可复用 `MailNotifier` 发**通知**邮件（沿用现有聚合与开关设置）。**邮件永远只是通知**（决策 6）：不含一次性 token、不含任何可直接改变状态的链接，最多给一个需要正常登录的 Web UI 地址。裁决只能在已鉴权入口完成。
- 人裁决：`POST /escalations/{id}/resolve { "decision":"...", "rationale":"...", "appliesTo":{...} }`。
- **裁决是终局**：写回 issue/criterion/score 后该对象进入 `human_ruled`，任何 Agent 不得再改（API 返回 `HUMAN_RULING_FINAL`）。
- Agent 侧等待人工时**不阻塞**：可以继续处理别的 issue；被裁决后中枢再唤醒相关方。
- 兜底：所有 `awaiting_human` 超过 `humanTimeoutSec`（默认不超时）只是排队，不会自动放行——安全默认。

---

## 6. Agent 接入方式（三选一，可叠加）

| 方式 | 适用 | 优点 | 代价 |
|---|---|---|---|
| **A. 纯 HTTP + 提示词** | 任何 Agent（含 Claude Code / Codex / CI） | 零耦合、跨厂商 | 依赖 Agent 会正确 curl；需要好的提示模板与错误回执 |
| **B. Pi 扩展工具注入** | pi2web 托管的 Pi Agent | 工具签名即 schema，模型不易出错；无需 token 管理 | 只对 Pi 生效，需改 `sdk-backend.ts` 注册工具 |
| **C. MCP server** | 支持 MCP 的客户端 | 生态通用 | 额外传输层与依赖 |

**已定（决策 1）：先做 A**，作为协议地基；B/C 后续按需叠加，且必须构建在同一套 HTTP 契约之上，不得另立协议。

配套产物：
- `POST /sessions/{id}/join` 返回 `participantToken` + **`briefing`**：一段可直接塞进 Agent 系统提示的说明（包含它的角色、当前阶段、要调用的 URL 与 JSON 模板、错误码含义）。
- `pi2web collab` 子命令（薄 CLI），让外部 Agent `pi2web collab submit-findings --file f.json`，比手写 curl 更不易错。
- 校验失败一律返回 `422 + { code, fieldErrors:[{path,code,message,expected}] }`，让 Agent 能自我纠正后重试（幂等键保证重试安全）。

---

## 7. API 一览（`/api/v1/collab`）

| Method | Path | 说明 | 谁能调 |
|---|---|---|---|
| POST | `/sessions` | 创建协作会话 | **仅人**（pairing code） |
| GET | `/sessions` `/sessions/{id}` | 列表 / 详情 | 人 + 参与者 |
| POST | `/sessions/{id}/participants` | **仅人**登记参与者；Review 在 `draft`/`implementing`/`collecting` 开放，且 finished 后允许追加 implementer 为下一次修复做准备；scoring 仅 `nominating` | 人（pairing code） |
| POST | `/sessions/{id}/advance` | 僵局时**人工强推**（记入报告） | **仅人**（pairing code） |
| GET | `/sessions/{id}/events?since=` `?tail=` | 事件回放（`tail=` 取最新 N 条）；盲评/封盘期间他人提交的 payload 对参与者按条打码 | 全体 |
| GET | `/sessions/{id}/inbox?wait=` | 外部 Agent 长轮询任务 | 参与者本人 |
| GET | `/sessions/{id}/digest?for=` | 角色定制的当前任务包 | 参与者本人 |
| POST | `/sessions/{id}/findings` | 提交评审发现（批量、幂等） | 任何参与者（对称评审） |
| POST | `/sessions/{id}/recheck` | 对 finished Review 直接复核，或指定开发 Agent 先修复再复核 | **仅人**（pairing code） |
| GET | `/sessions/{id}/issues` | issue 看板（盲评期间参与者只能看到自己提的和指向自己的，单条 `…/issues/{iid}` 同规则） | 全体 |
| POST | `/sessions/{id}/issues/{iid}/merge-into` | 合并重复 | moderator / 人 |
| POST | `/sessions/{id}/criteria/nominations` | 提名评分类目 | reviewer |
| GET | `/sessions/{id}/criteria` | 候选集 / 已锁定 rubric | 全体 |
| POST | `/sessions/{id}/criteria/votes` | 投票 | reviewer |
| POST | `/sessions/{id}/scores` | 打分 / 改分 | reviewer |
| GET | `/sessions/{id}/analysis` | 分歧分析 | 全体 |
| POST | `/sessions/{id}/debates/{did}/arguments` | 辩论发言 | reviewer |
| POST | `/escalations` | 申请人工介入 | 任何参与者 |
| GET | `/escalations` | 待裁决队列 | 人 |
| POST | `/escalations/{id}/resolve` | 人工裁决（带结构化补救：`extra.tokenBudget` / `extra.maxTotalRounds`；参数不合法直接 422，不会默默用掉唯一一次裁定机会） | 人（pairing code） |
| POST | `/sessions/{id}/participants/{pid}/budget` | 单独提高某个座位的 token 预算并解封 `budget_exhausted`（随时可用，不受裁定一次性限制） | 人（pairing code） |
| GET | `/sessions/{id}/report` | 最终报告（Markdown + JSON），含全部 issue 与升级项 | **仅人**（pairing code） |
| GET | `/sessions/{id}/review-rounds` | 逐轮复核档案：每轮对之前 confirmed Finding 的 `resolved / still_present / pending` 结论、该轮新增 Finding、baseline 与该轮结论 | **仅人**（pairing code） |

鉴权：`Authorization: Bearer <pairing code>` = 人/管理员全权；`Bearer <participantToken>` = 仅该 session 内该参与者的权限。全部写接口带 `clientRequestId` 幂等键；对象更新带 `version` 乐观锁，冲突返回 `409 CONFLICT` 与最新版本。

---

## 8. 数据模型（SQLite，与 `remote-pi.db` 同库，`user_version` 升到 3）

```sql
collab_sessions(id PK, kind, title, workspace_id, cwd, subject_json, phase, round,
                policy_json, status, outcome_json, created_at, updated_at)
collab_participants(id PK, session_id FK, role, display_name, binding_type, agent_id,
                    token_hash, state, last_seen_at, created_at)
collab_events(session_id FK, sequence, id, type, actor_id, payload_json, created_at,
              PRIMARY KEY(session_id, sequence))
collab_issues(id PK, session_id FK, external_id, reporter_id, title, severity, category,
              required_action, confidence, location_json, evidence, impact, suggestion,
              status, round, version, merged_into, created_at, updated_at)
collab_issue_messages(id PK, issue_id FK, round, author_id, kind /*response|verdict|note*/,
                      payload_json, created_at)
collab_baselines(id PK, session_id FK, round, vcs, commit_sha, range_expr, dirty_hash,
                 paths_json, captured_at, UNIQUE(session_id, round))
collab_criteria(id PK, session_id FK, state /*candidate|approved|rejected*/, name,
                definition, anchors_json, weight, source_json, round, created_at)
collab_votes(id PK, session_id FK, criterion_id FK, participant_id FK, round, stance,
             weight, amendment, rationale, created_at, UNIQUE(criterion_id,participant_id,round))
collab_scores(id PK, session_id FK, criterion_id FK, participant_id FK, round, score,
              rationale, evidence_json, confidence, change_reason, created_at,
              UNIQUE(criterion_id,participant_id,round))
collab_debates(id PK, session_id FK, criterion_id FK, round, status, created_at)
collab_debate_arguments(id PK, debate_id FK, participant_id FK, stance, argument,
                        evidence_json, responding_to, created_at)
collab_escalations(id PK, session_id FK, kind, ref_id, raised_by, summary, positions_json,
                   question, options_json, urgency, status, decision_json, resolved_by,
                   created_at, resolved_at)
collab_inbox(id PK, session_id FK, participant_id FK, type, payload_json, created_at,
             delivered_at, acked_at)
collab_idempotency(key PK, session_id, participant_id, response_json, created_at)
```

---

## 9. 分期与里程碑（每个里程碑一个 commit，带测试）

| M | 内容 | 完成标准 |
|---|---|---|
| **M0** | 本方案文档 + 分支 | ✅ 本文 |
| **M1** | `types.ts` + `validate.ts` + `store.ts` + schema 迁移 | 单测：校验器错误路径、迁移幂等 |
| **M2** | `review-flow.ts` 纯状态机 | 单测覆盖 issue/session 全部状态迁移、僵局不推进、非提出者关闭被拒 |
| **M3** | `hub.ts` + `routes.ts` + 鉴权 + 幂等 + WS 事件 | 端到端测试：2 reviewer + 1 implementer 走完一轮闭环 |
| **M4** | escalation + 人工裁决 + Web UI 待裁决队列 + 邮件复用 | ✅ 升级→裁决→终局不可改；`MailNotifier.notifyCollab()` 立即发信（`collabEscalations` 开关） |
| **M5** | `scoring-flow.ts` 全阶段（提名/归并/投票/锁定/打分/辩论/收敛） | 单测：收敛判定、权重归一化、强制锁定兜底 |
| **M6** | Dispatcher：托管 Agent 自动唤醒 + 外部长轮询 inbox + briefing 模板 | ✅ `src/collab/dispatcher.ts`；`GET /inbox?wait=` 长轮询；`test/collab-dispatch.test.ts` |
| **M7** | Web UI 协作看板（issue 看板 / rubric 进度 / 待裁定队列 / 最终报告） | ✅ `web/collab.html` + `web/collab.js`，WS `subscribe_collab` 实时刷新；评分热力图仍待做 |
| **M8** | 文档 + Pi 扩展工具（方式 B）：安全任务 DTO、按阶段强类型提交工具、scoring 全阶段上下文 | ✅ `npm run check && npm test` 全绿；openapi.yaml 后续继续扩充 |

---

## 10. 决策记录（2026-08-08 已拍板）

| # | 决策 | 实现影响 |
|---|---|---|
| 1 | **先做 HTTP 通用协议**（方式 A），Pi 扩展/MCP 后续叠加 | 所有接入方式共用同一份契约，不得另立协议 |
| 2 | **只有人能创建 session、登记参与者、强推阶段**（长期而非阶段性） | 取消 Agent 自助 `join`；`POST /participants` 与 `/advance` 只接受 pairing code |
| 3 | **超时绝不自动推进**，只标 `stalled` + 事件 + 邮件通知 | 删除一切"视作弃权"逻辑；盲评揭晓也改为仅由全员提交/人工触发 |
| 4 | **允许反向评审**（对称模型），权限按 capability 判定 | issue 新增 `targetParticipantId`；状态机复用，不写第二套流程 |
| 5 | **证据强制且不可关**：`score.evidence[].path` 与 `finding.location.path` 均必填 | 去掉 `requireEvidence` 开关；缺证据一律 422 |
| 6 | **邮件永远只是通知**，不含 token / 可改变状态的链接 | 复用现有 `MailNotifier`，只加一类通知事件 |
| 7 | **每参与者 token 预算默认 600K**，超限锁写、保留读、自动升级人工 | 新增 `tokenBudget`/`tokensUsed` 与计量逻辑（§2.6） |
| 8 | **盲评默认开**（两个场景都开） | 一张 `visibility` 规则表统一控制 |
| 9 | **外部 Agent 是一等公民**（保留 inbox 长轮询） | 保留 `collab_inbox` 表与 participantToken 体系 |

### 实现中的默认解（没听到反对就这么做，随时可推翻）

- **D1** 托管 Agent 用 `follow-up` 唤醒（排队不打断）。
- **D2** external 参与者不自报 usage 时按 `bytes/4` 粗估，报告里标 `estimated`。
- **D3** 反向评审的 issue 与正向一视同仁，同样阻塞会话结束。
- **D4** `budget_exhausted` 后保留只读权限，便于人工接管后恢复。
- **D5** `maxTotalRounds` 默认 6 作为 token 预算之外的第二道防线；到顶不强制出报告，而是升级人工（与决策 3 保持一致）。

---

## 11. 已识别风险

- **死循环**：双方互不让步 → `maxIssueRounds` + `maxTotalRounds` + 每参与者 600K token 预算，三道闸门任一触发都转人工。
- **僵死（决策 3 的自觉代价）**：某方永久不交 → 会话永远停在 `stalled`。缓解手段：`stalled.waitingOn` 明确点名 + `participant_overdue` 事件 + 邮件通知 + Web UI 高亮 + 人工 `advance`。这是有意接受的权衡：宁可停住等人，也不放行未经评审的结论。
- **对称评审的轮次放大**：允许反向提 issue 后理论上可能互提互驳。靠 `maxTotalRounds` + token 预算封顶，并在报告里单独统计反向 issue 的采纳率（连续多条反向 issue 被 `reject` 的参与者会被标出来）。
- **Agent 不按格式提交**：422 + `fieldErrors` + 幂等重试 + briefing 里给完整示例；托管 Agent 还可用扩展工具从根上约束。
- **越权**：participantToken 作用域限定到 session + 自己的对象；关闭权只属于提出者与人。
- **雪崩式唤醒**：Dispatcher 串行化每个 Agent 的任务投递（同一 agentId 一个队列），避免同时 follow-up 多次。
- **`server.ts` 继续膨胀**：本次顺带把路由拆成表驱动的 `routes.ts`，只在 collab 范围内做，不动既有行为。
- **数据库迁移**：新表全部 `CREATE TABLE IF NOT EXISTS`，不改动既有表，`user_version` 从 1 → 2，向后兼容。

---

## 12. 测试策略

- **纯状态机单测**（`review-flow.ts` / `scoring-flow.ts` 不碰 IO）：全部状态迁移、越权（非提出者关 issue）、**超时阻塞（必须验证不会自动推进）**、轮次上限、token 预算耗尽、收敛与强制锁定兜底。这是收益最高的一块，必须先于 HTTP 层。
- **HTTP 契约测试**：沿用现有 `RemotePiServer({port:0,dataDir})` + `fetch` 的写法，覆盖 Reviewer findings → finished/confirmed，以及 finished → 新开发修复 → `/ready` → 原 Reviewer `resolved/still_present` 复核闭环。
- **幂等与并发**：同一 `clientRequestId` 重放两次只产生一条 Issue 或一份复核结果；重复复核同一 Issue 会被拒绝。
- **恶意/畸形输入**：超大 payload、错误 severity、缺失 `location.path` / `evidence`、跨 session 引用 issueId（必须 404 而不是泄露）、用 A 的 token 改 B 的对象、用 participantToken 调 `POST /sessions` 或 `/advance`（必须 403）。
- **持久化**：重启 pi2web 后 session/issue/escalation 全部还在（复用 mail-settings 测试里"重启再查"的写法）。
- **不做**：真实多 LLM 联调不进 CI（不稳定、烧钱），改用脚本 `examples/collab-demo` 手动跑。

