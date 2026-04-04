import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  renameSession,
  type SDKSession,
  type SDKMessage,
  type SDKSessionOptions,
} from "@anthropic-ai/claude-agent-sdk";

interface PersistedSession {
  id: string;
  name: string;
  isHub: boolean;
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  session: SDKSession;
  status: "starting" | "running" | "ended";
  createdAt: Date;
  messages: SDKMessage[];
  isHub: boolean;
  sendMessage: (text: string) => Promise<void>;
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private cwd: string;
  private stateFile: string;
  private hubSession: SessionInfo | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.stateFile = join(cwd, ".claude-code-server-sessions.json");
  }

  private getSessionOptions(): SDKSessionOptions {
    return {
      model: "sonnet",
      permissionMode: "bypassPermissions",
    };
  }

  private saveState(): void {
    const persisted: PersistedSession[] = this.getAllSessions()
      .filter((s) => s.status !== "ended")
      .map((s) => ({
        id: s.id,
        name: s.name,
        isHub: s.isHub,
        createdAt: s.createdAt.toISOString(),
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
  }): Promise<SessionInfo> {
    const name = options?.name ?? `session-${Date.now()}`;
    const sessionOptions = this.getSessionOptions();

    // Create or resume the v2 session
    const sdkSession = options?.resume
      ? unstable_v2_resumeSession(options.resume, sessionOptions)
      : unstable_v2_createSession(sessionOptions);

    const messages: SDKMessage[] = [];

    const info: SessionInfo = {
      id: "", // filled on first message or immediately for resumed sessions
      name,
      session: sdkSession,
      status: "starting",
      createdAt: new Date(),
      messages,
      isHub: options?.isHub ?? false,
      sendMessage: async (text: string) => {
        await sdkSession.send(text);
      },
    };

    // Start consuming the message stream in background
    this.consumeMessages(info);

    // For resumed sessions, sessionId is available immediately
    if (options?.resume) {
      try {
        info.id = sdkSession.sessionId;
        info.status = "running";
      } catch {
        // sessionId not yet available, wait for init
        await this.waitForInit(info);
      }
    } else {
      // Send initial prompt if provided, to trigger init and get sessionId
      if (options?.prompt) {
        await sdkSession.send(options.prompt);
      }
      await this.waitForInit(info);
    }

    this.sessions.set(info.id, info);
    this.saveState();

    // Set session display name
    try {
      await renameSession(info.id, name, { dir: this.cwd });
      console.log(`Session ${info.id}: renamed to "${name}"`);
    } catch (err) {
      console.error(`Session ${info.id}: failed to rename:`, err);
    }

    // Enable remote control so session is accessible from claude.ai/code
    try {
      await (sdkSession as any).enableRemoteControl?.(true);
      console.log(`Session ${info.id}: remote control enabled`);
    } catch (err) {
      console.error(`Session ${info.id}: failed to enable remote control:`, err);
    }

    console.log(`Session created: ${info.id} (${name})`);
    return info;
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
      for await (const message of session.session.stream()) {
        session.messages.push(message);

        if (message.type === "system" && message.subtype === "init") {
          session.id = (message as any).session_id ?? session.id;
          session.status = "running";
        }

        // Also try to pick up sessionId from session_state_changed
        if (message.type === "system" && (message as any).session_id && session.id === "") {
          session.id = (message as any).session_id;
          session.status = "running";
        }

        if (message.type === "result") {
          console.log(`Session ${session.id}: result received`);
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
    return (session.session as any).reloadPlugins?.();
  }

  async reloadAllPlugins(): Promise<Record<string, any>> {
    const results: Record<string, any> = {};
    for (const session of this.getActiveSessions()) {
      try {
        results[session.id] = await (session.session as any).reloadPlugins?.();
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
    session.session.close();
    session.status = "ended";
    this.sessions.delete(sessionId);
    this.saveState();
  }

  async endAllSessions(): Promise<string[]> {
    const ended: string[] = [];
    for (const session of this.getActiveSessions()) {
      if (session.isHub) continue;
      session.session.close();
      session.status = "ended";
      this.sessions.delete(session.id);
      ended.push(session.id);
    }
    this.saveState();
    return ended;
  }

  async restartSession(sessionId: string): Promise<SessionInfo> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const { name, isHub } = session;
    session.session.close();
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
