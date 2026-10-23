@AGENTS.md

## Claude Code specifics

The operating manual above applies to every agent. This section covers what Claude Code
does automatically in this repository (configuration in `.claude/`).

- **Permissions** (`.claude/settings.json`): read-only git commands, `docker ps/info`, the
  verification scripts (`pnpm check*`, `lint*`, `typecheck`, `format*`, `test:unit*`,
  `test:integration*`, `test:e2e*`) and the harness scripts (`pnpm harness:*`,
  `scripts/clean-state-check.sh`) run without prompting. Reading or editing `.env`,
  editing `next-env.d.ts` and `pnpm-lock.yaml`, `docker compose down -v`, force pushes and
  `git reset --hard` are denied.
- **Hooks**: `SessionStart` prints branch, recent commits, Current Verified State and the
  active feature. `PreToolUse` (`guard.sh`) blocks bare `vitest`/`playwright`, npm/yarn/npx
  and destructive commands, runs `pnpm harness:check` before every `git commit`, denies edits
  to the lockfile, `next-env.d.ts` and `.env*`, and asks before edits to generated migrations
  in `drizzle/` or the Next.js marker block in `AGENTS.md`. `PostToolUse` runs Prettier on every
  edited file. `Stop` (`stop-guard.sh`) is inert in interactive sessions; the loop driver sets
  `HARNESS_STOP_GUARD=1` and then it blocks stopping until the clean-state check passes (D-002).
- **Skills**: `/clock-in [F-NNN]` runs the clock-in routine and activates a feature
  (`pnpm harness:feature activate`); `/verify-feature F-NNN` runs `pnpm harness:verify`, which
  executes the feature's layers in order and records evidence; `/clock-out` runs
  `scripts/clean-state-check.sh`, updates state files and commits.
- **Driver-run sessions**: `pnpm harness:loop` (`scripts/harness-loop.ts`, config in
  `harness.config.json`) starts one `claude -p` session per ready feature in its own worktree,
  re-checks the result, runs the evaluator in a second session and opens a PR. How it works:
  [docs/harness/README.md](docs/harness/README.md).
- **Subagent** `evaluator`: fresh-context reviewer that scores the working-tree diff against
  `docs/harness/evaluator-rubric.md`. Use it from `/clock-out` or on request; it never edits.
- Prefer `pnpm test:watch` for tight unit-test loops.
