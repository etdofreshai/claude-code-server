import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { query, renameSession, type Query, type SDKMessage, type SDKUserMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ChannelBinding } from "./channels/types.js";

interface PersistedSession {
  id: string;
  name: string;
  isHub: boolean;
  createdAt: string;
  remoteControl: boolean;
  channel?: ChannelBinding;
}

interface SessionHistoryEntry extends PersistedSession {
  status: "created" | "resumed" | "ended";
  timestamp: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  query: Query;
  status: "starting" | "running" | "ended";
  createdAt: Date;
  messages: SDKMessage[];
  isHub: boolean;
  remoteControl: boolean;
  channel?: ChannelBinding;
  sendMessage: (text: string, images?: ImageAttachment[]) => void;
}

export type { ImageAttachment };

/**
 * Creates an async iterable that stays open until explicitly closed.
 * Push messages into it with push(), close it with close().
 */
function createMessageStream() {
  const queue: SDKUserMessage[] = [];
  let resolve: (() => void) | null = null;
  let closed = false;

  const stream: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<SDKUserMessage>> {
          while (queue.length === 0) {
            if (closed) return { done: true, value: undefined };
            await new Promise<void>((r) => { resolve = r; });
            resolve = null;
          }
          return { done: false, value: queue.shift()! };
        },
      };
    },
  };

  return {
    stream,
    push(msg: SDKUserMessage) {
      queue.push(msg);
      resolve?.();
    },
    close() {
      closed = true;
      resolve?.();
    },
  };
}

interface ImageAttachment {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string; // base64-encoded
}

function makeUserMessage(text: string, images?: ImageAttachment[]): SDKUserMessage {
  let content: any;

  if (images && images.length > 0) {
    // Build content block array with text + images
    const blocks: any[] = [];
    if (text) {
      blocks.push({ type: "text", text });
    }
    for (const img of images) {
      blocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: img.mediaType,
          data: img.data,
        },
      });
    }
    content = blocks;
  } else {
    content = text;
  }

  return {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString(),
  };
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private cwd: string;
  private defaultOptions: Partial<Options>;
  private stateFile: string;
  private historyFile: string;
  private hubIdFile: string;
  private hubSession: SessionInfo | null = null;
  private isShuttingDown = false;
  onAssistantMessage: ((sessionId: string, text: string) => void) | null = null;
  onToolUse: ((sessionId: string, tools: string) => void) | null = null;

  constructor(cwd: string, defaultOptions: Partial<Options> = {}) {
    this.cwd = cwd;
    this.defaultOptions = defaultOptions;
    this.stateFile = join(cwd, ".claude-code-server-sessions.json");
    this.historyFile = join(cwd, ".claude-code-server-sessions-history.jsonl");
    this.hubIdFile = join(cwd, ".claude-code-server-hub-id");
  }

  private getSavedHubId(): string | null {
    try {
      return readFileSync(this.hubIdFile, "utf-8").trim() || null;
    } catch {
      return null;
    }
  }

  private saveHubId(id: string): void {
    try {
      writeFileSync(this.hubIdFile, id);
    } catch (err) {
      console.error("Failed to save hub ID:", err);
    }
  }

  private saveState(): void {
    const persisted: PersistedSession[] = this.getAllSessions()
      .filter((s) => s.status !== "ended")
      .map((s) => ({
        id: s.id,
        name: s.name,
        isHub: s.isHub,
        createdAt: s.createdAt.toISOString(),
        remoteControl: s.remoteControl,
        channel: s.channel,
      }));
    try {
      writeFileSync(this.stateFile, JSON.stringify(persisted, null, 2));
    } catch (err) {
      console.error("Failed to save session state:", err);
    }
  }

  private appendHistory(session: SessionInfo, status: SessionHistoryEntry["status"]): void {
    const entry: SessionHistoryEntry = {
      id: session.id,
      name: session.name,
      isHub: session.isHub,
      createdAt: session.createdAt.toISOString(),
      remoteControl: session.remoteControl,
      channel: session.channel,
      status,
      timestamp: new Date().toISOString(),
    };
    try {
      appendFileSync(this.historyFile, JSON.stringify(entry) + "\n");
    } catch (err) {
      console.error("Failed to append session history:", err);
    }
  }

  getHistory(): SessionHistoryEntry[] {
    try {
      const data = readFileSync(this.historyFile, "utf-8");
      return data.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  getHistoryLatest(): PersistedSession[] {
    const history = this.getHistory();
    const latest = new Map<string, SessionHistoryEntry>();
    for (const entry of history) {
      latest.set(entry.id, entry);
    }
    return Array.from(latest.values()).map(({ status, timestamp, ...rest }) => rest);
  }

  private loadState(): PersistedSession[] {
    try {
      const data = readFileSync(this.stateFile, "utf-8");
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async restore(hubName?: string): Promise<void> {
    const saved = this.loadState();
    if (saved.length === 0) return;

    console.log(`Restoring ${saved.length} session(s)...`);
    for (const entry of saved) {
      try {
        const name = entry.isHub && hubName ? hubName : entry.name;
        const session = await this.createSession({
          name,
          resume: entry.id,
          isHub: entry.isHub,
          remoteControl: entry.remoteControl,
          channel: entry.channel,
        });
        if (entry.isHub) {
          this.hubSession = session;
          this.saveHubId(session.id);
        }
        console.log(`Restored session: ${session.id} (${name})`);
      } catch (err) {
        console.error(`Failed to restore session ${entry.id}:`, err);
      }
    }
  }

  async startHub(name: string = "Hub"): Promise<SessionInfo> {
    // Reuse the persisted hub session ID if one exists, so the hub
    // always resumes the same conversation across restarts.
    const savedHubId = this.getSavedHubId();

    const session = await this.createSession({
      name,
      isHub: true,
      ...(savedHubId ? { resume: savedHubId } : {}),
    });

    // Save the hub ID for future restarts
    this.saveHubId(session.id);
    this.hubSession = session;
    return session;
  }

  getHub(): SessionInfo | null {
    return this.hubSession;
  }

  async createSession(options?: {
    name?: string;
    resume?: string;
    prompt?: string;
    isHub?: boolean;
    cwd?: string;
    remoteControl?: boolean;
    channel?: ChannelBinding;
  }): Promise<SessionInfo> {
    const isHub = options?.isHub ?? false;
    const remoteControl = options?.remoteControl ?? false;
    const name = options?.name ?? `session-${Date.now()}`;

    const isResuming = !!options?.resume;

    const { stream, push, close } = createMessageStream();

    // Only send a message if an explicit prompt was provided.
    // No bootstrap messages needed — we pre-assign the session ID via
    // Options.sessionId so we don't need to wait for the SDK's init event.
    if (options?.prompt) {
      push(makeUserMessage(options.prompt));
    }

    const abortController = new AbortController();

    // For new sessions, pre-assign a UUID so we know the ID immediately
    // without needing to wait for the SDK's init event.
    const preAssignedId = !isResuming ? randomUUID() : undefined;

    const queryOptions: Options = {
      ...this.defaultOptions,
      abortController,
      cwd: options?.cwd ?? this.cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
      extraArgs: {
        name: name,
        chrome: null,
        ...this.defaultOptions.extraArgs,
      },
      ...(isResuming ? { resume: options!.resume } : {}),
      ...(preAssignedId ? { sessionId: preAssignedId } : {}),
    };

    const q = query({ prompt: stream, options: queryOptions });
    const messages: SDKMessage[] = [];

    const sessionId = isResuming ? options!.resume! : preAssignedId!;

    const session: SessionInfo = {
      id: sessionId,
      name,
      query: q,
      status: "running",
      createdAt: new Date(),
      messages,
      isHub,
      remoteControl,
      channel: options?.channel,
      sendMessage: (text: string, images?: ImageAttachment[]) => push(makeUserMessage(text, images)),
    };

    // Store close fn and abort controller for cleanup/interrupt
    (session as any)._closeStream = close;
    (session as any)._abortController = abortController;

    // Start consuming messages in background
    this.consumeMessages(session);

    // Session ID is known immediately — no need to wait for init
    this.sessions.set(session.id, session);
    this.saveState();
    this.appendHistory(session, isResuming ? "resumed" : "created");

    if (!isResuming) {
      // Set session display name
      try {
        await renameSession(session.id, name, { dir: options?.cwd ?? this.cwd });
        console.log(`Session ${session.id}: renamed to "${name}"`);
      } catch (err) {
        console.error(`Session ${session.id}: failed to rename:`, err);
      }
    }

    // Enable remote control only if requested
    if (remoteControl) {
      try {
        await (q as any).enableRemoteControl(true);
        console.log(`Session ${session.id}: remote control enabled`);
      } catch (err) {
        console.error(`Session ${session.id}: failed to enable remote control:`, err);
      }
    }

    console.log(`Session created: ${session.id} (${name})`);
    return session;
  }

  private async consumeMessages(session: SessionInfo): Promise<void> {
    try {
      for await (const message of session.query) {
        session.messages.push(message);

        if (message.type === "system" && message.subtype === "init") {
          // Update ID if the SDK assigned a different one (shouldn't happen with pre-assigned IDs)
          const initId = (message as any).session_id;
          if (initId && initId !== session.id) {
            console.log(`Session ${session.id}: SDK assigned different ID ${initId}`);
          }
          session.status = "running";
        }

        if (message.type === "result") {
          console.log(`Session ${session.id}: result received`);
        }

        // Notify listener of assistant text and tool use messages
        if (message.type === "assistant" && session.id) {
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            const text = content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n");
            if (text && this.onAssistantMessage) {
              this.onAssistantMessage(session.id, text);
            }

            // Notify tool uses
            const toolUses = content.filter((b: any) => b.type === "tool_use");
            if (toolUses.length > 0 && this.onToolUse) {
              const tools = toolUses.map((t: any) => t.name).join(", ");
              this.onToolUse(session.id, tools);
            }
          }
        }
      }
    } catch (err) {
      console.error(`Session ${session.id} error:`, err);
    } finally {
      session.status = "ended";
      // Don't overwrite saved state during shutdown — shutdown() already saved
      // the sessions so they can be restored on next startup
      if (!this.isShuttingDown) {
        this.saveState();
        this.appendHistory(session, "ended");
      }
      console.log(`Session ${session.id}: ended`);
    }
  }

  getSession(sessionId: string): SessionInfo | undefined {
    return this.sessions.get(sessionId);
  }

  getAllSessions(): SessionInfo[] {
    return Array.from(this.sessions.values());
  }

  getActiveSessions(): SessionInfo[] {
    return this.getAllSessions().filter((s) => s.status === "running");
  }

  getWorkerSessions(): SessionInfo[] {
    return this.getAllSessions().filter((s) => !s.isHub);
  }

  async reloadPlugins(sessionId: string): Promise<any> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running") {
      throw new Error(`Session ${sessionId} not found or not running`);
    }
    return session.query.reloadPlugins();
  }

  /**
   * Interrupt a running session — aborts the current turn then resumes.
   * The session is torn down and immediately re-created with --resume.
   */
  async interruptSession(sessionId: string): Promise<SessionInfo> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const { name, isHub, remoteControl, channel } = session;

    // Abort and close the current query
    const ac = (session as any)._abortController as AbortController | undefined;
    if (ac) ac.abort();
    (session as any)._closeStream?.();
    session.query.close();
    session.status = "ended";
    this.sessions.delete(sessionId);

    // Immediately resume — creates a new query attached to the same session
    const newSession = await this.createSession({
      name,
      resume: sessionId,
      isHub,
      remoteControl,
      channel,
    });
    if (isHub) this.hubSession = newSession;

    console.log(`Session ${sessionId}: interrupted and resumed`);
    return newSession;
  }

  async reloadAllPlugins(): Promise<Record<string, any>> {
    const results: Record<string, any> = {};
    for (const session of this.getActiveSessions()) {
      try {
        results[session.id] = await session.query.reloadPlugins();
      } catch (err) {
        results[session.id] = { error: String(err) };
      }
    }
    return results;
  }

  async endSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    (session as any)._closeStream?.();
    session.query.close();
    session.status = "ended";
    this.sessions.delete(sessionId);
    this.saveState();
    this.appendHistory(session, "ended");
  }

  async endAllSessions(): Promise<string[]> {
    const ended: string[] = [];
    for (const session of this.getActiveSessions()) {
      if (session.isHub) continue;
      (session as any)._closeStream?.();
      session.query.close();
      session.status = "ended";
      this.sessions.delete(session.id);
      ended.push(session.id);
    }
    this.saveState();
    return ended;
  }

  /**
   * Graceful shutdown — close ALL sessions including hub.
   * State is saved so sessions can be restored on next startup.
   */
  shutdown(): void {
    console.log("Shutting down all sessions...");
    this.isShuttingDown = true;

    // Save state FIRST — before closing queries, because query.close() can
    // synchronously resolve the consumeMessages iterator, which sets
    // session.status = "ended". If we save after closing, all sessions
    // would be filtered out by saveState()'s status !== "ended" check.
    this.saveState();

    for (const session of this.getAllSessions()) {
      if (session.status === "ended") continue;
      try {
        (session as any)._closeStream?.();
        session.query.close();
        console.log(`Session ${session.id} (${session.name}): closed`);
      } catch (err) {
        console.error(`Session ${session.id}: failed to close:`, err);
      }
    }
  }

  async restartSession(sessionId: string): Promise<SessionInfo> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const { name, isHub } = session;
    (session as any)._closeStream?.();
    session.query.close();
    session.status = "ended";
    this.sessions.delete(sessionId);

    const newSession = await this.createSession({ name, resume: sessionId, isHub });
    if (isHub) this.hubSession = newSession;
    return newSession;
  }

  async restartAllSessions(): Promise<SessionInfo[]> {
    const active = this.getActiveSessions();
    const restarted: SessionInfo[] = [];
    for (const session of active) {
      const newSession = await this.restartSession(session.id);
      restarted.push(newSession);
    }
    return restarted;
  }
}
