#!/usr/bin/env bash
set -euo pipefail

echo "=== claude-code-server ==="
echo "Workspace directory: /workspace"
echo "Args: ${CLAUDE_CODE_ARGS}"
echo "Restart delay: ${RESTART_DELAY}s"

# Pass OAuth token to Claude Code if set
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN}" ]; then
    export CLAUDE_CODE_OAUTH_TOKEN
    echo "OAuth token: configured"
else
    echo "OAuth token: not set"
fi

# Trap SIGTERM/SIGINT for graceful shutdown
CHILD_PID=""
cleanup() {
    echo "Shutting down..."
    if [ -n "$CHILD_PID" ] && kill -0 "$CHILD_PID" 2>/dev/null; then
        kill "$CHILD_PID"
        wait "$CHILD_PID" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup SIGTERM SIGINT

while true; do
    echo "$(date -Iseconds) Starting Claude Code with remote-control..."

    # Start claude with configured args
    # shellcheck disable=SC2086
    claude $CLAUDE_CODE_ARGS &
    CHILD_PID=$!

    # Wait for the process to exit
    wait "$CHILD_PID" || true
    EXIT_CODE=$?
    CHILD_PID=""

    echo "$(date -Iseconds) Claude Code exited with code $EXIT_CODE"
    echo "Restarting in ${RESTART_DELAY}s..."
    sleep "$RESTART_DELAY"
done
