import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import type {AgentManager, AgentRecord} from './agents.js';
import type {AgentTemplateStore} from './agent-templates.js';
import type {MetadataStore} from './metadata-store.js';
import type {WorkspaceStore} from './workspaces.js';
import type {MailNotifier} from './mail-notifier.js';
import {assistantText, clipSummaryField} from './voice.js';

/**
 * Scheduled Agent tasks.
 *
 * Each schedule runs in a fresh, empty Pi session (so long-lived context never bloats) with a
 * dedicated history directory `<dataDir>/schedules/<taskId>/`:
 * - `runs/<timestamp>_<runId>.md`: archived final output of each run
 * - `latest.md`: copy of the most recent completed run's output
 * - `memory.md`: optional persistent scratchpad that the task prompt can read/update across runs
 */
export type ScheduleKind = 'cron' | 'interval' | 'once';
export type ScheduleNotifyMode = 'none' | 'mail' | 'orchestrator';
export type ScheduleRunStatus = 'running' | 'completed' | 'error' | 'aborted' | 'skipped';

export type ScheduledTask = {
  id: string;
  name: string;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  /** Cron expression (`min hour dom mon dow`, 5 fields in local time), interval like `30m`/`2h`, or ISO timestamp. */
  scheduleExpr: string;
  prompt: string;
  workspaceId?: string;
  /** Relative to workspaceId when set, or omitted to run inside the task's own schedule directory. */
  relativeCwd?: string;
  model?: {provider: string; modelId: string};
  thinkingLevel?: string;
  templateId?: string;
  notifyMode: ScheduleNotifyMode;
  notifyOrchestratorId?: string;
  historyDir: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastRunStatus?: ScheduleRunStatus;
  createdAt: string;
  updatedAt: string;
};

export type ScheduledRun = {
  id: string;
  taskId: string;
  taskName: string;
  agentId?: string;
  sessionFile?: string;
  status: ScheduleRunStatus;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  outputFile?: string;
};

export type ScheduleTaskInput = {
  name: string;
  enabled?: boolean;
  scheduleKind: ScheduleKind;
  scheduleExpr: string;
  prompt: string;
  workspaceId?: string;
  relativeCwd?: string;
  model?: {provider: string; modelId: string} | null;
  thinkingLevel?: string | null;
  templateId?: string | null;
  notifyMode?: ScheduleNotifyMode;
  notifyOrchestratorId?: string | null;
};

export type SchedulerOptions = {
  connection: () => Database.Database;
  schedulesDir: string;
  agents: AgentManager;
  workspaces: WorkspaceStore;
  metadata: MetadataStore;
  templates: AgentTemplateStore;
  mailNotifier?: MailNotifier;
  tickMs?: number;
  now?: () => number;
  log?: (message: string) => void;
};

const invalid = (message: string) => Object.assign(new Error(message), {code: 'INVALID_REQUEST'});
const notFound = (message: string) => Object.assign(new Error(message), {code: 'SCHEDULE_NOT_FOUND'});

// ---- Minimal, dependency-free schedule parser (local time 5-field cron, interval, once) ----

type CronField = Set<number>;
type ParsedCron = {
  minutes: CronField;
  hours: CronField;
  days: CronField;
  months: CronField;
  weekdays: CronField;
  dayWildcard: boolean;
  weekdayWildcard: boolean;
};

function parseCronField(
  expr: string,
  min: number,
  max: number,
  name: string,
  allowSevenForZero = false
): CronField {
  const result = new Set<number>();
  const parts = expr.split(',');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) throw invalid(`Invalid cron ${name}: empty token`);
    const [rangePart, stepPart] = trimmed.split('/');
    if (trimmed.split('/').length > 2) throw invalid(`Invalid cron ${name}: ${trimmed}`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw invalid(`Invalid cron ${name} step: ${trimmed}`);
    let start: number, end: number;
    if (rangePart === '*') {
      start = min;
      end = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      start = Number(a);
      end = Number(b);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start > end)
        throw invalid(`Invalid cron ${name} range: ${trimmed}`);
    } else {
      start = Number(rangePart);
      end = start;
      if (!Number.isInteger(start)) throw invalid(`Invalid cron ${name} value: ${trimmed}`);
    }
    const maxBound = allowSevenForZero ? Math.max(max, 7) : max;
    if (start < min || end > maxBound) throw invalid(`Cron ${name} out of range (${min}-${max}): ${trimmed}`);
    for (let v = start; v <= end; v += step) result.add(allowSevenForZero && v === 7 ? 0 : v);
  }
  if (!result.size) throw invalid(`Cron ${name} matches no values`);
  return result;
}

export function parseCronExpression(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5)
    throw invalid('Cron expression must have 5 fields: minute hour day-of-month month day-of-week');
  return {
    minutes: parseCronField(fields[0], 0, 59, 'minute'),
    hours: parseCronField(fields[1], 0, 23, 'hour'),
    days: parseCronField(fields[2], 1, 31, 'day-of-month'),
    months: parseCronField(fields[3], 1, 12, 'month'),
    weekdays: parseCronField(fields[4], 0, 6, 'day-of-week', true),
    dayWildcard: fields[2] === '*',
    weekdayWildcard: fields[4] === '*'
  };
}

export function parseIntervalMs(expr: string): number {
  const match =
    /^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(
      expr.trim()
    );
  if (!match) throw invalid('Interval expression must look like "30m", "2h", "1d", or "60s"');
  const count = Number(match[1]);
  const unit = match[2].toLowerCase()[0];
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const ms = count * factor;
  if (!Number.isFinite(ms) || ms < 60_000 || ms > 365 * 86_400_000)
    throw invalid('Interval must be between 1 minute (60s) and 365 days');
  return ms;
}

/** Compute the next run timestamp strictly after `afterMs` (epoch ms), or undefined when a one-shot is in the past. */
export function computeNextRun(kind: ScheduleKind, expr: string, afterMs: number): number | undefined {
  if (kind === 'interval') return afterMs + parseIntervalMs(expr);
  if (kind === 'once') {
    const target = Date.parse(expr.trim());
    if (!Number.isFinite(target)) throw invalid('One-shot scheduleExpr must be a valid ISO-8601 date/time');
    return target > afterMs ? target : undefined;
  }
  if (kind !== 'cron') throw invalid('scheduleKind must be cron, interval, or once');
  const cron = parseCronExpression(expr);
  const candidate = new Date(afterMs);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  // Search up to 4 years ahead (covers leap day Feb 29).
  const limit = afterMs + 4 * 366 * 86_400_000;
  while (candidate.getTime() <= limit) {
    if (!cron.months.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    const dayMatch = cron.days.has(candidate.getDate()),
      weekdayMatch = cron.weekdays.has(candidate.getDay());
    const dateOk =
      cron.dayWildcard && cron.weekdayWildcard
        ? true
        : cron.dayWildcard
          ? weekdayMatch
          : cron.weekdayWildcard
            ? dayMatch
            : dayMatch || weekdayMatch;
    if (!dateOk) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.has(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
      continue;
    }
    return candidate.getTime();
  }
  throw invalid('Cron expression has no upcoming trigger within 4 years');
}

export function validateScheduleExpression(kind: ScheduleKind, expr: string, nowMs = Date.now()) {
  if (kind === 'cron') parseCronExpression(expr);
  else if (kind === 'interval') parseIntervalMs(expr);
  else if (kind === 'once') {
    const t = Date.parse(expr.trim());
    if (!Number.isFinite(t)) throw invalid('One-shot scheduleExpr must be a valid ISO-8601 date/time');
  } else throw invalid('scheduleKind must be cron, interval, or once');
  return computeNextRun(kind, expr, nowMs);
}

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : undefined);
const stampForFile = (ms: number) => new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 19);

export class ScheduleManager {
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private activeByTask = new Map<string, {runId: string; agentId: string; taskId: string}>();
  private activeByAgent = new Map<string, {runId: string; taskId: string}>();
  private lastReply = new Map<string, {text: string; error?: string}>();
  private endFallbacks = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  private get db() {
    return this.options.connection();
  }

  init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_kind TEXT NOT NULL,
        schedule_expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        workspace_id TEXT,
        relative_cwd TEXT,
        model_json TEXT,
        thinking_level TEXT,
        template_id TEXT,
        notify_mode TEXT NOT NULL DEFAULT 'none',
        notify_orchestrator_id TEXT,
        next_run_at INTEGER,
        last_run_at INTEGER,
        last_run_status TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL
      );
      CREATE TABLE IF NOT EXISTS scheduled_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent_id TEXT,
        session_file TEXT,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        summary TEXT,
        error TEXT,
        output_file TEXT,
        FOREIGN KEY(task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS scheduled_runs_task_recent ON scheduled_runs(task_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS scheduled_runs_recent ON scheduled_runs(started_at DESC);
    `);
    // Any run still marked running from a previous server process did not finish cleanly.
    const now = this.now();
    this.db
      .prepare(
        "UPDATE scheduled_runs SET status='aborted', finished_at=?, error='Server restarted during run' WHERE status='running'"
      )
      .run(now);
    // Advance overdue recurring tasks to their next future trigger instead of firing a catch-up storm.
    for (const task of this.listTasks()) {
      if (!task.enabled || task.scheduleKind === 'once') continue;
      const nextMs = task.nextRunAt ? Date.parse(task.nextRunAt) : 0;
      if (!nextMs || nextMs <= now) {
        try {
          const recomputed = computeNextRun(task.scheduleKind, task.scheduleExpr, now);
          this.db
            .prepare('UPDATE scheduled_tasks SET next_run_at=? WHERE id=?')
            .run(recomputed ?? null, task.id);
        } catch {}
      }
    }
  }

  start() {
    if (this.closed) return;
    if (!this.unsubscribe) {
      this.unsubscribe = this.options.agents.subscribeAll((agentId, published) =>
        this.onAgentEvent(agentId, published.event)
      );
    }
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? 15_000);
      this.timer.unref?.();
    }
  }

  stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.endFallbacks.values()) clearTimeout(timer);
    this.endFallbacks.clear();
    this.activeByTask.clear();
    this.activeByAgent.clear();
    this.lastReply.clear();
  }

  historyDir(taskId: string) {
    return path.join(this.options.schedulesDir, taskId);
  }

  listTasks(): ScheduledTask[] {
    const rows = this.db
      .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC, id DESC')
      .all() as any[];
    return rows.map(row => this.rowToTask(row));
  }

  getTask(id: string): ScheduledTask {
    const row = this.db.prepare('SELECT * FROM scheduled_tasks WHERE id=?').get(id) as any;
    if (!row) throw notFound(`Scheduled task not found: ${id}`);
    return this.rowToTask(row);
  }

  createTask(input: ScheduleTaskInput): ScheduledTask {
    const validated = this.validateInput(input, undefined);
    const id = `sched-${randomUUID().slice(0, 12)}`;
    const now = this.now();
    const nextRunAt = validated.enabled
      ? computeNextRun(validated.scheduleKind, validated.scheduleExpr, now)
      : undefined;
    const dir = this.historyDir(id);
    mkdirSync(path.join(dir, 'runs'), {recursive: true});
    this.db
      .prepare(
        `INSERT INTO scheduled_tasks(
          id,name,enabled,schedule_kind,schedule_expr,prompt,workspace_id,relative_cwd,
          model_json,thinking_level,template_id,notify_mode,notify_orchestrator_id,
          next_run_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        id,
        validated.name,
        validated.enabled ? 1 : 0,
        validated.scheduleKind,
        validated.scheduleExpr,
        validated.prompt,
        validated.workspaceId ?? null,
        validated.relativeCwd ?? null,
        validated.model ? JSON.stringify(validated.model) : null,
        validated.thinkingLevel ?? null,
        validated.templateId ?? null,
        validated.notifyMode,
        validated.notifyOrchestratorId ?? null,
        nextRunAt ?? null,
        now,
        now
      );
    return this.getTask(id);
  }

  updateTask(id: string, patch: Partial<ScheduleTaskInput>): ScheduledTask {
    const existing = this.getTask(id);
    const merged: ScheduleTaskInput = {
      name: patch.name !== undefined ? patch.name : existing.name,
      enabled: patch.enabled !== undefined ? patch.enabled : existing.enabled,
      scheduleKind: patch.scheduleKind !== undefined ? patch.scheduleKind : existing.scheduleKind,
      scheduleExpr: patch.scheduleExpr !== undefined ? patch.scheduleExpr : existing.scheduleExpr,
      prompt: patch.prompt !== undefined ? patch.prompt : existing.prompt,
      workspaceId: patch.workspaceId !== undefined ? patch.workspaceId || undefined : existing.workspaceId,
      relativeCwd: patch.relativeCwd !== undefined ? patch.relativeCwd || undefined : existing.relativeCwd,
      model: patch.model !== undefined ? patch.model : existing.model,
      thinkingLevel: patch.thinkingLevel !== undefined ? patch.thinkingLevel : existing.thinkingLevel,
      templateId: patch.templateId !== undefined ? patch.templateId : existing.templateId,
      notifyMode: patch.notifyMode !== undefined ? patch.notifyMode : existing.notifyMode,
      notifyOrchestratorId:
        patch.notifyOrchestratorId !== undefined ? patch.notifyOrchestratorId : existing.notifyOrchestratorId
    };
    const validated = this.validateInput(merged, existing);
    const now = this.now();
    const scheduleChanged =
      validated.scheduleKind !== existing.scheduleKind ||
      validated.scheduleExpr !== existing.scheduleExpr ||
      (validated.enabled && !existing.enabled);
    const nextRunAt = !validated.enabled
      ? null
      : scheduleChanged || !existing.nextRunAt
        ? (computeNextRun(validated.scheduleKind, validated.scheduleExpr, now) ?? null)
        : Date.parse(existing.nextRunAt);
    this.db
      .prepare(
        `UPDATE scheduled_tasks SET
          name=?, enabled=?, schedule_kind=?, schedule_expr=?, prompt=?, workspace_id=?, relative_cwd=?,
          model_json=?, thinking_level=?, template_id=?, notify_mode=?, notify_orchestrator_id=?,
          next_run_at=?, updated_at=?
        WHERE id=?`
      )
      .run(
        validated.name,
        validated.enabled ? 1 : 0,
        validated.scheduleKind,
        validated.scheduleExpr,
        validated.prompt,
        validated.workspaceId ?? null,
        validated.relativeCwd ?? null,
        validated.model ? JSON.stringify(validated.model) : null,
        validated.thinkingLevel ?? null,
        validated.templateId ?? null,
        validated.notifyMode,
        validated.notifyOrchestratorId ?? null,
        nextRunAt,
        now,
        id
      );
    return this.getTask(id);
  }

  deleteTask(id: string) {
    this.getTask(id);
    this.db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(id);
    this.activeByTask.delete(id);
  }

  listRuns(taskId?: string, limit = 30): ScheduledRun[] {
    const bounded = Math.min(200, Math.max(1, Math.trunc(limit) || 30));
    const sql = taskId
      ? `SELECT r.*, t.name AS task_name FROM scheduled_runs r JOIN scheduled_tasks t ON t.id=r.task_id WHERE r.task_id=? ORDER BY r.started_at DESC LIMIT ?`
      : `SELECT r.*, t.name AS task_name FROM scheduled_runs r JOIN scheduled_tasks t ON t.id=r.task_id ORDER BY r.started_at DESC LIMIT ?`;
    const rows = (
      taskId ? this.db.prepare(sql).all(taskId, bounded) : this.db.prepare(sql).all(bounded)
    ) as any[];
    return rows.map(row => this.rowToRun(row));
  }

  getRun(runId: string): ScheduledRun {
    const row = this.db
      .prepare(
        'SELECT r.*, t.name AS task_name FROM scheduled_runs r JOIN scheduled_tasks t ON t.id=r.task_id WHERE r.id=?'
      )
      .get(runId) as any;
    if (!row) throw notFound(`Scheduled run not found: ${runId}`);
    return this.rowToRun(row);
  }

  /** Check due tasks and launch them. Also callable directly in tests. */
  async tick() {
    if (this.closed) return;
    const now = this.now();
    const due = this.db
      .prepare(
        'SELECT id FROM scheduled_tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?'
      )
      .all(now) as {id: string}[];
    for (const row of due) {
      const task = this.getTask(row.id);
      // Advance schedule before executing so a slow run cannot trigger twice on the next tick.
      const next =
        task.scheduleKind === 'once' ? undefined : computeNextRun(task.scheduleKind, task.scheduleExpr, now);
      this.db
        .prepare('UPDATE scheduled_tasks SET next_run_at=?, enabled=? WHERE id=?')
        .run(next ?? null, task.scheduleKind === 'once' ? 0 : 1, task.id);
      if (this.activeByTask.has(task.id)) {
        this.recordSkipped(task, now, 'Previous run is still in progress');
        continue;
      }
      await this.executeTask(task, now).catch(error =>
        this.options.log?.(
          `Scheduled task ${task.name} (${task.id}) failed to start: ${(error as Error).message}`
        )
      );
    }
  }

  /** Manually trigger one run of a scheduled task right now (even if disabled). */
  async runNow(taskId: string): Promise<ScheduledRun> {
    const task = this.getTask(taskId);
    if (this.activeByTask.has(task.id))
      throw Object.assign(new Error('Scheduled task is already running'), {code: 'AGENT_BUSY'});
    return this.executeTask(task, this.now());
  }

  /**
   * Open a past scheduled run's Pi session file as a browsable Agent (or return its existing Agent
   * if still loaded/active).
   */
  async openRunAgent(runId: string): Promise<AgentRecord> {
    const run = this.getRun(runId);
    if (run.agentId) {
      try {
        return {...this.options.agents.get(run.agentId).record};
      } catch {
        /* Was archived after completion; reopen from its sessionFile below. */
      }
    }
    if (!run.sessionFile || !existsSync(run.sessionFile))
      throw Object.assign(new Error('Run session file is not available'), {code: 'SESSION_NOT_FOUND'});
    const task = this.getTask(run.taskId);
    const created = task.workspaceId
      ? await this.options.agents.create(
          task.workspaceId,
          task.relativeCwd || '.',
          run.sessionFile,
          'default'
        )
      : await this.options.agents.createStandalone(task.historyDir, {
          profile: 'default',
          sessionFile: run.sessionFile
        });
    const label = `[定时] ${task.name} · ${run.startedAt.slice(0, 16).replace('T', ' ')}`;
    await this.options.agents.setSessionName(created.agentId, label).catch(() => {});
    const record = this.options.agents.get(created.agentId).record;
    this.options.metadata.saveAgent(record);
    return {...record};
  }

  private async executeTask(task: ScheduledTask, startedAt: number): Promise<ScheduledRun> {
    const runId = `run-${randomUUID().slice(0, 12)}`;
    const dir = this.historyDir(task.id);
    mkdirSync(path.join(dir, 'runs'), {recursive: true});
    const template = task.templateId ? this.options.templates.snapshot(task.templateId) : undefined;
    let agent: AgentRecord;
    try {
      agent = task.workspaceId
        ? await this.options.agents.create(
            task.workspaceId,
            task.relativeCwd || '.',
            undefined,
            'default',
            template
          )
        : await this.options.agents.createStandalone(dir, {profile: 'default', template});
      if (task.model)
        await this.options.agents.setModel(agent.agentId, task.model.provider, task.model.modelId, false);
      if (task.thinkingLevel) await this.options.agents.setThinkingLevel(agent.agentId, task.thinkingLevel);
      const runTitle = `[定时] ${task.name} · ${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')}`;
      await this.options.agents.setSessionName(agent.agentId, runTitle).catch(() => {});
      const fresh = this.options.agents.get(agent.agentId).record;
      this.options.metadata.saveAgent(fresh);
      agent = fresh;
    } catch (error) {
      const message = (error as Error).message;
      this.db
        .prepare(
          'INSERT INTO scheduled_runs(id,task_id,status,started_at,finished_at,error) VALUES(?,?,?,?,?,?)'
        )
        .run(runId, task.id, 'error', startedAt, this.now(), message);
      this.db
        .prepare('UPDATE scheduled_tasks SET last_run_at=?, last_run_status=? WHERE id=?')
        .run(startedAt, 'error', task.id);
      throw error;
    }

    this.db
      .prepare(
        'INSERT INTO scheduled_runs(id,task_id,agent_id,session_file,status,started_at) VALUES(?,?,?,?,?,?)'
      )
      .run(runId, task.id, agent.agentId, agent.sessionFile ?? null, 'running', startedAt);
    this.db
      .prepare('UPDATE scheduled_tasks SET last_run_at=?, last_run_status=? WHERE id=?')
      .run(startedAt, 'running', task.id);
    this.activeByTask.set(task.id, {runId, agentId: agent.agentId, taskId: task.id});
    this.activeByAgent.set(agent.agentId, {runId, taskId: task.id});

    const fullPrompt = buildScheduledPrompt(task, dir, startedAt);
    try {
      await this.options.agents.submitCommand(agent.agentId, 'prompt', fullPrompt);
    } catch (error) {
      this.finishRun(agent.agentId, 'error', '', (error as Error).message);
    }
    return this.getRun(runId);
  }

  private onAgentEvent(agentId: string, event: {type: string; [key: string]: unknown}) {
    if (this.closed) return;
    if (!this.activeByAgent.has(agentId)) return;
    if (event.type === 'message_end') {
      const msg = event.message as any;
      if (msg?.role === 'assistant') {
        const text = assistantText(msg) ?? '';
        const error =
          msg.stopReason === 'error'
            ? String(msg.errorMessage || 'LLM request failed')
            : msg.errorMessage
              ? String(msg.errorMessage)
              : undefined;
        this.lastReply.set(agentId, {text, error});
      }
      return;
    }
    if (event.type === 'agent_settled') {
      const fb = this.endFallbacks.get(agentId);
      if (fb) clearTimeout(fb);
      this.endFallbacks.delete(agentId);
      const reply = this.lastReply.get(agentId);
      this.lastReply.delete(agentId);
      const status: ScheduleRunStatus =
        event.aborted === true ? 'aborted' : reply?.error ? 'error' : 'completed';
      this.finishRun(agentId, status, reply?.text ?? '', reply?.error);
      return;
    }
    if (event.type === 'agent_end' && event.willRetry !== true) {
      const existing = this.endFallbacks.get(agentId);
      if (existing) clearTimeout(existing);
      const aborted = event.aborted === true;
      const timer = setTimeout(() => {
        this.endFallbacks.delete(agentId);
        if (this.closed || !this.activeByAgent.has(agentId)) return;
        const reply = this.lastReply.get(agentId);
        this.lastReply.delete(agentId);
        const status: ScheduleRunStatus = aborted ? 'aborted' : reply?.error ? 'error' : 'completed';
        this.finishRun(agentId, status, reply?.text ?? '', reply?.error);
      }, 40);
      timer.unref?.();
      this.endFallbacks.set(agentId, timer);
    }
  }

  private finishRun(agentId: string, status: ScheduleRunStatus, output: string, error?: string) {
    const active = this.activeByAgent.get(agentId);
    if (!active) return;
    this.activeByAgent.delete(agentId);
    this.activeByTask.delete(active.taskId);
    const finishedAt = this.now();
    let sessionFile: string | undefined;
    try {
      sessionFile = this.options.agents.get(agentId).record.sessionFile;
    } catch {}
    let task: ScheduledTask | undefined;
    try {
      task = this.getTask(active.taskId);
    } catch {}
    let outputFile: string | undefined;
    if (task) {
      try {
        const dir = this.historyDir(task.id);
        mkdirSync(path.join(dir, 'runs'), {recursive: true});
        outputFile = path.join(dir, 'runs', `${stampForFile(finishedAt)}_${active.runId}.md`);
        const content = [
          `# ${task.name}`,
          '',
          `- Run ID: ${active.runId}`,
          `- Status: ${status}`,
          `- Finished: ${new Date(finishedAt).toISOString()}`,
          ...(error ? [`- Error: ${error}`] : []),
          '',
          output.trim() || '(no text output)',
          ''
        ].join('\n');
        writeFileSync(outputFile, content, 'utf8');
        if (status === 'completed') writeFileSync(path.join(dir, 'latest.md'), content, 'utf8');
      } catch (writeError) {
        this.options.log?.(
          `Failed to archive scheduled run ${active.runId}: ${(writeError as Error).message}`
        );
      }
    }
    const summary = output.trim() ? clipSummaryField(output, 1500) : undefined;
    this.db
      .prepare(
        'UPDATE scheduled_runs SET status=?, finished_at=?, session_file=COALESCE(?,session_file), summary=?, error=?, output_file=? WHERE id=?'
      )
      .run(
        status,
        finishedAt,
        sessionFile ?? null,
        summary ?? null,
        error ?? null,
        outputFile ?? null,
        active.runId
      );
    this.db.prepare('UPDATE scheduled_tasks SET last_run_status=? WHERE id=?').run(status, active.taskId);

    // Archive the completed transient Agent out of the main sidebar so scheduled runs never flood the list;
    // the JSONL session file and archived Markdown output stay intact and can be opened any time.
    void this.archiveTransientAgent(agentId);

    if (task) void this.deliverNotification(task, active.runId, status, output, error, outputFile);
  }

  private async archiveTransientAgent(agentId: string) {
    try {
      const record = await this.options.agents.archive(agentId);
      this.options.metadata.archiveAgent(record);
    } catch {
      /* Ignore if already removed or still winding down. */
    }
  }

  private async deliverNotification(
    task: ScheduledTask,
    runId: string,
    status: ScheduleRunStatus,
    output: string,
    error?: string,
    outputFile?: string
  ) {
    if (task.notifyMode === 'mail' && this.options.mailNotifier) {
      const subject = `[Remote Pi 定时任务] ${task.name} · ${status}`;
      const body = [
        `任务：${task.name} (${task.id})`,
        `运行 ID：${runId}`,
        `状态：${status}`,
        ...(error ? [`错误：${error}`] : []),
        ...(outputFile ? [`归档文件：${outputFile}`] : []),
        '',
        clipSummaryField(output.trim() || '(无文本输出)', 20_000)
      ].join('\n');
      await this.options.mailNotifier.notifyCollab({subject, text: body});
      return;
    }
    if (task.notifyMode === 'orchestrator' && task.notifyOrchestratorId) {
      try {
        const target = this.options.agents.get(task.notifyOrchestratorId).record;
        if (target.profile !== 'orchestrator') return;
        const message = [
          '[pi2web scheduled task result]',
          `Task: ${task.name} (${task.id})`,
          `Run: ${runId} · status=${status}`,
          ...(error ? [`Error: ${error}`] : []),
          ...(outputFile ? [`Archived output: ${outputFile}`] : []),
          '',
          clipSummaryField(output.trim() || '(no text output)', 3000)
        ].join('\n');
        await this.options.agents.submitCommand(task.notifyOrchestratorId, 'prompt', message);
      } catch (notifyError) {
        this.options.log?.(
          `Scheduled task notification to orchestrator ${task.notifyOrchestratorId} failed: ${(notifyError as Error).message}`
        );
      }
    }
  }

  private recordSkipped(task: ScheduledTask, at: number, reason: string) {
    const runId = `run-${randomUUID().slice(0, 12)}`;
    this.db
      .prepare(
        'INSERT INTO scheduled_runs(id,task_id,status,started_at,finished_at,error) VALUES(?,?,?,?,?,?)'
      )
      .run(runId, task.id, 'skipped', at, at, reason);
    this.db
      .prepare('UPDATE scheduled_tasks SET last_run_at=?, last_run_status=? WHERE id=?')
      .run(at, 'skipped', task.id);
  }

  private validateInput(input: ScheduleTaskInput, _existing?: ScheduledTask) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120 || /[\r\n]/.test(name))
      throw invalid('name must be a single line of 1-120 characters');
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt || prompt.length > 100_000) throw invalid('prompt is required (up to 100000 chars)');
    const scheduleKind = input.scheduleKind;
    const scheduleExpr = typeof input.scheduleExpr === 'string' ? input.scheduleExpr.trim() : '';
    if (!scheduleExpr) throw invalid('scheduleExpr is required');
    validateScheduleExpression(scheduleKind, scheduleExpr, this.now());
    const enabled = input.enabled !== false;
    let workspaceId =
      typeof input.workspaceId === 'string' && input.workspaceId.trim()
        ? input.workspaceId.trim()
        : undefined;
    let relativeCwd =
      typeof input.relativeCwd === 'string' && input.relativeCwd.trim()
        ? input.relativeCwd.trim()
        : undefined;
    if (workspaceId) {
      if (!this.options.workspaces.get(workspaceId))
        throw Object.assign(new Error('Workspace not found'), {code: 'WORKSPACE_NOT_FOUND'});
      relativeCwd = relativeCwd || '.';
    } else {
      relativeCwd = undefined;
    }
    let model: {provider: string; modelId: string} | undefined;
    if (input.model) {
      if (typeof input.model.provider !== 'string' || typeof input.model.modelId !== 'string')
        throw invalid('model.provider and model.modelId must be strings');
      model = {provider: input.model.provider.trim(), modelId: input.model.modelId.trim()};
    }
    const thinkingLevel =
      typeof input.thinkingLevel === 'string' && input.thinkingLevel.trim()
        ? input.thinkingLevel.trim()
        : undefined;
    const templateId =
      typeof input.templateId === 'string' && input.templateId.trim() ? input.templateId.trim() : undefined;
    if (templateId) this.options.templates.get(templateId);
    const notifyMode: ScheduleNotifyMode = input.notifyMode ?? 'none';
    if (!['none', 'mail', 'orchestrator'].includes(notifyMode))
      throw invalid('notifyMode must be none, mail, or orchestrator');
    const notifyOrchestratorId =
      notifyMode === 'orchestrator' &&
      typeof input.notifyOrchestratorId === 'string' &&
      input.notifyOrchestratorId.trim()
        ? input.notifyOrchestratorId.trim()
        : undefined;
    if (notifyMode === 'orchestrator' && !notifyOrchestratorId)
      throw invalid('notifyOrchestratorId is required when notifyMode is orchestrator');
    return {
      name,
      enabled,
      scheduleKind,
      scheduleExpr,
      prompt,
      workspaceId,
      relativeCwd,
      model,
      thinkingLevel,
      templateId,
      notifyMode,
      notifyOrchestratorId
    };
  }

  private rowToTask(row: any): ScheduledTask {
    let model: {provider: string; modelId: string} | undefined;
    if (row.model_json) {
      try {
        model = JSON.parse(row.model_json);
      } catch {}
    }
    return {
      id: row.id,
      name: row.name,
      enabled: Boolean(row.enabled),
      scheduleKind: row.schedule_kind,
      scheduleExpr: row.schedule_expr,
      prompt: row.prompt,
      ...(row.workspace_id ? {workspaceId: row.workspace_id} : {}),
      ...(row.relative_cwd ? {relativeCwd: row.relative_cwd} : {}),
      ...(model ? {model} : {}),
      ...(row.thinking_level ? {thinkingLevel: row.thinking_level} : {}),
      ...(row.template_id ? {templateId: row.template_id} : {}),
      notifyMode: row.notify_mode ?? 'none',
      ...(row.notify_orchestrator_id ? {notifyOrchestratorId: row.notify_orchestrator_id} : {}),
      historyDir: this.historyDir(row.id),
      nextRunAt: iso(row.next_run_at),
      lastRunAt: iso(row.last_run_at),
      ...(row.last_run_status ? {lastRunStatus: row.last_run_status} : {}),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  private rowToRun(row: any): ScheduledRun {
    return {
      id: row.id,
      taskId: row.task_id,
      taskName: row.task_name ?? row.task_id,
      ...(row.agent_id ? {agentId: row.agent_id} : {}),
      ...(row.session_file ? {sessionFile: row.session_file} : {}),
      status: row.status,
      startedAt: new Date(row.started_at).toISOString(),
      ...(row.finished_at ? {finishedAt: new Date(row.finished_at).toISOString()} : {}),
      ...(row.summary ? {summary: row.summary} : {}),
      ...(row.error ? {error: row.error} : {}),
      ...(row.output_file ? {outputFile: row.output_file} : {})
    };
  }
}

function buildScheduledPrompt(task: ScheduledTask, dir: string, startedAt: number): string {
  const latestFile = path.join(dir, 'latest.md');
  const memoryFile = path.join(dir, 'memory.md');
  const lines = [
    `[Scheduled Task: ${task.name}]`,
    `Run time: ${new Date(startedAt).toISOString()}`,
    `History directory: ${dir}`,
    `- Previous runs archive: ${path.join(dir, 'runs')}`,
    `- Latest completed output: ${latestFile} (${existsSync(latestFile) ? 'exists' : 'not yet created'})`,
    `- Persistent memory/cursor file: ${memoryFile} (${existsSync(memoryFile) ? 'exists' : 'optional, create/update if you want to remember state between runs'})`,
    'This run starts with a fresh, empty conversation context. Read latest.md or memory.md only if needed.',
    '',
    '--- Task Instructions ---',
    task.prompt
  ];
  return lines.join('\n');
}
