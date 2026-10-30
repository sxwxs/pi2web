import type {AgentTurnDecision} from '@earendil-works/pi-agent-core';
import type {AgentSession} from '@earendil-works/pi-coding-agent';

/**
 * Safe pause progress, published as `safe_pause` events:
 * - `requested`: the run will stop before its next model request;
 * - `reached`: a model request was withheld, the run is winding down and can no longer be resumed;
 * - `paused`: the run settled at the safe point;
 * - `cancelled`: the request was withdrawn before it was reached;
 * - `finished`: the run ended on its own (final answer, abort, error) before reaching a safe point.
 */
export type SafePauseState = 'requested' | 'reached' | 'paused' | 'cancelled' | 'finished';

const error = (message: string, code: string) => Object.assign(new Error(message), {code});

/**
 * Stops a Pi session before the conversation advances: no further model response or tool call
 * once the pause is reached. Tools that are running finish and their results are recorded first,
 * so the transcript ends with tool results (or the user's message) and nothing is lost.
 *
 * A Pi run asks the model again through exactly two entries, and each one is gated:
 * - Gate A, the agent loop's `finishTurn`: the next turn inside the loop.
 * - Gate B, `agent.continue()`: every continuation the session's run controller starts after the
 *   loop ends, i.e. auto-retry, overflow-compaction retry, queued messages and extension
 *   `agent_before_settle` continuations.
 * Neither gate depends on event timing. Housekeeping model calls that do not advance the
 * conversation (compaction summaries, prompt-cache warming) are not gated.
 */
export class SafePause {
  private state: 'none' | 'requested' | 'reached' = 'none';
  /** Set for the agent_settled of a run that ended at the safe point. */
  private settledPaused = false;

  constructor(
    private readonly session: AgentSession,
    private readonly emit: (state: SafePauseState) => void
  ) {
    const agent = session.agent;
    // Gate A. AgentSession installed its own finishTurn (extension turn_end boundaries); run it first.
    const finishTurn = agent.finishTurn;
    agent.finishTurn = async (turn, signal): Promise<AgentTurnDecision | undefined> => {
      const decision = (await finishTurn?.(turn, signal)) ?? undefined;
      if (this.state === 'none' || decision?.action === 'end') return decision;
      // An error or aborted turn ends the loop anyway; a retry has to pass gate B.
      if (turn.message.stopReason === 'error' || turn.message.stopReason === 'aborted') return decision;
      // A final answer with nothing queued and no continuation request ends the loop by itself.
      const wouldContinue =
        turn.toolResults.length > 0 || decision?.action === 'continue' || agent.hasQueuedMessages();
      if (!wouldContinue) return decision;
      this.reach();
      return {action: 'end'};
    };
    // Gate B. The run controller calls agent.continue() only after the previous loop has fully
    // ended, so no request is in flight and no tool is running here. Instead of continuing, ask
    // the session to stop its run: abort() first sets the controller's stop flag synchronously,
    // which ends the run before another request. Queued messages stay queued for the next prompt.
    const resume = agent.continue.bind(agent);
    agent.continue = async () => {
      if (this.state === 'none') return resume();
      this.reach();
      // abort() waits for the run to settle, which happens only after this call returns.
      void session.abort().catch(() => {});
    };
    session.subscribe(event => {
      if (event.type !== 'agent_settled') {
        this.settledPaused = false;
        return;
      }
      const state = this.state;
      this.state = 'none';
      this.settledPaused = state === 'reached';
      if (state === 'reached') this.emit('paused');
      else if (state === 'requested') this.emit('finished');
    });
  }

  /** Whether the agent_settled being delivered ends a run that stopped at the safe point. */
  get pausedRunSettled() {
    return this.settledPaused;
  }

  async request() {
    if (!this.session.isStreaming) throw error('Agent is not running', 'AGENT_NOT_RUNNING');
    if (this.state !== 'none') return;
    this.state = 'requested';
    this.emit('requested');
    // During a retry backoff the next step is the retried model request. isRetrying means Pi has
    // created the retry's abort controller, so cancelling it now takes effect; the run then winds
    // down through the controller, and any continuation it still attempts meets gate B.
    if (this.session.isRetrying) {
      this.reach();
      this.session.abortRetry();
    }
  }

  async cancel() {
    if (this.state === 'reached')
      throw error('The run has already stopped at the safe point', 'PAUSE_ALREADY_REACHED');
    if (this.state !== 'requested') return;
    this.state = 'none';
    this.emit('cancelled');
  }

  private reach() {
    if (this.state === 'reached') return;
    this.state = 'reached';
    this.emit('reached');
  }
}
