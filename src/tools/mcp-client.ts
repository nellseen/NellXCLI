import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { resolveWorkspacePath } from "./path-guard.js";
import { redactSensitiveData } from "../security/redaction.js";

const ServerSchema = z
  .object({
    command: z
      .string()
      .min(1)
      .max(256)
      .refine((v) => !v.includes("\0")),
    args: z
      .array(
        z
          .string()
          .max(2_000)
          .refine((v) => !v.includes("\0")),
      )
      .max(64)
      .default([]),
  })
  .strict();
const ConfigSchema = z
  .object({
    servers: z
      .record(z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/), ServerSchema)
      .refine((v) => Object.keys(v).length <= 8),
  })
  .strict();
const MAX_RESULT_CHARS = 50_000;

type Config = z.infer<typeof ConfigSchema>;

/** Stdio MCP client. Each operation starts and closes a configured server process. */
export class MCPClientManager {
  async listTools(workspace: string, serverName: string): Promise<unknown> {
    const { client, transport } = await this.connect(workspace, serverName);
    try {
      const result = await client.listTools({}, { timeout: 15_000 });
      if (result.tools.length > 100)
        throw new Error("MCP server exposes more than 100 tools.");
      const tools = result.tools.map((tool) => ({
        name: tool.name.slice(0, 128),
        description: (tool.description ?? "").slice(0, 2_000),
        inputSchema: tool.inputSchema,
      }));
      if (JSON.stringify(tools).length > MAX_RESULT_CHARS)
        throw new Error("MCP tool listing exceeds the 50 KB limit.");
      return tools;
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }

  async callTool(
    workspace: string,
    serverName: string,
    toolName: string,
    arguments_: Record<string, unknown>,
  ): Promise<unknown> {
    if (toolName.length > 128 || !toolName.trim())
      throw new Error("MCP tool name is invalid.");
    const { client, transport } = await this.connect(workspace, serverName);
    try {
      const tools = await client.listTools({}, { timeout: 15_000 });
      const definition = tools.tools.find((tool) => tool.name === toolName);
      if (!definition)
        throw new Error(
          `MCP tool "${toolName}" is not provided by "${serverName}".`,
        );
      const inputSchema: unknown = JSON.parse(
        JSON.stringify(definition.inputSchema),
      );
      z.fromJSONSchema(
        inputSchema as Parameters<typeof z.fromJSONSchema>[0],
      ).parse(arguments_);
      const result = await client.callTool(
        { name: toolName, arguments: arguments_ },
        undefined,
        { timeout: 60_000 },
      );
      const safeResult = redactSensitiveData(result);
      const serialized = JSON.stringify(safeResult);
      if (serialized.length > MAX_RESULT_CHARS)
        throw new Error("MCP tool result exceeds the 50 KB limit.");
      return safeResult;
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    }
  }

  private async connect(
    workspace: string,
    serverName: string,
  ): Promise<{ client: Client; transport: StdioClientTransport }> {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(serverName))
      throw new Error("MCP server name is invalid.");
    const configPath = await resolveWorkspacePath(
      workspace,
      ".nellx/mcp.json",
      false,
    );
    const raw = await readFile(configPath, "utf8");
    if (Buffer.byteLength(raw) > 32_000)
      throw new Error("MCP configuration exceeds the 32 KB limit.");
    const config: Config = ConfigSchema.parse(JSON.parse(raw) as unknown);
    const server = config.servers[serverName];
    if (!server)
      throw new Error(`MCP server "${serverName}" is not configured.`);
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: workspace,
      stderr: "ignore",
      maxBufferSize: 1_000_000,
    });
    const client = new Client({ name: "nellxcli", version: "0.1.0" });
    try {
      await client.connect(transport, { timeout: 15_000 });
      return { client, transport };
    } catch (error) {
      await transport.close().catch(() => undefined);
      const safeReason = String(
        redactSensitiveData(
          error instanceof Error ? error.message : "connection failed",
        ),
      );
      // SDK/process errors may contain unredacted environment values.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        `Could not connect to configured MCP server "${serverName}": ${safeReason}`,
      );
    }
  }
}

export const mcpListSchema = z
  .object({ server: z.string().min(1).max(32) })
  .strict();
export const mcpCallSchema = z
  .object({
    server: z.string().min(1).max(32),
    tool: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
