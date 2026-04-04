#!/usr/bin/env bash
set -euo pipefail

echo "=== claude-code-server ==="
echo "Workspace directory: /workspace"
echo "Args: ${CLAUDE_CODE_ARGS}"
echo "Restart delay: ${RESTART_DELAY}s"

# Trap SIGTERM/SIGINT for graceful shutdown
cleanup() {
    echo "Shutting down..."
    # Kill all child processes
    kill 0 2>/dev/null || true
    exit 0
}
trap cleanup SIGTERM SIGINT

while true; do
    echo "$(date -Iseconds) Starting Claude Code remote-control..."

    # Use script to allocate a pseudo-TTY for interactive mode
    # shellcheck disable=SC2086
    script -qec "claude remote-control $CLAUDE_CODE_ARGS" /dev/null || true
    EXIT_CODE=$?

    echo "$(date -Iseconds) Claude Code exited with code $EXIT_CODE"
    echo "Restarting in ${RESTART_DELAY}s..."
    sleep "$RESTART_DELAY"
done
