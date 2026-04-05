import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
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
  sendMessage: (text: string) => void;
}

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

function makeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    timestamp: new Date().toISOString(),
  };
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private cwd: string;
  private defaultOptions: Partial<Options>;
  private stateFile: string;
  private hubSession: SessionInfo | null = null;
  onAssistantMessage: ((sessionId: string, text: string) => void) | null = null;

  constructor(cwd: string, defaultOptions: Partial<Options> = {}) {
    this.cwd = cwd;
    this.defaultOptions = defaultOptions;
    this.stateFile = join(cwd, ".claude-code-server-sessions.json");
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
        }
        console.log(`Restored session: ${session.id} (${name})`);
      } catch (err) {
        console.error(`Failed to restore session ${entry.id}:`, err);
      }
    }
  }

  async startHub(name: string = "Hub"): Promise<SessionInfo> {
    const session = await this.createSession({
      name,
      isHub: true,
    });
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
    const remoteControl = options?.remoteControl ?? (isHub ? true : false);
    const name = options?.name ?? `session-${Date.now()}`;

    const { stream, push, close } = createMessageStream();

    // Send initial prompt — required to initialize the session
    const now = new Date().toLocaleString("sv-SE", { timeZone: "America/Chicago", hour12: false });
    push(makeUserMessage(options?.prompt ?? `Server is up and ready. Current time: ${now} CT. Reply OK if you understand.`));

    const queryOptions: Options = {
      ...this.defaultOptions,
      cwd: options?.cwd ?? this.cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
      extraArgs: {
        name: name,
        chrome: null,
        ...this.defaultOptions.extraArgs,
      },
      ...(options?.resume ? { resume: options.resume } : {}),
    };

    const q = query({ prompt: stream, options: queryOptions });
    const messages: SDKMessage[] = [];

    const session: SessionInfo = {
      id: "", // filled on init message
      name,
      query: q,
      status: "starting",
      createdAt: new Date(),
      messages,
      isHub,
      remoteControl,
      channel: options?.channel,
      sendMessage: (text: string) => push(makeUserMessage(text)),
    };

    // Store close fn for cleanup
    (session as any)._closeStream = close;

    // Start consuming messages in background
    this.consumeMessages(session);

    // Wait for init to get session ID
    await this.waitForInit(session);

    this.sessions.set(session.id, session);
    this.saveState();

    // Set session display name
    try {
      await renameSession(session.id, name, { dir: options?.cwd ?? this.cwd });
      console.log(`Session ${session.id}: renamed to "${name}"`);
    } catch (err) {
      console.error(`Session ${session.id}: failed to rename:`, err);
    }

    // Enable remote control only if requested (hub defaults to true, others false)
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

  private async waitForInit(session: SessionInfo, timeoutMs: number = 30000): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const check = () => {
        if (session.id !== "") {
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          reject(new Error(`Session init timed out after ${timeoutMs}ms`));
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  private async consumeMessages(session: SessionInfo): Promise<void> {
    try {
      for await (const message of session.query) {
        session.messages.push(message);

        if (message.type === "system" && message.subtype === "init") {
          session.id = (message as any).session_id ?? session.id;
          session.status = "running";
        }

        if (message.type === "result") {
          console.log(`Session ${session.id}: result received`);
        }

        // Notify listener of assistant text messages
        if (message.type === "assistant" && this.onAssistantMessage && session.id) {
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            const text = content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n");
            if (text) {
              this.onAssistantMessage(session.id, text);
            }
          }
        }
      }
    } catch (err) {
      console.error(`Session ${session.id} error:`, err);
    } finally {
      session.status = "ended";
      this.saveState();
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
    // Save state BEFORE marking ended, so they can be restored
    this.saveState();
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
