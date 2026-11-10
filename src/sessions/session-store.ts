import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalDatabase } from "../storage/database.js";
import { redactSensitiveData } from "../security/redaction.js";

const SessionEventTypeSchema = z.enum([
  "user_message",
  "assistant_message",
  "plan_updated",
  "tool_call",
  "tool_started",
  "tool_result",
  "tool_failure",
  "approval",
  "provider_attempt",
  "provider_failover",
  "provider_quarantined",
  "provider_cooldown",
  "checkpoint",
  "task_complete",
  "task_cancelled",
]);
const SessionPayloadSchema = z.record(z.string(), z.unknown());
const CheckpointSchema = z.object({
  userInstructions: z.array(z.string()),
  plan: z.array(z.string()),
  completedToolResults: z.array(z.record(z.string(), z.unknown())),
  pendingWork: z.array(z.string()),
  lastEventSequence: z.number().int().nonnegative(),
});
const ToolOperationInputSchema = z.object({
  id: z.string().uuid().optional(),
  toolName: z.string().min(1).max(100),
  idempotent: z.boolean(),
  input: z.record(z.string(), z.unknown()),
});

export type SessionEventType = z.infer<typeof SessionEventTypeSchema>;
export type SessionCheckpoint = z.infer<typeof CheckpointSchema>;
export type ToolOperationStatus =
  "running" | "succeeded" | "failed" | "uncertain";
export interface SessionInfo {
  id: string;
  title: string;
  workspace: string;
  state: "active" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  model?: string;
}
export interface SessionEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: SessionEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}
export interface ToolOperation {
  id: string;
  sessionId: string;
  toolName: string;
  status: ToolOperationStatus;
  idempotent: boolean;
  input: Record<string, unknown>;
  result?: unknown;
  startedAt: string;
  finishedAt?: string;
}

export class SessionStore {
  constructor(private readonly database: LocalDatabase) {}

  async create(
    workspace: string,
    title = "New session",
    model?: string,
  ): Promise<SessionInfo> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.database.execute(
      `INSERT INTO sessions (id, title, workspace, state, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      [id, title, workspace, now, now],
    );
    if (model) await this.setModel(id, model);
    return {
      id,
      title,
      workspace,
      state: "active",
      createdAt: now,
      updatedAt: now,
      ...(model ? { model } : {}),
    };
  }

  list(): SessionInfo[] {
    const rows = this.database.query<{
      id: string;
      title: string;
      workspace: string;
      state: SessionInfo["state"];
      created_at: string;
      updated_at: string;
      model_id?: string | null;
    }>(`SELECT s.*, m.model_id FROM sessions s
       LEFT JOIN session_metadata m ON m.session_id = s.id
       ORDER BY s.updated_at DESC`);
    return rows.map(toSessionInfo);
  }

  get(sessionId: string): SessionInfo {
    const row = this.database.queryOne<{
      id: string;
      title: string;
      workspace: string;
      state: SessionInfo["state"];
      created_at: string;
      updated_at: string;
      model_id?: string | null;
    }>(
      `SELECT s.*, m.model_id FROM sessions s
       LEFT JOIN session_metadata m ON m.session_id = s.id WHERE s.id = ?`,
      [sessionId],
    );
    if (!row) throw new Error("Session was not found.");
    return toSessionInfo(row);
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    this.get(sessionId);
    const normalized = z.string().trim().min(1).max(200).parse(model);
    await this.database.execute(
      `INSERT INTO session_metadata (session_id, model_id, updated_at)
       VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET
       model_id = excluded.model_id, updated_at = excluded.updated_at`,
      [sessionId, normalized, new Date().toISOString()],
    );
    await this.database.execute(
      "UPDATE sessions SET updated_at = ? WHERE id = ?",
      [new Date().toISOString(), sessionId],
    );
  }

  async setWorkspace(sessionId: string, workspace: string): Promise<void> {
    this.get(sessionId);
    const normalized = z.string().trim().min(1).max(4_096).parse(workspace);
    await this.database.execute(
      "UPDATE sessions SET workspace = ?, updated_at = ? WHERE id = ?",
      [normalized, new Date().toISOString(), sessionId],
    );
  }

  async appendEvent(
    sessionId: string,
    type: SessionEventType,
    payload: Record<string, unknown>,
  ): Promise<SessionEvent> {
    this.get(sessionId);
    const eventType = SessionEventTypeSchema.parse(type);
    const safePayload = SessionPayloadSchema.parse(
      redactSensitiveData(payload),
    );
    const sequence =
      (this.database.queryOne<{ sequence: number }>(
        "SELECT MAX(sequence) AS sequence FROM session_events WHERE session_id = ?",
        [sessionId],
      )?.sequence ?? 0) + 1;
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    await this.database.execute(
      `INSERT INTO session_events (id, session_id, sequence, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        id,
        sessionId,
        sequence,
        eventType,
        JSON.stringify(safePayload),
        createdAt,
      ],
    );
    await this.database.execute(
      "UPDATE sessions SET updated_at = ? WHERE id = ?",
      [createdAt, sessionId],
    );
    return {
      id,
      sessionId,
      sequence,
      type: eventType,
      payload: safePayload,
      createdAt,
    };
  }

  events(sessionId: string, fromSequence = 1): SessionEvent[] {
    this.get(sessionId);
    const rows = this.database.query<{
      id: string;
      session_id: string;
      sequence: number;
      event_type: string;
      payload_json: string;
      created_at: string;
    }>(
      `SELECT * FROM session_events WHERE session_id = ? AND sequence >= ? ORDER BY sequence`,
      [sessionId, fromSequence],
    );
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      sequence: row.sequence,
      type: SessionEventTypeSchema.parse(row.event_type),
      payload: SessionPayloadSchema.parse(
        JSON.parse(row.payload_json) as unknown,
      ),
      createdAt: row.created_at,
    }));
  }

  async compact(
    sessionId: string,
    retainRecentEvents = 20,
  ): Promise<SessionCheckpoint | undefined> {
    const retain = z.number().int().min(5).max(100).parse(retainRecentEvents);
    const previous = this.latestCheckpoint(sessionId);
    const newEvents = this.events(
      sessionId,
      (previous?.lastEventSequence ?? 0) + 1,
    ).filter((event) => event.type !== "checkpoint");
    if (newEvents.length <= retain) return previous;

    const compacted = newEvents.slice(0, -retain);
    const userInstructions = [...(previous?.userInstructions ?? [])];
    let instructionSize = userInstructions.reduce(
      (total, item) => total + item.length,
      0,
    );
    for (const event of compacted) {
      if (
        event.type !== "user_message" ||
        typeof event.payload.text !== "string"
      )
        continue;
      const text = event.payload.text.trim();
      if (!text) continue;
      const clipped = text.slice(0, Math.min(text.length, 2_000));
      userInstructions.push(clipped);
      instructionSize += clipped.length;
    }
    while (instructionSize > 12_000 && userInstructions.length > 1) {
      const removed = userInstructions.splice(1, 1)[0];
      instructionSize -= removed?.length ?? 0;
    }

    let plan = previous?.plan ?? [];
    for (const event of compacted) {
      if (event.type === "plan_updated") {
        const candidate = event.payload.plan;
        if (Array.isArray(candidate)) {
          plan = candidate
            .filter((step): step is string => typeof step === "string")
            .slice(0, 20)
            .map((step) => step.slice(0, 300));
        } else if (typeof event.payload.text === "string") {
          plan = event.payload.text
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(0, 20)
            .map((step) => step.slice(0, 300));
        }
      }
    }

    const completedToolResults = [...(previous?.completedToolResults ?? [])];
    for (const event of compacted) {
      if (event.type !== "tool_result") continue;
      const serialized = JSON.stringify(event.payload);
      completedToolResults.push({
        operationId: event.payload.operationId ?? "unknown",
        toolName: event.payload.toolName ?? "unknown",
        summary:
          serialized.length > 1_500
            ? serialized.slice(0, 1_500) + " [truncated]"
            : serialized,
      });
    }
    while (completedToolResults.length > 8) completedToolResults.shift();

    const unresolved = this.database.query<{
      id: string;
      tool_name: string;
      status: ToolOperationStatus;
    }>(
      "SELECT id, tool_name, status FROM tool_operations WHERE session_id = ? AND status IN ('running', 'uncertain') ORDER BY started_at",
      [sessionId],
    );
    const pendingWork = unresolved
      .slice(0, 20)
      .map(
        (operation) =>
          `Tool operation ${operation.id} (${operation.tool_name}) is ${operation.status}; inspect its recorded state before replay.`,
      );
    const state: SessionCheckpoint = {
      userInstructions,
      plan,
      completedToolResults,
      pendingWork,
      lastEventSequence:
        compacted.at(-1)?.sequence ?? previous?.lastEventSequence ?? 0,
    };
    await this.checkpoint(sessionId, state);
    return state;
  }

  async checkpoint(sessionId: string, state: SessionCheckpoint): Promise<void> {
    this.get(sessionId);
    const validated = CheckpointSchema.parse(redactSensitiveData(state));
    const latestSequence =
      this.database.queryOne<{ sequence: number }>(
        "SELECT MAX(sequence) AS sequence FROM session_events WHERE session_id = ?",
        [sessionId],
      )?.sequence ?? 0;
    await this.database.execute(
      "INSERT INTO checkpoints (id, session_id, sequence, state_json, created_at) VALUES (?, ?, ?, ?, ?)",
      [
        randomUUID(),
        sessionId,
        latestSequence,
        JSON.stringify(validated),
        new Date().toISOString(),
      ],
    );
    await this.appendEvent(sessionId, "checkpoint", {
      sequence: latestSequence,
    });
  }

  latestCheckpoint(sessionId: string): SessionCheckpoint | undefined {
    this.get(sessionId);
    const row = this.database.queryOne<{ state_json: string }>(
      "SELECT state_json FROM checkpoints WHERE session_id = ? ORDER BY sequence DESC, created_at DESC LIMIT 1",
      [sessionId],
    );
    return row
      ? CheckpointSchema.parse(JSON.parse(row.state_json) as unknown)
      : undefined;
  }

  async beginToolOperation(
    sessionId: string,
    input: z.input<typeof ToolOperationInputSchema>,
  ): Promise<ToolOperation> {
    this.get(sessionId);
    const parsed = ToolOperationInputSchema.parse(input);
    const id = parsed.id ?? randomUUID();
    const startedAt = new Date().toISOString();
    const safeInput = SessionPayloadSchema.parse(
      redactSensitiveData(parsed.input),
    );
    await this.database.execute(
      `INSERT INTO tool_operations
        (id, session_id, tool_name, status, idempotent, input_json, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      [
        id,
        sessionId,
        parsed.toolName,
        parsed.idempotent ? 1 : 0,
        JSON.stringify(safeInput),
        startedAt,
      ],
    );
    await this.appendEvent(sessionId, "tool_started", {
      operationId: id,
      toolName: parsed.toolName,
    });
    return {
      id,
      sessionId,
      toolName: parsed.toolName,
      status: "running",
      idempotent: parsed.idempotent,
      input: safeInput,
      startedAt,
    };
  }

  async finishToolOperation(
    operationId: string,
    status: "succeeded" | "failed",
    result: unknown,
  ): Promise<void> {
    const operation = this.getToolOperation(operationId);
    if (operation.status !== "running")
      throw new Error("Tool operation is no longer running.");
    const finishedAt = new Date().toISOString();
    const safeResult = redactSensitiveData(result);
    const serialized = JSON.stringify(safeResult);
    await this.database.execute(
      "UPDATE tool_operations SET status = ?, result_json = ?, finished_at = ? WHERE id = ?",
      [status, serialized, finishedAt, operationId],
    );
    await this.appendEvent(
      operation.sessionId,
      status === "succeeded" ? "tool_result" : "tool_failure",
      {
        operationId,
        toolName: operation.toolName,
        result: safeResult,
      },
    );
  }

  getToolOperation(operationId: string): ToolOperation {
    const row = this.database.queryOne<{
      id: string;
      session_id: string;
      tool_name: string;
      status: ToolOperationStatus;
      idempotent: number;
      input_json: string;
      result_json: string | null;
      started_at: string;
      finished_at: string | null;
    }>("SELECT * FROM tool_operations WHERE id = ?", [operationId]);
    if (!row) throw new Error("Tool operation was not found.");
    return {
      id: row.id,
      sessionId: row.session_id,
      toolName: row.tool_name,
      status: row.status,
      idempotent: row.idempotent === 1,
      input: SessionPayloadSchema.parse(JSON.parse(row.input_json) as unknown),
      ...(row.result_json
        ? { result: JSON.parse(row.result_json) as unknown }
        : {}),
      startedAt: row.started_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    };
  }

  async reconcileInterruptedOperations(
    sessionId: string,
  ): Promise<ToolOperation[]> {
    this.get(sessionId);
    const rows = this.database.query<{ id: string }>(
      "SELECT id FROM tool_operations WHERE session_id = ? AND status = 'running'",
      [sessionId],
    );
    const uncertain: ToolOperation[] = [];
    for (const row of rows) {
      const finishedAt = new Date().toISOString();
      await this.database.execute(
        "UPDATE tool_operations SET status = 'uncertain', finished_at = ? WHERE id = ?",
        [finishedAt, row.id],
      );
      const operation = this.getToolOperation(row.id);
      uncertain.push(operation);
      await this.appendEvent(sessionId, "tool_failure", {
        operationId: operation.id,
        toolName: operation.toolName,
        status: "uncertain",
        safeToReplay: operation.idempotent,
      });
    }
    return uncertain;
  }

  async setState(
    sessionId: string,
    state: SessionInfo["state"],
  ): Promise<void> {
    this.get(sessionId);
    await this.database.execute(
      "UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?",
      [state, new Date().toISOString(), sessionId],
    );
  }
}

function toSessionInfo(row: {
  id: string;
  title: string;
  workspace: string;
  state: SessionInfo["state"];
  created_at: string;
  updated_at: string;
  model_id?: string | null;
}): SessionInfo {
  return {
    id: row.id,
    title: row.title,
    workspace: row.workspace,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.model_id ? { model: row.model_id } : {}),
  };
}
