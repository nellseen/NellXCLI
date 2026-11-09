import { z } from "zod";
import { redactSensitiveData } from "../security/redaction.js";

export type ToolPermission = "read" | "write" | "shell" | "destructive";
export type AgentMode = "normal" | "auto" | "plan";

export interface ToolContext {
  workspace: string;
  mode: AgentMode;
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
  requestApproval?: (summary: string) => Promise<boolean>;
}

export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  permission: ToolPermission;
  idempotent: boolean;
  approvalRequired?: boolean;
  inputSchema: TSchema;
  persistInput?: (input: z.output<TSchema>) => unknown;
  execute(input: z.output<TSchema>, context: ToolContext): Promise<unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<TSchema extends z.ZodType>(
    definition: ToolDefinition<TSchema>,
  ): void {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(definition.name)) {
      throw new Error(
        "Tool names must use lowercase letters, numbers, and underscores.",
      );
    }
    if (this.tools.has(definition.name))
      throw new Error(`Tool "${definition.name}" is already registered.`);
    this.tools.set(definition.name, definition as ToolDefinition);
  }

  getDefinition(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool "${name}".`);
    return tool;
  }

  persistInput(name: string, rawInput: unknown): unknown {
    const tool = this.getDefinition(name);
    const input = tool.inputSchema.parse(rawInput);
    return redactSensitiveData(
      tool.persistInput ? tool.persistInput(input) : input,
    );
  }

  list(): readonly {
    name: string;
    description: string;
    permission: ToolPermission;
    inputSchema: unknown;
  }[] {
    return [...this.tools.values()].map(
      ({ name, description, permission, inputSchema }) => ({
        name,
        description,
        permission,
        inputSchema: z.toJSONSchema(inputSchema),
      }),
    );
  }

  async execute(
    name: string,
    rawInput: unknown,
    context: ToolContext,
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool "${name}".`);
    const input = tool.inputSchema.parse(rawInput);

    if (context.mode === "plan" && tool.permission !== "read") {
      throw new Error(`Tool "${name}" cannot run in Plan mode.`);
    }

    const approvalRequired =
      tool.approvalRequired === true ||
      tool.permission === "destructive" ||
      (context.mode === "normal" && tool.permission === "write") ||
      tool.permission === "shell";
    if (approvalRequired) {
      if (!context.requestApproval)
        throw new Error(`Tool "${name}" requires user approval.`);
      const safeInput = JSON.stringify(redactSensitiveData(input));
      if (safeInput.length > 16_000)
        throw new Error(
          "Approval preview exceeds the 16 KB limit; split the operation into smaller steps.",
        );
      const approved = await context.requestApproval(
        `${name}: ${tool.description}\nWorkspace: ${context.workspace}\nArguments: ${safeInput}`,
      );
      if (!approved) throw new Error(`Tool "${name}" was not approved.`);
    }

    return tool.execute(input, context);
  }
}
