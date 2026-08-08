# pi2web 多 Agent 协作中枢（Collaboration Hub）方案 v0.1

> 状态：**待讨论**。本文先给出整体架构、协议、状态机、数据模型和分期计划；确认后再进入实现。

## 0. 目标与定位

pi2web 现在是"人 ↔ 单个 Agent"的远程网关。本方案在其上叠加一层 **协作中枢（Collab Hub）**：

- 中枢是**唯一事实来源**：所有跨 Agent 的交互都必须经由结构化 API，Agent 之间不直接对话。
- Agent 之间只交换**结构化数据（JSON）**，不是自由文本聊天；自由文本只作为结构化字段里的 `rationale` / `body`。
- 中枢负责：身份与权限、汇总与分发、状态机推进、去重、超时、收敛判定、**人工升级（escalation）**。
- 两个首发场景：
  - **场景一 Review Loop**：1 个实现 Agent × N 个评审 Agent，issue 提出 → 汇总 → 回应 → 裁定 → 关闭 / 升级人工。
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
| `src/collab/hub.ts` | 编排：鉴权、事务、事件广播、分发、超时 |
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
  "binding": { "type": "managed", "agentId": "agent-..." }   // 或 {"type":"external"}
  "token": "<仅在 join 时返回一次，DB 存 sha256>",
  "state": "active" | "left" | "timed_out",
  "lastSeenAt": "..."
}
```

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
  "reviewerSubmitTimeoutSec": 1800, // 评审超时 → 视作弃权，不阻塞流程
  "implementerReplyTimeoutSec": 3600,
  "autoEscalateOnDeadlock": true,
  "severityGate": "major",          // 低于该严重度不阻塞 session 结束
  "scoring": {
    "minCriteria": 4, "maxCriteria": 8,
    "approvalThreshold": 0.67,      // 类目通过所需赞成比例
    "maxVotingRounds": 3,
    "scale": { "min": 0, "max": 10, "step": 0.5 },
    "convergenceRange": 2.0,        // 同一类目极差 ≤ 2 视为收敛
    "maxDebateRounds": 2
  }
}
```

---

## 3. 场景一：Review Loop

### 3.1 Session 阶段机

```
draft ──open_round──▶ collecting        (评审 Agent 提交 findings)
collecting ──全部提交/超时──▶ consolidating (中枢去重、排序、编号)
consolidating ──自动──▶ responding       (实现 Agent 收到汇总包，逐条回应)
responding ──全部回应/超时──▶ adjudicating (回应分发回各自提出者，评审裁定)
adjudicating ──▶ 若仍有 open issue 且 round < max ──▶ collecting (round+1，只针对未关闭 issue)
             ──▶ 全部 resolved/closed ──▶ finished
             ──▶ 有 escalated 且人工未裁决 ──▶ awaiting_human ──▶ (裁决后回到 adjudicating)
```

### 3.2 Issue 状态机

```
                    ┌────────────── reviewer: withdraw ─────────────┐
                    │                                               ▼
open ──implementer 回应──▶ answered ──reviewer verdict──┬─ accept ─▶ resolved
                                                        ├─ reject ─▶ open (round+1)
                                                        └─ escalate ▶ escalated
open/answered ── 任一方 escalate / round>max / 超时 ──▶ escalated
escalated ── 人工裁决 ──▶ resolved | wontfix | closed(无效)
```

`implementer` 的回应类型（`responseType`）：

| 值 | 含义 | 必填字段 |
|---|---|---|
| `fixed` | 已修复 | `changes[]`（文件+简述，可含 commit/diff 摘要） |
| `partially_fixed` | 部分修复 | `changes[]` + `remaining` |
| `rejected` | 不认为是问题 | `rationale`（≥ 30 字符，强制说明理由） |
| `needs_info` | 需要澄清 | `question` |
| `deferred` | 认可但本轮不做 | `rationale` + `followUpRef?` |

`reviewer` 的裁定（`verdict`）：`accept` / `reject`（附 `rationale`）/ `needs_info` / `escalate`（附 `rationale`）。

> 关键约束：**只有 issue 的提出者（或人工）才能把它关掉**，实现 Agent 无权 close。这直接对应你的要求。

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
    "requiredAction": "must_fix|should_fix|discuss|fyi"
  }],
  "reviewComplete": true                 // 本轮我提完了
}
→ 201 { "accepted": [{ "externalId":"sec-1", "issueId":"i-7" }],
        "rejected": [{ "externalId":"...", "code":"INVALID_SEVERITY", "message":"..." }],
        "possibleDuplicates": [{ "issueId":"i-7", "similarTo":"i-3", "score":0.82 }] }
```

实现 Agent 拿到的汇总包（`GET /sessions/{id}/digest?for=implementer`）：

```jsonc
{
  "sessionId":"...", "round":1,
  "stats": { "total": 12, "byRequiredAction": { "must_fix": 3, "should_fix": 5, "discuss": 2, "fyi": 2 } },
  "issues": [ { "issueId":"i-7", "title":"...", "severity":"critical", "reportedBy":"reviewer-security",
                "location":{...}, "evidence":"...", "suggestion":"...", "history":[ /* 历轮往返 */ ] } ],
  "duplicateGroups": [ ["i-7","i-3"] ],
  "instructions": "对每个 issue 调用 POST .../issues/{issueId}/response ..."
}
```

实现 Agent 回应：`POST /sessions/{id}/responses`（同样批量 + 幂等）。
评审 Agent 裁定：`POST /sessions/{id}/verdicts`。
任一方升级：`POST /sessions/{id}/escalations`。

### 3.4 去重策略

中枢**不自动合并**，只标注 `possibleDuplicates`：同 `path` 且行区间重叠 → 权重 0.5；标题/建议的词集合 Jaccard 相似度 → 权重 0.5；`score ≥ 0.7` 提示。合并由 moderator/人工调 `POST /issues/{id}/merge-into` 完成（被合并方状态 `duplicate`，裁定权归主 issue）。理由：误合并会丢掉真实缺陷，代价高于重复处理。

---

## 4. 场景二：Panel Scoring

### 4.1 阶段机

```
nominating ─▶ consolidating ─▶ voting ─┬─(未达标且 round<max)─▶ nominating/voting (round+1)
                                        └─(达标)─▶ rubric_locked ─▶ scoring ─▶ analysis
analysis ─┬─(全部类目收敛)──────────────────────────────▶ finalized
          └─(有分歧类目)─▶ debating ─▶ rescoring ─▶ analysis (debateRound+1)
                                     └─(超轮次仍分歧)─▶ awaiting_human ─▶ finalized
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

- 中枢把它放进**全局待裁决队列**：`GET /api/v1/collab/escalations?status=pending`，Web UI 顶栏红点 + 列表，可选复用 `MailNotifier` 发邮件（沿用现有聚合与开关设置）。
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

**建议顺序：A（必做，作为协议地基）→ B（Pi Agent 的最佳体验）→ C（以后按需）。**

配套产物：
- `POST /sessions/{id}/join` 返回 `participantToken` + **`briefing`**：一段可直接塞进 Agent 系统提示的说明（包含它的角色、当前阶段、要调用的 URL 与 JSON 模板、错误码含义）。
- `pi2web collab` 子命令（薄 CLI），让外部 Agent `pi2web collab submit-findings --file f.json`，比手写 curl 更不易错。
- 校验失败一律返回 `422 + { code, fieldErrors:[{path,code,message,expected}] }`，让 Agent 能自我纠正后重试（幂等键保证重试安全）。

---

## 7. API 一览（`/api/v1/collab`）

| Method | Path | 说明 | 谁能调 |
|---|---|---|---|
| POST | `/sessions` | 创建协作会话 | 人（pairing code） |
| GET | `/sessions` `/sessions/{id}` | 列表 / 详情 | 人 + 参与者 |
| POST | `/sessions/{id}/join` | 加入并领取 participantToken + briefing | 人代为登记 / 邀请码 |
| POST | `/sessions/{id}/advance` | 手动推进阶段（超时兜底） | 人 / moderator |
| GET | `/sessions/{id}/events?since=` | 事件回放 | 全体 |
| GET | `/sessions/{id}/inbox?wait=` | 外部 Agent 长轮询任务 | 参与者本人 |
| GET | `/sessions/{id}/digest?for=` | 角色定制的当前任务包 | 参与者本人 |
| POST | `/sessions/{id}/findings` | 提交评审发现（批量、幂等） | reviewer |
| POST | `/sessions/{id}/responses` | 实现方回应（批量、幂等） | implementer |
| POST | `/sessions/{id}/verdicts` | 提出者裁定 | reviewer（仅自己的 issue） |
| GET | `/sessions/{id}/issues` | issue 看板 | 全体 |
| POST | `/sessions/{id}/issues/{iid}/merge-into` | 合并重复 | moderator / 人 |
| POST | `/sessions/{id}/criteria/nominations` | 提名评分类目 | reviewer |
| GET | `/sessions/{id}/criteria` | 候选集 / 已锁定 rubric | 全体 |
| POST | `/sessions/{id}/criteria/votes` | 投票 | reviewer |
| POST | `/sessions/{id}/scores` | 打分 / 改分 | reviewer |
| GET | `/sessions/{id}/analysis` | 分歧分析 | 全体 |
| POST | `/sessions/{id}/debates/{did}/arguments` | 辩论发言 | reviewer |
| POST | `/escalations` | 申请人工介入 | 任何参与者 |
| GET | `/escalations` | 待裁决队列 | 人 |
| POST | `/escalations/{id}/resolve` | 人工裁决 | 人（pairing code） |
| GET | `/sessions/{id}/report` | 最终报告（Markdown + JSON） | 全体 |

鉴权：`Authorization: Bearer <pairing code>` = 人/管理员全权；`Bearer <participantToken>` = 仅该 session 内该参与者的权限。全部写接口带 `clientRequestId` 幂等键；对象更新带 `version` 乐观锁，冲突返回 `409 CONFLICT` 与最新版本。

---

## 8. 数据模型（SQLite，与 `remote-pi.db` 同库，`user_version` 升到 2）

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
| **M2** | `review-flow.ts` 纯状态机 | 单测覆盖 issue/session 全部状态迁移与超时、越权关闭被拒 |
| **M3** | `hub.ts` + `routes.ts` + 鉴权 + 幂等 + WS 事件 | 端到端测试：2 reviewer + 1 implementer 走完一轮闭环 |
| **M4** | escalation + 人工裁决 + Web UI 待裁决队列 + 邮件复用 | 测试：升级→裁决→终局不可改 |
| **M5** | `scoring-flow.ts` 全阶段（提名/归并/投票/锁定/打分/辩论/收敛） | 单测：收敛判定、权重归一化、强制锁定兜底 |
| **M6** | Dispatcher：托管 Agent 自动唤醒 + 外部长轮询 inbox + briefing 模板 | 测试：MockBackend 收到结构化任务包 |
| **M7** | Web UI 协作看板（issue 看板 / rubric 进度 / 评分热力图 / 最终报告） | 手测 + 截图 |
| **M8** | 文档（README + `COLLAB.md` + openapi.yaml）+ Pi 扩展工具（方式 B） | `npm run check && npm test` 全绿 |

---

## 10. 需要你拍板的问题

1. **Agent 接入优先级**：先做「HTTP + 提示词（跨厂商通用）」还是先做「Pi 扩展工具（体验最好但只服务 Pi）」？我倾向前者做地基、后者做糖。
2. **托管 Agent 的唤醒方式**：用 `follow-up`（排队，不打断当前任务）还是 `prompt`？我倾向 `follow-up`，且任务包用 fenced JSON + 明确指令。
3. **谁来发起 session**：只允许人在 Web UI 发起，还是也允许"主控 Agent"通过 API 发起并拉人？（后者更自动化，但要防止 Agent 自造循环）
4. **实现 Agent 是否有权提 issue 反向评审评审者**？（即对称模型）当前方案是非对称的。
5. **评分场景是否也要挂在真实代码上**（要求 evidence 必须带 path/line），还是允许纯文字论证？我倾向强制 evidence，减少幻觉。
6. **超时默认值**是否合适（评审 30 分钟、回应 60 分钟）？超时是"视作弃权继续推进"还是"卡住等人"？我倾向前者但记入报告。
7. **是否需要 session 级别的成本上限**（比如总轮次 / 总 token 预算），到顶自动收敛并出报告？
8. **人工裁决入口**除 Web UI 外，是否需要邮件里的一键链接（需要考虑安全，链接带一次性 token）？

---

## 11. 已识别风险

- **死循环**：双方互不让步 → `maxIssueRounds` + 自动升级 + 会话级总轮次上限三重兜底。
- **Agent 不按格式提交**：422 + `fieldErrors` + 幂等重试 + briefing 里给完整示例；托管 Agent 还可用扩展工具从根上约束。
- **越权**：participantToken 作用域限定到 session + 自己的对象；关闭权只属于提出者与人。
- **雪崩式唤醒**：Dispatcher 串行化每个 Agent 的任务投递（同一 agentId 一个队列），避免同时 follow-up 多次。
- **`server.ts` 继续膨胀**：本次顺带把路由拆成表驱动的 `routes.ts`，只在 collab 范围内做，不动既有行为。
- **数据库迁移**：新表全部 `CREATE TABLE IF NOT EXISTS`，不改动既有表，`user_version` 从 1 → 2，向后兼容。
