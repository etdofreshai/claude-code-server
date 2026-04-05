# Claude Code Server API

Base URL: `http://localhost:3000`

## Health & State

- `GET /api/health` — Server status and active session count
- `GET /api/state` — Full server state (sessions, heartbeat, jobs, channels)

## Heartbeat

- `GET /api/heartbeat` — Heartbeat status (enabled, interval, next/last fire time)
- `POST /api/heartbeat/config` — Update heartbeat settings
  - Body: `{ "enabled?": boolean, "intervalMinutes?": number, "quietHours?": { "start": "HH:MM", "end": "HH:MM" } }`
- `POST /api/heartbeat/trigger` — Fire heartbeat immediately

## Cron Jobs

- `GET /api/jobs` — List all jobs with next fire times
- `GET /api/jobs/{name}` — Get single job detail
- `POST /api/jobs` — Create a new job
  - Body: `{ "name": string, "schedule": string, "prompt": string, "session?": string, "recurring?": boolean, "notify?": boolean }`
- `DELETE /api/jobs/{name}` — Delete a job
- `POST /api/jobs/{name}/trigger` — Fire job immediately
- `POST /api/jobs/reload` — Force reload jobs from disk

## All Sessions

- `POST /api/all-sessions/reload-plugins` — Reload plugins on all running sessions
- `POST /api/all-sessions/restart` — Restart all running sessions
- `POST /api/all-sessions/end` — End all running sessions

## Sessions

- `GET /api/sessions` — List all sessions
- `POST /api/sessions/new` — Create a new session
  - Body: `{ "name?": string, "resume?": string, "prompt?": string, "cwd?": string, "remoteControl?": boolean, "channel?": { "type": "web"|"telegram"|"discord", "targetId": string } }`

## Single Session

- `GET /api/sessions/{session_id}` — Get session info
- `POST /api/sessions/{session_id}/message` — Send a message to a session
  - Body: `{ "text": string }`
- `POST /api/sessions/{session_id}/end` — End a session
- `POST /api/sessions/{session_id}/resume` — Resume a session
  - Body: `{ "name?": string, "prompt?": string, "remoteControl?": boolean, "channel?": { ... } }`
- `POST /api/sessions/{session_id}/reload-plugins` — Reload plugins for session
- `POST /api/sessions/{session_id}/restart` — Restart a session (end + resume)
- `POST /api/sessions/{session_id}/bind` — Bind session to a channel
  - Body: `{ "channel": { "type": "web"|"telegram"|"discord", "targetId": string } }`
- `POST /api/sessions/{session_id}/unbind` — Unbind session from its channel

## Server

- `POST /api/server/restart` — Restart the server process

## Web Chat

- `GET /chat.html` — Browser-based chat UI
- `WebSocket /ws` — Real-time chat and status updates
