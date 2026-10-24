import { createPrivateKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";
import type { z } from "zod";
import type { Env } from "@/server/env";
import {
  parseRetryAfter,
  ProviderAuthError,
  type ProviderError,
  providerErrorFromStatus,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "../errors";
import {
  accountSchema,
  aspspsResponseSchema,
  authResponseSchema,
  balancesResponseSchema,
  createSessionResponseSchema,
  errorResponseSchema,
  sessionResponseSchema,
  transactionsResponseSchema,
  type Aspsp,
  type CreatedSession,
  type EnableBankingAccount,
  type EnableBankingBalance,
  type EnableBankingSession,
  type EnableBankingTransactionPage,
} from "./schemas";

// A typed client for the Enable Banking REST API (F-006): the application
// JWT, the authorisation flow (`/aspsps`, `/auth`, `/sessions`) and the
// read-only account endpoints. Every response is validated with zod; 429
// and 5xx responses and network failures are retried with a backoff, then
// mapped to the typed provider errors. Nothing here logs, and error messages
// name paths with their ids replaced (`/accounts/{uid}/balances`), so the
// JWT, session ids and IBANs never reach a log through it.

const PROVIDER_ID = "enable_banking";
/** Sandbox and production share the API; the application decides. */
export const ENABLE_BANKING_API_URL = "https://api.enablebanking.com";

export const JWT_ISSUER = "enablebanking.com";
export const JWT_AUDIENCE = "api.enablebanking.com";
/** Lifetime of an application JWT (Enable Banking allows up to a day). */
export const JWT_TTL_SECONDS = 3600;
/** A cached JWT is replaced this long before it expires. */
const JWT_RENEW_BEFORE_SECONDS = 300;

/** Attempts per request, the first included. */
export const DEFAULT_MAX_ATTEMPTS = 3;
/** First retry delay; doubled for each further one. */
const BASE_RETRY_DELAY_MS = 1_000;
/** A longer `Retry-After` is not waited for: the error goes to the caller. */
const MAX_RETRY_DELAY_MS = 30_000;

export type EnableBankingEnvironment = "sandbox" | "production";

export interface EnableBankingConfig {
  /** The application id, sent as the JWT's `kid`. */
  appId: string;
  /** The application's RSA private key. */
  privateKey: KeyObject;
  /** Where the bank sends the user back after authorising. */
  redirectUrl?: string;
  environment: EnableBankingEnvironment;
}

type EnableBankingEnv = Pick<
  Env,
  | "ENABLE_BANKING_APP_ID"
  | "ENABLE_BANKING_PRIVATE_KEY_PATH"
  | "ENABLE_BANKING_REDIRECT_URL"
  | "ENABLE_BANKING_ENV"
>;

/** The configuration from `ENABLE_BANKING_*`; reads the key file. */
export function enableBankingConfigFromEnv(
  env: EnableBankingEnv,
): EnableBankingConfig {
  const appId = env.ENABLE_BANKING_APP_ID;
  const keyPath = env.ENABLE_BANKING_PRIVATE_KEY_PATH;
  if (!appId || !keyPath) {
    throw new Error(
      "Enable Banking is not configured: set ENABLE_BANKING_APP_ID and ENABLE_BANKING_PRIVATE_KEY_PATH",
    );
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFileSync(keyPath));
  } catch (error) {
    throw new Error(
      `Cannot read the Enable Banking private key from ENABLE_BANKING_PRIVATE_KEY_PATH (${keyPath})`,
      { cause: error },
    );
  }
  return {
    appId,
    privateKey,
    redirectUrl: env.ENABLE_BANKING_REDIRECT_URL,
    environment: env.ENABLE_BANKING_ENV,
  };
}

/**
 * The RS256 application JWT: `kid` = application id, issued by
 * `enablebanking.com` for `api.enablebanking.com`.
 */
export async function createApplicationJwt(
  config: Pick<EnableBankingConfig, "appId" | "privateKey">,
  now: Date,
  ttlSeconds: number = JWT_TTL_SECONDS,
): Promise<string> {
  const iat = Math.floor(now.getTime() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: config.appId })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttlSeconds)
    .sign(config.privateKey);
}

/** An error response the sync layer does not handle: a bug or a bad input. */
export class EnableBankingApiError extends Error {
  override readonly name = "EnableBankingApiError";

  constructor(
    message: string,
    readonly status: number,
    /** Enable Banking's error name, e.g. `WRONG_AUTHORIZATION_CODE`. */
    readonly code: string | null,
    readonly detail: unknown,
  ) {
    super(message);
  }
}

/**
 * Error names that mean the session or consent is gone (API reference; the
 * sandbox recordings hold none of them, F-001).
 */
const SESSION_ERRORS = new Set([
  "CLOSED_SESSION",
  "EXPIRED_SESSION",
  "REVOKED_SESSION",
  "SESSION_DOES_NOT_EXIST",
  "WRONG_SESSION_STATUS",
  "EXPIRED_ACCESS",
]);
/** The bank's own daily limit (PSD2's four unattended fetches). */
const RATE_LIMIT_ERRORS = new Set(["ASPSP_RATE_LIMIT_EXCEEDED"]);
const UNAVAILABLE_ERRORS = new Set(["ASPSP_ERROR", "ASPSP_TIMEOUT"]);

/** `/accounts/{uid}/balances` for `/accounts/<uid>/balances?…`. */
export function redactPath(path: string): string {
  return path
    .split("?")[0]
    .replace(/^\/accounts\/[^/]+/, "/accounts/{uid}")
    .replace(/^\/sessions\/[^/]+/, "/sessions/{id}");
}

export interface EnableBankingClientOptions {
  /** The configuration, or a function that loads it on first use. */
  config: EnableBankingConfig | (() => EnableBankingConfig);
  fetch?: typeof fetch;
  /** Milliseconds since the epoch. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  maxAttempts?: number;
}

export interface StartAuthorizationInput {
  aspsp: { name: string; country: string };
  /** Returned unchanged in the redirect, to tie it to this request. */
  state: string;
  /** When the consent ends; at most the bank's `maximum_consent_validity`. */
  validUntil: Date;
  psuType?: "personal" | "business";
}

export interface TransactionQuery {
  dateFrom?: string;
  dateTo?: string;
  continuationKey?: string;
  /** `BOOK`, `PDNG`, …; omitted = every status. */
  transactionStatus?: string;
}

export interface EnableBankingClient {
  readonly environment: () => EnableBankingEnvironment;
  getAspsps(country: string): Promise<Aspsp[]>;
  startAuthorization(
    input: StartAuthorizationInput,
  ): Promise<{ url: string; authorizationId: string }>;
  createSession(code: string): Promise<CreatedSession>;
  getSession(sessionId: string): Promise<EnableBankingSession>;
  getAccountDetails(uid: string): Promise<EnableBankingAccount>;
  getBalances(uid: string): Promise<EnableBankingBalance[]>;
  getTransactions(
    uid: string,
    query?: TransactionQuery,
  ): Promise<EnableBankingTransactionPage>;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | undefined>;
  /** False for calls that must not repeat after a 5xx (`POST /sessions`). */
  retryUnavailable?: boolean;
}

export function createEnableBankingClient(
  options: EnableBankingClientOptions,
): EnableBankingClient {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const baseUrl = options.baseUrl ?? ENABLE_BANKING_API_URL;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  let config: EnableBankingConfig | undefined;
  const getConfig = () =>
    (config ??=
      typeof options.config === "function" ? options.config() : options.config);

  let token: { jwt: string; renewAt: number } | undefined;
  async function applicationJwt(): Promise<string> {
    const at = now();
    if (!token || at >= token.renewAt) {
      token = {
        jwt: await createApplicationJwt(getConfig(), new Date(at)),
        renewAt: at + (JWT_TTL_SECONDS - JWT_RENEW_BEFORE_SECONDS) * 1000,
      };
    }
    return token.jwt;
  }

  async function errorFor(
    label: string,
    response: Response,
  ): Promise<ProviderError | EnableBankingApiError> {
    let body: z.infer<typeof errorResponseSchema> = {};
    try {
      const parsed = errorResponseSchema.safeParse(await response.json());
      if (parsed.success) body = parsed.data;
    } catch {
      // Not JSON (a proxy's error page): the status decides.
    }
    const code = body.error ?? null;
    const apiError = new EnableBankingApiError(
      `Enable Banking ${label} → HTTP ${response.status}${code ? ` ${code}` : ""}${body.message ? `: ${body.message}` : ""}`,
      response.status,
      code,
      body.detail ?? null,
    );
    const cause = apiError;
    if (code && SESSION_ERRORS.has(code)) {
      return new ProviderAuthError(PROVIDER_ID, apiError.message, { cause });
    }
    if (code && RATE_LIMIT_ERRORS.has(code)) {
      return new ProviderRateLimitError(PROVIDER_ID, apiError.message, {
        cause,
        retryAfterMs: parseRetryAfter(
          response.headers.get("retry-after"),
          new Date(now()),
        ),
      });
    }
    if (code && UNAVAILABLE_ERRORS.has(code)) {
      return new ProviderUnavailableError(PROVIDER_ID, apiError.message, {
        cause,
      });
    }
    return (
      providerErrorFromStatus(PROVIDER_ID, response.status, {
        retryAfter: response.headers.get("retry-after"),
        now: new Date(now()),
        cause,
      }) ?? apiError
    );
  }

  async function request<S extends z.ZodType>(
    method: "GET" | "POST",
    path: string,
    schema: S,
    { body, query, retryUnavailable = true }: RequestOptions = {},
  ): Promise<z.infer<S>> {
    const label = `${method} ${redactPath(path)}`;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) params.set(key, value);
    }
    const url = `${baseUrl}${path}${params.size ? `?${params}` : ""}`;

    for (let attempt = 1; ; attempt++) {
      const backoff = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      const canRetry = attempt < maxAttempts;
      let response: Response;
      try {
        response = await fetchFn(url, {
          method,
          headers: {
            Authorization: `Bearer ${await applicationJwt()}`,
            Accept: "application/json",
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (retryUnavailable && canRetry) {
          await sleep(backoff);
          continue;
        }
        throw new ProviderUnavailableError(
          PROVIDER_ID,
          `Enable Banking ${label} is unreachable: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }

      if (response.ok) {
        let json: unknown;
        try {
          json = await response.json();
        } catch (error) {
          throw new Error(`Enable Banking ${label} returned no JSON`, {
            cause: error,
          });
        }
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          throw new Error(
            `Enable Banking ${label} returned an unexpected response:\n${prettify(parsed.error)}`,
          );
        }
        return parsed.data;
      }

      const status = response.status;
      const retryable =
        status === 429 ||
        (retryUnavailable && (status === 408 || status >= 500));
      if (retryable && canRetry) {
        const retryAfter = parseRetryAfter(
          response.headers.get("retry-after"),
          new Date(now()),
        );
        if (retryAfter === null || retryAfter <= MAX_RETRY_DELAY_MS) {
          // Free the connection before waiting.
          await response.body?.cancel();
          await sleep(retryAfter ?? backoff);
          continue;
        }
      }
      throw await errorFor(label, response);
    }
  }

  const sessionPath = (id: string) => `/sessions/${encodeURIComponent(id)}`;
  const accountPath = (uid: string, rest: string) =>
    `/accounts/${encodeURIComponent(uid)}/${rest}`;

  return {
    environment: () => getConfig().environment,

    async getAspsps(country) {
      const { aspsps } = await request("GET", "/aspsps", aspspsResponseSchema, {
        query: { country },
      });
      return aspsps;
    },

    async startAuthorization(input) {
      const redirectUrl = getConfig().redirectUrl;
      if (!redirectUrl) {
        throw new Error(
          "ENABLE_BANKING_REDIRECT_URL is not set: Enable Banking cannot send the user back",
        );
      }
      const result = await request("POST", "/auth", authResponseSchema, {
        body: {
          access: { valid_until: input.validUntil.toISOString() },
          aspsp: { name: input.aspsp.name, country: input.aspsp.country },
          state: input.state,
          redirect_url: redirectUrl,
          psu_type: input.psuType ?? "personal",
        },
      });
      return { url: result.url, authorizationId: result.authorization_id };
    },

    createSession(code) {
      return request("POST", "/sessions", createSessionResponseSchema, {
        body: { code },
        // The code is single-use: after a 5xx it may already be spent.
        retryUnavailable: false,
      });
    },

    getSession(sessionId) {
      return request("GET", sessionPath(sessionId), sessionResponseSchema);
    },

    getAccountDetails(uid) {
      return request("GET", accountPath(uid, "details"), accountSchema);
    },

    async getBalances(uid) {
      const { balances } = await request(
        "GET",
        accountPath(uid, "balances"),
        balancesResponseSchema,
      );
      return balances;
    },

    getTransactions(uid, query = {}) {
      return request(
        "GET",
        accountPath(uid, "transactions"),
        transactionsResponseSchema,
        {
          query: {
            date_from: query.dateFrom,
            date_to: query.dateTo,
            continuation_key: query.continuationKey,
            transaction_status: query.transactionStatus,
          },
        },
      );
    },
  };
}

/** Issue paths and messages only: no response values (IBANs, names). */
function prettify(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}
