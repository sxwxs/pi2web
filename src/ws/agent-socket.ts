import {WebSocket} from 'ws';
import type {AgentManager} from '../agents.js';
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

/** Serves `/api/v1/ws`: Agent event subscriptions with replay, commands, drafts and collab events. */
export function handleAgentSocket(ctx: AgentSocketContext, ws: WebSocket) {
  ctx.clients.add(ws);
  const subscriptions = new Map<string, () => void>();
  // Pi providers may emit one delta per token. Events are already slimmed to bare
  // deltas (see slimEvent), but one frame per token still floods high-latency links:
  // agent_end gets stuck behind thousands of tiny frames. Coalesce adjacent
  // text/thinking deltas while preserving their sequence cursor and event order.
  let pendingDelta: any, deltaTimer: ReturnType<typeof setTimeout> | undefined;
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
  const send = (message: any) => {
    const update =
        message?.type === 'agent_event' && message.event?.type === 'message_update'
          ? message.event.assistantMessageEvent
          : undefined,
      isDelta =
        update &&
        (update.type === 'text_delta' || update.type === 'thinking_delta') &&
        typeof update.delta === 'string';
    if (!isDelta) {
      flushDelta();
      sendNow(message);
      return;
    }
    const previous = pendingDelta?.event?.assistantMessageEvent;
    if (pendingDelta && pendingDelta.agentId === message.agentId && previous?.type === update.type) {
      previous.delta += update.delta;
      pendingDelta.eventId = message.eventId;
      pendingDelta.sequence = message.sequence;
      pendingDelta.timestamp = message.timestamp;
    } else {
      flushDelta();
      pendingDelta = {...message, event: {...message.event, assistantMessageEvent: {...update}}};
    }
    if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 40);
  };
  const unsubscribeVoice = ctx.voice?.subscribe((agentId, event) => {
    if (subscriptions.has('*') || subscriptions.has(agentId)) send({type: 'voice_event', agentId, event});
  });
  const unsubscribeNamer = ctx.sessionNamer?.subscribe((agentId, event) => {
    if (subscriptions.has('*') || subscriptions.has(agentId))
      send({type: 'session_namer_event', agentId, event});
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
          const forward = (agentId: string, e: any) =>
            !subscriptions.has(agentId) &&
            send({
              type: 'agent_event',
              agentId,
              eventId: e.id,
              sequence: e.sequence,
              timestamp: e.timestamp,
              status: e.status,
              event: e.event
            });
          subscriptions.set('*', ctx.agents.subscribeAll(forward));
          send({type: 'subscribed_all', protocolVersion: 1});
          return;
        }
        if (m.type === 'subscribe') {
          const agentId = m.agentId,
            fromNow = m.fromNow === true;
          subscriptions.get(agentId)?.();
          const forward = (e: any) =>
            send({
              type: 'agent_event',
              agentId,
              eventId: e.id,
              sequence: e.sequence,
              timestamp: e.timestamp,
              status: e.status,
              event: e.event
            });
          let ready = false,
            active = true;
          const unsubscribe = ctx.agents.subscribe(agentId, e => {
            if (ready) forward(e);
          });
          const stop = () => {
            active = false;
            ready = false;
            unsubscribe();
          };
          subscriptions.set(agentId, stop);
          try {
            send({
              type: 'subscribed',
              agentId,
              protocolVersion: 1,
              currentSequence: ctx.agents.currentSequence(agentId)
            });
            if (!fromNow) {
              const last = Number(m.lastSequence ?? 0),
                replay = ctx.agents.events(agentId, last);
              if (ctx.agents.hasReplayGap(agentId, last) || replay.length > 250) {
                const messageLimit = m.messageLimit === undefined ? undefined : Number(m.messageLimit);
                const snapshot = await ctx.agents.snapshot(
                  agentId,
                  Number.isFinite(messageLimit) ? messageLimit : undefined
                );
                if (!active) return; // Closed or replaced by a newer subscription while awaiting messages.
                // Do not forward live events ahead of the snapshot. Catch up from the
                // existing bounded replay cache instead of maintaining another buffer.
                const updates = ctx.agents.events(agentId, snapshot.lastSequence);
                if (
                  ctx.agents.hasReplayGap(agentId, snapshot.lastSequence) ||
                  (updates.length && updates[0].sequence !== snapshot.lastSequence + 1)
                ) {
                  stop();
                  ws.close(1013, 'Replay gap during snapshot');
                  return;
                }
                send({type: 'agent_snapshot', agentId, ...snapshot});
                for (const event of updates) forward(event);
              } else for (const event of replay) forward(event);
            }
            // Refresh/reconnect may already have a saved cursor but no in-memory
            // activity. Send the current IDs after replay, even if replay was empty.
            send({
              type: 'agent_state',
              agentId,
              sequence: ctx.agents.currentSequence(agentId),
              state: ctx.agents.snapshotState(agentId)
            });
            ready = true;
          } catch (error) {
            if (!active) return;
            stop();
            if (subscriptions.get(agentId) === stop) subscriptions.delete(agentId);
            throw error;
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
