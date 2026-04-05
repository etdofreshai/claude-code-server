import express from "express";
import { createServer } from "http";
import { join } from "path";
import { getSessionMessages, unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { SessionManager } from "./session-manager.js";
import { Config } from "./config.js";
import { Heartbeat } from "./heartbeat.js";
import { JobManager } from "./jobs.js";
import { ChannelManager } from "./channels/manager.js";
import { WebChannel } from "./channels/web.js";
import { TelegramChannel } from "./channels/telegram.js";
import { DiscordChannel } from "./channels/discord.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR ?? "/home/claude/workspace";
const HUB_NAME_TEMPLATE = process.env.HUB_NAME ?? "Hub";
const BUILD_SHA = "__BUILD_SHA__";
const BUILD_DATETIME = "__BUILD_DATETIME__";
const START_TIME = new Date();

// --- Initialize ---

const config = new Config(WORKSPACE_DIR);
const manager = new SessionManager(WORKSPACE_DIR);
const heartbeat = new Heartbeat(config.get().heartbeat, WORKSPACE_DIR);
const jobManager = new JobManager(config.get().jobs, WORKSPACE_DIR);
const channelManager = new ChannelManager(manager);

// Web channel (always on)
const webChannel = new WebChannel();
channelManager.registerChannel(webChannel);

// Telegram channel (if configured)
const telegramConfig = config.get().channels.telegram;
if (telegramConfig?.token) {
  channelManager.registerChannel(new TelegramChannel(telegramConfig));
}

// Discord channel (if configured)
const discordConfig = config.get().channels.discord;
if (discordConfig?.token) {
  channelManager.registerChannel(new DiscordChannel(discordConfig));
}

// Config hot-reload
config.onChange((newConfig) => {
  heartbeat.updateConfig(newConfig.heartbeat);
  jobManager.updateConfig(newConfig.jobs);
});

// --- Express App ---

const app = express();
app.use(express.json());

// Serve static frontend
app.use(express.static(join(import.meta.dirname, "../public")));

// --- Landing Page ---

function formatSession(s: { id: string; name: string; status: string; createdAt: Date; messageCount: number; remoteControl: boolean; channel?: { type: string; targetId: string } }) {
  const channelBadge = s.channel
    ? `<span class="badge channel">${s.channel.type}:${s.channel.targetId}</span>`
    : "";
  const rcBadge = s.remoteControl
    ? `<span class="badge rc">RC</span>`
    : "";
  return `<tr>
    <td><code>${s.id}</code></td>
    <td>${s.name}</td>
    <td><span class="status ${s.status}">${s.status}</span></td>
    <td>${s.messageCount}</td>
    <td>${channelBadge}${rcBadge}</td>
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
    remoteControl: s.remoteControl,
    channel: s.channel,
  }));
  const uptime = Math.floor((Date.now() - START_TIME.getTime()) / 1000);
  const activeWorkers = workers.filter((s) => s.status === "running").length;
  const hbStatus = heartbeat.getStatus();
  const jobs = jobManager.listJobs();

  const hubHtml = hub
    ? formatSession({ id: hub.id, name: hub.name, status: hub.status, createdAt: hub.createdAt, messageCount: hub.messages.length, remoteControl: hub.remoteControl, channel: hub.channel })
    : `<tr><td colspan="6" style="text-align:center;color:#888">Not started</td></tr>`;

  const workerRows = workers.length
    ? workers.map(formatSession).join("")
    : `<tr><td colspan="6" style="text-align:center;color:#888">No sessions</td></tr>`;

  const heartbeatHtml = hbStatus.enabled
    ? `<div class="card"><div class="label">Heartbeat</div><div class="value running">Every ${hbStatus.intervalMinutes}m${hbStatus.nextAt ? ` · Next: ${new Date(hbStatus.nextAt).toLocaleTimeString()}` : ""}</div></div>`
    : `<div class="card"><div class="label">Heartbeat</div><div class="value ended">Disabled</div></div>`;

  const jobsHtml = jobs.length
    ? jobs.map((j) => `<tr><td>${j.name}</td><td><code>${j.schedule}</code></td><td>${j.session}</td><td>${j.nextAt ? new Date(j.nextAt).toLocaleTimeString() : "—"}</td></tr>`).join("")
    : `<tr><td colspan="4" style="text-align:center;color:#888">No jobs</td></tr>`;

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
    .badge { display: inline-block; padding: 0.15em 0.5em; border-radius: 8px; font-size: 0.75rem; margin-right: 0.25rem; }
    .badge.channel { background: #1a3a5c; color: #58a6ff; }
    .badge.rc { background: #2a1f00; color: #d29922; }
    nav { margin-bottom: 1.5rem; }
    nav a { color: #58a6ff; text-decoration: none; margin-right: 1rem; }
    nav a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>Claude Code Server</h1>
  <nav><a href="/">Dashboard</a><a href="/chat.html">Chat</a></nav>
  <div class="meta">
    <div class="card">
      <div class="label">Status</div>
      <div class="value running">Running</div>
    </div>
    <div class="card">
      <div class="label">Build</div>
      <div class="value">${BUILD_SHA.slice(0, 7)} · ${BUILD_DATETIME}</div>
    </div>
    <div class="card">
      <div class="label">Uptime</div>
      <div class="value">${uptime}s</div>
    </div>
    <div class="card">
      <div class="label">Active Sessions</div>
      <div class="value">${activeWorkers} / ${workers.length}</div>
    </div>
    ${heartbeatHtml}
  </div>
  <h2>Hub Session</h2>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Messages</th><th>Channels</th><th>Created</th></tr></thead>
    <tbody>${hubHtml}</tbody>
  </table>
  <h2>Worker Sessions</h2>
  <table>
    <thead><tr><th>ID</th><th>Name</th><th>Status</th><th>Messages</th><th>Channels</th><th>Created</th></tr></thead>
    <tbody>${workerRows}</tbody>
  </table>
  <h2>Cron Jobs</h2>
  <table>
    <thead><tr><th>Name</th><th>Schedule</th><th>Session</th><th>Next</th></tr></thead>
    <tbody>${jobsHtml}</tbody>
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

// --- State (combined endpoint) ---

app.get("/api/state", (_req, res) => {
  const sessions = manager.getAllSessions().map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    createdAt: s.createdAt,
    messageCount: s.messages.length,
    isHub: s.isHub,
    remoteControl: s.remoteControl,
    channel: s.channel,
  }));

  res.json({
    uptime: Math.floor((Date.now() - START_TIME.getTime()) / 1000),
    heartbeat: heartbeat.getStatus(),
    jobs: jobManager.listJobs(),
    sessions,
    channels: channelManager.getAllBindings(),
    workspaceDir: WORKSPACE_DIR,
  });
});

// --- Heartbeat ---

app.get("/api/heartbeat", (_req, res) => {
  res.json(heartbeat.getStatus());
});

app.post("/api/heartbeat/config", (req, res) => {
  const newConfig = { ...config.get().heartbeat, ...req.body };
  heartbeat.updateConfig(newConfig);
  res.json(heartbeat.getStatus());
});

app.post("/api/heartbeat/trigger", (_req, res) => {
  heartbeat.trigger();
  res.json({ triggered: true });
});

// --- Jobs ---

app.get("/api/jobs", (_req, res) => {
  res.json({ jobs: jobManager.listJobs() });
});

app.get("/api/jobs/:name", (req, res) => {
  const job = jobManager.getJob(req.params.name);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

app.post("/api/jobs", (req, res) => {
  try {
    const { name, schedule, prompt, session, recurring, notify } = req.body;
    if (!name || !schedule || !prompt) {
      return res.status(400).json({ error: "name, schedule, and prompt are required" });
    }
    jobManager.createJob(name, schedule, prompt, { session, recurring, notify });
    res.json({ created: name });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.delete("/api/jobs/:name", (req, res) => {
  try {
    jobManager.deleteJob(req.params.name);
    res.json({ deleted: req.params.name });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/jobs/:name/trigger", (req, res) => {
  try {
    jobManager.triggerJob(req.params.name);
    res.json({ triggered: req.params.name });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/jobs/reload", (_req, res) => {
  jobManager.reload();
  res.json({ reloaded: true, jobs: jobManager.listJobs() });
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
  const sessions = manager.getAllSessions().map((s) => {
    // Count messages from the JSONL file on disk for an accurate count
    const projectSlug = WORKSPACE_DIR.replace(/\//g, "-");
    const jsonlPath = join(
      process.env.HOME ?? "/home/claude",
      ".claude/projects",
      projectSlug,
      `${s.id}.jsonl`
    );
    let messageCount = 0;
    try {
      if (existsSync(jsonlPath)) {
        const data = readFileSync(jsonlPath, "utf-8");
        for (const line of data.split("\n")) {
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "user" || msg.type === "assistant") {
              messageCount++;
            }
          } catch {}
        }
      }
    } catch {}

    return {
      id: s.id,
      name: s.name,
      status: s.status,
      createdAt: s.createdAt,
      messageCount,
      isHub: s.isHub,
      remoteControl: s.remoteControl,
      channel: s.channel,
    };
  });
  res.json({ sessions });
});

app.get("/api/sessions/history", (_req, res) => {
  res.json({ sessions: manager.getHistoryLatest() });
});

app.post("/api/sessions/new", async (req, res) => {
  try {
    const { name, resume, prompt, cwd, remoteControl, channel } = req.body ?? {};
    const session = await manager.createSession({
      name,
      cwd,
      resume,
      prompt,
      remoteControl,
      channel,
    });

    // Bind to channel if specified
    if (channel) {
      channelManager.bind(session.id, channel);
    }

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
    remoteControl: session.remoteControl,
    channel: session.channel,
  });
});

app.get("/api/sessions/:sessionId/messages", (req, res) => {
  const session = manager.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  // Read from the JSONL file on disk (full conversation history)
  // Claude Code stores sessions at ~/.claude/projects/<slug>/<sessionId>.jsonl
  // where slug is the cwd with / replaced by - (leading slash becomes the first -)
  const projectSlug = WORKSPACE_DIR.replace(/\//g, "-");
  const jsonlPath = join(
    process.env.HOME ?? "/home/claude",
    ".claude/projects",
    projectSlug,
    `${req.params.sessionId}.jsonl`
  );

  const messages: Array<{ from: string; type: string; text: string; ts: string | null; images?: Array<{ mediaType: string; data: string }> }> = [];

  try {
    if (existsSync(jsonlPath)) {
      const data = readFileSync(jsonlPath, "utf-8");
      const lines = data.split("\n").filter(Boolean);

      for (const line of lines) {
        try {
          const msg = JSON.parse(line);

          if (msg.type === "user") {
            // Skip tool results (internal plumbing)
            const content = msg.message?.content;
            const hasToolResult = Array.isArray(content) && content.some((b: any) => b.type === "tool_result");
            if (hasToolResult) continue;

            // Extract image blocks if present
            let images: Array<{ mediaType: string; data: string }> | undefined;
            if (Array.isArray(content)) {
              const imageBlocks = content.filter((b: any) => b.type === "image" && b.source?.type === "base64");
              if (imageBlocks.length > 0) {
                images = imageBlocks.map((b: any) => ({
                  mediaType: b.source.media_type,
                  data: b.source.data,
                }));
              }
            }

            // Extract text, filtering out SDK image metadata (e.g. "[Image: original 2048x2048...]")
            let text: string | null;
            if (typeof content === "string") {
              text = content;
            } else if (Array.isArray(content)) {
              const textBlocks = content
                .filter((b: any) => b.type === "text")
                .filter((b: any) => !images || !b.text?.startsWith("[Image:"))
                .map((b: any) => b.text);
              text = textBlocks.length > 0 ? textBlocks.join("\n") : null;
            } else {
              text = null;
            }

            if (text || images) {
              messages.push({ from: "user", type: "text", text: text || "", ts: msg.timestamp ?? null, images });
            }

          } else if (msg.type === "assistant") {
            const content = msg.message?.content;
            if (!Array.isArray(content)) continue;

            // Extract text blocks
            const textParts = content.filter((b: any) => b.type === "text").map((b: any) => b.text);
            if (textParts.length > 0) {
              messages.push({ from: "assistant", type: "text", text: textParts.join("\n"), ts: null });
            }

            // Note tool uses (collapsed summary)
            const toolUses = content.filter((b: any) => b.type === "tool_use");
            if (toolUses.length > 0) {
              const tools = toolUses.map((t: any) => t.name).join(", ");
              messages.push({ from: "assistant", type: "tool", text: tools, ts: null });
            }
          }
        } catch { /* skip unparseable lines */ }
      }
    }
  } catch (err) {
    console.error("Failed to read JSONL:", err);
  }

  // Also append any recent in-memory messages not yet flushed to JSONL
  // (messages from the current turn that haven't been written to disk yet)
  // This is handled by the SDK, so the JSONL should be up to date.

  res.json({ messages });
});

app.post("/api/sessions/:sessionId/remote-control", async (req, res) => {
  const session = manager.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "running") return res.status(400).json({ error: "Session not running" });

  const { enabled } = req.body ?? {};
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled (boolean) is required" });

  try {
    await (session.query as any).enableRemoteControl(enabled);
    session.remoteControl = enabled;
    res.json({ remoteControl: enabled });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:sessionId/set-hub", (req, res) => {
  const session = manager.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    manager.setHub(req.params.sessionId);
    res.json({ isHub: true, sessionId: req.params.sessionId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:sessionId/message", (req, res) => {
  const session = manager.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.status !== "running") return res.status(400).json({ error: "Session not running" });

  const { text } = req.body ?? {};
  if (!text) return res.status(400).json({ error: "text is required" });

  session.sendMessage(text);
  res.json({ sent: true });
});

app.post("/api/sessions/:sessionId/end", async (req, res) => {
  try {
    await manager.endSession(req.params.sessionId);
    channelManager.unbind(req.params.sessionId);
    res.json({ ended: req.params.sessionId });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:sessionId/resume", async (req, res) => {
  try {
    const { name, prompt, cwd, remoteControl, channel } = req.body ?? {};
    const session = await manager.createSession({
      name,
      cwd,
      resume: req.params.sessionId,
      prompt,
      remoteControl,
      channel,
    });

    if (channel) {
      channelManager.bind(session.id, channel);
    }

    res.json({ id: session.id, name: session.name, status: session.status });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:sessionId/interrupt", async (req, res) => {
  try {
    const session = await manager.interruptSession(req.params.sessionId);
    res.json({ id: session.id, name: session.name, status: session.status, interrupted: true });
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

app.post("/api/sessions/:sessionId/bind", (req, res) => {
  const session = manager.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  const { channel } = req.body ?? {};
  if (!channel?.type || !channel?.targetId) {
    return res.status(400).json({ error: "channel.type and channel.targetId required" });
  }

  channelManager.bind(req.params.sessionId, channel);
  session.channel = channel;
  res.json({ bound: true, channel });
});

app.post("/api/sessions/:sessionId/unbind", (req, res) => {
  const session = manager.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  channelManager.unbind(req.params.sessionId);
  session.channel = undefined;
  res.json({ unbound: true });
});

// --- Send to Workspace ---

// Helper: extract text from SDK message content
function extractMessageText(msg: any): string {
  const content = msg.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n");
  }
  return "";
}

// Helper: read recent messages formatted as context
async function getRecentContext(sessionId: string, sessionName: string): Promise<string> {
  const msgs = await getSessionMessages(sessionId, { dir: WORKSPACE_DIR, limit: 20 });
  const lines: string[] = [];
  for (const msg of msgs) {
    if (msg.type === "system") continue;
    const msgText = extractMessageText(msg);
    if (!msgText) continue;
    const role = msg.type === "user" ? "User" : "Assistant";
    lines.push(`${role}: ${msgText}`);
  }
  if (lines.length > 0) {
    return `[Context from "${sessionName}" — last ${lines.length} messages]:\n${lines.join("\n\n")}`;
  }
  return "";
}

// Summarize a session using a one-off query (does NOT modify the original session)
app.post("/api/sessions/:sessionId/summarize", async (req, res) => {
  const session = manager.getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    // Read all messages from the session
    const msgs = await getSessionMessages(req.params.sessionId, { dir: WORKSPACE_DIR, limit: 50 });
    const lines: string[] = [];
    for (const msg of msgs) {
      if (msg.type === "system") continue;
      const msgText = extractMessageText(msg);
      if (!msgText) continue;
      const role = msg.type === "user" ? "User" : "Assistant";
      lines.push(`${role}: ${msgText}`);
    }

    if (lines.length === 0) {
      return res.json({ summary: "(No messages in this session)" });
    }

    // Use a one-off query to summarize — completely separate from the original session
    const transcript = lines.join("\n\n");
    const prompt = `Here is a conversation transcript from a workspace called "${session.name}":\n\n${transcript}\n\nPlease provide a concise summary of this conversation. Focus on: what tasks were discussed, what was accomplished, what's in progress, and any key decisions made. Format it as a brief, readable summary. Respond ONLY with the summary text, nothing else.`;

    const result = await unstable_v2_prompt(prompt, {
      model: "claude-sonnet-4-6",
    });

    if (result.type === "result" && result.subtype === "success") {
      res.json({ summary: result.result });
    } else {
      res.status(500).json({ error: "Summary generation failed" });
    }
  } catch (err) {
    console.error("Failed to summarize session:", err);
    res.status(500).json({ error: String(err) });
  }
});

app.post("/api/sessions/:sessionId/send-to", async (req, res) => {
  const sourceSession = manager.getSession(req.params.sessionId);
  if (!sourceSession) return res.status(404).json({ error: "Source session not found" });

  const { targetSessionId, text, images, mode } = req.body ?? {};
  if (!targetSessionId) return res.status(400).json({ error: "targetSessionId is required" });

  const targetSession = manager.getSession(targetSessionId);
  if (!targetSession) return res.status(404).json({ error: "Target session not found" });
  if (targetSession.status !== "running") return res.status(400).json({ error: "Target session not running" });

  // Build context based on mode
  let contextBlock = "";
  try {
    if (mode === "summary") {
      // Summarize using a one-off query (does NOT modify the source session)
      const msgs = await getSessionMessages(req.params.sessionId, { dir: WORKSPACE_DIR, limit: 50 });
      const lines: string[] = [];
      for (const msg of msgs) {
        if (msg.type === "system") continue;
        const msgText = extractMessageText(msg);
        if (!msgText) continue;
        const role = msg.type === "user" ? "User" : "Assistant";
        lines.push(`${role}: ${msgText}`);
      }

      if (lines.length > 0) {
        const transcript = lines.join("\n\n");
        const prompt = `Here is a conversation transcript from a workspace called "${sourceSession.name}":\n\n${transcript}\n\nPlease provide a concise summary of this conversation. Focus on: what tasks were discussed, what was accomplished, what's in progress, and any key decisions made. Format it as a brief, readable summary. Respond ONLY with the summary text, nothing else.`;

        const result = await unstable_v2_prompt(prompt, { model: "claude-sonnet-4-6" });
        if (result.type === "result" && result.subtype === "success") {
          contextBlock = `[Summary from "${sourceSession.name}"]:\n${result.result}`;
        }
      }
    } else {
      // Default: include recent messages (no truncation)
      contextBlock = await getRecentContext(req.params.sessionId, sourceSession.name);
    }
  } catch (err) {
    console.error("Failed to build context:", err);
    // Continue without context rather than failing
  }

  const fullMessage = contextBlock
    ? `${contextBlock}\n\n[Request]:\n${text || ""}`
    : `[Request from "${sourceSession.name}"]:\n${text || ""}`;

  // Convert images if present
  const imageAttachments = images?.map((img: any) => ({
    mediaType: img.mediaType,
    data: img.data,
  }));

  targetSession.sendMessage(fullMessage, imageAttachments);
  res.json({ sent: true, targetSessionId });
});

// --- Disk Sessions (for restore) ---

app.get("/api/disk-sessions", async (_req, res) => {
  const homeDir = process.env.HOME ?? "/home/claude";
  const projectsDir = join(homeDir, ".claude/projects");

  try {
    // List all folders in ~/.claude/projects/
    const folders: string[] = [];
    try {
      const entries = readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          folders.push(entry.name);
        }
      }
    } catch {
      return res.json({ folders: [], sessions: {} });
    }

    // For each folder, list .jsonl session files with their last modified time and name
    const sessions: Record<string, Array<{ id: string; name: string | null; lastModified: string; sizeBytes: number }>> = {};

    for (const folder of folders) {
      const folderPath = join(projectsDir, folder);
      try {
        const files = readdirSync(folderPath);
        const folderSessions: Array<{ id: string; name: string | null; lastModified: string; sizeBytes: number }> = [];

        for (const file of files) {
          if (!file.endsWith(".jsonl")) continue;
          const sessionId = file.replace(".jsonl", "");
          try {
            const filePath = join(folderPath, file);
            const stat = statSync(filePath);

            // Read session name from the first few lines (look for custom-title)
            let name: string | null = null;
            try {
              const data = readFileSync(filePath, "utf-8");
              // Only scan the first few lines for the title
              const firstLines = data.slice(0, 2000).split("\n").slice(0, 10);
              for (const line of firstLines) {
                if (!line) continue;
                try {
                  const entry = JSON.parse(line);
                  if (entry.type === "custom-title" && entry.customTitle) {
                    name = entry.customTitle;
                    break;
                  }
                } catch { /* skip unparseable lines */ }
              }
            } catch { /* skip unreadable files */ }

            folderSessions.push({
              id: sessionId,
              name,
              lastModified: stat.mtime.toISOString(),
              sizeBytes: stat.size,
            });
          } catch { /* skip unreadable files */ }
        }

        // Sort by lastModified descending (newest first)
        folderSessions.sort((a, b) => new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime());

        if (folderSessions.length > 0) {
          sessions[folder] = folderSessions;
        }
      } catch { /* skip unreadable folders */ }
    }

    res.json({ folders: folders.filter(f => sessions[f]), sessions });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// --- Server ---

app.post("/api/server/restart", async (_req, res) => {
  res.json({ status: "restarting" });
  console.log("Server restart requested via API");
  setTimeout(() => process.exit(0), 500);
});

// --- Start ---

const httpServer = createServer(app);

// Attach WebSocket to the HTTP server
webChannel.attachToServer(httpServer);

// Route assistant messages to web channel (session ID = room name)
manager.onAssistantMessage = (sessionId, text) => {
  webChannel.send(sessionId, text);
  // Also route to bound channels (telegram, discord, etc.)
  channelManager.sendToChannel(sessionId, text);
};

// Route tool use notifications to web channel
manager.onToolUse = (sessionId, tools) => {
  webChannel.broadcastToRoom(sessionId, {
    type: "msg",
    from: "assistant",
    text: tools,
    room: sessionId,
    ts: new Date().toISOString(),
    msgType: "tool",
  });
};

httpServer.listen(PORT, async () => {
  console.log(`claude-code-server listening on :${PORT}`);
  console.log(`Workspace: ${WORKSPACE_DIR}`);

  // Start channels
  await channelManager.startAll();

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

    // Restore channel bindings for all sessions
    for (const session of manager.getAllSessions()) {
      if (session.channel) {
        channelManager.bind(session.id, session.channel);
      }
    }
  } catch (err) {
    console.error("Failed to initialize sessions:", err);
  }

  // Start heartbeat — sends to hub session
  heartbeat.start((prompt) => {
    const hub = manager.getHub();
    if (hub && hub.status === "running") {
      hub.sendMessage(prompt);
    }
  });

  // Start job manager — executes by sending prompt to target session
  jobManager.start((jobName, prompt, sessionTarget) => {
    let session;
    if (sessionTarget === "hub") {
      session = manager.getHub();
    } else {
      // Try by name first, then by ID
      session = manager.getAllSessions().find((s) => s.name === sessionTarget) ??
                manager.getSession(sessionTarget);
    }

    if (session && session.status === "running") {
      console.log(`Job "${jobName}" → session ${session.id} (${session.name})`);
      session.sendMessage(prompt);
    } else {
      console.error(`Job "${jobName}": target session "${sessionTarget}" not found or not running`);
    }
  });

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // prevent double shutdown
    shuttingDown = true;
    console.log("\nGraceful shutdown initiated...");
    heartbeat.stop();
    jobManager.stop();
    await channelManager.stopAll();
    manager.shutdown();
    httpServer.close();
    // Give child processes time to exit cleanly
    console.log("Waiting for child processes to exit...");
    await new Promise((r) => setTimeout(r, 3000));
    console.log("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("beforeExit", shutdown);

  console.log("All systems initialized");
});
