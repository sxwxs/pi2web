import type {AgentEvent} from './agents.js';
import type {TimelineEntry} from './timeline.js';

export const PERFORMANCE_ENTRY = 'pi2web.performance.v1';
export type PerformanceSpan = {
  kind: 'model' | 'tool' | 'compaction' | 'retry';
  start: number;
  end: number;
  name?: string;
  toolCallId?: string;
  firstResponse?: number;
  /** Provider-reported output tokens (may include reasoning tokens). */
  outputTokens?: number;
  incomplete?: boolean;
};
export type PerformanceRun = {start: number; end: number; spans: PerformanceSpan[]; incomplete?: boolean};

/** Wall-clock spans, collected on the host running Pi. Parallel tool spans deliberately overlap. */
export class SessionPerformanceTracker {
  private run: {start: number; spans: PerformanceSpan[]; incomplete?: boolean} | null = null;
  private model: PerformanceSpan | null = null;
  private tools = new Map<string, PerformanceSpan>();
  private other: PerformanceSpan | null = null;

  constructor(
    private readonly save: (run: PerformanceRun) => void,
    private readonly now: () => number = Date.now
  ) {}

  private finish(span: PerformanceSpan | null, at: number) {
    if (span) span.end = at;
  }
  private span(kind: PerformanceSpan['kind'], at: number, name?: string): PerformanceSpan {
    const span: PerformanceSpan = {kind, start: at, end: at};
    if (name) span.name = name;
    this.run!.spans.push(span);
    return span;
  }
  apply(event: AgentEvent) {
    const at = this.now(),
      e = event as any;
    if (event.type === 'agent_start' && !this.run) this.run = {start: at, spans: []};
    if (!this.run) return;
    switch (event.type) {
      case 'turn_start':
        if (this.other?.kind === 'retry') {
          this.finish(this.other, at);
          this.other = null;
        }
        this.finish(this.model, at);
        this.model = this.span('model', at);
        break;
      case 'message_update':
        if (this.model && this.model.firstResponse === undefined) this.model.firstResponse = at;
        break;
      case 'message_end':
        if (e.message?.role === 'assistant') {
          if (this.model && Number.isFinite(e.message.usage?.output) && e.message.usage.output >= 0)
            this.model.outputTokens = e.message.usage.output;
          this.finish(this.model, at);
          this.model = null;
        }
        break;
      case 'tool_execution_start':
        if (e.parentToolCallId) break; // nested tools are included in their parent's wall-clock span
        if (this.model) {
          this.finish(this.model, at);
          this.model = null;
        }
        if (e.toolCallId) {
          const span = this.span('tool', at, String(e.toolName ?? 'tool'));
          span.toolCallId = String(e.toolCallId);
          this.tools.set(span.toolCallId, span);
        }
        break;
      case 'tool_execution_end': {
        const span = this.tools.get(String(e.toolCallId));
        if (span) {
          this.finish(span, at);
          this.tools.delete(String(e.toolCallId));
        }
        break;
      }
      case 'compaction_start':
      case 'auto_retry_start':
        this.finish(this.other, at);
        this.other = this.span(event.type === 'compaction_start' ? 'compaction' : 'retry', at);
        break;
      case 'compaction_end':
      case 'auto_retry_end':
        this.finish(this.other, at);
        this.other = null;
        if (event.type === 'auto_retry_end' && e.finalError === 'Retry cancelled') this.run.incomplete = true;
        break;
      case 'agent_end':
        this.finish(this.model, at);
        this.model = null;
        if (e.aborted) this.run.incomplete = true;
        break;
      case 'agent_settled':
        // Unlike agent_end, this also follows post-run compaction or a cancelled retry delay.
        this.finish(this.model, at);
        this.finish(this.other, at);
        for (const span of this.tools.values()) {
          this.finish(span, at);
          span.incomplete = true;
        }
        this.save({
          start: this.run.start,
          end: at,
          spans: this.run.spans,
          ...(this.run.incomplete ? {incomplete: true} : {})
        });
        this.run = null;
        this.model = this.other = null;
        this.tools.clear();
    }
  }
}

/** Current branch only. Earlier sessions have tool timestamps but no model-call spans. */
export function sessionPerformance(entries: TimelineEntry[]) {
  const runs: PerformanceRun[] = [];
  const legacyTools: PerformanceSpan[] = [];
  for (const entry of entries) {
    const e = entry as any;
    if (
      e.type === 'custom' &&
      e.customType === PERFORMANCE_ENTRY &&
      e.data?.spans &&
      Number.isFinite(e.data.start) &&
      Number.isFinite(e.data.end)
    ) {
      runs.push(e.data as PerformanceRun);
    }
  }
  for (const entry of entries) {
    const e = entry as any;
    if (e.type !== 'message' || e.message?.role !== 'toolResult') continue;
    const duration = Number(e.message.durationMs);
    const end = Number(e.message.timestamp) || Date.parse(e.timestamp ?? '');
    if (
      !Number.isFinite(duration) ||
      duration < 0 ||
      !Number.isFinite(end) ||
      runs.some(run => end >= run.start && end <= run.end)
    )
      continue;
    legacyTools.push({kind: 'tool', start: end - duration, end, name: String(e.message.toolName ?? 'tool')});
  }
  return {runs, legacyTools};
}
