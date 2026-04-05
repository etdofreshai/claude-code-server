import type { Channel, MessageMeta, ReplyMeta } from "./types.js";

interface DiscordConfig {
  token: string;
  allowedChannelIds: string[];
}

// Discord Gateway Intents
const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGES: 1 << 12,
  MESSAGE_CONTENT: 1 << 15,
};

export class DiscordChannel implements Channel {
  readonly type = "discord" as const;
  onMessage: ((targetId: string, text: string, meta: MessageMeta) => void) | null = null;

  private config: DiscordConfig;
  private ws: import("ws").WebSocket | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private lastSequence: number | null = null;
  private botUserId: string | null = null;
  private running = false;
  private resumeGatewayUrl: string | null = null;
  private sessionId: string | null = null;

  constructor(config: DiscordConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.token) {
      console.log("Discord channel: no token configured, skipping");
      return;
    }

    this.running = true;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.ws?.close();
    this.ws = null;
  }

  async send(targetId: string, text: string, _meta?: ReplyMeta): Promise<void> {
    // Split long messages (Discord limit: 2000 chars)
    const chunks = this.chunkText(text, 2000);
    for (const chunk of chunks) {
      await this.apiCall(`/channels/${targetId}/messages`, "POST", { content: chunk });
    }
  }

  private async connect(): Promise<void> {
    const { default: WebSocket } = await import("ws");

    // Get gateway URL
    const gateway = await this.apiCall("/gateway/bot", "GET");
    if (!gateway?.url) {
      console.error("Discord: failed to get gateway URL");
      return;
    }

    const url = `${gateway.url}/?v=10&encoding=json`;
    this.ws = new WebSocket(url);

    this.ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        this.handleGatewayEvent(data);
      } catch (err) {
        console.error("Discord: failed to parse gateway event", err);
      }
    });

    this.ws.on("close", (code) => {
      console.log(`Discord gateway closed: ${code}`);
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

      // Reconnect if still running
      if (this.running) {
        setTimeout(() => this.connect(), 5000);
      }
    });

    this.ws.on("error", (err) => {
      console.error("Discord gateway error:", err);
    });
  }

  private handleGatewayEvent(data: any): void {
    if (data.s !== null && data.s !== undefined) {
      this.lastSequence = data.s;
    }

    switch (data.op) {
      case 10: // HELLO
        this.startHeartbeat(data.d.heartbeat_interval);
        this.identify();
        break;

      case 11: // HEARTBEAT_ACK
        break;

      case 1: // HEARTBEAT request
        this.sendHeartbeat();
        break;

      case 0: // DISPATCH
        this.handleDispatch(data.t, data.d);
        break;

      case 7: // RECONNECT
        this.ws?.close();
        break;

      case 9: // INVALID_SESSION
        setTimeout(() => this.identify(), 2000);
        break;
    }
  }

  private identify(): void {
    const intents =
      INTENTS.GUILDS |
      INTENTS.GUILD_MESSAGES |
      INTENTS.GUILD_MESSAGE_REACTIONS |
      INTENTS.DIRECT_MESSAGES |
      INTENTS.MESSAGE_CONTENT;

    this.ws?.send(JSON.stringify({
      op: 2,
      d: {
        token: this.config.token,
        intents,
        properties: {
          os: "linux",
          browser: "claude-code-server",
          device: "claude-code-server",
        },
      },
    }));
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.sendHeartbeat();
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), intervalMs);
  }

  private sendHeartbeat(): void {
    this.ws?.send(JSON.stringify({ op: 1, d: this.lastSequence }));
  }

  private handleDispatch(event: string, data: any): void {
    switch (event) {
      case "READY":
        this.botUserId = data.user?.id;
        this.sessionId = data.session_id;
        this.resumeGatewayUrl = data.resume_gateway_url;
        console.log(`Discord channel started: ${data.user?.username}#${data.user?.discriminator}`);
        break;

      case "MESSAGE_CREATE":
        this.handleMessage(data);
        break;
    }
  }

  private handleMessage(data: any): void {
    // Ignore own messages
    if (data.author?.id === this.botUserId) return;
    // Ignore bot messages
    if (data.author?.bot) return;

    const channelId = data.channel_id;
    const text = data.content;
    if (!text) return;

    // Check allowlist
    if (this.config.allowedChannelIds.length > 0 && !this.config.allowedChannelIds.includes(channelId)) {
      return;
    }

    if (this.onMessage) {
      this.onMessage(channelId, text, {
        userId: data.author?.id,
        userName: data.author?.global_name ?? data.author?.username,
        timestamp: data.timestamp,
      });
    }
  }

  private async apiCall(path: string, method: string, body?: any): Promise<any> {
    try {
      const res = await fetch(`https://discord.com/api/v10${path}`, {
        method,
        headers: {
          Authorization: `Bot ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        const retry = await res.json() as any;
        const retryAfter = (retry.retry_after ?? 1) * 1000;
        console.log(`Discord rate limited, retrying in ${retryAfter}ms`);
        await new Promise((r) => setTimeout(r, retryAfter));
        return this.apiCall(path, method, body);
      }

      return await res.json();
    } catch (err) {
      console.error(`Discord API ${method} ${path} error:`, err);
      return null;
    }
  }

  private chunkText(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      if (remaining.length <= limit) {
        chunks.push(remaining);
        break;
      }
      let breakAt = remaining.lastIndexOf("\n", limit);
      if (breakAt < limit / 2) breakAt = limit;
      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt);
    }
    return chunks;
  }
}
