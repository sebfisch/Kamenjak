#!/bin/bash
# Prepare a Claude Code on the web session so the test suite can run without any
# manual steps: install npm dependencies (which pulls the matching Chromium build
# via @playwright/browser-chromium) and the OS libraries Chromium needs.
set -euo pipefail

# Only run in the remote (web) environment; local setups manage their own deps.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

# Idempotent: npm install is a no-op when node_modules is already up to date.
npm install

# Guarantee the matching Chromium build is present. The @playwright/browser-chromium
# npm install-script download is a no-op when node_modules already looks up to date
# (and is skipped under --ignore-scripts), so install it explicitly. Idempotent.
npx playwright install chromium

# System shared libraries for Chromium. Best-effort: may need root/apt and is a
# no-op once already installed, so don't fail the session if it can't run.
npx playwright install-deps chromium || true
