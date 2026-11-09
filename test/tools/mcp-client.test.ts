import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../../src/tools/mcp-client.js";
import { createBuiltinToolRegistry } from "../../src/tools/builtins.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

describe("MCP stdio client", () => {
  it("lists and calls an explicitly configured local MCP tool", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nellx-mcp-"));
    roots.push(workspace);
    await mkdir(join(workspace, ".nellx"));
    const fixture = join(process.cwd(), "test/fixtures/mcp-echo-server.mjs");
    await writeFile(
      join(workspace, ".nellx/mcp.json"),
      JSON.stringify({
        servers: { echo: { command: process.execPath, args: [fixture] } },
      }),
    );
    const client = new MCPClientManager();
    await expect(client.listTools(workspace, "echo")).resolves.toEqual([
      expect.objectContaining({
        name: "echo",
        description: "Return the supplied text",
      }),
    ]);
    await expect(
      client.callTool(workspace, "echo", "echo", { text: "hello" }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: '{"text":"hello"}' }],
    });
    await expect(
      client.callTool(workspace, "echo", "echo", {}),
    ).rejects.toThrow();
  });

  it("requires approval in Auto mode and is unavailable in Plan mode", async () => {
    const registry = createBuiltinToolRegistry();
    let approvalCount = 0;
    await expect(
      registry.execute(
        "mcp_list_tools",
        { server: "echo" },
        {
          workspace: process.cwd(),
          mode: "auto",
          requestApproval: async () => {
            approvalCount += 1;
            return false;
          },
        },
      ),
    ).rejects.toThrow(/not approved/);
    expect(approvalCount).toBe(1);
    await expect(
      registry.execute(
        "mcp_call_tool",
        {
          server: "echo",
          tool: "mutate",
          arguments: {},
        },
        { workspace: process.cwd(), mode: "plan" },
      ),
    ).rejects.toThrow(/Plan mode/);
  });

  it("rejects malformed MCP configuration before starting a process", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nellx-mcp-"));
    roots.push(workspace);
    await mkdir(join(workspace, ".nellx"));
    await writeFile(
      join(workspace, ".nellx/mcp.json"),
      JSON.stringify({
        servers: {
          bad: {
            command: "node",
            args: ["--eval", "bad"],
            env: { SECRET: "plaintext" },
          },
        },
      }),
    );
    await expect(
      new MCPClientManager().listTools(workspace, "bad"),
    ).rejects.toThrow();
  });
});
