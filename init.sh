#!/usr/bin/env bash
# Standard startup and verification path (course: learn-harness-engineering).
#   ./init.sh                 install + tooling checks + L1 baseline (`pnpm check`)
#   FAST=1 ./init.sh          skip the baseline (tooling checks only)
#   RUN_START_COMMAND=1 ./init.sh   additionally start Docker services and `pnpm dev`
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$1"; }
step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "Working directory: $PWD"

step "Tooling"
WANT_NODE="$(tr -d 'v[:space:]' < .nvmrc)"
HAVE_NODE="$(node -v 2>/dev/null | tr -d 'v' || true)"
if [ -z "$HAVE_NODE" ]; then
  echo "Node.js is not installed; install Node ${WANT_NODE} (see .nvmrc)." >&2
  exit 1
fi
if [ "${HAVE_NODE%%.*}" != "${WANT_NODE%%.*}" ]; then
  warn "Node ${HAVE_NODE} found, .nvmrc wants ${WANT_NODE} (try: nvm use)"
fi
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is missing; run: corepack enable" >&2
  exit 1
fi
echo "node ${HAVE_NODE} · pnpm $(pnpm -v)"

if [ ! -f .env ]; then
  warn ".env is missing — pnpm db:up, pnpm dev and the worker need it: cp .env.example .env (then set POSTGRES_PASSWORD and DATABASE_URL)"
fi
if docker info >/dev/null 2>&1; then
  echo "docker: running (dev database via pnpm db:up)"
else
  warn "Docker is not running — pnpm db:up and any L2/L3 layer (AGENTS.md) are unavailable"
fi

step "Installing dependencies"
pnpm install --frozen-lockfile

if [ "${FAST:-0}" = "1" ]; then
  step "FAST=1 — skipping baseline verification"
else
  step "Baseline verification (L1): pnpm check"
  pnpm check
fi

step "Start commands"
echo "  pnpm db:up && pnpm db:migrate && pnpm dev   # http://localhost:3000 (health: /api/health)"
echo "  pnpm worker:dev                              # scheduled jobs, in another terminal"

if [ "${RUN_START_COMMAND:-0}" = "1" ]; then
  step "Starting the app"
  pnpm db:up
  pnpm db:migrate
  exec pnpm dev
fi

cat <<'MSG'

Next steps:
  1. Read PROGRESS.md and feature_list.json.
  2. Pick ONE unfinished feature (highest priority, not blocked) and set it in_progress.
  3. Implement only that feature; run its verification layers in order.
  4. Record evidence, update PROGRESS.md, commit (see AGENTS.md → Clock-out).
Set RUN_START_COMMAND=1 to have init.sh start Docker services and the dev server.
MSG
