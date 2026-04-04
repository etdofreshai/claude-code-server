# Claude Code Server API

Base URL: `http://localhost:3000`

## Health

- `GET /api/health` — Server status and active session count

## All Sessions

- `POST /api/all-sessions/reload-plugins` — Reload plugins on all running sessions
- `POST /api/all-sessions/restart` — Restart all running sessions
- `POST /api/all-sessions/end` — End all running sessions

## Sessions

- `GET /api/sessions` — List all sessions
- `POST /api/sessions/new` — Create a new session
  - Body: `{ "name?": string, "resume?": string, "sessionId?": string, "prompt?": string }`

## Single Session

- `GET /api/sessions/{session_id}` — Get session info
- `POST /api/sessions/{session_id}/end` — End a session
- `POST /api/sessions/{session_id}/resume` — Resume a session
  - Body: `{ "name?": string, "prompt?": string }`
- `POST /api/sessions/{session_id}/reload-plugins` — Reload plugins for session
- `POST /api/sessions/{session_id}/restart` — Restart a session (end + resume)
