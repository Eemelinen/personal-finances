# Decisions

Lightweight architecture decision records. Newest last. Add an entry whenever a choice
is made that a future session could not derive from the code alone (why, not what).
Product-level choices (stack, hosting, bank access) are summarised in
[plan.md → Decisions](plan.md#decisions); their background is in [tech-stack.md](tech-stack.md)
and [api-access-research.md](api-access-research.md).

Format: **Context** (what forced a choice) · **Decision** · **Consequences**. When a later
decision changes an earlier one, amend the earlier entry in place and say why.

## D-001 · Agent harness ported from Metsävahti (2026-10-23)

- Context: the project is meant to be built mostly by coding-agent sessions, many of them unattended. Metsävahti already has a working harness (course _learn-harness-engineering_ on Claude Code) with a porting guide at its tag `harness-reference`.
- Decision:
  - Port it as the guide prescribes: COPY files stay byte-identical to the reference (a Prettier override in `.prettierrc.json` keeps them in the reference style, so they can be diffed against the tag when re-syncing), ADAPT files get only the guide's § 4 edits, WRITE files follow its skeletons.
  - Deliberate deviations from COPY: `scripts/harness-feature.ts` no longer prints the removed `epic` / `design` fields (two lines), because the feature schema dropped them (no epics or design artboards here). `ticket` is `FIN-NNN` and maps 1:1 to `F-NNN`.
  - Skipped: `import-tickets.ts` and its test (tickets are written alongside `feature_list.json` instead of being parsed from a spec), knip (not used in this repo), design-system lint and the deviations ledger (no design artboards or external spec).
  - Layers are named, not invented: L1 `pnpm check` exists at bootstrap; L2 (`pnpm test:integration`, Vitest + Testcontainers Postgres) is introduced by F-002 and L3 (`pnpm test:e2e`, Playwright) by F-003, each together with its first real tests. Until then the harness runs with L1 only, as the guide allows for projects without integration tests.
  - Unit tests live in `tests/unit/**` (a Vitest project), so the harness tests in `tests/unit/harness/` validate the real `feature_list.json` on every `pnpm check`.
  - The clean-state check forbids added `console.log` in `src/` and allows `console.info/warn/error`, because the repo has no logger; there are no coverage thresholds yet, so that check was removed rather than kept as an always-pass.
  - CI is one job named `Verify`; the features that add L2/L3 add steps to it, so the required status check never changes name.
  - `pnpm typecheck` runs `next typegen` before `tsc`: route types (`LayoutProps`, …) and `next-env.d.ts` are generated and gitignored, and a fresh worktree or CI runner has only committed files (acceptance check 9 caught this).
- Consequences: one manual for every agent (`AGENTS.md`, imported by `CLAUDE.md`); the session loop (read state → one feature → verify → write state) is enforced by scripts and hooks rather than prose; status lives only in `feature_list.json` and only scripts change it.

## D-002 · Driver-run sessions: local loop, auto permissions, PR per feature, opt-in Stop hook (2026-10-23)

- Context: unattended sessions (`pnpm harness:loop`) have nobody to answer questions and run on the host, next to Docker and the dev database.
- Decision (unchanged from the reference's D-008 unless stated):
  - The driver is a local script run on this machine with the existing Claude Code login and host Docker; no CI or cloud runner.
  - Sessions run `claude -p --permission-mode auto --permission-prompts none` with an explicit `--allowedTools` list from `harness.config.json`; the deny list and `guard.sh` still apply; `bypassPermissions` is not used.
  - One worktree and branch `feat/F-NNN` per feature under `../personal-finances-worktrees`, then a PR via `gh`. `harness.config.json` started with `merge: "wait"` (a human merges) and is `"auto"` since 2026-10-23, when `main` got branch protection with the required `Verify` check; switch to `"auto"` once `main` has branch protection with the required `Verify` check, otherwise GitHub would merge before CI.
  - Caps start at the guide's values: 2 attempts, 200 turns, 15 USD, 60 minutes per session; the evaluator 60 turns, 4 USD, 15 minutes. Raise them only after measuring runs (`pnpm harness:report`).
  - Generator/evaluator split: the evaluator is a separate `claude -p` session with the body and tools of `.claude/agents/evaluator.md` (`--append-system-prompt` / `--tools`) and a JSON verdict schema; `--agent` is not used because it ignores `--json-schema`.
  - The Stop hook is inert unless `HARNESS_STOP_GUARD=1` (set by the driver) and blocks at most three times.
  - Features that need real credentials or a person (F-001, F-013, F-023) carry `manual:` steps, so the driver never picks them.
- Consequences: `.harness/` is gitignored; in loop mode `guard.sh` additionally blocks `pnpm db:up/down`, `git push`, leaving the branch, worktree commands and writes outside the worktree; one feature runs at a time; `gh` must be installed and logged in for PRs.

## D-003 · pnpm instead of npm, and `pnpm add` allowed unattended (2026-10-23)

- Context: the harness scripts, hooks, skills and driver call `pnpm`, and every feature installs dependencies in a fresh worktree, which is only fast with pnpm's shared store. The repo started on npm.
- Decision:
  - Switch to pnpm: `pnpm import` converted the lockfile (same versions); `packageManager` pins **pnpm 10.15.0**, run through corepack. pnpm 12 was tried first, but it creates directory symlinks, which fail on Windows without admin rights or developer mode; pnpm 10 uses junctions. Build-script approvals moved from npm's `allowScripts` to `pnpm.onlyBuiltDependencies`.
  - `"type": "module"` in `package.json`, because the harness scripts are ESM.
  - `Bash(pnpm add *)` is in the unattended `allowedTools`: features must add the dependencies their tickets name (Testcontainers, Playwright, iron-session, jose, Recharts, …). `guard.sh` still blocks npm, yarn and npx, and the lockfile can only change through pnpm.
- Consequences: the Docker images install with `pnpm install --frozen-lockfile` via corepack; a dependency an unattended session adds is visible in the PR diff (`package.json`, `pnpm-lock.yaml`) and reviewed by the evaluator and the human merging the PR.

## D-004 · The harness is the shared package and Claude Code plugin, not a copy (2026-10-23)

- Context: D-001 ported the harness by copying files from Metsävahti's `harness-reference` tag. The copies drifted at once: Metsävahti fixed the loop's wait on a failed CI check after the tag, Ideaforge fixed the guard's command matching, and neither fix reached this repository without porting it by hand.
- Decision: the harness now comes from `Eemelinen/harness`, pinned to one git tag twice. The package is `@eemelinen/harness` (`devDependencies`, `github:Eemelinen/harness#vX.Y.Z`; the `harness` CLI behind `pnpm harness:*`). The Claude Code plugin is `harness@eemelinen-harness` (`.claude/settings.json` → `extraKnownMarketplaces` with `ref`, `enabledPlugins`; skills `/harness:*`, agent `harness:evaluator`, the hooks). Everything that was a project edit of a copied file is configuration in `harness.config.json`: the `FIN-NNN` ticket format, the guard rules for `next-env.d.ts`, `drizzle/` and `.env*`, the `.only`/`.skip` check over `tests` and `src`, the `console.log` check, the marker block, the Docker services and the session-start lines. The ticket and deviation instructions moved into `docs/harness/generator-notes.md`. `pnpm check` runs `pnpm harness:check` instead of the copied unit tests, and `./init.sh` runs `pnpm harness:doctor`. Driver sessions load the plugin from the installed package (`--plugin-dir`) and stop when it is missing. This amends D-001 and D-002.
- Consequences: the copied scripts, hooks, skills, prompts, evaluator and harness tests are gone, along with the Prettier override that kept them in the reference style. Harness fixes arrive by bumping both pins (`docs/harness/README.md`). Skill names gained the `harness:` prefix. Interactive sessions need the folder trusted once for the marketplace and the permissions to apply.

## D-005 · Core schema types: `date` for calendar days, `bigint` read as `number`, open-text providers (2026-10-23)

- Context: F-002 creates the first schema. FIN-002 asks for `timestamptz` everywhere, `bigint` minor units with a `char(3)` currency and an `account_type` enum, and leaves the rest open.
- Decision:
  - Points in time are `timestamptz`; calendar days (`booking_date`, `value_date`, the snapshot `date`) are `date` (read as `YYYY-MM-DD` strings). A bank's booking day is not an instant, and a timestamp at UTC midnight would show as the previous day in another zone.
  - Money is `bigint` minor units read as JS `number` (exact to 2^53 cents), not `bigint`, so values serialise to JSON and work with arithmetic without conversions.
  - `provider` columns are open `text` (new providers need no migration); closed sets (account type, statuses, category source and kind, rule match field and type) are Postgres enums. Ids are `uuid` (`gen_random_uuid()`).
  - Dedupe identity is `dedupeHash()` (`src/server/dedupe-hash.ts`): SHA-256 over the normalised booking date (`YYYY-MM-DD`, ISO timestamp or `d.m.yyyy`), the integer amount and NFKC-normalised, lower-cased, whitespace-collapsed counterparty and description.
  - L2 runs one Testcontainers `postgres:18-alpine` per test file, migrated by the same `applyMigrations()` the `migrate` service uses.
- Consequences: deviations are listed in FIN-002's Notes. Amounts beyond 2^53 minor units would need `mode: "bigint"`; F-019 decides quantities for crypto separately.

## D-006 · L3: Playwright against the standalone build with its own Testcontainers Postgres; shadcn/ui Nova (2026-10-23)

- Context: F-003 introduces the L3 layer and the app shell. FIN-003 asks for a `webServer` that builds and serves the app on a fixed test port, and leaves the e2e database open (Testcontainers or a compose `db_test` service). Loop sessions must not run Docker Compose, and the machine already runs other projects' containers.
- Decision:
  - The e2e database is **Testcontainers**, not a compose service: `tests/e2e/support/server.ts` (Playwright's `webServer`) starts `postgres:18-alpine` with the same `startTestDatabase()` L2 uses, so it is migrated by the app's own runner, then runs `pnpm build` and serves `.next/standalone/server.js` (what the Docker image runs, static assets copied in the same way) on `127.0.0.1:3100` (`E2E_PORT`). Playwright waits for `/api/health`, which only answers 200 once the app reaches that database. Nothing touches the dev database, and the container dies with the process (SIGTERM, else Ryuk).
  - `reuseExistingServer: false`: the fixed port must never silently test some other server. `E2E_SKIP_BUILD=1` reuses an existing build (CI builds once, before L3).
  - Chromium only, `retries: 0`, `forbidOnly`. Desktop and mobile widths are `test.use` viewports inside one spec rather than two projects, so each assertion states which layout it checks.
  - `@playwright/test` is pinned exactly to **1.63.0**, the version whose Chromium revision (1243) is already installed on the loop machine; a newer release needs a new browser download, which an unattended session must not do to the host. Bump it together with `pnpm exec playwright install chromium`; `./init.sh` warns when the revision is missing.
  - shadcn/ui was initialised with the CLI (`-b radix -p nova`): Radix primitives, `lucide-react`, the `cn` package, theme variables in `globals.css`. The CLI added `shadcn` itself as a runtime dependency for its `tailwind.css`; it is a devDependency here, because the CSS is resolved at build time.
  - Pages live in the `(app)` route group whose layout renders the shell; a page without it (F-004's login) goes outside the group. The active nav link uses `usePathname()` inside `<Suspense>` with an unhighlighted fallback, so a future dynamic route cannot fail the Cache Components prerender.
- Consequences: L3 needs Docker and the Playwright Chromium. The fixed port keeps loop runs sequential (already the case for Compose). Next 16 keeps visited pages mounted but hidden, so non-role e2e locators need `.filter({ visible: true })`.

## D-007 · Single-user login: base64url-encoded hash, stateless iron-session, daily re-issue, global backoff (2026-10-23)

- Context: F-004 adds the login. FIN-004 names argon2, `AUTH_PASSWORD_HASH`, iron-session with `SESSION_SECRET`, a 30-day sliding expiry, `src/proxy.ts` plus a data access layer check, and an in-memory backoff after 5 failures; the details are open.
- Decision:
  - `AUTH_PASSWORD_HASH` holds the argon2id PHC string **base64url-encoded** (`pnpm auth:hash` prints it). The Next.js `.env` loader expands `$name` even in single or double quotes, so a raw `$argon2id$v=19$…` would arrive mangled, and Docker Compose escapes `$` differently (`$$`) from Next (`\$`). A raw PHC string is still accepted when the variable is set without a `.env` file. Hashing uses `@node-rs/argon2` defaults (argon2id, m=19456 KiB, t=2, p=1).
  - The login secrets have their own schema, `getAuthEnv()` in `src/server/env.ts`, which only the app calls; the worker and the migrate job do not get them (Compose sets them on `app` only). `SESSION_SECRET` must be at least 32 characters (iron-session's minimum).
  - The session is stateless: the cookie `pf_session` seals only `{ issuedAt }`. It is valid for 30 days from `issuedAt` (checked explicitly and by the seal's own TTL). "Sliding" is implemented by the proxy re-issuing the cookie once the session is a day old, rather than on every request, so prefetches do not rewrite the cookie constantly. Logout deletes the cookie; it cannot revoke a copied cookie, which rotating `SESSION_SECRET` does.
  - `secure` is set when `NODE_ENV=production`. Browsers accept secure cookies on `http://localhost` and `127.0.0.1` (L3 runs that way), and Compose binds the app to `127.0.0.1`, so remote access needs a TLS proxy anyway.
  - Backoff: after 5 consecutive failures each attempt is refused until 1 s, 2 s, 4 s, … (cap 15 min) after the last failure; a success resets it. It is global, not per IP, because there is one account and client IPs behind a proxy are spoofable; the trade-off is that someone who keeps sending a wrong password whenever the window opens can keep the owner locked out. That is accepted because the app is bound to `127.0.0.1` (only someone already on the machine or behind the owner's own proxy can reach it); restarting the app clears the counter. Attempts are serialised (`createLoginChecker()` in `src/server/auth/login.ts`) so parallel requests cannot all pass before earlier failures are counted, and a refused attempt neither runs argon2 nor counts as a failure.
  - The proxy answers 401 JSON for `/api/*` without a session and redirects every other path to `/login`; `/login` with a valid session redirects to `/`. `/api/health` skips the session check entirely, so it still reports the database state when the login secrets are missing; every other path fails fast on them (500). The decision is the pure `accessDecision()` (`src/lib/auth/routes.ts`), unit-tested with the re-issue (`refreshSession()`). After login the app always opens `/` (no return-to parameter, so no open-redirect check is needed yet).
  - The proxy skips the daily re-issue on Server Action calls (`isServerActionRequest()`: a POST with `Next-Action`), because the action may change the cookie in the same response; logout must always end with the cookie gone. `getSession()` awaits `io()` before reading the clock (the guide's alternative, `'use cache: private'`, would cache the session check in the browser, which a stateless logout cannot invalidate).
  - L3 logs in once in a Playwright `setup` project and stores the browser state; `tests/e2e/support/credentials.ts` holds the test-only password and secret, and the e2e server hashes the password at startup.
- Consequences: a new Route Handler, Server Action or data-reading component must call `verifySession()` itself (architecture → Security). The backoff resets when the app restarts. `pnpm test:e2e <spec>` always runs the `setup` project first. L3 fails when the app server prints an error line (`tests/e2e/support/server-errors.ts`, Playwright global teardown), so a Cache Components or action error that leaves the page intact still breaks the run.

## D-008 · Provider contract: date-string ranges, decrypted connection, fake registered only on `BANK_PROVIDER=fake`, `v1:` AES-GCM format (2026-10-23)

- Context: F-005 finalises the `FinancialProvider` sketch in the architecture doc, adds the typed errors, the registry, the fake provider and the encryption of stored session ids. FIN-005 leaves the shapes, the switch and the key format open.
- Decision:
  - DTOs mirror the table columns (integer minor units + currency, `YYYY-MM-DD` calendar days, provider ids as `ref`). The transaction range is inclusive calendar days `{ from, to? }` as strings rather than the sketch's `Date`s, because the bank APIs and the `date` columns both work in days and a `Date` would bring a time zone into a day boundary. Providers receive `ProviderConnection { sessionRef }` with the session id already decrypted, so they never see `ENCRYPTION_KEY` or the database.
  - Typed errors carry a `kind` and the `providerId`; `providerErrorFromStatus()` is the single HTTP mapping (401/403 auth, 429 rate limit with `Retry-After`, 408/5xx unavailable, everything else a bug that is not caught). `getHoldings()` is optional with a provisional `{ symbol, quantity: string }` DTO that F-019 finalises.
  - `BANK_PROVIDER` (`enable_banking` default, or `fake`) is in the main env schema because app and worker both need it. The fake is registered only when it is selected, so a real installation never answers a `provider = 'fake'` row with fake data. The fake derives each day's transactions from a SHA-256 of account ref and day (no stored state, no seed), so separate processes (the e2e app server and the test runner) agree without sharing memory; only "today" reads the clock (injectable). Failure modes are selected by special session refs (`fake:expired`, …) for the same reason.
  - `ENCRYPTION_KEY` is 32 random bytes, base64, in its own schema (`getEncryptionEnv()`), like the login secrets, so the migrate job and `/api/health` keep working without it. Ciphertext is `v1:<iv>:<ciphertext>:<tag>` in base64url, with the version as GCM additional data, a 16-byte tag enforced on decryption and only canonical base64url accepted; a later `v2` (new key or format) can sit next to `v1` values.
- Consequences: F-006 registers Enable Banking in `defaultProviders()` and maps its HTTP failures with `providerErrorFromStatus()`; F-007 stores `encryptSecret(sessionId)` in `connections.session_ref` and needs `ENCRYPTION_KEY` passed to the Compose `app` and `worker` services (not done yet: nothing reads it at runtime). Key rotation is not built. L3 runs with `BANK_PROVIDER=fake` and a test-only key from `tests/e2e/support/credentials.ts`.
