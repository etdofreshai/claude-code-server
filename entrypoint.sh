#!/usr/bin/env bash
set -euo pipefail

echo "=== claude-code-server ==="
echo "Workspace directory: /home/claude/workspace"
echo "Args: ${CLAUDE_CODE_ARGS}"
echo "Restart delay: ${RESTART_DELAY}s"

# Configure git credentials for GitHub accounts
if [ -n "${GH_TOKEN_ETDOFRESH}" ]; then
    git config --global "url.https://etdofresh:${GH_TOKEN_ETDOFRESH}@github.com/etdofresh/.insteadOf" "https://github.com/etdofresh/"
    git config --global --add "url.https://etdofresh:${GH_TOKEN_ETDOFRESH}@github.com/etdofresh/.insteadOf" "git@github.com:etdofresh/"
    git config --global --add "url.https://etdofresh:${GH_TOKEN_ETDOFRESH}@github.com/etdofresh/.insteadOf" "ssh://git@github.com/etdofresh/"
    echo "GitHub: etdofresh configured"
fi

if [ -n "${GH_TOKEN_ETDOFRESHAI}" ]; then
    git config --global "url.https://etdofreshai:${GH_TOKEN_ETDOFRESHAI}@github.com/etdofreshai/.insteadOf" "https://github.com/etdofreshai/"
    git config --global --add "url.https://etdofreshai:${GH_TOKEN_ETDOFRESHAI}@github.com/etdofreshai/.insteadOf" "git@github.com:etdofreshai/"
    git config --global --add "url.https://etdofreshai:${GH_TOKEN_ETDOFRESHAI}@github.com/etdofreshai/.insteadOf" "ssh://git@github.com/etdofreshai/"
    echo "GitHub: etdofreshai configured"
fi

# Trap SIGTERM/SIGINT for graceful shutdown
cleanup() {
    echo "Shutting down..."
    # Kill all child processes
    kill 0 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

while true; do
    echo "$(date -Iseconds) Starting Claude Code..."

    # Replace ${DATETIME} placeholder with current timestamp (YYYYMMDDTHHmmss)
    RESOLVED_ARGS="${CLAUDE_CODE_ARGS//\$\{DATETIME\}/$(date +%Y%m%dT%H%M%S)}"

    # Use script to allocate a pseudo-TTY for interactive mode
    # shellcheck disable=SC2086
    script -qec "claude $RESOLVED_ARGS" /dev/null || true
    EXIT_CODE=$?

    echo "$(date -Iseconds) Claude Code exited with code $EXIT_CODE"
    echo "Restarting in ${RESTART_DELAY}s..."
    sleep "$RESTART_DELAY"
done
