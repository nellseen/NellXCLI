import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { AgentMode } from "./tools/registry.js";
import type { ModelInfo } from "./providers/provider.js";
import { canonicalModelId } from "./providers/provider.js";
import type { SelectOption } from "./tui-select.js";

export interface ChatSessionChoice {
  id: string;
  title: string;
  workspace: string;
  history?: string[];
  model?: string;
}
export interface ChatAccountChoice {
  id: string;
  label: string;
  active: boolean;
}
export interface ChatProps {
  sessionId: string;
  sessionTitle: string;
  model: string;
  accountLabel: string;
  workspace: string;
  onSubmit: (
    sessionId: string,
    prompt: string,
    model: string,
    mode: AgentMode,
    onChunk: (chunk: string) => void,
    requestApproval: (summary: string) => Promise<boolean>,
    onActivity: (message: string) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  onListSessions: () => Promise<ChatSessionChoice[]>;
  onResume: (sessionId: string) => Promise<ChatSessionChoice>;
  onNew: () => Promise<ChatSessionChoice>;
  onListModels: () => Promise<readonly ModelInfo[]>;
  onSetModel: (sessionId: string, model: string) => Promise<void>;
  onListAccounts: () => Promise<ChatAccountChoice[]>;
  onSelectAccount: (profileId: string) => Promise<string>;
  onPrepareWorkspace: (path: string) => Promise<string>;
  onSetWorkspace: (sessionId: string, path: string) => Promise<void>;
  onDiff: (sessionId: string) => Promise<string>;
}
type ChatSelection =
  | { kind: "model"; options: SelectOption<ModelInfo>[] }
  | { kind: "account"; options: SelectOption<ChatAccountChoice>[] };
const SELECTION_PAGE_SIZE = 6;

interface FilterableSelectionOption {
  label: string;
  detail?: string;
  value: unknown;
}

export function filterSelectionOptions(
  options: readonly FilterableSelectionOption[],
  query: string,
): FilterableSelectionOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...options];
  return options.filter((option) =>
    `${option.label} ${option.detail ?? ""}`
      .toLocaleLowerCase()
      .includes(normalized),
  );
}

export function Chat({
  sessionId,
  sessionTitle: initialSessionTitle,
  model: initialModel,
  accountLabel: initialAccountLabel,
  workspace: initialWorkspace,
  onSubmit,
  onListSessions,
  onResume,
  onNew,
  onListModels,
  onSetModel,
  onListAccounts,
  onSelectAccount,
  onPrepareWorkspace,
  onSetWorkspace,
  onDiff,
}: ChatProps): React.JSX.Element {
  const { exit } = useApp();
  const [activeSession, setActiveSession] = useState(sessionId);
  const [activeTitle, setActiveTitle] = useState(initialSessionTitle);
  const [model, setModel] = useState(initialModel);
  const [accountLabel, setAccountLabel] = useState(initialAccountLabel);
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [pendingWorkspace, setPendingWorkspace] = useState("");
  const [selection, setSelection] = useState<ChatSelection | undefined>();
  const [selectionIndex, setSelectionIndex] = useState(0);
  const [selectionQuery, setSelectionQuery] = useState("");
  const [mode, setMode] = useState<AgentMode>("normal");
  const [input, setInput] = useState("");
  const [transcript, setTranscript] = useState<string[]>([
    "NellXCLI — /help for commands, /quit to exit.",
  ]);
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState("");
  const resolver = React.useRef<((approved: boolean) => void) | undefined>(
    undefined,
  );
  const controller = React.useRef<AbortController | undefined>(undefined);

  const askApproval = (summary: string): Promise<boolean> => {
    setApproval(summary);
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  };

  const addTranscript = (message: string) => {
    setTranscript((items) => [...items, message].slice(-40));
  };

  const submit = async (value: string) => {
    const prompt = value.trim();
    setInput("");
    if (!prompt || busy) return;
    if (prompt === "/quit" || prompt === "/exit") {
      exit();
      return;
    }
    if (prompt === "/new") {
      try {
        const session = await onNew();
        setActiveSession(session.id);
        setActiveTitle(session.title);
        setModel(session.model ?? initialModel);
        setWorkspace(session.workspace);
        setTranscript([`Started ${session.title} (${session.id}).`]);
      } catch (error) {
        addTranscript(`Could not create a new session: ${errorMessage(error)}`);
      }
      return;
    }
    if (prompt === "/model" || prompt.startsWith("/model ")) {
      try {
        const models = await onListModels();
        if (models.length === 0) {
          addTranscript(
            "No available models were returned for the configured accounts.",
          );
          return;
        }
        const requested =
          prompt === "/model"
            ? undefined
            : canonicalModelId(prompt.slice("/model ".length).trim());
        if (requested) {
          const match = models.find(
            (item) => canonicalModelId(item.id) === requested,
          );
          if (!match) {
            addTranscript(
              `Model "${requested}" is unavailable. Run /model to choose an available model.`,
            );
            return;
          }
          await onSetModel(activeSession, match.id);
          setModel(canonicalModelId(match.id));
          addTranscript(
            `Model set to ${match.displayName} (${canonicalModelId(match.id)}).`,
          );
          return;
        }
        const sortedModels = [...models].sort((left, right) => {
          const leftActive = canonicalModelId(left.id) === model;
          const rightActive = canonicalModelId(right.id) === model;
          if (leftActive !== rightActive) return leftActive ? -1 : 1;
          return left.displayName.localeCompare(right.displayName);
        });
        setSelection({
          kind: "model",
          options: sortedModels.map((item) => ({
            label: item.displayName,
            detail: `${canonicalModelId(item.id)}${canonicalModelId(item.id) === model ? " · active" : ""}`,
            value: item,
          })),
        });
        setSelectionIndex(0);
        setSelectionQuery("");
      } catch (error) {
        addTranscript(`Could not change model: ${errorMessage(error)}`);
      }
      return;
    }
    if (prompt === "/account") {
      try {
        const choices = await onListAccounts();
        if (!choices.length) {
          addTranscript("No account profiles are configured.");
          return;
        }
        setSelection({
          kind: "account",
          options: choices.map((item) => ({
            label: `${item.label}${item.active ? " (active)" : ""}`,
            value: item,
          })),
        });
        setSelectionIndex(0);
        setSelectionQuery("");
      } catch (error) {
        addTranscript(`Could not change account: ${errorMessage(error)}`);
      }
      return;
    }
    if (prompt === "/workspace") {
      addTranscript(
        `Workspace: ${workspace}. Use /workspace <path> to request a change.`,
      );
      return;
    }
    if (prompt === "/workspace yes" || prompt === "/workspace no") {
      if (!pendingWorkspace) {
        addTranscript("There is no workspace change waiting for confirmation.");
        return;
      }
      if (prompt === "/workspace no") {
        setPendingWorkspace("");
        addTranscript("Workspace change cancelled.");
        return;
      }
      try {
        await onSetWorkspace(activeSession, pendingWorkspace);
        setWorkspace(pendingWorkspace);
        addTranscript(`Workspace changed to ${pendingWorkspace}.`);
      } catch (error) {
        addTranscript(`Could not change workspace: ${errorMessage(error)}`);
      } finally {
        setPendingWorkspace("");
      }
      return;
    }
    if (prompt.startsWith("/workspace ")) {
      try {
        const path = await onPrepareWorkspace(
          prompt.slice("/workspace ".length).trim(),
        );
        setPendingWorkspace(path);
        addTranscript(
          `Change workspace to ${path}? Confirm with /workspace yes, or /workspace no to cancel.`,
        );
      } catch (error) {
        addTranscript(`Could not use that workspace: ${errorMessage(error)}`);
      }
      return;
    }
    if (prompt === "/help") {
      addTranscript(
        "Commands: /help, /new, /sessions, /resume <id>, /model [id], /account, /workspace [path], /diff, /mode normal|auto|plan, Ctrl-C cancels, /quit.",
      );
      return;
    }
    if (prompt === "/sessions") {
      try {
        const sessions = await onListSessions();
        addTranscript(
          sessions.length
            ? sessions
                .map(
                  (item) =>
                    `${item.id}  ${item.title}  ${item.workspace}${item.model ? `  ${item.model}` : ""}`,
                )
                .join("\n")
            : "No saved sessions.",
        );
      } catch (error) {
        addTranscript(`Could not list sessions: ${errorMessage(error)}`);
      }
      return;
    }
    if (prompt.startsWith("/resume ")) {
      const id = prompt.slice("/resume ".length).trim();
      try {
        const session = await onResume(id);
        setActiveSession(session.id);
        setActiveTitle(session.title);
        setWorkspace(session.workspace);
        setModel(session.model ?? initialModel);
        setTranscript([
          `Resumed ${session.title} (${session.id}) in ${session.workspace}`,
          ...(session.history ?? []),
        ]);
      } catch (error) {
        addTranscript(`Could not resume session: ${errorMessage(error)}`);
      }
      return;
    }
    if (prompt === "/diff") {
      try {
        addTranscript((await onDiff(activeSession)) || "No working-tree diff.");
      } catch (error) {
        addTranscript(`Could not read diff: ${errorMessage(error)}`);
      }
      return;
    }
    if (prompt.startsWith("/mode ")) {
      const requested = prompt.slice("/mode ".length).trim();
      if (
        requested === "normal" ||
        requested === "auto" ||
        requested === "plan"
      ) {
        setMode(requested);
        addTranscript(`Mode set to ${requested}.`);
      } else addTranscript("Usage: /mode normal|auto|plan");
      return;
    }
    addTranscript(`> [${mode}] ${prompt}`);
    setResponse("");
    setBusy(true);
    const activeController = new AbortController();
    controller.current = activeController;
    let collected = "";
    try {
      await onSubmit(
        activeSession,
        prompt,
        model,
        mode,
        (chunk) => {
          collected += chunk;
          setResponse(collected);
        },
        askApproval,
        addTranscript,
        activeController.signal,
      );
    } catch (error) {
      collected += `\nError: ${errorMessage(error)}`;
      setResponse(collected);
    } finally {
      controller.current = undefined;
      setBusy(false);
      setTranscript((items) =>
        [...items, collected].filter(Boolean).slice(-40),
      );
      setResponse("");
    }
  };

  useInput((value, key) => {
    if (selection) {
      const filteredOptions = filterSelectionOptions(
        selection.options,
        selectionQuery,
      );
      if (key.ctrl && value.toLowerCase() === "c") {
        setSelection(undefined);
        return;
      }
      if (key.backspace || key.delete) {
        setSelectionQuery((current) => current.slice(0, -1));
        setSelectionIndex(0);
        return;
      }
      if (key.upArrow)
        setSelectionIndex((current) =>
          filteredOptions.length
            ? (current - 1 + filteredOptions.length) % filteredOptions.length
            : 0,
        );
      else if (key.downArrow)
        setSelectionIndex((current) =>
          filteredOptions.length ? (current + 1) % filteredOptions.length : 0,
        );
      else if (key.escape) setSelection(undefined);
      else if (key.return) {
        const choice = filteredOptions[selectionIndex]?.value;
        const kind = selection.kind;
        setSelection(undefined);
        if (choice)
          void applySelection(kind, choice as ModelInfo | ChatAccountChoice);
      } else if (value && !key.ctrl && !key.meta && value.length === 1) {
        setSelectionQuery((current) => `${current}${value}`);
        setSelectionIndex(0);
      }
      return;
    }
    if (approval) {
      if (value.toLowerCase() === "y" || value.toLowerCase() === "n") {
        resolver.current?.(value.toLowerCase() === "y");
        resolver.current = undefined;
        setApproval("");
      }
      return;
    }
    if (key.ctrl && value === "c") {
      if (busy) controller.current?.abort();
      else {
        process.exitCode = 130;
        exit();
      }
      return;
    }
    if (busy) return;
    if (key.return) {
      void submit(input);
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (value && !key.ctrl) setInput((current) => current + value);
  });

  const applySelection = async (
    kind: ChatSelection["kind"],
    choice: ModelInfo | ChatAccountChoice,
  ) => {
    try {
      if (kind === "model") {
        const selected = choice as ModelInfo;
        await onSetModel(activeSession, selected.id);
        setModel(canonicalModelId(selected.id));
        addTranscript(
          `Model set to ${selected.displayName} (${canonicalModelId(selected.id)}).`,
        );
      } else {
        const selected = choice as ChatAccountChoice;
        setAccountLabel(await onSelectAccount(selected.id));
        addTranscript(`Default account set to ${selected.label}.`);
      }
    } catch (error) {
      addTranscript(`Could not apply selection: ${errorMessage(error)}`);
    }
  };

  const filteredSelection = selection
    ? filterSelectionOptions(selection.options, selectionQuery)
    : [];
  const selectionStart = Math.max(
    0,
    Math.min(
      selectionIndex - Math.floor(SELECTION_PAGE_SIZE / 2),
      filteredSelection.length - SELECTION_PAGE_SIZE,
    ),
  );
  const visibleSelection = filteredSelection.slice(
    selectionStart,
    selectionStart + SELECTION_PAGE_SIZE,
  );

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        NellXCLI
      </Text>
      <Text dimColor>
        Account: {accountLabel} | Model: {model}
      </Text>
      <Text dimColor>Workspace: {workspace}</Text>
      <Text dimColor>
        Session: {activeTitle} ({activeSession}) | mode {mode}
      </Text>
      {selection ? (
        <Box flexDirection="column" marginY={1}>
          <Text bold>
            {selection.kind === "model"
              ? "Select model"
              : "Choose the default account"}
          </Text>
          <Text dimColor>
            {selection.kind === "model" ? "Filter: " : "Search: "}
            {selectionQuery || "type a name or ID"} · {filteredSelection.length}{" "}
            {filteredSelection.length === 1 ? "model" : "models"}
          </Text>
          {visibleSelection.map((option, index) => {
            const absoluteIndex = selectionStart + index;
            return (
              <Text
                key={`${option.label}-${index}`}
                {...(absoluteIndex === selectionIndex
                  ? { color: "green" as const }
                  : {})}
              >
                {absoluteIndex === selectionIndex ? "> " : "  "}
                {option.label}
                {option.detail ? <Text dimColor> {option.detail}</Text> : null}
              </Text>
            );
          })}
          {filteredSelection.length === 0 ? (
            <Text dimColor>
              No {selection.kind === "model" ? "models" : "accounts"} match that
              search.
            </Text>
          ) : null}
          {filteredSelection.length > SELECTION_PAGE_SIZE ? (
            <Text dimColor>
              Showing {selectionStart + 1}–
              {Math.min(
                selectionStart + SELECTION_PAGE_SIZE,
                filteredSelection.length,
              )}{" "}
              of {filteredSelection.length}
            </Text>
          ) : null}
          <Text dimColor>
            ↑/↓ move · type to filter · Backspace edit · Enter select ·
            Esc/Ctrl-C cancel
          </Text>
        </Box>
      ) : null}
      {transcript.slice(-12).map((line, index) => (
        <Text key={index} wrap="wrap">
          {line}
        </Text>
      ))}
      {response ? (
        <Text color="green" wrap="wrap">
          {response}
        </Text>
      ) : null}
      {approval ? <Text color="yellow">Approval: {approval} [y/N]</Text> : null}
      <Box>
        <Text color="cyan">{busy ? "Working (Ctrl-C cancels)… " : "> "}</Text>
        {!busy && !approval ? (
          <Text>
            {input}
            <Text inverse> </Text>
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
