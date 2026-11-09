import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalDatabase } from "../../src/storage/database.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createSubagentTool } from "../../src/runtime/subagents.js";
import type { ProviderRouter } from "../../src/runtime/provider-router.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("read-only subagents", () => {
  it("runs in a separate session with only read tools and a fixed step budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "nellx-subagent-"));
    roots.push(root);
    const database = await LocalDatabase.open(join(root, "test.sqlite"));
    try {
      const sessions = new SessionStore(database);
      const parent = await sessions.create(root, "parent");
      const prompts: { prompt: string; model: string }[] = [];
      const router = {
        async *streamText(request: { prompt: string; model: string }) {
          prompts.push({ prompt: request.prompt, model: request.model });
          yield JSON.stringify({
            type: "final",
            text: "Inspected the workspace.",
          });
        },
      } as unknown as ProviderRouter;
      const registry = new ToolRegistry();
      registry.register(createSubagentTool(router, sessions));
      const result = await registry.execute(
        "delegate_readonly",
        { task: "Inspect the current workspace layout." },
        {
          workspace: root,
          sessionId: parent.id,
          model: "models/test",
          mode: "normal",
        },
      );
      expect(result).toMatchObject({
        text: "Inspected the workspace.",
        steps: 1,
      });
      const child = sessions.list().find((entry) => entry.id !== parent.id);
      expect(child).toMatchObject({
        title: "Read-only subagent",
        state: "completed",
      });
      expect(prompts[0]?.model).toBe("models/test");
      expect(prompts[0]?.prompt).toContain('"name":"read_file"');
      expect(prompts[0]?.prompt).not.toContain('"name":"write_file"');
      expect(prompts[0]?.prompt).not.toContain('"name":"background_start"');
      expect(prompts[0]?.prompt).not.toContain('"name":"delegate_readonly"');
    } finally {
      database.close();
    }
  });

  it("rejects invalid tasks and requires a parent session", async () => {
    const root = await mkdtemp(join(tmpdir(), "nellx-subagent-"));
    roots.push(root);
    const database = await LocalDatabase.open(join(root, "test.sqlite"));
    try {
      const sessions = new SessionStore(database);
      const registry = new ToolRegistry();
      registry.register(createSubagentTool({} as ProviderRouter, sessions));
      await expect(
        registry.execute(
          "delegate_readonly",
          { task: " " },
          {
            workspace: root,
            mode: "normal",
          },
        ),
      ).rejects.toThrow();
      await expect(
        registry.execute(
          "delegate_readonly",
          { task: "inspect" },
          {
            workspace: root,
            mode: "normal",
          },
        ),
      ).rejects.toThrow(/active parent session/);
    } finally {
      database.close();
    }
  });
});
