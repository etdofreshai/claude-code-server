import type { Channel, ChannelBinding, MessageMeta } from "./types.js";
import type { SessionManager, SessionInfo } from "../session-manager.js";

interface BindingEntry {
  sessionId: string;
  binding: ChannelBinding;
}

export class ChannelManager {
  private channels = new Map<string, Channel>();
  private bindings: BindingEntry[] = [];
  private sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  registerChannel(channel: Channel): void {
    channel.onMessage = (targetId, text, meta) => {
      this.handleInbound(channel.type, targetId, text, meta);
    };
    this.channels.set(channel.type, channel);
  }

  async startAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.start();
        console.log(`Channel started: ${channel.type}`);
      } catch (err) {
        console.error(`Failed to start channel ${channel.type}:`, err);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.stop();
      } catch (err) {
        console.error(`Failed to stop channel ${channel.type}:`, err);
      }
    }
  }

  /**
   * Bind a session to a channel target.
   * Messages from that target route to the session; session replies route back.
   */
  bind(sessionId: string, binding: ChannelBinding): void {
    // Remove any existing binding for this session
    this.bindings = this.bindings.filter((b) => b.sessionId !== sessionId);
    this.bindings.push({ sessionId, binding });
    console.log(`Bound session ${sessionId} → ${binding.type}:${binding.targetId}`);
  }

  unbind(sessionId: string): void {
    this.bindings = this.bindings.filter((b) => b.sessionId !== sessionId);
  }

  getBinding(sessionId: string): ChannelBinding | undefined {
    return this.bindings.find((b) => b.sessionId === sessionId)?.binding;
  }

  getSessionForTarget(type: string, targetId: string): string | undefined {
    return this.bindings.find(
      (b) => b.binding.type === type && b.binding.targetId === targetId
    )?.sessionId;
  }

  getAllBindings(): Array<{ sessionId: string; binding: ChannelBinding }> {
    return [...this.bindings];
  }

  /**
   * Send a message from a session to its bound channel.
   */
  async sendToChannel(sessionId: string, text: string): Promise<void> {
    const entry = this.bindings.find((b) => b.sessionId === sessionId);
    if (!entry) return;

    const channel = this.channels.get(entry.binding.type);
    if (!channel) return;

    await channel.send(entry.binding.targetId, text);
  }

  /**
   * Broadcast to all connected web clients (for dashboard updates).
   */
  async broadcastWebUpdate(data: any): Promise<void> {
    const web = this.channels.get("web");
    if (web && "broadcast" in web) {
      (web as any).broadcast(data);
    }
  }

  /**
   * Handle an inbound message from a channel platform.
   */
  private handleInbound(type: string, targetId: string, text: string, meta: MessageMeta): void {
    // For web channel, the targetId IS the session ID (room = session ID)
    let sessionId = this.getSessionForTarget(type, targetId);

    if (!sessionId && type === "web") {
      // Direct routing: web chat rooms use session ID as room name
      sessionId = targetId;
    }

    if (!sessionId) {
      console.log(`No session bound to ${type}:${targetId}, ignoring message`);
      return;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session || session.status !== "running") {
      console.log(`Session ${sessionId} not running, ignoring message from ${type}:${targetId}`);
      return;
    }

    const prefix = meta.userName ? `[${meta.userName}] ` : "";
    session.sendMessage(`${prefix}${text}`);
  }
}
