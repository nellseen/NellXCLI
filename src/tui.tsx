import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { AgentMode } from "./tools/registry.js";

export interface ChatSessionChoice {
  id: string;
  title: string;
  workspace: string;
  history?: string[];
}
export interface ChatProps {
  sessionId: string;
  onSubmit: (
    sessionId: string,
    prompt: string,
    mode: AgentMode,
    onChunk: (chunk: string) => void,
    requestApproval: (summary: string) => Promise<boolean>,
    onActivity: (message: string) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  onListSessions: () => Promise<ChatSessionChoice[]>;
  onResume: (sessionId: string) => Promise<ChatSessionChoice>;
  onDiff: (sessionId: string) => Promise<string>;
}

export function Chat({
  sessionId,
  onSubmit,
  onListSessions,
  onResume,
  onDiff,
}: ChatProps): React.JSX.Element {
  const { exit } = useApp();
  const [activeSession, setActiveSession] = useState(sessionId);
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
    if (prompt === "/quit" || prompt === "/exit") exit();
    if (prompt === "/help") {
      addTranscript(
        "Commands: /help, /sessions, /resume <id>, /diff, /mode normal|auto|plan, Ctrl-C cancels, /quit.",
      );
      return;
    }
    if (prompt === "/sessions") {
      try {
        const sessions = await onListSessions();
        addTranscript(
          sessions.length
            ? sessions
                .map((item) => `${item.id}  ${item.title}  ${item.workspace}`)
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
        addTranscript(
          `Resumed ${session.title} (${session.id}) in ${session.workspace}`,
        );
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

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan" bold>
        NellXCLI{" "}
        <Text dimColor>
          session {activeSession} · mode {mode}
        </Text>
      </Text>
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
