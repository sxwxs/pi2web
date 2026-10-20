import {randomUUID} from 'node:crypto';

/**
 * Text that voice clients want placed into a Web UI input box (not sent). Delivered live to every subscribed
 * Web UI and kept as "pending" until some UI acknowledges it, so dictating while no page is open is not lost.
 */
export type DraftMode = 'append' | 'replace';
export type Draft = {id: string; text: string; mode: DraftMode; source?: string; createdAt: string};
type Listener = (draft: Draft, replay: boolean) => void;

export class DraftHub {
  private pending: Draft[] = [];
  private listeners = new Set<Listener>();
  private readonly max = 50;
  private readonly ttlMs = 60 * 60_000;

  /** Returns the stored draft and how many Web UIs were reached right now. */
  add(input: {text: string; mode?: DraftMode; source?: string}): {draft: Draft; delivered: number} {
    this.expire();
    const draft: Draft = {
      id: `draft-${randomUUID()}`,
      text: input.text,
      mode: input.mode ?? 'append',
      source: input.source,
      createdAt: new Date().toISOString()
    };
    this.pending.push(draft);
    while (this.pending.length > this.max) this.pending.shift();
    const delivered = this.listeners.size;
    for (const listener of [...this.listeners]) listener(draft, false);
    return {draft, delivered};
  }
  /** First acknowledgement wins: other tabs that already received it simply keep their copy. */
  ack(id: string) {
    const before = this.pending.length;
    this.pending = this.pending.filter(d => d.id !== id);
    return this.pending.length < before;
  }
  list() {
    this.expire();
    return [...this.pending];
  }
  subscriberCount() {
    return this.listeners.size;
  }
  subscribe(listener: Listener) {
    this.listeners.add(listener);
    for (const draft of this.list()) listener(draft, true);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private expire() {
    const cutoff = Date.now() - this.ttlMs;
    this.pending = this.pending.filter(d => Date.parse(d.createdAt) >= cutoff);
  }
}
