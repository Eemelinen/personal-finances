import { localDate } from "@/server/dates";
import type { IsoDate } from "@/server/providers/types";

// Notifications through ntfy (F-024): the worker sends a message when an
// issue needs the user (a connection failing its syncs, a consent ending or
// ended). Each issue has a stable key, and a key is sent at most once per
// calendar day (`APP_TIMEZONE`): the store claims the (key, day) before the
// message is sent and gives the claim back if sending fails, so the next
// check retries. Without `NTFY_URL` the notifier is disabled and does
// nothing. Messages name the bank and the problem, never amounts or account
// details: the ntfy server is a third party.

export interface Issue {
  /** Stable per issue, e.g. `consent-expiring:<connection id>`. */
  key: string;
  title: string;
  message: string;
  /** ntfy priority; `default` when unset. */
  priority?: "default" | "high";
  /** ntfy tags (emoji short codes or labels). */
  tags?: string[];
}

/** Which issues have been sent on which day. */
export interface NotificationStore {
  /** True if `issue` had not been claimed for `day` and now is. */
  claim(issue: string, day: IsoDate): Promise<boolean>;
  /** Gives a claim back, after a failed send. */
  release(issue: string, day: IsoDate): Promise<void>;
}

export interface NotifyResult {
  sent: string[];
  /** Already sent today. */
  skipped: string[];
  failed: { key: string; error: string }[];
}

export interface Notifier {
  enabled: boolean;
  notify(issues: readonly Issue[]): Promise<NotifyResult>;
}

export interface NotifierOptions {
  /** The ntfy topic URL; unset disables the notifier. */
  url: string | undefined;
  /** An ntfy access token, for a protected topic. */
  token?: string;
  store: NotificationStore;
  timeZone: string;
  now?: () => Date;
  fetch?: typeof fetch;
}

/** How long one publish may take. */
const SEND_TIMEOUT_MS = 10_000;

export function createNotifier(options: NotifierOptions): Notifier {
  const { url } = options;
  if (!url) {
    return {
      enabled: false,
      notify: async () => ({ sent: [], skipped: [], failed: [] }),
    };
  }
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetch ?? fetch;

  async function send(issue: Issue): Promise<void> {
    // Title, priority and tags as query parameters rather than headers:
    // header values must be ASCII, bank names need not be.
    const target = new URL(url!);
    target.searchParams.set("title", issue.title);
    target.searchParams.set("priority", issue.priority ?? "default");
    if (issue.tags?.length)
      target.searchParams.set("tags", issue.tags.join(","));
    const response = await fetchImpl(target, {
      method: "POST",
      body: issue.message,
      headers: options.token
        ? { Authorization: `Bearer ${options.token}` }
        : undefined,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(
        `ntfy answered ${response.status} ${response.statusText}`,
      );
    }
  }

  return {
    enabled: true,
    async notify(issues) {
      const day = localDate(now(), options.timeZone);
      const result: NotifyResult = { sent: [], skipped: [], failed: [] };
      for (const issue of issues) {
        if (!(await options.store.claim(issue.key, day))) {
          result.skipped.push(issue.key);
          continue;
        }
        try {
          await send(issue);
          result.sent.push(issue.key);
        } catch (error) {
          await options.store.release(issue.key, day);
          result.failed.push({
            key: issue.key,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
    },
  };
}

/** A store in memory, for tests and one-off runs. */
export function memoryNotificationStore(): NotificationStore {
  const claimed = new Set<string>();
  const id = (issue: string, day: IsoDate) => `${day} ${issue}`;
  return {
    async claim(issue, day) {
      if (claimed.has(id(issue, day))) return false;
      claimed.add(id(issue, day));
      return true;
    },
    async release(issue, day) {
      claimed.delete(id(issue, day));
    },
  };
}
