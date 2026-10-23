/**
 * In-memory backoff for the login form. The first `freeAttempts` consecutive
 * failures cost nothing; after that every attempt has to wait an exponentially
 * growing delay (1 s, 2 s, 4 s, … up to `maxDelayMs`) after the previous
 * failure. A successful login resets it. It is global rather than per client
 * because there is one account to protect, and a process restart clears it.
 */
export type LoginThrottleOptions = {
  freeAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export class LoginThrottle {
  readonly #freeAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  #failures = 0;
  #lastFailureAt = 0;

  constructor({
    freeAttempts = 5,
    baseDelayMs = 1000,
    maxDelayMs = 15 * 60 * 1000,
  }: LoginThrottleOptions = {}) {
    this.#freeAttempts = freeAttempts;
    this.#baseDelayMs = baseDelayMs;
    this.#maxDelayMs = maxDelayMs;
  }

  get failures(): number {
    return this.#failures;
  }

  /** Milliseconds until the next attempt is allowed; 0 when it is allowed now. */
  retryAfterMs(now: number): number {
    const excess = this.#failures - this.#freeAttempts;
    if (excess < 0) return 0;
    const delay = Math.min(this.#baseDelayMs * 2 ** excess, this.#maxDelayMs);
    return Math.max(0, this.#lastFailureAt + delay - now);
  }

  recordFailure(now: number): void {
    this.#failures += 1;
    this.#lastFailureAt = now;
  }

  recordSuccess(): void {
    this.#failures = 0;
    this.#lastFailureAt = 0;
  }
}
