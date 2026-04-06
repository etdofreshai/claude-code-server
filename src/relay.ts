import WebSocket, { WebSocketServer } from "ws";
import type { Server } from "http";
import type { SessionManager } from "./session-manager.js";
import { randomUUID } from "crypto";

// --- Protocol Types ---

interface RelayMessage {
  type: string;
  [key: string]: any;
}

export interface RemoteSessionInfo {
  id: string;
  name: string;
  status: string;
  messageCount: number;
  lastMessageAt: string | null;
  isHub: boolean;
  remoteControl: boolean;
  serverName: string;
  serverId: string;
}

interface ConnectedServer {
  id: string;
  name: string;
  ws: WebSocket;
  sessions: RemoteSessionInfo[];
  connectedAt: Date;
  lastHeartbeat: Date;
}

export interface RelayConfig {
  url: string;
  token: string;
  serverName: string;
}

// --- Relay Client ---
// Connects outbound to a remote relay server, exposes local sessions

export class RelayClient {
  private ws: WebSocket | null = null;
  private config: RelayConfig | null = null;
  private manager: SessionManager;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 5000;
  private connected = false;
  private connecting = false;
  private intentionalDisconnect = false;
  private lastError: string | null = null;

  // Callback to get session data for sending to remote
  getSessionsData: (() => RemoteSessionInfo[]) | null = null;

  constructor(manager: SessionManager) {
    this.manager = manager;
  }

  connect(config: RelayConfig): void {
    this.config = config;
    this.intentionalDisconnect = false;
    this.doConnect();
  }

  private doConnect(): void {
    if (!this.config) return;
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }

    console.log(`Relay client: connecting to ${this.config.url}...`);
    this.connecting = true;
    this.lastError = null;

    try {
      this.ws = new WebSocket(this.config.url, {
        rejectUnauthorized: false, // Allow self-signed certs
      });
    } catch (err: any) {
      console.error("Relay client: failed to create WebSocket:", err);
      this.connecting = false;
      this.lastError = err.message || "Failed to connect";
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      console.log("Relay client: connected, authenticating...");
      this.send({ type: "auth", token: this.config!.token, serverName: this.config!.serverName });
    });

    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as RelayMessage;
        this.handleMessage(msg);
      } catch {}
    });

    this.ws.on("close", () => {
      console.log("Relay client: disconnected");
      this.connected = false;
      this.connecting = false;
      this.stopHeartbeat();
      if (!this.intentionalDisconnect) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err) => {
      console.error("Relay client: error:", err.message);
      this.lastError = err.message;
      this.connecting = false;
    });
  }

  private handleMessage(msg: RelayMessage): void {
    switch (msg.type) {
      case "auth_ok":
        console.log("Relay client: authenticated");
        this.connected = true;
        this.connecting = false;
        this.lastError = null;
        this.reconnectDelay = 5000;
        this.startHeartbeat();
        this.sendSessions();
        break;

      case "auth_fail":
        console.error("Relay client: auth failed:", msg.reason);
        this.lastError = `Auth failed: ${msg.reason}`;
        this.connecting = false;
        this.intentionalDisconnect = true;
        this.ws?.close();
        break;

      case "heartbeat_ack":
        break;

      case "sessions_request":
        this.sendSessions();
        break;

      case "proxy_message":
        // Remote wants to send a message to a local session
        const session = this.manager.getSession(msg.sessionId);
        if (session && session.status === "running") {
          session.sendMessage(msg.text, msg.images);
        }
        break;
    }
  }

  sendSessions(): void {
    if (!this.connected || !this.ws) return;
    const sessions = this.getSessionsData?.() ?? [];
    this.send({ type: "sessions_response", sessions });
  }

  // Forward assistant message from local session back to relay server
  forwardMessage(sessionId: string, text: string, msgType?: string): void {
    if (!this.connected || !this.ws) return;
    this.send({ type: "proxy_response", sessionId, from: "assistant", text, msgType });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.connected = false;
    this.stopHeartbeat();
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.config = null;
    console.log("Relay client: disconnected intentionally");
  }

  getStatus(): { connected: boolean; connecting: boolean; url: string | null; serverName: string | null; error: string | null } {
    return {
      connected: this.connected,
      connecting: this.connecting,
      url: this.config?.url ?? null,
      serverName: this.config?.serverName ?? null,
      error: this.lastError,
    };
  }

  private send(msg: RelayMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      this.send({ type: "heartbeat" });
    }, 30000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) return;
    console.log(`Relay client: reconnecting in ${this.reconnectDelay / 1000}s...`);
    this.reconnectTimeout = setTimeout(() => {
      this.doConnect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 60000);
  }
}

// --- Relay Server ---
// Accepts inbound connections from relay clients

export class RelayServer {
  private wss: WebSocketServer | null = null;
  private connectedServers = new Map<string, ConnectedServer>();
  private allowedTokens: string[] = [];
  private monitorInterval: ReturnType<typeof setInterval> | null = null;

  // Callback when a proxied response comes from a remote session
  onProxyResponse: ((serverId: string, sessionId: string, from: string, text: string, msgType?: string) => void) | null = null;

  constructor() {}

  setAllowedTokens(tokens: string[]): void {
    this.allowedTokens = tokens;
  }

  attachToServer(server: Server): void {
    this.wss = new WebSocketServer({ noServer: true });

    // Handle upgrade requests manually to avoid conflicts with other WSS instances
    server.on("upgrade", (req, socket, head) => {
      if (req.url === "/relay") {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit("connection", ws, req);
        });
      }
      // Don't destroy the socket for other paths — let the other WSS handle them
    });

    this.wss.on("connection", (ws) => {
      let authenticated = false;
      let serverId = randomUUID();

      // Must authenticate within 10s
      const authTimeout = setTimeout(() => {
        if (!authenticated) {
          ws.send(JSON.stringify({ type: "auth_fail", reason: "Auth timeout" }));
          ws.close();
        }
      }, 10000);

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as RelayMessage;

          if (!authenticated) {
            if (msg.type === "auth") {
              if (this.allowedTokens.length === 0 || this.allowedTokens.includes(msg.token)) {
                clearTimeout(authTimeout);
                authenticated = true;
                const serverEntry: ConnectedServer = {
                  id: serverId,
                  name: msg.serverName || "Unknown",
                  ws,
                  sessions: [],
                  connectedAt: new Date(),
                  lastHeartbeat: new Date(),
                };
                this.connectedServers.set(serverId, serverEntry);
                ws.send(JSON.stringify({ type: "auth_ok" }));
                console.log(`Relay server: client connected - ${msg.serverName} (${serverId})`);
                // Request sessions immediately
                ws.send(JSON.stringify({ type: "sessions_request" }));
              } else {
                ws.send(JSON.stringify({ type: "auth_fail", reason: "Invalid token" }));
                ws.close();
              }
            }
            return;
          }

          const server = this.connectedServers.get(serverId);
          if (!server) return;

          this.handleMessage(server, msg);
        } catch {}
      });

      ws.on("close", () => {
        clearTimeout(authTimeout);
        const server = this.connectedServers.get(serverId);
        if (server) {
          console.log(`Relay server: client disconnected - ${server.name} (${serverId})`);
          this.connectedServers.delete(serverId);
        }
      });
    });

    // Monitor stale connections every 60s
    this.monitorInterval = setInterval(() => {
      const now = Date.now();
      for (const [id, server] of this.connectedServers) {
        if (now - server.lastHeartbeat.getTime() > 90000) {
          console.log(`Relay server: stale connection, removing ${server.name} (${id})`);
          try { server.ws.close(); } catch {}
          this.connectedServers.delete(id);
        }
      }
    }, 60000);

    console.log("Relay server ready (accepting connections on /relay)");
  }

  private handleMessage(server: ConnectedServer, msg: RelayMessage): void {
    switch (msg.type) {
      case "heartbeat":
        server.lastHeartbeat = new Date();
        server.ws.send(JSON.stringify({ type: "heartbeat_ack" }));
        break;

      case "sessions_response":
        server.sessions = (msg.sessions ?? []).map((s: any) => ({
          ...s,
          serverName: server.name,
          serverId: server.id,
        }));
        break;

      case "proxy_response":
        // A remote session sent a message back — forward to web clients
        if (this.onProxyResponse) {
          this.onProxyResponse(server.id, msg.sessionId, msg.from, msg.text, msg.msgType);
        }
        break;
    }
  }

  getConnectedServers(): Array<{ id: string; name: string; connectedAt: string; sessionCount: number }> {
    return Array.from(this.connectedServers.values()).map((s) => ({
      id: s.id,
      name: s.name,
      connectedAt: s.connectedAt.toISOString(),
      sessionCount: s.sessions.length,
    }));
  }

  getAllRemoteSessions(): RemoteSessionInfo[] {
    const sessions: RemoteSessionInfo[] = [];
    for (const server of this.connectedServers.values()) {
      sessions.push(...server.sessions);
    }
    return sessions;
  }

  proxyMessage(serverId: string, sessionId: string, text: string, images?: any[]): boolean {
    const server = this.connectedServers.get(serverId);
    if (!server || server.ws.readyState !== WebSocket.OPEN) return false;
    server.ws.send(JSON.stringify({ type: "proxy_message", sessionId, text, images }));
    return true;
  }

  // Request updated session list from a specific server
  requestSessions(serverId: string): void {
    const server = this.connectedServers.get(serverId);
    if (server && server.ws.readyState === WebSocket.OPEN) {
      server.ws.send(JSON.stringify({ type: "sessions_request" }));
    }
  }

  requestAllSessions(): void {
    for (const server of this.connectedServers.values()) {
      if (server.ws.readyState === WebSocket.OPEN) {
        server.ws.send(JSON.stringify({ type: "sessions_request" }));
      }
    }
  }

  stop(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    for (const server of this.connectedServers.values()) {
      try { server.ws.close(); } catch {}
    }
    this.connectedServers.clear();
    if (this.wss) {
      this.wss.close();
    }
  }
}
