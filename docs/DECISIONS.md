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
