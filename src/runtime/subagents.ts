import { z } from "zod";
import { SessionStore } from "../sessions/session-store.js";
import { AgentRuntime } from "./agent-runtime.js";
import { ProviderRouter } from "./provider-router.js";
import { createBuiltinToolRegistry } from "../tools/builtins.js";
import type { ToolDefinition } from "../tools/registry.js";

const subagentInput = z
  .object({
    task: z.string().trim().min(1).max(4_000),
  })
  .strict();
const MAX_CONCURRENT_SUBAGENTS = 2;

/** Creates a bounded, read-only worker that cannot recursively create subagents. */
export function createSubagentTool(
  router: ProviderRouter,
  sessions: SessionStore,
): ToolDefinition<typeof subagentInput> {
  let active = 0;
  return {
    name: "delegate_readonly",
    description:
      "Ask an isolated read-only subagent to inspect the workspace and return findings. It cannot edit files, run commands, use MCP, or create more subagents. The child session is saved separately.",
    permission: "read",
    idempotent: false,
    inputSchema: subagentInput,
    async execute(input, context) {
      if (active >= MAX_CONCURRENT_SUBAGENTS)
        throw new Error(
          "The maximum number of concurrent subagents is already running.",
        );
      if (!context.sessionId)
        throw new Error("Subagents require an active parent session.");
      active += 1;
      let completed = false;
      const child = await sessions.create(
        context.workspace,
        "Read-only subagent",
      );
      try {
        const worker = new AgentRuntime(
          router,
          sessions,
          createBuiltinToolRegistry({ readOnly: true }),
        );
        const result = await worker.run({
          sessionId: child.id,
          prompt: input.task,
          model: context.model ?? "gemini-2.5-flash",
          mode: "plan",
          maxSteps: 4,
          ...(context.signal ? { signal: context.signal } : {}),
        });
        await sessions.setState(child.id, "completed");
        completed = true;
        return {
          sessionId: child.id,
          steps: result.steps,
          text: result.text.slice(0, 8_000),
        };
      } finally {
        if (!completed && context.signal?.aborted && child)
          await sessions.setState(child.id, "cancelled");
        active -= 1;
      }
    },
  };
}
