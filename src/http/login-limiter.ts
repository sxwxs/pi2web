type LoginFailure = {count: number; expiresAt: number; lockedUntil: number; lockLevel: number};

/**
 * Rate limits pairing attempts per source address, with an escalating lock after repeated failures.
 * Reverse proxies and tunnels share one bucket by design.
 */
export class LoginLimiter {
  private failures = new Map<string, LoginFailure>();
  private readonly windowMs = 60_000;
  private readonly maxFailures = 10;
  private readonly lockMs = 60_000;
  private readonly maxLockMs = 15 * 60_000;

  /** Milliseconds until `key` may try again; 0 when it is not locked. */
  retryAfterMs(key: string) {
    const entry = this.failures.get(key);
    if (!entry) return 0;
    const now = Date.now();
    if (entry.lockedUntil > now) return entry.lockedUntil - now;
    if (entry.expiresAt <= now) this.failures.delete(key);
    return 0;
  }

  /** Records a failed attempt and returns the lock duration it triggered, or 0. */
  recordFailure(key: string) {
    const now = Date.now();
    if (this.failures.size > 1000)
      for (const [id, value] of this.failures)
        if (value.expiresAt <= now && value.lockedUntil <= now) this.failures.delete(id);
    const entry = this.failures.get(key);
    if (!entry || (entry.expiresAt <= now && entry.lockedUntil <= now)) {
      this.failures.set(key, {count: 1, expiresAt: now + this.windowMs, lockedUntil: 0, lockLevel: 0});
      return 0;
    }
    entry.count += 1;
    entry.expiresAt = now + this.windowMs;
    if (entry.count < this.maxFailures) return 0;
    entry.count = 0;
    entry.lockLevel = Math.min(entry.lockLevel + 1, 5);
    entry.lockedUntil = now + Math.min(this.lockMs * 2 ** (entry.lockLevel - 1), this.maxLockMs);
    entry.expiresAt = entry.lockedUntil + this.windowMs;
    return entry.lockedUntil - now;
  }

  /** A successful login clears the address's failure history. */
  clear(key: string) {
    this.failures.delete(key);
  }

  /** Forgets every address. */
  reset() {
    this.failures.clear();
  }
}
