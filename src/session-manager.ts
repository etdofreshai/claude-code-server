import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { query, type Query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";

interface PersistedSession {
  id: string;
  name: string;
  isHub: boolean;
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  name: string;
  query: Query;
  status: "starting" | "running" | "ended";
  createdAt: Date;
  messages: SDKMessage[];
  isHub: boolean;
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private cwd: string;
  private defaultOptions: Partial<Options>;
  private stateFile: string;
  private hubSession: SessionInfo | null = null;

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

  async restore(): Promise<void> {
    const saved = this.loadState();
    if (saved.length === 0) return;

    console.log(`Restoring ${saved.length} session(s)...`);
    for (const entry of saved) {
      try {
        const session = await this.createSession({
          name: entry.name,
          resume: entry.id,
          isHub: entry.isHub,
        });
        if (entry.isHub) {
          this.hubSession = session;
        }
        console.log(`Restored session: ${session.id} (${entry.name})`);
      } catch (err) {
        console.error(`Failed to restore session ${entry.id}:`, err);
      }
    }
  }

  async startHub(): Promise<SessionInfo> {
    const session = await this.createSession({
      name: "Hub",
      prompt: "You are the hub session for claude-code-server. You are always running. Await instructions.",
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
    sessionId?: string;
    prompt?: string;
    isHub?: boolean;
  }): Promise<SessionInfo> {
    const name = options?.name ?? `session-${Date.now()}`;
    const prompt = options?.prompt ?? "You are ready. Await instructions.";

    const queryOptions: Options = {
      ...this.defaultOptions,
      cwd: this.cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
      extraArgs: {
        "remote-control": null,
        ...this.defaultOptions.extraArgs,
      },
      ...(options?.resume ? { resume: options.resume } : {}),
      ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    };

    const q = query({ prompt, options: queryOptions });
    const messages: SDKMessage[] = [];

    const session: SessionInfo = {
      id: "", // filled on init message
      name,
      query: q,
      status: "starting",
      createdAt: new Date(),
      messages,
      isHub: options?.isHub ?? false,
    };

    // Start consuming messages in background
    this.consumeMessages(session);

    // Wait for init to get session ID
    await this.waitForInit(session);

    this.sessions.set(session.id, session);
    this.saveState();
    console.log(`Session created: ${session.id} (${name})`);
    return session;
  }

  private async waitForInit(session: SessionInfo): Promise<void> {
    return new Promise((resolve) => {
      const check = () => {
        if (session.id !== "") {
          resolve();
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
    session.query.close();
    session.status = "ended";
    this.sessions.delete(sessionId);
    this.saveState();
  }

  async endAllSessions(): Promise<string[]> {
    const ended: string[] = [];
    for (const session of this.getActiveSessions()) {
      if (session.isHub) continue;
      session.query.close();
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
