import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundTaskManager } from "../../src/tools/background-tasks.js";
import { createBuiltinToolRegistry } from "../../src/tools/builtins.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      }),
    ),
  ),
);

async function waitForState(
  manager: BackgroundTaskManager,
  workspace: string,
  sessionId: string,
  taskId: string,
  states: string[],
): Promise<string> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const task = await manager.get(workspace, sessionId, taskId);
    if (states.includes(task.state)) return task.state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Background task did not reach an expected state in time.");
}

describe("background tasks", () => {
  it("runs an approved argv process and persists its terminal status", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nellx-background-"));
    roots.push(workspace);
    const sessionId = randomUUID();
    const manager = new BackgroundTaskManager();
    const started = await manager.start(workspace, sessionId, {
      program: "node",
      label: "Run test child",
      args: ["-e", "process.exit(0)"],
      timeoutSeconds: 10,
    });
    expect(started.state).toBe("pending");
    await expect(
      waitForState(manager, workspace, sessionId, started.id, [
        "succeeded",
        "failed",
      ]),
    ).resolves.toBe("succeeded");
    await expect(manager.list(workspace, sessionId)).resolves.toEqual([
      expect.objectContaining({
        id: started.id,
        state: "succeeded",
        exitCode: 0,
      }),
    ]);
    await expect(
      manager.get(workspace, randomUUID(), started.id),
    ).rejects.toThrow(/not found/);
  }, 15_000);

  it("cancels a running process through its task marker", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nellx-background-"));
    roots.push(workspace);
    const sessionId = randomUUID();
    const manager = new BackgroundTaskManager();
    const started = await manager.start(workspace, sessionId, {
      program: "node",
      label: "Run test child",
      args: ["-e", "setTimeout(() => {}, 60000)"],
      timeoutSeconds: 60,
    });
    await waitForState(manager, workspace, sessionId, started.id, ["running"]);
    await manager.cancel(workspace, sessionId, started.id);
    await expect(
      waitForState(manager, workspace, sessionId, started.id, ["cancelled"]),
    ).resolves.toBe("cancelled");
  }, 15_000);

  it("omits command arguments from persisted session tool history", () => {
    const persisted = createBuiltinToolRegistry().persistInput(
      "background_start",
      {
        program: "node",
        label: "run package tests",
        args: ["-e", "console.log('do not persist this argument')"],
        timeoutSeconds: 20,
      },
    );
    expect(persisted).toEqual({
      program: "node",
      label: "run package tests",
      args: "[omitted from persisted session history]",
      timeoutSeconds: 20,
    });
  });

  it("rejects arguments with NUL bytes before launching a process", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nellx-background-"));
    roots.push(workspace);
    await expect(
      new BackgroundTaskManager().start(workspace, randomUUID(), {
        program: "node",
        label: "Invalid argv test",
        args: ["\0"],
      }),
    ).rejects.toThrow();
  });
});
