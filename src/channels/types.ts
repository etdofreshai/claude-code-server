export interface ImageData {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string; // base64-encoded
}

export interface MessageMeta {
  userId?: string;
  userName?: string;
  replyTo?: string;
  timestamp?: string;
  filePath?: string;
  images?: ImageData[];
}

export interface ReplyMeta {
  replyTo?: string;
  files?: string[];
}

export interface ChannelBinding {
  type: "web" | "telegram" | "discord";
  targetId: string;  // chat ID, channel ID, or web room name
}

export interface Channel {
  readonly type: "web" | "telegram" | "discord";

  start(): Promise<void>;
  stop(): Promise<void>;

  /**
   * Send a message from a session to the platform.
   */
  send(targetId: string, text: string, meta?: ReplyMeta): Promise<void>;

  /**
   * Called by the channel when a message arrives from the platform.
   * The channel manager sets this callback.
   */
  onMessage: ((targetId: string, text: string, meta: MessageMeta) => void) | null;
}
