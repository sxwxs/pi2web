import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {EventEmitter} from 'node:events';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {randomUUID} from 'node:crypto';
import {SessionManager} from '@earendil-works/pi-coding-agent';
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
export type ScheduleRunStatus = 'running' | 'completed' | 'error' | 'aborted' | 'timed_out' | 'skipped';

export const DEFAULT_SCHEDULE_TIMEOUT_SECONDS = 1800;
export const MAX_SCHEDULE_TIMEOUT_SECONDS = 86_400;

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
  /** Per-run timeout in seconds; 0 disables timeout protection. Default 1800 (30 min). */
  timeoutSeconds: number;
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
  timeoutSeconds?: number;
  notifyMode?: ScheduleNotifyMode;
  notifyOrchestratorId?: string | null;
};

export type ScheduleEvent = {
  type: 'run_finished';
  taskId: string;
  taskName: string;
  run: ScheduledRun;
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
      if (!Number.isInteger(start)) throw invalid(`Invalid cron ${name} value: ${trimmed}`);
      // Support Quartz-style `N/step` (e.g. `0/15` -> `0..max` step 15) instead of silently ignoring `/step`.
      end = stepPart === undefined ? start : max;
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
    // Both `*` and `*/step` are wildcard-based in standard cron day matching (AND with the other day field).
    dayWildcard: fields[2] === '*' || fields[2].startsWith('*/'),
    weekdayWildcard: fields[4] === '*' || fields[4].startsWith('*/')
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
  // Start strictly after `afterMs` on the next minute boundary in epoch time (safe across DST fall-back).
  const candidate = new Date(Math.floor(afterMs / 60_000) * 60_000 + 60_000);
  // Search up to 4 years ahead (covers leap day Feb 29).
  const limit = afterMs + 4 * 366 * 86_400_000;
  const advanceMonotonic = (prevMs: number) => {
    if (candidate.getTime() <= prevMs) candidate.setTime(prevMs + 60_000);
  };
  while (candidate.getTime() <= limit) {
    const prevMs = candidate.getTime();
    if (!cron.months.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      advanceMonotonic(prevMs);
      continue;
    }
    const dayMatch = cron.days.has(candidate.getDate()),
      weekdayMatch = cron.weekdays.has(candidate.getDay());
    const dateOk =
      cron.dayWildcard || cron.weekdayWildcard ? dayMatch && weekdayMatch : dayMatch || weekdayMatch;
    if (!dateOk) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      advanceMonotonic(prevMs);
      continue;
    }
    if (!cron.hours.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      advanceMonotonic(prevMs);
      continue;
    }
    if (!cron.minutes.has(candidate.getMinutes())) {
      candidate.setTime(prevMs + 60_000);
      continue;
    }
    if (candidate.getTime() <= afterMs) {
      candidate.setTime(prevMs + 60_000);
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
  private emitter = new EventEmitter();
  private timer?: ReturnType<typeof setInterval>;
  private unsubscribe?: () => void;
  private activeByTask = new Map<string, {runId: string; agentId?: string; taskId: string}>();
  private activeByAgent = new Map<string, {runId: string; taskId: string; timedOut?: boolean}>();
  /** Retains scheduled-run Agent IDs until archival completes so settlement listeners skip them reliably. */
  private scheduledAgents = new Set<string>();
  private runTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private lastReply = new Map<string, {text: string; error?: string}>();
  private inFlight = new Set<Promise<unknown>>();
  private ticking = false;
  private closed = false;
  private readonly now: () => number;
  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether `agentId` belongs to a scheduled run (so generic mail/voice/follow-up skips it). */
  isScheduledAgent(agentId: string) {
    return this.scheduledAgents.has(agentId);
  }

  subscribe(listener: (event: ScheduleEvent) => void) {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
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
        timeout_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_SCHEDULE_TIMEOUT_SECONDS},
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
    // Additive migration for timeout_seconds.
    const taskCols = this.db.prepare('PRAGMA table_info(scheduled_tasks)').all() as {name: string}[];
    if (!taskCols.some(col => col.name === 'timeout_seconds')) {
      this.db.exec(
        `ALTER TABLE scheduled_tasks ADD COLUMN timeout_seconds INTEGER NOT NULL DEFAULT ${DEFAULT_SCHEDULE_TIMEOUT_SECONDS}`
      );
    }
    // Any run still marked running from a previous server process did not finish cleanly.
    // Reconcile both run and task status (interrupted Agents stay inspectable in the sidebar).
    const now = this.now();
    this.db.transaction(() => {
      this.db
        .prepare(
          "UPDATE scheduled_runs SET status='aborted', finished_at=?, error='Server restarted during run' WHERE status='running'"
        )
        .run(now);
      this.db
        .prepare("UPDATE scheduled_tasks SET last_run_status='aborted' WHERE last_run_status='running'")
        .run();
    })();
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
      this.timer = setInterval(() => {
        void this.tick().catch(error =>
          this.options.log?.(`Scheduler tick failed: ${(error as Error).message}`)
        );
      }, this.options.tickMs ?? 15_000);
      this.timer.unref?.();
    }
  }

  async stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.runTimeouts.values()) clearTimeout(timer);
    this.runTimeouts.clear();
    await Promise.allSettled([...this.inFlight]);
    this.activeByTask.clear();
    this.activeByAgent.clear();
    this.scheduledAgents.clear();
    this.lastReply.clear();
    this.emitter.removeAllListeners();
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
          model_json,thinking_level,template_id,timeout_seconds,notify_mode,notify_orchestrator_id,
          next_run_at,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        validated.timeoutSeconds,
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
      timeoutSeconds: patch.timeoutSeconds !== undefined ? patch.timeoutSeconds : existing.timeoutSeconds,
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
          model_json=?, thinking_level=?, template_id=?, timeout_seconds=?, notify_mode=?, notify_orchestrator_id=?,
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
        validated.timeoutSeconds,
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
    if (this.activeByTask.has(id))
      throw Object.assign(new Error('Scheduled task is currently running and cannot be deleted'), {
        code: 'AGENT_BUSY'
      });
    this.db.prepare('DELETE FROM scheduled_tasks WHERE id=?').run(id);
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
    if (this.closed || this.ticking) return;
    this.ticking = true;
    const job = (async () => {
      const now = this.now();
      const due = this.db
        .prepare(
          'SELECT id FROM scheduled_tasks WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=?'
        )
        .all(now) as {id: string}[];
      for (const row of due) {
        if (this.closed) break;
        // Re-read immediately before advancing so pauses, edits, or deletions during an earlier startup take effect.
        let task: ScheduledTask;
        try {
          task = this.getTask(row.id);
        } catch {
          continue;
        }
        const dueAt = task.nextRunAt ? Date.parse(task.nextRunAt) : Number.NaN;
        if (!task.enabled || !Number.isFinite(dueAt) || dueAt > now) continue;
        // Advance schedule before executing so a slow run cannot trigger twice on the next tick.
        const next =
          task.scheduleKind === 'once'
            ? undefined
            : computeNextRun(task.scheduleKind, task.scheduleExpr, now);
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
    })();
    this.track(job);
    try {
      await job;
    } finally {
      this.ticking = false;
    }
  }

  /** Manually trigger one run of a scheduled task right now (even if disabled). */
  async runNow(taskId: string): Promise<ScheduledRun> {
    if (this.closed) throw invalid('Scheduler is stopped');
    const task = this.getTask(taskId);
    if (this.activeByTask.has(task.id))
      throw Object.assign(new Error('Scheduled task is already running'), {code: 'AGENT_BUSY'});
    return this.track(this.executeTask(task, this.now()));
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise);
    const cleanup = () => {
      this.inFlight.delete(promise);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  /**
   * Open a past scheduled run's Pi session file as a browsable Agent (or return its existing Agent
   * if still loaded/active). Reuses any live Agent already attached to the same sessionFile to avoid
   * duplicate backends writing to one JSONL file, and uses the session file's original cwd.
   */
  async openRunAgent(runId: string): Promise<AgentRecord> {
    const run = this.getRun(runId);
    if (run.agentId) {
      try {
        return {...this.options.agents.get(run.agentId).record};
      } catch {
        /* Was archived after completion; check sessionFile below. */
      }
    }
    if (!run.sessionFile || !existsSync(run.sessionFile))
      throw Object.assign(new Error('Run session file is not available'), {code: 'SESSION_NOT_FOUND'});
    const existing = this.options.agents.list().find(agent => agent.sessionFile === run.sessionFile);
    if (existing) return existing;
    const task = this.getTask(run.taskId);
    let sessionCwd = '';
    try {
      sessionCwd = SessionManager.open(run.sessionFile).getCwd() || '';
    } catch {}
    let created: AgentRecord;
    if (sessionCwd && existsSync(sessionCwd)) {
      const matched = await this.options.workspaces.matchDirectory(sessionCwd).catch(() => undefined);
      created = matched
        ? await this.options.agents.create(
            matched.workspace.id,
            path.relative(matched.workspace.rootPath, matched.cwd) || '.',
            run.sessionFile,
            'default'
          )
        : await this.options.agents.createStandalone(sessionCwd, {
            profile: 'default',
            sessionFile: run.sessionFile
          });
    } else {
      created = task.workspaceId
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
    }
    const label = `[定时] ${task.name} · ${run.startedAt.slice(0, 16).replace('T', ' ')}`;
    await this.options.agents.setSessionName(created.agentId, label).catch(() => {});
    const record = this.options.agents.get(created.agentId).record;
    this.options.metadata.saveAgent(record);
    return {...record};
  }

  private async executeTask(task: ScheduledTask, startedAt: number): Promise<ScheduledRun> {
    if (this.closed) throw invalid('Scheduler is stopped');
    if (this.activeByTask.has(task.id))
      throw Object.assign(new Error('Scheduled task is already running'), {code: 'AGENT_BUSY'});
    const runId = `run-${randomUUID().slice(0, 12)}`;
    // Reserve synchronously before any I/O or await so concurrent ticks / double-clicks cannot overlap.
    this.activeByTask.set(task.id, {runId, taskId: task.id});
    const dir = this.historyDir(task.id);
    let agent: AgentRecord | undefined;
    try {
      mkdirSync(path.join(dir, 'runs'), {recursive: true});
      const template = task.templateId ? this.options.templates.snapshot(task.templateId) : undefined;
      agent = task.workspaceId
        ? await this.options.agents.create(
            task.workspaceId,
            task.relativeCwd || '.',
            undefined,
            'default',
            template
          )
        : await this.options.agents.createStandalone(dir, {profile: 'default', template});
      this.scheduledAgents.add(agent.agentId);
      if (this.closed) throw new Error('Scheduler stopped during task startup');
      if (task.model)
        await this.options.agents.setModel(agent.agentId, task.model.provider, task.model.modelId, false);
      if (task.thinkingLevel) await this.options.agents.setThinkingLevel(agent.agentId, task.thinkingLevel);
      const runTitle = `[定时] ${task.name} · ${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')}`;
      await this.options.agents.setSessionName(agent.agentId, runTitle).catch(() => {});
      if (this.closed) throw new Error('Scheduler stopped during task startup');
      const fresh = this.options.agents.get(agent.agentId).record;
      this.options.metadata.saveAgent(fresh);
      agent = fresh;
    } catch (error) {
      this.activeByTask.delete(task.id);
      if (agent) {
        let failedRecord = agent;
        try {
          failedRecord = {...this.options.agents.get(agent.agentId).record, status: 'unloaded'};
        } catch {}
        await this.options.agents.remove(agent.agentId).catch(() => {});
        this.options.metadata.archiveAgent(failedRecord);
        this.scheduledAgents.delete(agent.agentId);
      }
      if (!this.closed) {
        const message = (error as Error).message;
        this.db
          .prepare(
            'INSERT INTO scheduled_runs(id,task_id,status,started_at,finished_at,error) VALUES(?,?,?,?,?,?)'
          )
          .run(runId, task.id, 'error', startedAt, this.now(), message);
        this.db
          .prepare('UPDATE scheduled_tasks SET last_run_at=?, last_run_status=? WHERE id=?')
          .run(startedAt, 'error', task.id);
        this.emitRunFinished(task, runId);
        void this.deliverNotification(task, runId, 'error', '', message);
      }
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

    if (task.timeoutSeconds > 0) {
      const timeoutAgentId = agent.agentId;
      const limitSec = task.timeoutSeconds;
      const timer = setTimeout(() => {
        this.runTimeouts.delete(timeoutAgentId);
        void this.handleRunTimeout(timeoutAgentId, limitSec);
      }, limitSec * 1000);
      timer.unref?.();
      this.runTimeouts.set(timeoutAgentId, timer);
    }

    const fullPrompt = buildScheduledPrompt(task, dir, startedAt);
    try {
      await this.options.agents.submitCommand(agent.agentId, 'prompt', fullPrompt);
    } catch (error) {
      this.finishRun(agent.agentId, 'error', '', (error as Error).message);
    }
    return this.getRun(runId);
  }

  private async handleRunTimeout(agentId: string, timeoutSeconds: number) {
    if (this.closed) return;
    const active = this.activeByAgent.get(agentId);
    if (!active) return;
    active.timedOut = true;
    const reply = this.lastReply.get(agentId)?.text ?? '';
    const message = `Timed out after ${timeoutSeconds}s and was aborted automatically`;
    try {
      await this.options.agents.abortBash(agentId);
      // Dispose tears down the backend and resolves any pending extension UI dialogs that abort() alone cannot unblock.
      await this.options.agents.dispose(agentId);
    } catch {}
    // Finalize immediately if disposal did not already trigger finishRun via agent_unloaded.
    if (this.activeByAgent.has(agentId)) {
      this.lastReply.delete(agentId);
      this.finishRun(agentId, 'timed_out', reply, message);
    }
  }

  private onAgentEvent(agentId: string, event: {type: string; [key: string]: unknown}) {
    if (this.closed) return;
    const active = this.activeByAgent.get(agentId);
    if (!active) return;
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
      const reply = this.lastReply.get(agentId);
      this.lastReply.delete(agentId);
      const status: ScheduleRunStatus = active.timedOut
        ? 'timed_out'
        : event.aborted === true || event.paused === true
          ? 'aborted'
          : reply?.error
            ? 'error'
            : 'completed';
      const error = active.timedOut
        ? 'Timed out and was aborted automatically'
        : event.paused === true
          ? 'Run was paused before completion'
          : reply?.error;
      this.finishRun(agentId, status, reply?.text ?? '', error);
      return;
    }
    if (event.type === 'agent_unloaded') {
      const reply = this.lastReply.get(agentId);
      this.lastReply.delete(agentId);
      this.finishRun(
        agentId,
        active.timedOut ? 'timed_out' : 'aborted',
        reply?.text ?? '',
        active.timedOut ? 'Timed out and was aborted automatically' : 'Agent was stopped'
      );
      return;
    }
    if (event.type === 'command_error') {
      const reply = this.lastReply.get(agentId);
      this.lastReply.delete(agentId);
      const message = typeof event.message === 'string' ? event.message : 'Agent execution error';
      this.finishRun(agentId, active.timedOut ? 'timed_out' : 'error', reply?.text ?? '', message);
    }
  }

  private finishRun(agentId: string, status: ScheduleRunStatus, output: string, error?: string) {
    const active = this.activeByAgent.get(agentId);
    if (!active) return;
    this.activeByAgent.delete(agentId);
    this.activeByTask.delete(active.taskId);
    const timer = this.runTimeouts.get(agentId);
    if (timer) clearTimeout(timer);
    this.runTimeouts.delete(agentId);
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

    // Archive the completed transient Agent before emitting `run_finished` so connected UIs can
    // reconcile their sidebar list cleanly without leaving a stale card behind.
    void this.archiveTransientAgent(agentId).finally(() => {
      if (task) this.emitRunFinished(task, active.runId);
    });

    if (task) void this.deliverNotification(task, active.runId, status, output, error, outputFile);
  }

  private emitRunFinished(task: ScheduledTask, runId: string) {
    if (this.closed) return;
    try {
      const run = this.getRun(runId);
      this.emitter.emit('event', {
        type: 'run_finished',
        taskId: task.id,
        taskName: task.name,
        run
      } satisfies ScheduleEvent);
    } catch {}
  }

  private async archiveTransientAgent(agentId: string) {
    try {
      // Dispose first so an active dialog or late error state never blocks archiving the transient Agent.
      await this.options.agents.dispose(agentId).catch(() => {});
      const record = await this.options.agents.archive(agentId);
      this.options.metadata.archiveAgent(record);
    } catch {
      /* Ignore if already removed or still winding down. */
    } finally {
      this.scheduledAgents.delete(agentId);
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
    // Timeouts always send mail when MailNotifier is enabled so silent kills never go unnoticed.
    const shouldMail = this.options.mailNotifier && (task.notifyMode === 'mail' || status === 'timed_out');
    if (shouldMail) {
      const label = status === 'timed_out' ? '超时已中止' : status;
      const subject = `[Remote Pi 定时任务] ${task.name} · ${label}`;
      const body = [
        `任务：${task.name} (${task.id})`,
        `运行 ID：${runId}`,
        `状态：${label}`,
        ...(error ? [`说明：${error}`] : []),
        ...(outputFile ? [`归档文件：${outputFile}`] : []),
        '',
        clipSummaryField(output.trim() || '(无文本输出)', 20_000)
      ].join('\n');
      await this.options.mailNotifier!.notifyDirect({subject, text: body, kind: 'schedule'});
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

  private validateInput(input: ScheduleTaskInput, existing?: ScheduledTask) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 120 || /[\r\n]/.test(name))
      throw invalid('name must be a single line of 1-120 characters');
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt || prompt.length > 100_000) throw invalid('prompt is required (up to 100000 chars)');
    const scheduleKind = input.scheduleKind;
    const scheduleExpr = typeof input.scheduleExpr === 'string' ? input.scheduleExpr.trim() : '';
    if (!scheduleExpr) throw invalid('scheduleExpr is required');
    const enabled = input.enabled !== false;
    const nextTrigger = validateScheduleExpression(scheduleKind, scheduleExpr, this.now());
    const scheduleOrEnableChanged =
      !existing ||
      scheduleKind !== existing.scheduleKind ||
      scheduleExpr !== existing.scheduleExpr ||
      (enabled && !existing.enabled);
    if (enabled && scheduleKind === 'once' && scheduleOrEnableChanged && !nextTrigger)
      throw invalid('One-shot scheduleExpr must be a future ISO-8601 date/time');
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
    if (templateId) this.options.templates.snapshot(templateId);
    const timeoutSeconds =
      input.timeoutSeconds === undefined
        ? DEFAULT_SCHEDULE_TIMEOUT_SECONDS
        : Math.trunc(Number(input.timeoutSeconds));
    if (
      !Number.isFinite(timeoutSeconds) ||
      timeoutSeconds < 0 ||
      timeoutSeconds > MAX_SCHEDULE_TIMEOUT_SECONDS
    )
      throw invalid(`timeoutSeconds must be an integer between 0 and ${MAX_SCHEDULE_TIMEOUT_SECONDS}`);
    const notifyMode: ScheduleNotifyMode = input.notifyMode ?? 'none';
    if (!['none', 'mail', 'orchestrator'].includes(notifyMode))
      throw invalid('notifyMode must be none, mail, or orchestrator');
    const notifyOrchestratorId =
      notifyMode === 'orchestrator' &&
      typeof input.notifyOrchestratorId === 'string' &&
      input.notifyOrchestratorId.trim()
        ? input.notifyOrchestratorId.trim()
        : undefined;
    if (notifyMode === 'orchestrator') {
      if (!notifyOrchestratorId)
        throw invalid('notifyOrchestratorId is required when notifyMode is orchestrator');
      // Validate recipient when enabled or changing recipient, while still allowing disabling a task
      // whose previous orchestrator was later archived.
      const recipientChanged = !existing || notifyOrchestratorId !== existing.notifyOrchestratorId;
      if (enabled || recipientChanged) {
        let recipient: AgentRecord;
        try {
          recipient = this.options.agents.get(notifyOrchestratorId).record;
        } catch {
          throw Object.assign(new Error(`Orchestrator agent not found: ${notifyOrchestratorId}`), {
            code: 'AGENT_NOT_FOUND'
          });
        }
        if (recipient.profile !== 'orchestrator')
          throw invalid(`Agent ${notifyOrchestratorId} is not an orchestrator`);
      }
    }
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
      timeoutSeconds,
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
      timeoutSeconds:
        row.timeout_seconds === undefined || row.timeout_seconds === null
          ? DEFAULT_SCHEDULE_TIMEOUT_SECONDS
          : Number(row.timeout_seconds),
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
