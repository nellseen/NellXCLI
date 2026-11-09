import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../../src/storage/database.js";
import { SessionStore } from "../../src/sessions/session-store.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function openStore(): Promise<{
  database: LocalDatabase;
  store: SessionStore;
  file: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "nellx-session-"));
  directories.push(directory);
  const file = join(directory, "nellx.sqlite");
  const database = await LocalDatabase.open(file);
  return { database, store: new SessionStore(database), file };
}

describe("SessionStore", () => {
  it("persists event history and checkpoints across database reopen", async () => {
    const first = await openStore();
    const session = await first.store.create("/workspace", "fix issue");
    await first.store.appendEvent(session.id, "user_message", {
      content: "Please update the tests",
      apiKey: "sensitive-key",
      note: "AIzaSyD-12345678901234567890",
    });
    await first.store.appendEvent(session.id, "plan_updated", {
      steps: ["inspect", "edit", "verify"],
    });
    await first.store.checkpoint(session.id, {
      userInstructions: ["do not rewrite history"],
      plan: ["edit one file"],
      completedToolResults: [],
      pendingWork: ["run unit tests"],
      lastEventSequence: 2,
    });
    const bytes = await readFile(first.file);
    expect(bytes.includes(Buffer.from("sensitive-key"))).toBe(false);
    expect(bytes.includes(Buffer.from("AIzaSyD-12345678901234567890"))).toBe(
      false,
    );
    first.database.close();

    const reopened = await LocalDatabase.open(first.file);
    const restored = new SessionStore(reopened);
    expect(restored.get(session.id).workspace).toBe("/workspace");
    expect(restored.events(session.id).map((event) => event.type)).toEqual([
      "user_message",
      "plan_updated",
      "checkpoint",
    ]);
    expect(restored.events(session.id)[0]?.payload).toMatchObject({
      apiKey: "[REDACTED]",
      note: "[REDACTED_API_KEY]",
    });
    expect(restored.latestCheckpoint(session.id)?.pendingWork).toEqual([
      "run unit tests",
    ]);
    reopened.close();
  });

  it("marks interrupted tool operations uncertain and never replays them automatically", async () => {
    const { database, store } = await openStore();
    const session = await store.create("/workspace");
    const operation = await store.beginToolOperation(session.id, {
      toolName: "shell",
      idempotent: false,
      input: { command: "touch output.txt" },
    });

    const reconciled = await store.reconcileInterruptedOperations(session.id);
    expect(reconciled).toMatchObject([
      { id: operation.id, status: "uncertain", idempotent: false },
    ]);
    expect(store.getToolOperation(operation.id).status).toBe("uncertain");
    expect(store.events(session.id).at(-1)?.payload).toMatchObject({
      safeToReplay: false,
    });
    database.close();
  });

  it("records completed tool results and rejects a second completion", async () => {
    const { database, store } = await openStore();
    const session = await store.create("/workspace");
    const operation = await store.beginToolOperation(session.id, {
      toolName: "read_file",
      idempotent: true,
      input: { path: "README.md" },
    });

    await store.finishToolOperation(operation.id, "succeeded", {
      content: "ok",
      token: "hidden",
    });
    expect(store.getToolOperation(operation.id)).toMatchObject({
      status: "succeeded",
    });
    expect(store.events(session.id).at(-1)?.payload).toMatchObject({
      result: { content: "ok", token: "[REDACTED]" },
    });
    await expect(
      store.finishToolOperation(operation.id, "succeeded", {}),
    ).rejects.toThrow(/no longer running/);
    database.close();
  });
  it("compacts old events into a durable checkpoint without losing instructions, plan, results, or pending work", async () => {
    const { database, store } = await openStore();
    const session = await store.create("/workspace", "compact context");
    try {
      await store.appendEvent(session.id, "user_message", {
        text: "Keep the API compatible.",
      });
      await store.appendEvent(session.id, "plan_updated", {
        plan: ["Inspect", "Implement", "Verify"],
      });
      await store.appendEvent(session.id, "tool_result", {
        operationId: "done-1",
        toolName: "read_file",
        result: { path: "src/index.ts" },
      });
      const pending = await store.beginToolOperation(session.id, {
        toolName: "shell",
        idempotent: false,
        input: { program: "pnpm", args: ["test"] },
      });
      for (let index = 0; index < 25; index += 1) {
        await store.appendEvent(session.id, "assistant_message", {
          text: `Progress ${index}`,
        });
      }

      const compacted = await store.compact(session.id, 10);
      expect(compacted?.userInstructions).toContain("Keep the API compatible.");
      expect(compacted?.plan).toEqual(["Inspect", "Implement", "Verify"]);
      expect(compacted?.completedToolResults).toContainEqual(
        expect.objectContaining({ operationId: "done-1" }),
      );
      expect(compacted?.pendingWork.join("\n")).toContain(pending.id);
      expect(compacted?.lastEventSequence).toBeLessThan(
        store.events(session.id).at(-1)?.sequence ?? 0,
      );
      expect(store.latestCheckpoint(session.id)).toEqual(compacted);
    } finally {
      database.close();
    }
  });
});
