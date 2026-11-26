import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import type {AgentEvent, AgentManager, AgentRecord} from '../agents.js';
import {assistantText, clipSummaryField} from '../voice.js';

/**
 * One-shot completion watches registered by an orchestrator Agent when it creates, prompts, or
 * explicitly watches a worker Agent.
 *
 * A watch fires once when the watched Agent settles (`agent_settled`), enters `waiting_for_user`
 * (an extension dialog needs human input), errors out, or is unloaded/archived. Multiple watches
 * sharing a `group` wait until every member of that group reaches a terminal outcome before waking
 * the orchestrator once with all results together; an urgent `waiting_for_user` dialog interrupts
 * immediately without consuming the rest of the group so the orchestrator can alert the user.
 */
export type WatchOutcome = 'completed' | 'aborted' | 'paused' | 'error' | 'waiting_for_user' | 'stopped';

export type OrchestratorWatch = {
  id: string;
  orchestratorId: string;
  targetId: string;
  group?: string;
  label?: string;
  createdAt: number;
  /** Latest terminal result recorded for a grouped watch waiting on siblings. */
  settled?: WatchResult;
  /** Whether a `waiting_for_user` notice has already been sent for the current dialog wait. */
  notifiedDialog?: boolean;
};

export type WatchResult = {
  watchId: string;
  targetId: string;
  targetName?: string;
  cwd: string;
  outcome: WatchOutcome;
  group?: string;
  label?: string;
  summary?: string;
  error?: string;
  finishedAt: number;
};

export type WatchView = {
  id: string;
  orchestratorId: string;
  targetId: string;
  targetName?: string;
  targetStatus?: string;
  targetCwd?: string;
  group?: string;
  label?: string;
  createdAt: number;
  settled?: {outcome: WatchOutcome; finishedAt: number};
};

export type OrchestratorHubOptions = {
  agents: AgentManager;
  /** Coalescing delay for ungrouped completions so nearly simultaneous workers wake the orchestrator once. */
  debounceMs?: number;
  /** Fallback flush delay when a watched Agent was already idle or finished without a follow-up event. */
  log?: (message: string) => void;
};

const BUSY_STATUSES = new Set(['starting', 'streaming', 'waiting_for_user', 'stopping']);
const SUMMARY_MAX_CHARS = 3000;

export class OrchestratorHub {
  private emitter = new EventEmitter();
  private watches = new Map<string, OrchestratorWatch>();
  /** Latest assistant output and error for currently watched Agents during their active run. */
  private lastReply = new Map<string, {text: string; error?: string}>();
  /** Pending results waiting for debounce or for the orchestrator to become idle. */
  private pending = new Map<string, WatchResult[]>();
  private deliveryRetries = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private delivering = new Map<string, Promise<void>>();
  private unsubscribe?: () => void;
  private closed = false;
  private readonly debounceMs: number;
  constructor(private readonly options: OrchestratorHubOptions) {
    this.debounceMs = options.debounceMs ?? 1200;
  }

  start() {
    if (this.unsubscribe || this.closed) return;
    this.unsubscribe = this.options.agents.subscribeAll((agentId, published) =>
      this.onAgentEvent(agentId, published.status, published.event)
    );
  }

  async stop() {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled([...this.delivering.values()]);
    this.watches.clear();
    this.pending.clear();
    this.deliveryRetries.clear();
    this.lastReply.clear();
    this.emitter.removeAllListeners();
  }

  /** Wait until scheduled notifications have been delivered (used in tests). */
  async drain() {
    for (let guard = 0; guard < 50 && (this.timers.size || this.delivering.size); guard++) {
      await Promise.allSettled([...this.delivering.values()]);
      if (this.timers.size) await new Promise(resolve => setTimeout(resolve, this.debounceMs + 20));
    }
    await Promise.allSettled([...this.delivering.values()]);
  }

  subscribe(listener: (orchestratorId: string, watches: WatchView[]) => void) {
    this.emitter.on('watches', listener);
    return () => this.emitter.off('watches', listener);
  }

  /** Every active watch grouped by orchestrator, for WebSocket initial sync. */
  all(): Array<[string, WatchView[]]> {
    const byOrchestrator = new Map<string, WatchView[]>();
    for (const watch of this.watches.values()) {
      const list = byOrchestrator.get(watch.orchestratorId) ?? [];
      list.push(this.viewOf(watch));
      byOrchestrator.set(watch.orchestratorId, list);
    }
    return [...byOrchestrator.entries()];
  }

  listFor(orchestratorId: string): WatchView[] {
    const items: WatchView[] = [];
    for (const watch of this.watches.values())
      if (watch.orchestratorId === orchestratorId) items.push(this.viewOf(watch));
    return items.sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Register (or update) a one-shot watch for `targetId` owned by `orchestratorId`. */
  watch(orchestratorId: string, targetId: string, options: {group?: string; label?: string} = {}): WatchView {
    if (orchestratorId === targetId)
      throw Object.assign(new Error('An orchestrator cannot watch itself'), {code: 'INVALID_REQUEST'});
    const orchestrator = this.options.agents.get(orchestratorId).record;
    if (orchestrator.profile !== 'orchestrator')
      throw Object.assign(new Error('Only orchestrator Agents can register completion watches'), {
        code: 'INVALID_REQUEST'
      });
    this.options.agents.get(targetId); // Validates target exists.
    const group = options.group?.trim() || undefined;
    const label = options.label?.trim() || undefined;
    // Deduplicate an existing unsettled watch for the same (orchestrator, target) pair.
    for (const existing of this.watches.values()) {
      if (existing.orchestratorId === orchestratorId && existing.targetId === targetId && !existing.settled) {
        existing.group = group ?? existing.group;
        existing.label = label ?? existing.label;
        existing.notifiedDialog = false;
        this.emitWatches(orchestratorId);
        return this.viewOf(existing);
      }
    }
    const watch: OrchestratorWatch = {
      id: randomUUID(),
      orchestratorId,
      targetId,
      group,
      label,
      createdAt: Date.now()
    };
    this.watches.set(watch.id, watch);
    this.notifyExistingDialogs(watch);
    this.emitWatches(orchestratorId);
    return this.viewOf(watch);
  }

  /** If the target already entered `waiting_for_user` before the watch was added, surface that dialog now. */
  private notifyExistingDialogs(watch: OrchestratorWatch) {
    try {
      const snapshot = this.options.agents.snapshotState(watch.targetId);
      const pendingDialog = snapshot.activity.dialogs[0];
      if (snapshot.status === 'waiting_for_user' && pendingDialog && !watch.notifiedDialog) {
        watch.notifiedDialog = true;
        this.enqueueResult(
          watch.orchestratorId,
          this.buildResult(watch, 'waiting_for_user', undefined, pendingDialog.title)
        );
      }
    } catch {}
  }

  /** Cancel one watch (by watchId or targetId) or all watches for an orchestrator. */
  unwatch(orchestratorId: string, targetOrWatchId?: string): number {
    let removed = 0;
    const removedWatchIds = new Set<string>();
    const removedTargets = new Set<string>();
    for (const [id, watch] of [...this.watches.entries()]) {
      if (watch.orchestratorId !== orchestratorId) continue;
      if (targetOrWatchId && id !== targetOrWatchId && watch.targetId !== targetOrWatchId) continue;
      this.watches.delete(id);
      removedWatchIds.add(id);
      removedTargets.add(watch.targetId);
      removed++;
    }
    if (!targetOrWatchId) {
      this.pending.delete(orchestratorId);
      this.deliveryRetries.delete(orchestratorId);
      const timer = this.timers.get(orchestratorId);
      if (timer) clearTimeout(timer);
      this.timers.delete(orchestratorId);
    } else {
      const queued = this.pending.get(orchestratorId);
      if (queued?.length) {
        const remaining = queued.filter(
          item =>
            !removedWatchIds.has(item.watchId) &&
            item.watchId !== targetOrWatchId &&
            !removedTargets.has(item.targetId) &&
            item.targetId !== targetOrWatchId
        );
        if (remaining.length) this.pending.set(orchestratorId, remaining);
        else this.pending.delete(orchestratorId);
      }
      // Removing a member of a group may unblock the rest of the group if everyone left is already settled.
      this.flushReadyGroups(orchestratorId);
    }
    if (removed) this.emitWatches(orchestratorId);
    return removed;
  }

  /** Clean up watches when an Agent is stopped or archived. */
  handleAgentRemoved(agentId: string) {
    // 1. If the removed Agent was an orchestrator, drop everything it was watching.
    this.unwatch(agentId);
    // 2. If it was being watched, report it as stopped.
    const affected = new Set<string>();
    for (const watch of [...this.watches.values()]) {
      if (watch.targetId !== agentId || watch.settled) continue;
      affected.add(watch.orchestratorId);
      this.recordOutcome(watch, 'stopped', undefined, 'Agent was archived or removed');
    }
    for (const orchestratorId of affected) this.emitWatches(orchestratorId);
  }

  private viewOf(watch: OrchestratorWatch): WatchView {
    const target = this.safeRecord(watch.targetId);
    return {
      id: watch.id,
      orchestratorId: watch.orchestratorId,
      targetId: watch.targetId,
      targetName: target?.sessionName,
      targetStatus: target?.status ?? 'removed',
      targetCwd: target?.cwd,
      group: watch.group,
      label: watch.label,
      createdAt: watch.createdAt,
      ...(watch.settled
        ? {settled: {outcome: watch.settled.outcome, finishedAt: watch.settled.finishedAt}}
        : {})
    };
  }

  private safeRecord(agentId: string): AgentRecord | undefined {
    try {
      return this.options.agents.get(agentId).record;
    } catch {
      return undefined;
    }
  }

  private emitWatches(orchestratorId: string) {
    if (!this.closed) this.emitter.emit('watches', orchestratorId, this.listFor(orchestratorId));
  }

  private onAgentEvent(agentId: string, status: string, event: AgentEvent) {
    if (this.closed) return;

    // When an orchestrator finishes its own turn, its dispatch loop is closed: evaluate any grouped
    // barriers that settled while it was still creating siblings, and deliver queued notices.
    if (event.type === 'agent_settled') {
      const record = this.safeRecord(agentId);
      if (record?.profile === 'orchestrator') {
        this.flushReadyGroups(agentId);
        if (this.pending.get(agentId)?.length) this.scheduleDelivery(agentId, 200);
      }
    }

    // If an orchestrator was unloaded, clear its active watches so background workers don't silently restart it.
    if (event.type === 'agent_unloaded') {
      const record = this.safeRecord(agentId);
      if (record?.profile === 'orchestrator') this.unwatch(agentId);
    }

    // Check if any active watch targets this Agent. Never cache replies for unwatched Agents so
    // completed runs never accumulate in memory.
    const matching = [...this.watches.values()].filter(w => w.targetId === agentId && !w.settled);
    if (
      (event.type === 'agent_settled' || event.type === 'agent_unloaded' || event.type === 'command_error') &&
      !matching.length
    ) {
      this.lastReply.delete(agentId);
      return;
    }
    if (!matching.length) {
      if (event.type === 'agent_start') this.lastReply.delete(agentId);
      return;
    }

    if (event.type === 'agent_start') {
      this.lastReply.delete(agentId);
      return;
    }
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

    if (event.type === 'extension_ui_request') {
      const title = typeof event.title === 'string' ? event.title : String(event.kind ?? 'input required');
      for (const watch of matching) {
        if (watch.notifiedDialog) continue;
        watch.notifiedDialog = true;
        this.enqueueResult(
          watch.orchestratorId,
          this.buildResult(watch, 'waiting_for_user', undefined, title)
        );
      }
      return;
    }
    if (event.type === 'extension_ui_response') {
      for (const watch of matching) watch.notifiedDialog = false;
      return;
    }

    if (event.type === 'agent_settled') {
      this.settleWatched(agentId, {aborted: event.aborted === true, paused: event.paused === true});
      return;
    }

    if (event.type === 'agent_unloaded') {
      this.lastReply.delete(agentId);
      this.completeWatches(matching, 'stopped', undefined, 'Agent was stopped/unloaded');
      return;
    }
    if (event.type === 'command_error') {
      const msg = typeof event.message === 'string' ? event.message : 'Agent execution error';
      this.lastReply.delete(agentId);
      this.completeWatches(matching, 'error', undefined, msg);
    }
  }

  private settleWatched(agentId: string, flags: {aborted: boolean; paused: boolean}) {
    const matching = [...this.watches.values()].filter(w => w.targetId === agentId && !w.settled);
    const reply = this.lastReply.get(agentId);
    this.lastReply.delete(agentId);
    if (!matching.length) return;
    const outcome: WatchOutcome = flags.paused
      ? 'paused'
      : flags.aborted
        ? 'aborted'
        : reply?.error
          ? 'error'
          : 'completed';
    this.completeWatches(matching, outcome, reply?.text, reply?.error);
  }

  private completeWatches(
    matching: OrchestratorWatch[],
    outcome: WatchOutcome,
    summary?: string,
    error?: string
  ) {
    const affected = new Set<string>();
    for (const watch of matching) {
      affected.add(watch.orchestratorId);
      this.recordOutcome(watch, outcome, summary, error);
    }
    for (const orchestratorId of affected) this.emitWatches(orchestratorId);
  }

  private buildResult(
    watch: OrchestratorWatch,
    outcome: WatchOutcome,
    summary?: string,
    error?: string
  ): WatchResult {
    const target = this.safeRecord(watch.targetId);
    return {
      watchId: watch.id,
      targetId: watch.targetId,
      targetName: target?.sessionName,
      cwd: target?.cwd ?? '',
      outcome,
      group: watch.group,
      label: watch.label,
      summary: summary ? clipSummaryField(summary, SUMMARY_MAX_CHARS) : undefined,
      error,
      finishedAt: Date.now()
    };
  }

  private recordOutcome(watch: OrchestratorWatch, outcome: WatchOutcome, summary?: string, error?: string) {
    const result = this.buildResult(watch, outcome, summary, error);
    if (!watch.group) {
      this.watches.delete(watch.id);
      this.enqueueResult(watch.orchestratorId, result);
      return;
    }
    watch.settled = result;
    this.flushReadyGroups(watch.orchestratorId);
  }

  private flushReadyGroups(orchestratorId: string) {
    // Keep group membership open while the orchestrator is still streaming its own turn so a fast
    // worker (e.g. an immediate API error) cannot close the group before sibling watches are added.
    const orchestrator = this.safeRecord(orchestratorId);
    if (orchestrator && BUSY_STATUSES.has(orchestrator.status)) return;
    const groups = new Map<string, OrchestratorWatch[]>();
    for (const watch of this.watches.values()) {
      if (watch.orchestratorId !== orchestratorId || !watch.group) continue;
      const list = groups.get(watch.group) ?? [];
      list.push(watch);
      groups.set(watch.group, list);
    }
    let flushed = false;
    for (const members of groups.values()) {
      if (!members.every(member => member.settled)) continue;
      for (const member of members) {
        this.watches.delete(member.id);
        this.enqueueResult(orchestratorId, member.settled!);
        flushed = true;
      }
    }
    if (flushed) this.emitWatches(orchestratorId);
  }

  private enqueueResult(orchestratorId: string, result: WatchResult) {
    const queue = this.pending.get(orchestratorId) ?? [];
    queue.push(result);
    this.pending.set(orchestratorId, queue);
    this.scheduleDelivery(orchestratorId, this.debounceMs);
  }

  private scheduleDelivery(orchestratorId: string, delayMs: number) {
    if (this.closed) return;
    const existing = this.timers.get(orchestratorId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(orchestratorId);
      void this.enqueueDelivery(orchestratorId);
    }, delayMs);
    timer.unref?.();
    this.timers.set(orchestratorId, timer);
  }

  private enqueueDelivery(orchestratorId: string) {
    const previous = this.delivering.get(orchestratorId) ?? Promise.resolve();
    const job = previous.catch(() => {}).then(() => this.deliver(orchestratorId));
    const tracked = job.finally(() => {
      if (this.delivering.get(orchestratorId) === tracked) this.delivering.delete(orchestratorId);
    });
    this.delivering.set(orchestratorId, tracked);
    return tracked;
  }

  private async deliver(orchestratorId: string) {
    if (this.closed) return;
    const items = this.pending.get(orchestratorId);
    if (!items?.length) return;
    const orchestrator = this.safeRecord(orchestratorId);
    if (!orchestrator || orchestrator.status === 'stopped' || orchestrator.status === 'unloaded') {
      this.pending.delete(orchestratorId);
      return;
    }
    // Wait until the orchestrator finishes its own current turn rather than racing with its active tool loop.
    if (BUSY_STATUSES.has(orchestrator.status)) {
      return;
    }
    const batch = items.splice(0);
    if (!items.length) this.pending.delete(orchestratorId);
    const remaining = this.listFor(orchestratorId);
    const message = formatNotification(batch, remaining);
    try {
      await this.options.agents.submitCommand(orchestratorId, 'prompt', message);
      this.deliveryRetries.delete(orchestratorId);
    } catch (error) {
      const code = (error as {code?: string}).code;
      const errMsg = error instanceof Error ? error.message : String(error);
      const retries = this.deliveryRetries.get(orchestratorId) ?? 0;
      if ((code === 'SESSION_BUSY' || code === 'AGENT_BUSY') && retries < 3) {
        this.deliveryRetries.set(orchestratorId, retries + 1);
        const current = this.pending.get(orchestratorId) ?? [];
        this.pending.set(orchestratorId, [...batch, ...current]);
        this.scheduleDelivery(orchestratorId, Math.max(this.debounceMs, 500));
        return;
      }
      this.deliveryRetries.delete(orchestratorId);
      this.options.log?.(`Orchestrator notification delivery to ${orchestratorId} failed: ${errMsg}`);
      this.options.agents.notify(
        orchestratorId,
        `子 Agent 完成通知未能自动送达（${batch.map(b => b.targetName || b.targetId).join(', ')}）：${errMsg}`,
        'error'
      );
    }
  }
}

function formatNotification(results: WatchResult[], remaining: WatchView[]): string {
  const lines: string[] = [
    '[pi2web completion notification]',
    `The following watched agent(s) reached a reportable state (${results.length}):`
  ];
  for (const item of results) {
    const title = [item.targetName || item.targetId, item.label ? `(${item.label})` : '']
      .filter(Boolean)
      .join(' ');
    const groupPart = item.group ? ` | group: ${item.group}` : '';
    lines.push(
      '',
      `### ${title}`,
      `- agentId: ${item.targetId}`,
      `- outcome: ${item.outcome}${groupPart}`,
      ...(item.cwd ? [`- cwd: ${item.cwd}`] : []),
      ...(item.error ? [`- detail: ${item.error}`] : [])
    );
    if (item.summary) {
      lines.push(
        '- final reply (truncated if long; use pi2web_read_session for full details):',
        '```',
        item.summary,
        '```'
      );
    } else if (item.outcome === 'completed') {
      lines.push('- final reply: (no text output; use pi2web_read_session to inspect tool activity)');
    }
  }
  if (remaining.length) {
    lines.push('', `Still watched (${remaining.length}):`);
    for (const watch of remaining) {
      const state = watch.settled
        ? `settled:${watch.settled.outcome} (waiting for group ${watch.group})`
        : watch.targetStatus || 'unknown';
      lines.push(
        `- ${watch.targetName || watch.targetId} [${watch.targetId}] · ${state}${watch.group ? ` · group=${watch.group}` : ''}`
      );
    }
  } else {
    lines.push('', 'No other watched agents remain.');
  }
  return lines.join('\n');
}
