import { readFileSync, watchFile, existsSync } from "fs";
import { join } from "path";

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  quietHours?: { start: string; end: string };
  timezone: string;
  promptFile: string;
}

export interface JobsConfig {
  dir: string;
  timezone: string;
}

export interface WebChannelConfig {
  enabled: boolean;
}

export interface TelegramChannelConfig {
  token: string;
  allowedChatIds: string[];
}

export interface DiscordChannelConfig {
  token: string;
  allowedChannelIds: string[];
}

export interface ChannelsConfig {
  web: WebChannelConfig;
  telegram?: TelegramChannelConfig;
  discord?: DiscordChannelConfig;
}

export interface SessionsConfig {
  hubRemoteControl: boolean;
  defaultRemoteControl: boolean;
}

export interface RelayConfig {
  server: {
    enabled: boolean;
    allowedTokens: string[];
  };
  client: {
    url: string;
    token: string;
    serverName: string;
    autoConnect: boolean;
  };
}

export interface ServerConfig {
  heartbeat: HeartbeatConfig;
  jobs: JobsConfig;
  channels: ChannelsConfig;
  sessions: SessionsConfig;
  relay: RelayConfig;
}

const DEFAULT_CONFIG: ServerConfig = {
  heartbeat: {
    enabled: true,
    intervalMinutes: 15,
    timezone: "America/Chicago",
    promptFile: "prompts/HEARTBEAT.md",
  },
  jobs: {
    dir: "jobs",
    timezone: "America/Chicago",
  },
  channels: {
    web: { enabled: true },
  },
  sessions: {
    hubRemoteControl: false,
    defaultRemoteControl: false,
  },
  relay: {
    server: {
      enabled: true,
      allowedTokens: [],
    },
    client: {
      url: "",
      token: "",
      serverName: "",
      autoConnect: false,
    },
  },
};

export class Config {
  private config: ServerConfig;
  private configFile: string;
  private listeners: Array<(config: ServerConfig) => void> = [];

  constructor(workspaceDir: string) {
    this.configFile = join(workspaceDir, "config.json");
    this.config = this.load();

    // Watch for changes
    if (existsSync(this.configFile)) {
      watchFile(this.configFile, { interval: 5000 }, () => {
        console.log("Config file changed, reloading...");
        this.config = this.load();
        this.notify();
      });
    }
  }

  private load(): ServerConfig {
    try {
      if (existsSync(this.configFile)) {
        const raw = readFileSync(this.configFile, "utf-8");
        const parsed = JSON.parse(raw);
        return this.merge(DEFAULT_CONFIG, parsed);
      }
    } catch (err) {
      console.error("Failed to load config:", err);
    }
    return { ...DEFAULT_CONFIG };
  }

  private merge(defaults: any, overrides: any): any {
    const result = { ...defaults };
    for (const key of Object.keys(overrides)) {
      if (
        overrides[key] &&
        typeof overrides[key] === "object" &&
        !Array.isArray(overrides[key]) &&
        defaults[key] &&
        typeof defaults[key] === "object"
      ) {
        result[key] = this.merge(defaults[key], overrides[key]);
      } else {
        result[key] = overrides[key];
      }
    }
    return result;
  }

  get(): ServerConfig {
    return this.config;
  }

  onChange(listener: (config: ServerConfig) => void): void {
    this.listeners.push(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.config);
      } catch (err) {
        console.error("Config listener error:", err);
      }
    }
  }
}
