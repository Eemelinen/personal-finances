#!/usr/bin/env bash
# SessionStart hook: print a compact, read-only state summary into Claude's context.
# Must stay fast (< 1 s). It never fails the session.
set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}" || exit 0

echo "## Personal Finances session state ($(date +%F))"
echo "repo: $PWD · branch: $(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
echo
echo "recent commits:"
git log --oneline -5 2>/dev/null | sed 's/^/  /'

dirty="$(git status --short 2>/dev/null || true)"
if [ -n "$dirty" ]; then
  echo
  echo "uncommitted changes:"
  printf '%s\n' "$dirty" | head -15 | sed 's/^/  /'
  if printf '%s\n' "$dirty" | grep -qE '^.. src/' && ! printf '%s\n' "$dirty" | grep -qE '^.. (PROGRESS\.md|feature_list\.json)$'; then
    echo
    echo "WARNING: src/ has uncommitted changes but PROGRESS.md / feature_list.json are untouched."
    echo "A previous session may have stopped without clock-out. Read the diff before continuing."
  fi
fi

if [ -f PROGRESS.md ]; then
  echo
  awk '/^## Current Verified State/{f=1; print; next} /^## /{if (f) exit} f' PROGRESS.md
fi

if [ -f feature_list.json ]; then
  node -e '
    const fs = require("fs")
    try {
      const list = JSON.parse(fs.readFileSync("feature_list.json", "utf8"))
      const by = (s) => list.features.filter((f) => f.status === s)
      const active = by("in_progress")[0]
      const next = by("not_started").sort((a, b) => a.priority - b.priority)[0]
      console.log("")
      console.log(active ? `active feature: ${active.id} — ${active.title}` : "active feature: none (WIP=1 slot is free)")
      if (next) console.log(`next not_started: ${next.id} — ${next.title}`)
      console.log(`features: ${list.features.length} total · ${by("passing").length} passing · ${by("in_progress").length} in_progress · ${by("blocked").length} blocked`)
    } catch (e) {
      console.log("feature_list.json: " + e.message)
    }
  '
fi

echo
[ -f .env ] && echo "env: .env present" || echo "env: .env MISSING — cp .env.example .env before pnpm db:up / pnpm dev"
if docker info >/dev/null 2>&1; then
  echo "docker: running (pnpm db:up starts the dev database)"
else
  echo "docker: not running (pnpm db:up, and any L2/L3 layer a feature adds, need Docker Desktop)"
fi
echo
echo "Clock-in: AGENTS.md → Clock-in (or /clock-in). Layers: pnpm check (L1); see AGENTS.md → Verification layers for L2/L3."
exit 0
