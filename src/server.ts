import express from "express";
import { SessionManager } from "./session-manager.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? "/home/claude/workspace";

const app = express();
app.use(express.json());

const manager = new SessionManager(WORKSPACE_DIR);

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
    const { name, resume, sessionId, prompt } = req.body ?? {};
    const session = await manager.createSession({
      name,
      resume,
      sessionId,
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

// --- Start ---

app.listen(PORT, () => {
  console.log(`claude-code-server listening on :${PORT}`);
  console.log(`Workspace: ${WORKSPACE_DIR}`);
});
