---
name: workspace
description: Launch a new named Claude Code session via the claude-code-server API, optionally resuming an existing session by ID. The workspace name is only a display label. Use when the user wants to open a new Claude instance with a given name.
---

# /workspace

Launch a named Claude Code session via the claude-code-server API.

Usage: `/workspace <name> [session_id]`

- `name` — session display name only
- `session_id` — UUID of an existing session to resume (optional)

---

## Instructions

### Step 1: Parse Arguments

Inspect `<command-args>`:

- **If empty:** ask the user for a workspace name. **STOP**.
- **First token** = `WORKSPACE_NAME`
- **Second token** (if present) = `SESSION_ID`

### Step 2: Create or Resume Session

**If `SESSION_ID` is provided** (resume):

```bash
curl -sf -X POST http://localhost:3000/api/sessions/<SESSION_ID>/resume \
  -H "Content-Type: application/json" \
  -d '{"name": "<WORKSPACE_NAME>", "remoteControl": true}'
```

**If `SESSION_ID` is NOT provided** (new session):

```bash
curl -sf -X POST http://localhost:3000/api/sessions/new \
  -H "Content-Type: application/json" \
  -d '{"name": "<WORKSPACE_NAME>", "remoteControl": true}'
```

Parse the JSON response to get `id`, `name`, and `status`.

If the request fails, inform the user that claude-code-server is not reachable at `localhost:3000`.

### Step 3: Report to User

```
Workspace: <WORKSPACE_NAME>
Session:   <id from response>
Status:    <status from response>

Resume:          /workspace <WORKSPACE_NAME> <id>
End session:     curl -sf -X POST http://localhost:3000/api/sessions/<id>/end
Restart session: curl -sf -X POST http://localhost:3000/api/sessions/<id>/restart
Reload plugins:  curl -sf -X POST http://localhost:3000/api/sessions/<id>/reload-plugins
Restart server:  curl -sf -X POST http://localhost:3000/api/server/restart
```

---

## Examples

| Command | Result |
|---|---|
| `/workspace hello-world` | Creates a new session named "hello-world" |
| `/workspace hello-world abc-123` | Resumes session `abc-123`, named "hello-world" |
