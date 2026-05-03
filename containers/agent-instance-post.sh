#!/usr/bin/env bash
# Apptainer %post hook for containers/agent-instance.def.
# Invoked by `apptainer build` during container assembly.
set -euo pipefail

apt-get update
apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    openssh-client \
    python3 \
    sqlite3
rm -rf /var/lib/apt/lists/*

corepack enable
cd /opt/auto-archive
pnpm install --prod --frozen-lockfile

# Provider runtimes:
#   - @openai/codex      — used when AUTO_ARCHIVE_RUNTIME_PROVIDER is unset or 'codex'.
#   - @anthropic-ai/claude-agent-sdk — used when AUTO_ARCHIVE_RUNTIME_PROVIDER='claude-agent'.
# Both are installed so a single image can serve either provider per
# specs/CLARIFICATIONS/multi-provider-scope.md.
pnpm install --global @openai/codex @anthropic-ai/claude-agent-sdk
