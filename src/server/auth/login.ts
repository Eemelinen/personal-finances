import { LoginThrottle } from "./login-throttle";

export type LoginResult = { ok: true } | { ok: false; error: string };

export type LoginCheckerOptions = {
  /** Checks a password against the stored hash (argon2 in the app). */
  verify: (password: string) => Promise<boolean>;
  throttle?: LoginThrottle;
  now?: () => number;
  onFailure?: (failures: number) => void;
};

/**
 * The password check behind the login form, with the backoff applied. A
 * refused attempt neither runs the (slow) hash check nor counts as a failure.
 * Attempts run one at a time, so parallel requests cannot all slip in before
 * the earlier failures are counted.
 */
export function createLoginChecker({
  verify,
  throttle = new LoginThrottle(),
  now = Date.now,
  onFailure,
}: LoginCheckerOptions): (password: string) => Promise<LoginResult> {
  let queue: Promise<unknown> = Promise.resolve();

  async function check(password: string): Promise<LoginResult> {
    const waitMs = throttle.retryAfterMs(now());
    if (waitMs > 0) {
      return {
        ok: false,
        error: `Too many failed attempts. Try again in ${Math.ceil(waitMs / 1000)} s.`,
      };
    }
    if (await verify(password)) {
      throttle.recordSuccess();
      return { ok: true };
    }
    throttle.recordFailure(now());
    onFailure?.(throttle.failures);
    return { ok: false, error: "Wrong password." };
  }

  return (password) => {
    const attempt = queue.then(() => check(password));
    queue = attempt.catch(() => undefined);
    return attempt;
  };
}
