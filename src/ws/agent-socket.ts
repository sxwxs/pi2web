import {WebSocket} from 'ws';
import type {AgentManager} from '../agents.js';
import type {DetailMessage} from '../agent-feed.js';
import type {CollabHub} from '../collab/hub.js';
import type {DraftHub} from '../drafts.js';
import type {SessionNamer} from '../session-namer.js';
import type {VoiceManager} from '../voice.js';

export type AgentSocketContext = {
  agents: AgentManager;
  drafts: DraftHub;
  collab: CollabHub;
  voice?: VoiceManager;
  sessionNamer?: SessionNamer;
  /** Every open socket, so the server can count and close them. */
  clients: Set<WebSocket>;
};

export const PROTOCOL_VERSION = 2;

/**
 * Events every client sees for every Agent: what it is doing, not what it produced.
 * Transcript content reaches only clients viewing the Agent (`focus`), as timeline items.
 */
const OVERVIEW_EVENTS = new Set([
  'agent_start',
  'agent_end',
  'agent_settled',
  'activity_changed',
  'queue_update',
  'session_info_changed',
  'agent_unloaded',
  'agent_loaded',
  'auto_retry_start',
  'auto_retry_end',
  'summarization_retry_scheduled',
  'summarization_retry_attempt_start',
  'summarization_retry_finished',
  'extension_ui_request',
  'extension_ui_response',
  'extension_ui_notify',
  'extension_ui_status',
  'extension_ui_widget',
  'extension_ui_title',
  'extension_ui_working_message'
]);

/** Delay before sending streamed text or tool output, so one frame carries many updates. */
const BATCH_WINDOW_MS = 100;

/**
 * Serves `/api/v1/ws`.
 * - `subscribe_all`: the state of every Agent, then their overview events.
 * - `focus {agentId, limit}`: a snapshot of the Agent being viewed (newest timeline page, streamed
 *   text, dialogs), then in order on this socket: streamed text, appended items, user shell output.
 * - `watch`/`unwatch {toolCallId}`: output of a running tool the client has expanded.
 * Nothing is replayed: on (re)connect a client gets current state again. HTTP serves only what
 * never changes: older timeline pages and item bodies.
 */
export function handleAgentSocket(ctx: AgentSocketContext, ws: WebSocket) {
  ctx.clients.add(ws);
  const subscriptions = new Map<string, () => void>();
  let focused: string | undefined;
  /** Running tools whose card this client has expanded. */
  const watched = new Set<string>();
  // Providers emit one delta per token, and tools report their whole output so far on every update.
  // Both wait for a short window: adjacent deltas merge, and only a tool's latest output is sent.
  let pendingDelta: {type: 'delta'; agentId: string; kind: string; delta: string} | undefined,
    batchTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingOutputs = new Map<string, {agentId: string; output: string}>();
  const sendNow = (message: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) {
      ws.close(1013, 'Agent client is too slow');
      return;
    }
    ws.send(JSON.stringify(message));
  };
  const flushBatch = () => {
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = undefined;
    if (pendingDelta) {
      const message = pendingDelta;
      pendingDelta = undefined;
      sendNow(message);
    }
    for (const [toolCallId, {agentId, output}] of pendingOutputs)
      if (watched.has(toolCallId)) sendNow({type: 'tool_output', agentId, toolCallId, output});
    pendingOutputs.clear();
  };
  const scheduleBatch = () => {
    if (!batchTimer) batchTimer = setTimeout(flushBatch, BATCH_WINDOW_MS);
  };
  /** Everything goes through here so a held delta or output is never overtaken by a later message. */
  const send = (message: any) => {
    if (message?.type !== 'delta') {
      flushBatch();
      sendNow(message);
      return;
    }
    if (pendingDelta && pendingDelta.agentId === message.agentId && pendingDelta.kind === message.kind)
      pendingDelta.delta += message.delta;
    else {
      flushBatch();
      pendingDelta = {...message};
    }
    scheduleBatch();
  };
  const forwardDetail = (agentId: string, message: DetailMessage) => {
    if (message.type === 'tool_output') {
      if (!watched.has(message.toolCallId)) return;
      pendingOutputs.set(message.toolCallId, {agentId, output: message.output});
      scheduleBatch();
    } else if (message.type === 'event')
      send({
        type: 'agent_event',
        agentId,
        timestamp: Date.now(),
        status: ctx.agents.get(agentId).record.status,
        event: message.event
      });
    else send({...message, agentId});
  };
  let focusRequest = 0;
  const unfocus = () => {
    focusRequest++;
    subscriptions.get('focus')?.();
    subscriptions.delete('focus');
    focused = undefined;
    watched.clear();
    pendingOutputs.clear();
  };
  const unsubscribeVoice = ctx.voice?.subscribe((agentId, event) => {
    if (subscriptions.has('*')) send({type: 'voice_event', agentId, event});
  });
  const unsubscribeNamer = ctx.sessionNamer?.subscribe((agentId, event) => {
    if (subscriptions.has('*')) send({type: 'session_namer_event', agentId, event});
  });
  ws.on('close', () => {
    if (batchTimer) clearTimeout(batchTimer);
    pendingDelta = undefined;
    pendingOutputs.clear();
    ctx.clients.delete(ws);
    unsubscribeVoice?.();
    unsubscribeNamer?.();
    for (const unsubscribe of subscriptions.values()) unsubscribe();
  });
  ws.on('message', raw => {
    void (async () => {
      let m: any;
      try {
        m = JSON.parse(raw.toString());
        if (m.type === 'subscribe_drafts') {
          subscriptions.get('drafts')?.();
          send({type: 'subscribed_drafts', protocolVersion: 1});
          subscriptions.set(
            'drafts',
            ctx.drafts.subscribe((draft, replay) => send({type: 'draft_event', draft, replay}))
          );
          return;
        }
        if (m.type === 'draft_ack') {
          ctx.drafts.ack(String(m.id ?? ''));
          return;
        }
        if (m.type === 'subscribe_collab') {
          subscriptions.get('collab')?.();
          subscriptions.set(
            'collab',
            ctx.collab.subscribe(event => send({type: 'collab_event', event}))
          );
          send({type: 'subscribed_collab', protocolVersion: 1});
          return;
        }
        if (m.type === 'subscribe_all') {
          subscriptions.get('*')?.();
          // State first: events that follow are then always newer than what the client holds.
          for (const agent of ctx.agents.list())
            send({
              type: 'agent_state',
              agentId: agent.agentId,
              state: ctx.agents.snapshotState(agent.agentId)
            });
          subscriptions.set(
            '*',
            ctx.agents.subscribeAll((agentId, e) => {
              if (OVERVIEW_EVENTS.has(e.event.type))
                send({
                  type: 'agent_event',
                  agentId,
                  timestamp: e.timestamp,
                  status: e.status,
                  event: e.event
                });
            })
          );
          // serverTime lets clients correct clock skew when showing how long an activity has been running.
          send({type: 'subscribed_all', protocolVersion: PROTOCOL_VERSION, serverTime: Date.now()});
          return;
        }
        if (m.type === 'focus') {
          unfocus();
          if (m.agentId === null || m.agentId === undefined) return;
          const agentId = String(m.agentId),
            request = focusRequest;
          // Messages emitted while the snapshot is being sent wait for it; they are all newer.
          let held: DetailMessage[] | undefined = [];
          const focus = await ctx.agents
            .focus(agentId, message => (held ? held.push(message) : forwardDetail(agentId, message)), m.limit)
            .catch(error => {
              if (request === focusRequest)
                send({type: 'focus_error', agentId, error: {code: error.code, message: error.message}});
            });
          if (!focus) return;
          if (request !== focusRequest) return focus.unsubscribe(); // Focus moved on while loading.
          focused = agentId;
          subscriptions.set('focus', focus.unsubscribe);
          send({type: 'focus_state', agentId, ...focus.snapshot});
          const pending = held;
          held = undefined;
          for (const message of pending) forwardDetail(agentId, message);
          return;
        }
        if (m.type === 'watch' || m.type === 'unwatch') {
          const toolCallId = String(m.toolCallId ?? '');
          if (m.type === 'unwatch') {
            watched.delete(toolCallId);
            pendingOutputs.delete(toolCallId);
          } else if (focused && toolCallId) {
            watched.add(toolCallId);
            const output = ctx.agents.toolOutput(focused, toolCallId);
            if (output !== undefined) send({type: 'tool_output', agentId: focused, toolCallId, output});
          }
          return;
        }
        if (['prompt', 'steer', 'follow-up', 'abort'].includes(m.type)) {
          if (m.type !== 'abort') {
            ctx.voice?.recordUserPrompt(m.agentId, String(m.message ?? ''));
            ctx.sessionNamer?.recordUserPrompt(m.agentId, String(m.message ?? ''));
          }
          const disposition = await ctx.agents.command(m.agentId, m.type, m.message);
          send({type: 'command_result', requestId: m.requestId, success: true, disposition});
          return;
        }
        if (m.type === 'clear-queue') {
          send({
            type: 'command_result',
            requestId: m.requestId,
            success: true,
            queue: await ctx.agents.clearQueue(m.agentId)
          });
          return;
        }
        throw new Error('Unknown command');
      } catch (e) {
        send({
          type: 'command_result',
          requestId: m?.requestId,
          success: false,
          error: {
            code: (e as any).code ?? 'BAD_REQUEST',
            message: e instanceof SyntaxError ? 'Invalid JSON' : (e as Error).message
          }
        });
      }
    })();
  });
}
