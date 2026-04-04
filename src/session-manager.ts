import { query, type Query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";

export interface SessionInfo {
  id: string;
  name: string;
  query: Query;
  status: "starting" | "running" | "ended";
  createdAt: Date;
  messages: SDKMessage[];
}

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();
  private cwd: string;
  private defaultOptions: Partial<Options>;

  constructor(cwd: string, defaultOptions: Partial<Options> = {}) {
    this.cwd = cwd;
    this.defaultOptions = defaultOptions;
  }

  async createSession(options?: {
    name?: string;
    resume?: string;
    sessionId?: string;
    prompt?: string;
  }): Promise<SessionInfo> {
    const name = options?.name ?? `session-${Date.now()}`;
    const prompt = options?.prompt ?? "You are ready. Await instructions.";

    const queryOptions: Options = {
      ...this.defaultOptions,
      cwd: this.cwd,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["user", "project", "local"],
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
    };

    // Start consuming messages in background
    this.consumeMessages(session);

    // Wait for init to get session ID
    await this.waitForInit(session);

    this.sessions.set(session.id, session);
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
  }

  async endAllSessions(): Promise<string[]> {
    const ended: string[] = [];
    for (const session of this.getActiveSessions()) {
      session.query.close();
      session.status = "ended";
      this.sessions.delete(session.id);
      ended.push(session.id);
    }
    return ended;
  }

  async restartSession(sessionId: string): Promise<SessionInfo> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const { name } = session;
    session.query.close();
    session.status = "ended";
    this.sessions.delete(sessionId);

    return this.createSession({ name, resume: sessionId });
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
