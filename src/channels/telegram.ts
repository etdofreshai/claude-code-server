import type { Channel, MessageMeta, ReplyMeta } from "./types.js";

interface TelegramConfig {
  token: string;
  allowedChatIds: string[];
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; title?: string; type: string };
    from?: { id: number; first_name: string; username?: string };
    text?: string;
    date: number;
  };
}

export class TelegramChannel implements Channel {
  readonly type = "telegram" as const;
  onMessage: ((targetId: string, text: string, meta: MessageMeta) => void) | null = null;

  private config: TelegramConfig;
  private polling = false;
  private lastUpdateId = 0;
  private abortController: AbortController | null = null;

  constructor(config: TelegramConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (!this.config.token) {
      console.log("Telegram channel: no token configured, skipping");
      return;
    }

    // Verify token
    const me = await this.apiCall("getMe");
    if (me?.ok) {
      console.log(`Telegram channel started: @${me.result.username}`);
    } else {
      console.error("Telegram channel: invalid token");
      return;
    }

    this.polling = true;
    this.poll();
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.abortController?.abort();
  }

  async send(targetId: string, text: string, _meta?: ReplyMeta): Promise<void> {
    // Split long messages (Telegram limit: 4096 chars)
    const chunks = this.chunkText(text, 4096);
    for (const chunk of chunks) {
      await this.apiCall("sendMessage", {
        chat_id: targetId,
        text: chunk,
        parse_mode: "HTML",
      });
    }
  }

  private async poll(): Promise<void> {
    while (this.polling) {
      try {
        this.abortController = new AbortController();
        const result = await this.apiCall("getUpdates", {
          offset: this.lastUpdateId + 1,
          timeout: 25,
        }, this.abortController.signal);

        if (result?.ok && Array.isArray(result.result)) {
          for (const update of result.result as TelegramUpdate[]) {
            this.lastUpdateId = update.update_id;
            this.handleUpdate(update);
          }
        }
      } catch (err: any) {
        if (err?.name === "AbortError") break;
        console.error("Telegram poll error:", err);
        // Back off on error
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private handleUpdate(update: TelegramUpdate): void {
    const msg = update.message;
    if (!msg?.text) return;

    const chatId = String(msg.chat.id);

    // Check allowlist
    if (this.config.allowedChatIds.length > 0 && !this.config.allowedChatIds.includes(chatId)) {
      return;
    }

    if (this.onMessage) {
      this.onMessage(chatId, msg.text, {
        userId: msg.from ? String(msg.from.id) : undefined,
        userName: msg.from?.first_name ?? msg.from?.username,
        timestamp: new Date(msg.date * 1000).toISOString(),
      });
    }
  }

  private async apiCall(method: string, params?: Record<string, any>, signal?: AbortSignal): Promise<any> {
    const url = `https://api.telegram.org/bot${this.config.token}/${method}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: params ? JSON.stringify(params) : undefined,
        signal,
      });
      return await res.json();
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
      console.error(`Telegram API ${method} error:`, err);
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
      // Try to break at newline
      let breakAt = remaining.lastIndexOf("\n", limit);
      if (breakAt < limit / 2) breakAt = limit;
      chunks.push(remaining.slice(0, breakAt));
      remaining = remaining.slice(breakAt);
    }
    return chunks;
  }
}
