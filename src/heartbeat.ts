import { readFileSync, existsSync } from "fs";
import { join } from "path";
import type { HeartbeatConfig } from "./config.js";

export interface HeartbeatStatus {
  enabled: boolean;
  intervalMinutes: number;
  nextAt: string | null;
  lastAt: string | null;
  quietHours: { start: string; end: string } | null;
}

export class Heartbeat {
  private config: HeartbeatConfig;
  private workspaceDir: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextAt: Date | null = null;
  private lastAt: Date | null = null;
  private sendFn: ((prompt: string) => void) | null = null;

  constructor(config: HeartbeatConfig, workspaceDir: string) {
    this.config = config;
    this.workspaceDir = workspaceDir;
  }

  start(sendFn: (prompt: string) => void): void {
    this.sendFn = sendFn;
    this.scheduleNext();
    console.log(`Heartbeat started: every ${this.config.intervalMinutes}m`);
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextAt = null;
    console.log("Heartbeat stopped");
  }

  updateConfig(config: HeartbeatConfig): void {
    const wasEnabled = this.config.enabled;
    this.config = config;

    if (config.enabled && this.sendFn) {
      // Reschedule with new interval
      this.stop();
      this.scheduleNext();
      console.log(`Heartbeat reconfigured: every ${config.intervalMinutes}m`);
    } else if (!config.enabled && wasEnabled) {
      this.stop();
    }
  }

  trigger(): void {
    if (this.sendFn) {
      this.fire();
    }
  }

  getStatus(): HeartbeatStatus {
    return {
      enabled: this.config.enabled,
      intervalMinutes: this.config.intervalMinutes,
      nextAt: this.nextAt?.toISOString() ?? null,
      lastAt: this.lastAt?.toISOString() ?? null,
      quietHours: this.config.quietHours ?? null,
    };
  }

  private scheduleNext(): void {
    if (!this.config.enabled) return;

    const delayMs = this.config.intervalMinutes * 60 * 1000;
    this.nextAt = new Date(Date.now() + delayMs);

    this.timer = setTimeout(() => {
      this.fire();
      this.scheduleNext(); // Reschedule after firing
    }, delayMs);
  }

  private fire(): void {
    if (this.isQuietTime()) {
      console.log("Heartbeat: skipping (quiet hours)");
      return;
    }

    const prompt = this.loadPrompt();
    console.log("Heartbeat: firing");
    this.lastAt = new Date();

    if (this.sendFn) {
      this.sendFn(prompt);
    }
  }

  private isQuietTime(): boolean {
    if (!this.config.quietHours) return false;

    const { start, end } = this.config.quietHours;
    const now = new Date();
    const nowStr = now.toLocaleString("en-US", {
      timeZone: this.config.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    // Parse HH:MM to minutes since midnight
    const toMinutes = (s: string) => {
      const [h, m] = s.split(":").map(Number);
      return h * 60 + m;
    };

    const nowMin = toMinutes(nowStr);
    const startMin = toMinutes(start);
    const endMin = toMinutes(end);

    // Handle overnight quiet hours (e.g., 22:00 - 07:00)
    if (startMin > endMin) {
      return nowMin >= startMin || nowMin < endMin;
    }
    return nowMin >= startMin && nowMin < endMin;
  }

  private loadPrompt(): string {
    const promptPath = join(this.workspaceDir, this.config.promptFile);
    const now = new Date().toLocaleString("sv-SE", {
      timeZone: this.config.timezone,
      hour12: false,
    });

    try {
      if (existsSync(promptPath)) {
        const template = readFileSync(promptPath, "utf-8");
        return template.replace(/\$\{DATETIME\}/g, now);
      }
    } catch (err) {
      console.error("Failed to load heartbeat prompt:", err);
    }

    // Fallback prompt
    return `Heartbeat check-in. Current time: ${now}. Review pending tasks and reminders. If something needs attention, mention it. If nothing needs attention, reply HEARTBEAT_OK.`;
  }
}
