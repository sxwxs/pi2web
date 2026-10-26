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

/** Delay before sending streamed text, so one frame carries many tokens. */
const DELTA_WINDOW_MS = 100;

/**
 * Serves `/api/v1/ws`.
 * - `subscribe_all`: the state of every Agent, then their overview events.
 * - `focus {agentId}`: streamed text, timeline changes and user shell output of the Agent being viewed.
 * - `watch`/`unwatch {toolCallId}`: live output of a running tool the client has expanded.
 * Nothing is replayed: on (re)connect a client gets current state here and the timeline over HTTP.
 */
export function handleAgentSocket(ctx: AgentSocketContext, ws: WebSocket) {
  ctx.clients.add(ws);
  const subscriptions = new Map<string, () => void>();
  let focused: string | undefined;
  const watched = new Set<string>();
  // Providers emit one delta per token. Coalesce adjacent deltas of the same kind into one frame.
  let pendingDelta: {type: 'delta'; agentId: string; kind: string; delta: string} | undefined,
    deltaTimer: ReturnType<typeof setTimeout> | undefined;
  const sendNow = (message: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 2 * 1024 * 1024) {
      ws.close(1013, 'Agent client is too slow');
      return;
    }
    ws.send(JSON.stringify(message));
  };
  const flushDelta = () => {
    if (deltaTimer) clearTimeout(deltaTimer);
    deltaTimer = undefined;
    if (pendingDelta) {
      const message = pendingDelta;
      pendingDelta = undefined;
      sendNow(message);
    }
  };
  /** Everything goes through here so a coalesced delta is never overtaken by a later message. */
  const send = (message: any) => {
    if (message?.type !== 'delta') {
      flushDelta();
      sendNow(message);
      return;
    }
    if (pendingDelta && pendingDelta.agentId === message.agentId && pendingDelta.kind === message.kind)
      pendingDelta.delta += message.delta;
    else {
      flushDelta();
      pendingDelta = {...message};
    }
    if (!deltaTimer) deltaTimer = setTimeout(flushDelta, DELTA_WINDOW_MS);
  };
  const forwardDetail = (agentId: string, message: DetailMessage) => {
    if (message.type === 'tool_output') {
      if (watched.has(message.toolCallId)) send({...message, agentId});
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
  const unfocus = () => {
    subscriptions.get('focus')?.();
    subscriptions.delete('focus');
    focused = undefined;
    watched.clear();
  };
  const unsubscribeVoice = ctx.voice?.subscribe((agentId, event) => {
    if (subscriptions.has('*')) send({type: 'voice_event', agentId, event});
  });
  const unsubscribeNamer = ctx.sessionNamer?.subscribe((agentId, event) => {
    if (subscriptions.has('*')) send({type: 'session_namer_event', agentId, event});
  });
  ws.on('close', () => {
    if (deltaTimer) clearTimeout(deltaTimer);
    pendingDelta = undefined;
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
          const agentId = String(m.agentId);
          ctx.agents.get(agentId);
          focused = agentId;
          subscriptions.set(
            'focus',
            ctx.agents.subscribeDetail(agentId, message => forwardDetail(agentId, message))
          );
          send({type: 'focus_state', agentId, ...ctx.agents.detailState(agentId)});
          return;
        }
        if (m.type === 'watch' || m.type === 'unwatch') {
          const toolCallId = String(m.toolCallId ?? '');
          if (m.type === 'unwatch') watched.delete(toolCallId);
          else if (focused && toolCallId) {
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
