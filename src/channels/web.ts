import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { Channel, MessageMeta, ReplyMeta } from "./types.js";

interface WebClient {
  ws: WebSocket;
  sessionId: string | null;  // which session this client is chatting with
  room: string | null;        // room name (targetId)
}

export class WebChannel implements Channel {
  readonly type = "web" as const;
  onMessage: ((targetId: string, text: string, meta: MessageMeta) => void) | null = null;

  private wss: WebSocketServer | null = null;
  private clients = new Set<WebClient>();

  /**
   * Attach WebSocket server to an existing HTTP server.
   */
  attachToServer(server: Server): void {
    this.wss = new WebSocketServer({ server, path: "/ws" });

    this.wss.on("connection", (ws) => {
      const client: WebClient = { ws, sessionId: null, room: null };
      this.clients.add(client);

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this.handleClientMessage(client, msg);
        } catch (err) {
          console.error("WebChannel: invalid message", err);
        }
      });

      ws.on("close", () => {
        this.clients.delete(client);
      });

      // Send welcome
      ws.send(JSON.stringify({ type: "connected", ts: new Date().toISOString() }));
    });
  }

  async start(): Promise<void> {
    // WebSocket is attached to the main HTTP server, no separate start needed
    console.log("Web channel ready (attached to main server)");
  }

  async stop(): Promise<void> {
    if (this.wss) {
      for (const client of this.clients) {
        client.ws.close();
      }
      this.clients.clear();
      this.wss.close();
    }
  }

  /**
   * Send a message to all clients in a specific room.
   */
  async send(targetId: string, text: string, _meta?: ReplyMeta): Promise<void> {
    const msg = JSON.stringify({
      type: "msg",
      from: "assistant",
      text,
      room: targetId,
      ts: new Date().toISOString(),
    });

    for (const client of this.clients) {
      if (client.room === targetId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  /**
   * Broadcast status/dashboard updates to ALL connected clients.
   */
  broadcast(data: any): void {
    const msg = JSON.stringify({ type: "status", ...data });
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  /**
   * Send a message to a specific session's room (used for job results, heartbeat, etc.)
   */
  broadcastToRoom(room: string, data: any): void {
    const msg = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.room === room && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msg);
      }
    }
  }

  private handleClientMessage(client: WebClient, msg: any): void {
    switch (msg.type) {
      case "join": {
        // Client joins a room (session chat)
        client.room = msg.room ?? null;
        client.sessionId = msg.sessionId ?? null;
        client.ws.send(JSON.stringify({
          type: "joined",
          room: client.room,
          sessionId: client.sessionId,
        }));
        break;
      }

      case "msg": {
        // Client sends a chat message (optionally with images)
        if (!client.room) {
          client.ws.send(JSON.stringify({ type: "error", error: "Not in a room" }));
          return;
        }

        // Echo to other clients in the room
        const echo = JSON.stringify({
          type: "msg",
          from: "user",
          text: msg.text,
          room: client.room,
          ts: new Date().toISOString(),
          images: msg.images ?? undefined,
        });
        for (const other of this.clients) {
          if (other !== client && other.room === client.room && other.ws.readyState === WebSocket.OPEN) {
            other.ws.send(echo);
          }
        }

        // Route to channel manager
        if (this.onMessage) {
          this.onMessage(client.room, msg.text ?? "", {
            userId: client.sessionId ?? undefined,
            timestamp: new Date().toISOString(),
            images: msg.images ?? undefined,
          });
        }
        break;
      }

      case "ping": {
        client.ws.send(JSON.stringify({ type: "pong" }));
        break;
      }
    }
  }
}
