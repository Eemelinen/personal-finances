# Quality document

A quality snapshot per product domain and architectural layer. Read it at clock-in to see
where the codebase is weakest; update it at clock-out when the session changed a grade.

**Update cadence:** after each significant session, and during the periodic (monthly) sweep.

**Grades:** **A** all verification passing, clean boundaries, agent-legible, stable tests ·
**B** verification passing, minor gaps in legibility or coverage · **C** partially working,
known gaps, hard for an agent to follow · **D** not working or major structural issues.

## Product domains

| Domain                                        | Grade | Verification | Agent legibility                      | Test stability | Key gaps                                     | Last updated |
| --------------------------------------------- | ----- | ------------ | ------------------------------------- | -------------- | -------------------------------------------- | ------------ |
| Bank data (`server/providers`, `server/sync`) | D     | none yet     | Tickets FIN-005 – FIN-013 describe it | —              | Not built (M1)                               | 2026-10-23   |
| Categorization                                | D     | none yet     | Tickets FIN-014, FIN-015              | —              | Not built (M2)                               | 2026-10-23   |
| Dashboard & reports                           | D     | none yet     | Tickets FIN-016 – FIN-018             | —              | Not built (M3); only a placeholder home page | 2026-10-23   |
| Investments                                   | D     | none yet     | Tickets FIN-019 – FIN-023             | —              | Not built (M4)                               | 2026-10-23   |

## Architectural layers

| Layer                                | Grade | Boundary enforcement                                   | Agent legibility                       | Key gaps                                             | Last updated |
| ------------------------------------ | ----- | ------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------- | ------------ |
| `src/server` (env, db, shared logic) | B     | Convention only (plain Node, `getEnv()`), no lint rule | Small, commented; docs/architecture.md | No schema yet (F-002); no import-boundary lint       | 2026-10-23   |
| Worker (`src/worker`)                | B     | Job registry; graceful shutdown                        | Two small files                        | Only a heartbeat job; no tests                       | 2026-10-23   |
| Frontend (`src/app`)                 | C     | Server Components by default; Cache Components on      | Placeholder page + health route        | No app shell (F-003), no auth (F-004), no UI tests   | 2026-10-23   |
| Tests & environments                 | C     | Vitest unit project; harness tests validate the queue  | AGENTS.md → Verification layers        | Only L1 exists; L2 arrives with F-002, L3 with F-003 | 2026-10-23   |
| Harness                              | A     | Scripts with exit codes, hooks, commit gates, CI       | AGENTS.md, docs/harness/README.md      | Loop not yet run for real; rubric not calibrated     | 2026-10-23   |

## Change history

### 2026-10-23

- Changes: initial snapshot at harness bootstrap (F-000).
- Domains promoted: —
- Demoted: —
- New gaps identified: see Key gaps; all tracked as features in `feature_list.json`.
- Gaps closed: —
