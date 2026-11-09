import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { resolveWorkspacePath } from "./path-guard.js";
import { redactSensitiveData } from "../security/redaction.js";

const TaskStatusSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    program: z.enum(["git", "node", "pnpm", "npm", "python", "python3"]),
    label: z.string().min(1).max(120),
    state: z.enum([
      "pending",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
      "unknown",
    ]),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    pid: z.number().int().positive().optional(),
    exitCode: z.number().int().nullable().optional(),
  })
  .strict();
export type BackgroundTaskStatus = z.infer<typeof TaskStatusSchema>;

export const backgroundStartSchema = z
  .object({
    program: z.enum(["git", "node", "pnpm", "npm", "python", "python3"]),
    label: z.string().trim().min(1).max(120),
    args: z
      .array(
        z
          .string()
          .max(2_000)
          .refine((value) => !value.includes("\0")),
      )
      .max(100),
    timeoutSeconds: z.number().int().min(10).max(3_600).default(900),
  })
  .strict();
export const backgroundIdSchema = z.object({ id: z.string().uuid() }).strict();

const MAX_ACTIVE_TASKS = 3;
const wrapperSource = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [command, argsJson, cwd, statusPath, cancelPath, timeoutText] = process.argv.slice(1);
const task = JSON.parse(fs.readFileSync(statusPath, "utf8"));
const atomicWrite = (next) => {
  const temp = statusPath + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(temp, statusPath);
};
let child;
let cancelled = false;
let timedOut = false;
let finished = false;
let cancelPoll;
let timeout;
let heartbeat;
let forceKill;
const finish = (state, exitCode) => {
  if (finished) return;
  finished = true;
  if (cancelPoll) clearInterval(cancelPoll);
  if (timeout) clearTimeout(timeout);
  if (heartbeat) clearInterval(heartbeat);
  if (forceKill) clearTimeout(forceKill);
  try { fs.unlinkSync(cancelPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  atomicWrite({ ...task, state, exitCode, updatedAt: new Date().toISOString() });
};
try {
  child = spawn(command, JSON.parse(argsJson), { cwd, shell: false, stdio: "ignore", windowsHide: true });
  task.state = "running";
  task.pid = child.pid;
  task.updatedAt = new Date().toISOString();
  atomicWrite(task);
} catch {
  finish("failed", 127);
  process.exit(1);
}
cancelPoll = setInterval(() => {
  if (!cancelled && fs.existsSync(cancelPath)) {
    cancelled = true;
    child.kill("SIGTERM");
    forceKill = setTimeout(() => child.kill("SIGKILL"), 3_000);
  }
}, 250);
timeout = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
  forceKill = setTimeout(() => child.kill("SIGKILL"), 3_000);
}, Number(timeoutText) * 1000);
heartbeat = setInterval(() => {
  task.updatedAt = new Date().toISOString();
  atomicWrite(task);
}, 5_000);
child.once("error", () => finish("failed", 127));
child.once("close", (code) => finish(cancelled ? "cancelled" : timedOut ? "timed_out" : code === 0 ? "succeeded" : "failed", code));
`;

export class BackgroundTaskManager {
  async start(
    workspace: string,
    sessionId: string,
    input: z.input<typeof backgroundStartSchema>,
  ): Promise<BackgroundTaskStatus> {
    const parsedSessionId = z.string().uuid().parse(sessionId);
    const args = backgroundStartSchema.parse(input);
    const directory = await this.taskDirectory(workspace, true);
    const tasks = await this.list(workspace, parsedSessionId);
    if (
      tasks.filter(
        (task) => task.state === "pending" || task.state === "running",
      ).length >= MAX_ACTIVE_TASKS
    )
      throw new Error(
        `At most ${MAX_ACTIVE_TASKS} background tasks may run per session.`,
      );

    const id = randomUUID();
    const now = new Date().toISOString();
    const statusPath = join(directory, `${id}.json`);
    const cancelPath = join(directory, `${id}.cancel`);
    const initial = TaskStatusSchema.parse({
      id,
      sessionId: parsedSessionId,
      program: args.program,
      label: String(redactSensitiveData(args.label)),
      state: "pending",
      startedAt: now,
      updatedAt: now,
    });
    await writeFile(statusPath, JSON.stringify(initial), {
      flag: "wx",
      mode: 0o600,
    });

    try {
      const child = spawn(
        process.execPath,
        [
          "-e",
          wrapperSource,
          args.program,
          JSON.stringify(args.args),
          workspace,
          statusPath,
          cancelPath,
          String(args.timeoutSeconds),
        ],
        {
          cwd: workspace,
          detached: true,
          shell: false,
          stdio: "ignore",
          windowsHide: true,
        },
      );
      child.once("error", async () => {
        const failed = {
          ...initial,
          state: "failed" as const,
          updatedAt: new Date().toISOString(),
          exitCode: 127,
        };
        await this.writeStatus(statusPath, failed);
      });
      child.unref();
    } catch (error) {
      await rm(statusPath, { force: true });
      throw error;
    }
    return initial;
  }

  async list(
    workspace: string,
    sessionId: string,
  ): Promise<BackgroundTaskStatus[]> {
    const parsedSessionId = z.string().uuid().parse(sessionId);
    const directory = await this.taskDirectory(workspace, false);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const tasks: BackgroundTaskStatus[] = [];
    for (const name of names) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      const path = await resolveWorkspacePath(
        workspace,
        `.nellx/tasks/${name}`,
        false,
      );
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const status = TaskStatusSchema.parse(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
      if (status.id !== name.slice(0, -5))
        throw new Error(
          "Background task status ID does not match its filename.",
        );
      if (status.sessionId === parsedSessionId)
        tasks.push(this.expireStale(status));
    }
    return tasks.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async get(
    workspace: string,
    sessionId: string,
    id: string,
  ): Promise<BackgroundTaskStatus> {
    const taskId = z.string().uuid().parse(id);
    const parsedSessionId = z.string().uuid().parse(sessionId);
    const path = await resolveWorkspacePath(
      workspace,
      `.nellx/tasks/${taskId}.json`,
      false,
    );
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Background task status is not a regular file.");
    const status = TaskStatusSchema.parse(
      JSON.parse(await readFile(path, "utf8")) as unknown,
    );
    if (status.id !== taskId)
      throw new Error("Background task ID does not match its status file.");
    if (status.sessionId !== parsedSessionId)
      throw new Error("Background task was not found in this session.");
    return status;
  }

  async cancel(
    workspace: string,
    sessionId: string,
    id: string,
  ): Promise<BackgroundTaskStatus> {
    const status = await this.get(workspace, sessionId, id);
    if (status.state !== "pending" && status.state !== "running")
      throw new Error(`Background task is already ${status.state}.`);
    const directory = await this.taskDirectory(workspace, false);
    const cancelPath = join(directory, `${status.id}.cancel`);
    const handle = await open(cancelPath, "wx", 0o600);
    await handle.close();
    return this.expireStale(status);
  }

  private expireStale(status: BackgroundTaskStatus): BackgroundTaskStatus {
    const isActive = status.state === "pending" || status.state === "running";
    const age = Date.now() - Date.parse(status.updatedAt);
    return isActive && age > 30_000 ? { ...status, state: "unknown" } : status;
  }

  private async taskDirectory(
    workspace: string,
    create: boolean,
  ): Promise<string> {
    const path = await resolveWorkspacePath(workspace, ".nellx/tasks", true);
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    return path;
  }

  private async writeStatus(
    path: string,
    status: BackgroundTaskStatus,
  ): Promise<void> {
    const temp = `${path}.tmp-${process.pid}`;
    await writeFile(temp, JSON.stringify(status), { mode: 0o600 });
    await rename(temp, path);
  }
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
