import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { cronMatches, nextCronMatch } from "./cron.js";
import type { JobsConfig } from "./config.js";

export interface JobDefinition {
  name: string;
  schedule: string;
  session: string;       // "hub" or a session name/id
  recurring: boolean;
  notify: boolean;
  prompt: string;
}

export interface JobInfo extends JobDefinition {
  nextAt: string | null;
  lastAt: string | null;
  lastResult: string | null;
}

interface JobState {
  lastAt: Date | null;
  lastResult: string | null;
}

export class JobManager {
  private config: JobsConfig;
  private workspaceDir: string;
  private jobs = new Map<string, JobDefinition>();
  private jobState = new Map<string, JobState>();
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private reloadTimer: ReturnType<typeof setInterval> | null = null;
  private executeFn: ((jobName: string, prompt: string, session: string) => void) | null = null;

  constructor(config: JobsConfig, workspaceDir: string) {
    this.config = config;
    this.workspaceDir = workspaceDir;
  }

  start(executeFn: (jobName: string, prompt: string, session: string) => void): void {
    this.executeFn = executeFn;
    this.reload();

    // Tick every 60 seconds
    this.tickTimer = setInterval(() => this.tick(), 60_000);

    // Reload jobs from disk every 30 seconds
    this.reloadTimer = setInterval(() => this.reload(), 30_000);

    console.log(`Job manager started, watching: ${this.getJobsDir()}`);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.reloadTimer) clearInterval(this.reloadTimer);
    this.tickTimer = null;
    this.reloadTimer = null;
  }

  updateConfig(config: JobsConfig): void {
    this.config = config;
    this.reload();
  }

  reload(): void {
    const dir = this.getJobsDir();
    if (!existsSync(dir)) return;

    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    const newJobs = new Map<string, JobDefinition>();

    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), "utf-8");
        const job = this.parseJobFile(file, content);
        if (job) newJobs.set(job.name, job);
      } catch (err) {
        console.error(`Failed to parse job ${file}:`, err);
      }
    }

    this.jobs = newJobs;
  }

  private tick(): void {
    const now = new Date();

    for (const [name, job] of this.jobs) {
      if (cronMatches(job.schedule, now, this.config.timezone)) {
        console.log(`Job "${name}" triggered`);

        const state = this.jobState.get(name) ?? { lastAt: null, lastResult: null };
        state.lastAt = now;
        this.jobState.set(name, state);

        if (this.executeFn) {
          this.executeFn(name, job.prompt, job.session);
        }

        // Remove non-recurring jobs
        if (!job.recurring) {
          this.deleteJob(name);
        }
      }
    }
  }

  listJobs(): JobInfo[] {
    const now = new Date();
    return Array.from(this.jobs.values()).map((job) => {
      const state = this.jobState.get(job.name);
      let nextAt: string | null = null;
      try {
        nextAt = nextCronMatch(job.schedule, now, this.config.timezone).toISOString();
      } catch { /* ignore */ }

      return {
        ...job,
        nextAt,
        lastAt: state?.lastAt?.toISOString() ?? null,
        lastResult: state?.lastResult ?? null,
      };
    });
  }

  getJob(name: string): JobInfo | undefined {
    const job = this.jobs.get(name);
    if (!job) return undefined;

    const state = this.jobState.get(name);
    const now = new Date();
    let nextAt: string | null = null;
    try {
      nextAt = nextCronMatch(job.schedule, now, this.config.timezone).toISOString();
    } catch { /* ignore */ }

    return {
      ...job,
      nextAt,
      lastAt: state?.lastAt?.toISOString() ?? null,
      lastResult: state?.lastResult ?? null,
    };
  }

  createJob(name: string, schedule: string, prompt: string, options?: Partial<Pick<JobDefinition, "session" | "recurring" | "notify">>): void {
    const dir = this.getJobsDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const content = [
      "---",
      `schedule: "${schedule}"`,
      `session: ${options?.session ?? "hub"}`,
      `recurring: ${options?.recurring ?? true}`,
      `notify: ${options?.notify ?? true}`,
      "---",
      prompt,
    ].join("\n");

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-");
    writeFileSync(join(dir, `${safeName}.md`), content);
    this.reload();
  }

  deleteJob(name: string): void {
    const dir = this.getJobsDir();
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "-");
    const filePath = join(dir, `${safeName}.md`);

    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch (err) {
      console.error(`Failed to delete job ${name}:`, err);
    }

    this.jobs.delete(name);
    this.jobState.delete(name);
  }

  triggerJob(name: string): void {
    const job = this.jobs.get(name);
    if (!job) throw new Error(`Job "${name}" not found`);

    const state = this.jobState.get(name) ?? { lastAt: null, lastResult: null };
    state.lastAt = new Date();
    this.jobState.set(name, state);

    if (this.executeFn) {
      this.executeFn(name, job.prompt, job.session);
    }
  }

  private getJobsDir(): string {
    return join(this.workspaceDir, this.config.dir);
  }

  private parseJobFile(filename: string, content: string): JobDefinition | null {
    const name = basename(filename, ".md");

    // Parse YAML-like frontmatter
    const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!match) {
      // No frontmatter — treat entire content as prompt with defaults
      return {
        name,
        schedule: "0 * * * *", // hourly default
        session: "hub",
        recurring: true,
        notify: true,
        prompt: content.trim(),
      };
    }

    const [, frontmatter, body] = match;
    const meta: Record<string, string> = {};
    for (const line of frontmatter.split("\n")) {
      const kv = line.match(/^\s*(\w+)\s*:\s*(.+)\s*$/);
      if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
    }

    if (!meta.schedule) {
      console.warn(`Job "${name}" has no schedule, skipping`);
      return null;
    }

    return {
      name,
      schedule: meta.schedule,
      session: meta.session ?? "hub",
      recurring: meta.recurring !== "false",
      notify: meta.notify !== "false",
      prompt: body.trim(),
    };
  }
}
