import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ProviderRouter } from "../../src/runtime/provider-router.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import { LocalDatabase } from "../../src/storage/database.js";
import { ToolRegistry } from "../../src/tools/registry.js";
const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);
async function fixture(replies: string[]) {
  const directory = await mkdtemp(join(tmpdir(), "nellx-agent-"));
  roots.push(directory);
  const database = await LocalDatabase.open(join(directory, "agent.sqlite"));
  const sessions = new SessionStore(database);
  const session = await sessions.create(directory);
  const registry = new ToolRegistry();
  registry.register({
    name: "echo_value",
    description: "Return the supplied value.",
    permission: "read",
    idempotent: true,
    inputSchema: z.object({ value: z.string() }),
    async execute(input) {
      return { echoed: input.value };
    },
  });
  const prompts: string[] = [];
  const router = {
    async *streamText(request: { prompt: string }) {
      prompts.push(request.prompt);
      const reply = replies.shift();
      if (reply === undefined)
        throw new Error("No fake provider response remains.");
      yield reply;
    },
  } as unknown as ProviderRouter;
  return {
    runtime: new AgentRuntime(router, sessions, registry),
    sessions,
    session,
    database,
    prompts,
    registry,
  };
}
describe("agent runtime", () => {
  it("executes sequential validated tool calls and persists tool results", async () => {
    const f = await fixture([
      JSON.stringify({
        type: "tool_call",
        name: "echo_value",
        arguments: { value: "hello" },
      }),
      JSON.stringify({ type: "final", text: "Done." }),
    ]);
    try {
      const result = await f.runtime.run({
        sessionId: f.session.id,
        prompt: "Echo hello.",
        model: "fake",
        mode: "auto",
      });
      expect(result).toEqual({ text: "Done.", steps: 2 });
      expect(
        f.sessions
          .events(f.session.id)
          .some((event) => event.type === "tool_result"),
      ).toBe(true);
      expect(f.prompts[0]).toContain("inputSchema");
      expect(f.prompts[0]).toContain("value");
      expect(f.prompts[1]).toContain("echoed");
    } finally {
      f.database.close();
    }
  });

  it("loads nested instructions before writing into their directory", async () => {
    const f = await fixture([
      JSON.stringify({
        type: "tool_call",
        name: "write_file",
        arguments: { path: "nested/output.txt", content: "done" },
      }),
      JSON.stringify({ type: "final", text: "Done." }),
    ]);
    await mkdir(join(f.session.workspace, "nested"));
    await writeFile(
      join(f.session.workspace, "nested", "AGENTS.md"),
      "Do not write until these instructions are loaded.",
    );
    f.registry.register({
      name: "write_file",
      description: "Write a file.",
      permission: "write",
      idempotent: true,
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      async execute(input) {
        const args = z
          .object({ path: z.string(), content: z.string() })
          .parse(input);
        await writeFile(join(f.session.workspace, args.path), args.content);
        return { path: args.path };
      },
    });
    try {
      await f.runtime.run({
        sessionId: f.session.id,
        prompt: "Write it.",
        model: "fake",
        mode: "auto",
      });
      expect(f.prompts[1]).toContain(
        "Do not write until these instructions are loaded.",
      );
      await expect(
        readFile(join(f.session.workspace, "nested", "output.txt"), "utf8"),
      ).rejects.toThrow();
      const results = f.sessions
        .events(f.session.id)
        .filter((event) => event.type === "tool_result");
      expect(
        results.some((event) =>
          JSON.stringify(event.payload).includes("executed"),
        ),
      ).toBe(true);
    } finally {
      f.database.close();
    }
  });

  it("loads nested instructions before listing a directory", async () => {
    const f = await fixture([
      JSON.stringify({
        type: "tool_call",
        name: "list_files",
        arguments: { path: ".", depth: 3 },
      }),
      JSON.stringify({ type: "final", text: "Done." }),
    ]);
    await mkdir(join(f.session.workspace, "nested"));
    await writeFile(
      join(f.session.workspace, "nested", "AGENTS.md"),
      "Do not inspect this directory until these instructions are loaded.",
    );
    const execute = vi.fn(async () => ["nested/file.txt"]);
    f.registry.register({
      name: "list_files",
      description: "List files.",
      permission: "read",
      idempotent: true,
      inputSchema: z.object({ path: z.string().default(".") }),
      execute,
    });
    try {
      await f.runtime.run({
        sessionId: f.session.id,
        prompt: "Inspect the nested directory.",
        model: "fake",
        mode: "auto",
      });
      expect(f.prompts[1]).toContain(
        "Do not inspect this directory until these instructions are loaded.",
      );
      expect(execute).not.toHaveBeenCalled();
    } finally {
      f.database.close();
    }
  });

  it("rejects repeated tool-call loops and caps user prompts", async () => {
    const action = JSON.stringify({
      type: "tool_call",
      name: "echo_value",
      arguments: { value: "same" },
    });
    const f = await fixture([action, action, action]);
    try {
      await expect(
        f.runtime.run({
          sessionId: f.session.id,
          prompt: "go",
          model: "fake",
          mode: "auto",
        }),
      ).rejects.toThrow(/repeated tool-call loop/i);
      await expect(
        f.runtime.run({
          sessionId: f.session.id,
          prompt: "x".repeat(20_001),
          model: "fake",
          mode: "auto",
        }),
      ).rejects.toThrow();
    } finally {
      f.database.close();
    }
  });
  it("compacts older session context before prompting and preserves a pending operation", async () => {
    const f = await fixture([
      JSON.stringify({ type: "final", text: "Resumed safely." }),
    ]);
    try {
      await f.sessions.appendEvent(f.session.id, "user_message", {
        text: "Compatibility matters.",
      });
      const pending = await f.sessions.beginToolOperation(f.session.id, {
        toolName: "shell",
        idempotent: false,
        input: { program: "pnpm", args: ["test"] },
      });
      for (let index = 0; index < 45; index += 1) {
        await f.sessions.appendEvent(f.session.id, "assistant_message", {
          text: `Archived work ${index}`,
        });
      }
      await f.runtime.run({
        sessionId: f.session.id,
        prompt: "Continue.",
        model: "fake",
        mode: "auto",
      });
      expect(f.prompts[0]).toContain("Compatibility matters.");
      expect(f.prompts[0]).toContain(pending.id);
      expect(f.sessions.getToolOperation(pending.id).status).toBe("uncertain");
      expect(
        f.sessions.latestCheckpoint(f.session.id)?.lastEventSequence,
      ).toBeGreaterThan(0);
    } finally {
      f.database.close();
    }
  });
});
