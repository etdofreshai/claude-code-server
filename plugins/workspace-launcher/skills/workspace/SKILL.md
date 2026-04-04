---
name: workspace
description: Launch a new named Claude Code session, optionally resuming an existing session by ID. The workspace name is only a display label — the working directory is always $WORKSPACES_DIR (default ~/workspace), or the explicitly provided second argument. Never append the name to the path. Use when the user wants to open a new Claude instance with a given name.
---

# /workspace

Launch a named Claude Code session via the claude-code-server API, or locally in a new terminal tab.

Usage: `/workspace <name> [directory] [session_id]`

- `name` — session display name only (never used as a path component)
- `directory` — working directory (optional; defaults to the `WORKSPACES_DIR` env var, or `~/workspace` if unset)
- `session_id` — UUID of an existing session to resume (optional)

**IMPORTANT: The workspace name is NOT appended to the directory. It is only used as the session title.**

---

## Instructions

### Step 1: Parse Arguments

Inspect `<command-args>`:

- **If empty:** ask the user for a workspace name. **STOP**.
- **First token** = `WORKSPACE_NAME` (display label only, not a path)
- **Second token** (if present) = `WORKSPACE_DIR`
- **Third token** (if present) = `SESSION_ID`

### Step 2: Detect Mode

Check if the claude-code-server API is available:

```bash
curl -sf http://localhost:3000/api/health >/dev/null 2>&1 && echo "server" || echo "local"
```

Store as `MODE`.

---

## Server Mode (`MODE=server`)

### Step 3s: Create or Resume Session via API

**If `SESSION_ID` is provided** (resume):

```bash
curl -sf -X POST http://localhost:3000/api/sessions/<SESSION_ID>/resume \
  -H "Content-Type: application/json" \
  -d '{"name": "<WORKSPACE_NAME>", "prompt": "You are ready. Await instructions."}'
```

**If `SESSION_ID` is NOT provided** (new session):

```bash
curl -sf -X POST http://localhost:3000/api/sessions/new \
  -H "Content-Type: application/json" \
  -d '{"name": "<WORKSPACE_NAME>", "prompt": "You are ready. Await instructions."}'
```

Parse the JSON response to get `id`, `name`, and `status`.

### Step 4s: Report to User

```
Workspace: <WORKSPACE_NAME>
Session:   <id from response>
Status:    <status from response>
Mode:      server (claude-code-server)

Resume: /workspace "<WORKSPACE_NAME>" "" <id>
```

---

## Local Mode (`MODE=local`)

### Step 3l: Resolve the Working Directory

If `WORKSPACE_DIR` was **not** provided by the user, run:

```bash
echo "${WORKSPACES_DIR:-$HOME/workspace}"
```

Use the printed value as `WORKSPACE_DIR`.

**Do NOT append `WORKSPACE_NAME` to this path under any circumstances.**

### Step 4l: Detect Platform

```bash
if command -v wt.exe &>/dev/null || command -v cmd.exe &>/dev/null; then echo "windows"; else echo "linux"; fi
```

Store as `PLATFORM`.

**If Windows (`windows`):** convert the directory to a Windows-style path for `wt.exe`:

```bash
cygpath -w "<WORKSPACE_DIR>"
```

Use the result as `WORKSPACE_DIR_WIN`. If `cygpath` is unavailable, manually replace a leading `/c/` with `C:\` and convert remaining `/` to `\`.

**If Linux (`linux`):** no path conversion needed.

### Step 5l: Resolve the Session ID

If `SESSION_ID` was provided in Step 1, use it and set `RESUME_MODE` to `true`.

Otherwise, generate a new one:

```bash
uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || python3 -c "import uuid; print(uuid.uuid4())"
```

Store as `SESSION_ID` and set `RESUME_MODE` to `false`. The result **must** be a valid UUID — do not fall back to timestamp-based IDs.

### Step 6l: Launch the Session

**If `RESUME_MODE` is `true`**, first attempt to launch with `--resume <SESSION_ID>`. If the resume attempt fails (non-zero exit), fall back to launching with `--session-id <SESSION_ID>` instead (same commands below, replacing `--resume` with `--session-id`).

**If `RESUME_MODE` is `false`**, launch directly with `--session-id <SESSION_ID>`.

#### Windows (WSL)

```bash
wt.exe new-tab --title "<WORKSPACE_NAME>" -d "<WORKSPACE_DIR_WIN>" -- "C:\Users\etgarcia\.local\bin\claude.exe" --dangerously-skip-permissions --remote-control --resume <SESSION_ID> --name "<WORKSPACE_NAME>"
```

**Fallback chain** if `wt.exe` fails:
1. `psmux.exe new-window -n "<WORKSPACE_NAME>" -- cmd /c "cd /d <WORKSPACE_DIR_WIN> && C:\Users\etgarcia\.local\bin\claude.exe --dangerously-skip-permissions --remote-control --resume <SESSION_ID> --name <WORKSPACE_NAME>"`
2. `cmd.exe /c start "<WORKSPACE_NAME>" /d "<WORKSPACE_DIR_WIN>" C:\Users\etgarcia\.local\bin\claude.exe --dangerously-skip-permissions --remote-control --resume <SESSION_ID> --name "<WORKSPACE_NAME>"`
3. If all fail, fall through to the Linux method.

If `RESUME_MODE` is `false`, replace `--resume <SESSION_ID>` with `--session-id <SESSION_ID>` in all commands above.

#### Linux

```bash
script -qc 'cd "<WORKSPACE_DIR>" && claude --dangerously-skip-permissions --remote-control --resume <SESSION_ID> --name "<WORKSPACE_NAME>"' /dev/null &
```

If `RESUME_MODE` is `false`, replace `--resume <SESSION_ID>` with `--session-id <SESSION_ID>`.

This allocates a pseudo-TTY (required by Claude Code) and runs the session in the background.

**Fallback** if `script` is unavailable:
1. Print the manual command for the user to run themselves.

**Fallback** if resume fails (non-zero exit, `RESUME_MODE` is `true`):
1. Re-run the same launch command with `--session-id <SESSION_ID>` instead of `--resume <SESSION_ID>`.

### Step 7l: Report to User

```
Workspace: <WORKSPACE_NAME>
Directory: <WORKSPACE_DIR>
Session:   <SESSION_ID>
Mode:      local

Resume: /workspace "<WORKSPACE_NAME>" "" <SESSION_ID>
```

---

## Examples

| Command | Result |
|---|---|
| `/workspace hello-world` | Opens session named "hello-world" (server mode if available, otherwise local) |
| `/workspace hello-world ~/projects/my-app` | Opens session in `~/projects/my-app`, named "hello-world" (local mode only) |
| `/workspace hello-world "" abc-123` | Resumes session `abc-123`, named "hello-world" |

---

## Notes

- Automatically detects whether claude-code-server is running and uses the API if available.
- `WORKSPACES_DIR` env var overrides the default root (`~/workspace`) in local mode.
- On Windows/WSL, `claude.exe` is launched directly (not via bash) so there are no PATH or shell profile issues.
- On Linux, `script -qc ... /dev/null &` allocates a PTY and backgrounds the process.
