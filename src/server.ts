import express from "express";
import { SessionManager } from "./session-manager.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? "/home/claude/workspace";
const HUB_NAME_TEMPLATE = process.env.HUB_NAME ?? "Hub";
const BUILD_SHA = "__BUILD_SHA__";
const BUILD_DATETIME = "__BUILD_DATETIME__";
const START_TIME = new Date();

const app = express();
app.use(express.json());

const manager = new SessionManager(WORKSPACE_DIR);

// --- Landing Page ---

function formatSession(s: { id: string; name: string; status: string; createdAt: Date; messageCount: number }) {
  return `<tr>
    <td><code>${s.id}</code></td>
    <td>${s.name}</td>
    <td><span class="status ${s.status}">${s.status}</span></td>
    <td>${s.messageCount}</td>
    <td>${new Date(s.createdAt).toISOString()}</td>
  </tr>`;
}

app.get("/", (_req, res) => {
  const hub = manager.getHub();
  const workers = manager.getWorkerSessions().map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    createdAt: s.createdAt,
    messageCount: s.messages.length,
  }));
  const uptime = Math.floor((Date.now() - START_TIME.getTime()) / 1000);
  const activeWorkers = workers.filter((s) => s.status === "running").length;

  const hubHtml = hub
    ? formatSession({ id: hub.id, name: hub.name, status: hub.status, createdAt: hub.createdAt, messageCount: hub.messages.length })
    : `<tr><td colspan="5" style="text-align:center;color:#888">Not started</td></tr>`;

  const workerRows = workers.length
    ? workers.map(formatSession).join("")
    : `<tr><td colspan="5" style="text-align:center;color:#888">No sessions</td></tr>`;

  res.type("html").send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Claude Code Server</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d1117; color: #e6edf3; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
    h2 { font-size: 1.1rem; margin-bottom: 0.75rem; margin-top: 1.5rem; }
    .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; }
    .card .label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }
    .card .value { font-size: 1.1rem; font-family: monospace; word-break: break-all; }
    .running { color: #3fb950; }
    .starting { color: #d29922; }
    .ended { color: #8b949e; }
    table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; margin-bottom: 1rem; }
    th, td { padding: 0.75rem 1rem; text-align: left; border-bottom: 1px solid #21262d; }
    th { background: #1c2128; font-size: 0.8rem; color: #8b949e; text-transform: uppercase; letter-spacing: 0.05em; }
    code { background: #1c2128; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.85em; }
    .status { padding: 0.2em 0.6em; border-radius: 12px; font-size: 0.8rem; font-weight: 500; }
    .status.running { background: #0d2818; }
    .status.starting { background: #2a1f00; }
    .status.ended { background: #1c1c1c; }
  </style>
</head>
<body>
  <h1>Claude Code Server</h1>
  <div class="meta">
    <div class="card">
      <div class="label">Status</div>
      <div class="value running">Running</div>
    </div>
    <div class="card">
      <div class="label">Build SHA</div>
      <div class="value">${BUILD_SHA}</div>
    </div>
    <div class="card">
      <div class="label">Build Date</div>
      <div class="value">${BUILD_DATETIME}</div>
    </div>
    <div class="card">
      <div class="label">Uptime</div>
      <div class="value">${uptime}s</div>
    </div>
    <div class="card">
      <div class="label">Active Sessions</div>
      <div class="value">${activeWorkers} / ${workers.length}</div>
    </div>
  </div>
  <h2>Hub Session</h2>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Messages</th><th>Created</th></tr></thead>
    <tbody>${hubHtml}</tbody>
  </table>
  <h2>Worker Sessions</h2>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Messages</th><th>Created</th></tr></thead>
    <tbody>${workerRows}</tbody>
  </table>
</body>
</html>`);
});

// --- Health ---

app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    sessions: manager.getActiveSessions().length,
  });
});

// --- All Sessions ---

app.post("/api/all-sessions/reload-plugins", async (_req, res) => {
  try {
    const results = await manager.reloadAllPlugins();
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/all-sessions/restart", async (_req, res) => {
  try {
    const sessions = await manager.restartAllSessions();
    res.json({
      restarted: sessions.map((s) => ({ id: s.id, name: s.name })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/all-sessions/end", async (_req, res) => {
  try {
    const ended = await manager.endAllSessions();
    res.json({ ended });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Session CRUD ---

app.get("/api/sessions", (_req, res) => {
  const sessions = manager.getAllSessions().map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    createdAt: s.createdAt,
    messageCount: s.messages.length,
  }));
  res.json({ sessions });
});

app.post("/api/sessions/new", async (req, res) => {
  try {
    const { name, resume, prompt } = req.body ?? {};
    const session = await manager.createSession({
      name,
      resume,
      prompt,
    });
    res.json({ id: session.id, name: session.name, status: session.status });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Single Session ---

app.get("/api/sessions/:sessionId", (req, res) => {
  const session = manager.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({
    id: session.id,
    name: session.name,
    status: session.status,
    createdAt: session.createdAt,
    messageCount: session.messages.length,
  });
});

app.post("/api/sessions/:sessionId/end", async (req, res) => {
  try {
    await manager.endSession(req.params.sessionId);
    res.json({ ended: req.params.sessionId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:sessionId/resume", async (req, res) => {
  try {
    const { name, prompt } = req.body ?? {};
    const session = await manager.createSession({
      name,
      resume: req.params.sessionId,
      prompt,
    });
    res.json({ id: session.id, name: session.name, status: session.status });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:sessionId/reload-plugins", async (req, res) => {
  try {
    const result = await manager.reloadPlugins(req.params.sessionId);
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:sessionId/restart", async (req, res) => {
  try {
    const session = await manager.restartSession(req.params.sessionId);
    res.json({ id: session.id, name: session.name, status: session.status });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Server ---

app.post("/api/server/restart", async (_req, res) => {
  res.json({ status: "restarting" });
  console.log("Server restart requested via API");
  // Exit with 0 — Docker restart policy will bring it back
  setTimeout(() => process.exit(0), 500);
});

// --- Start ---

app.listen(PORT, async () => {
  console.log(`claude-code-server listening on :${PORT}`);
  console.log(`Workspace: ${WORKSPACE_DIR}`);

  // Resolve hub name with current datetime
  const hubName = HUB_NAME_TEMPLATE.replace("${DATETIME}", new Date().toLocaleString("sv-SE", { timeZone: "America/Chicago", hour12: false }).replace(/[-: ]/g, (m) => m === " " ? "T" : ""));

  // Restore previous sessions, or start a fresh hub
  try {
    await manager.restore(hubName);
    if (!manager.getHub()) {
      const hub = await manager.startHub(hubName);
      console.log(`Hub session started: ${hub.id}`);
    } else {
      console.log(`Hub session restored: ${manager.getHub()!.id}`);
    }
  } catch (err) {
    console.error("Failed to initialize sessions:", err);
  }
});
