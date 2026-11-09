#!/usr/bin/env node
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import React from "react";
import { render } from "ink";
import { Chat } from "./tui.js";
import { AccountManager } from "./accounts/account-manager.js";
import { createCredentialService } from "./accounts/secrets.js";
import { readHiddenInput } from "./cli/hidden-input.js";
import {
  getConfigDirectory,
  openDefaultDatabase,
} from "./storage/default-database.js";
import type { LocalDatabase } from "./storage/database.js";
import { createGeminiProvider, getGeminiApiKey } from "./providers/gemini.js";
import {
  ProviderConfigurationError,
  ProviderRequestError,
} from "./providers/provider.js";
import { logger } from "./logger.js";
import { redactSensitiveText } from "./security/redaction.js";
import { SessionStore } from "./sessions/session-store.js";
import { ProviderRouter } from "./runtime/provider-router.js";
import { AgentRuntime } from "./runtime/agent-runtime.js";
import type { AgentRunResult } from "./runtime/agent-runtime.js";
import { attachAbortSignals } from "./cli/signal-abort.js";
import { createBuiltinToolRegistry } from "./tools/builtins.js";
import { loadWorkspaceImage } from "./providers/image-input.js";
import { createSubagentTool } from "./runtime/subagents.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("nellx")
    .description("An independent Gemini-powered terminal coding agent")
    .version("0.1.0", "-V, --version", "display version number")
    .action(async () => {
      if (stdin.isTTY && stdout.isTTY) await startInteractiveChat();
      else logger.info("Use `nellx run <prompt>` for non-interactive tasks.");
    });

  const modelsCommand = new Command("models").description(
    "Discover models available to configured Gemini accounts",
  );
  modelsCommand
    .command("list")
    .description("List Gemini models that support text generation")
    .action(async () => {
      try {
        const apiKey = await resolveGeminiApiKey();
        const provider = createGeminiProvider(apiKey);
        const models = await provider.listModels();
        if (models.length === 0) {
          process.stdout.write(
            "No available Gemini text generation models were returned.\n",
          );
          return;
        }
        for (const model of models) {
          process.stdout.write(`${model.id}\t${model.displayName}\n`);
        }
      } catch (error) {
        const message =
          error instanceof ProviderConfigurationError ||
          error instanceof ProviderRequestError
            ? error.message
            : error instanceof Error
              ? redactSensitiveText(error.message)
              : "Gemini model discovery failed. Details were omitted to protect credentials.";
        const fields =
          error instanceof ProviderRequestError
            ? {
                category: error.category,
                ...(error.statusCode !== undefined
                  ? { statusCode: error.statusCode }
                  : {}),
              }
            : {};
        logger.error(fields, message);
        process.exitCode = 1;
      }
    });
  program.addCommand(modelsCommand);
  program.addCommand(createAccountsCommand());
  program.addCommand(createRunCommand());
  program.addCommand(createSessionsCommand());

  return program;
}

async function startInteractiveChat(): Promise<void> {
  const database = await openDefaultDatabase();
  try {
    const sessions = new SessionStore(database);
    const session = await sessions.create(process.cwd(), "Interactive session");
    let activeSessionId = session.id;
    const accounts = new AccountManager(
      database,
      createCredentialService(getConfigDirectory()),
    );
    const tools = createBuiltinToolRegistry();
    const router = new ProviderRouter(
      accounts,
      (key) => createGeminiProvider(key),
      {
        onEvent: async (event) => {
          await sessions.appendEvent(activeSessionId, event.type, { ...event });
        },
      },
    );
    tools.register(createSubagentTool(router, sessions));
    const runtime = new AgentRuntime(router, sessions, tools);
    const instance = render(
      React.createElement(Chat, {
        sessionId: session.id,
        onSubmit: async (
          sessionId,
          prompt,
          mode,
          onChunk,
          requestApproval,
          onActivity,
          signal,
        ) => {
          activeSessionId = sessionId;
          await runtime.run({
            sessionId,
            prompt,
            model: "gemini-2.5-flash",
            mode,
            signal,
            requestApproval,
            onText: onChunk,
            onToolActivity: onActivity,
          });
        },
        onListSessions: async () =>
          sessions
            .list()
            .map(({ id, title, workspace }) => ({ id, title, workspace })),
        onResume: async (sessionId) => {
          const resumed = sessions.get(sessionId);
          activeSessionId = resumed.id;
          await sessions.setState(resumed.id, "active");
          const history = sessions
            .events(resumed.id)
            .filter(
              (event) =>
                event.type === "user_message" ||
                event.type === "assistant_message",
            )
            .map((event) => {
              const text = event.payload.text;
              return typeof text === "string"
                ? `${event.type === "user_message" ? "> " : ""}${text.slice(0, 2_000)}`
                : "";
            })
            .filter(Boolean);
          return {
            id: resumed.id,
            title: resumed.title,
            workspace: resumed.workspace,
            history,
          };
        },
        onDiff: async (sessionId) => {
          const target = sessions.get(sessionId);
          const result = await tools.execute(
            "git_diff",
            {},
            {
              workspace: target.workspace,
              mode: "plan",
            },
          );
          if (!isRecord(result)) return "Git diff returned no text.";
          return [result.stdout, result.stderr]
            .filter((part) => typeof part === "string" && part)
            .join("\n");
        },
      }),
      { exitOnCtrlC: false },
    );
    await instance.waitUntilExit();
  } finally {
    database.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseMode(value: string): "normal" | "auto" | "plan" {
  if (value === "normal" || value === "auto" || value === "plan") return value;
  throw new Error("Mode must be normal, auto, or plan.");
}

function collectImagePath(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function createRunCommand(): Command {
  const run = new Command("run")
    .description("Run a coding task in a persisted workspace session")
    .argument("<prompt>", "Task or question for the coding agent")
    .option("-m, --model <model>", "Gemini model", "gemini-2.5-flash")
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .option("--session <id>", "Continue an existing session")
    .option("--mode <mode>", "normal, auto, or plan", parseMode, "normal")
    .option(
      "--image <path>",
      "Attach a workspace image (repeat up to four times)",
      collectImagePath,
      [],
    )
    .action(
      async (
        prompt: string,
        options: {
          model: string;
          workspace: string;
          session?: string;
          mode: "normal" | "auto" | "plan";
          image: string[];
        },
      ) => {
        let database: LocalDatabase | undefined;
        try {
          database = await openDefaultDatabase();
          const accounts = new AccountManager(
            database,
            createCredentialService(getConfigDirectory()),
          );
          const sessions = new SessionStore(database);
          const taskPrompt = await readTaskPrompt(prompt, stdin);
          if (options.image.length > 4)
            throw new Error(
              "At most four images can be attached to one request.",
            );
          const session = options.session
            ? sessions.get(options.session)
            : await sessions.create(
                resolve(options.workspace),
                taskPrompt.slice(0, 80),
              );
          const images = await Promise.all(
            options.image.map((path) =>
              loadWorkspaceImage(session.workspace, path),
            ),
          );
          const promptWithImagePaths = images.length
            ? `${taskPrompt}\n[Attached workspace images: ${options.image.join(", ")}]`
            : taskPrompt;
          const router = new ProviderRouter(
            accounts,
            (key) => createGeminiProvider(key),
            {
              onEvent: async (event) => {
                await sessions.appendEvent(session.id, event.type, {
                  ...event,
                });
              },
            },
          );
          const approval = async (summary: string): Promise<boolean> => {
            if (!stdin.isTTY || !stdout.isTTY) {
              process.stderr.write(
                `Approval required in interactive mode: ${summary}\n`,
              );
              return false;
            }
            const rl = createInterface({ input: stdin, output: stdout });
            try {
              return (
                (await rl.question(`${summary} [y/N] `))
                  .trim()
                  .toLowerCase() === "y"
              );
            } finally {
              rl.close();
            }
          };
          const controller = new AbortController();
          const detachAbortSignals = attachAbortSignals(controller);
          const tools = createBuiltinToolRegistry();
          tools.register(createSubagentTool(router, sessions));
          const runtime = new AgentRuntime(router, sessions, tools);
          let result: AgentRunResult;
          try {
            result = await runtime.run({
              sessionId: session.id,
              prompt: promptWithImagePaths,
              images,
              model: options.model,
              mode: options.mode,
              signal: controller.signal,
              requestApproval: approval,
              onText: (chunk) => stdout.write(chunk),
            });
          } finally {
            detachAbortSignals();
          }
          if (!stdout.isTTY) stdout.write("\n");
          await sessions.setState(session.id, "completed");
          logger.info(
            { sessionId: session.id, steps: result.steps },
            "Task completed",
          );
        } catch (error) {
          logger.error(
            { operation: "agent_run" },
            error instanceof Error
              ? redactSensitiveText(error.message)
              : "Agent run failed.",
          );
          process.exitCode = 1;
        } finally {
          database?.close();
        }
      },
    );
  return run;
}

function createSessionsCommand(): Command {
  const sessions = new Command("sessions").description(
    "List saved NellXCLI sessions",
  );
  sessions.command("list").action(async () => {
    const db = await openDefaultDatabase();
    try {
      const entries = new SessionStore(db).list();
      for (const session of entries)
        process.stdout.write(
          `${session.id}\t${session.state}\t${session.title}\t${session.workspace}\n`,
        );
    } finally {
      db.close();
    }
  });
  return sessions;
}

function createAccountsCommand(): Command {
  const accounts = new Command("accounts").description(
    "Manage local Gemini account profiles and credentials",
  );
  accounts
    .command("list")
    .description("List account profiles without displaying API keys")
    .action(() =>
      runAccountAction(async (manager) => {
        const profiles = await manager.listProfiles();
        if (profiles.length === 0) {
          process.stdout.write("No account profiles configured.\n");
          return;
        }
        const defaultId = manager.getDefaultProfileId();
        for (const profile of profiles) {
          const selected = profile.id === defaultId ? " (default)" : "";
          const status = profile.enabled ? "enabled" : "disabled";
          process.stdout.write(
            `${profile.id}\t${profile.displayName}\tproject=${profile.projectId}\t${status}\tkeys=${profile.credentialCount}${selected}\n`,
          );
        }
      }),
    );

  accounts
    .command("add <display-name> <project-id> [user-label]")
    .description(
      "Create an account profile and add an API key through hidden input",
    )
    .action((displayName: string, projectId: string, userLabel?: string) =>
      runAccountAction(async (manager) => {
        const apiKey = await readHiddenInput("Gemini API key: ");
        const profile = await manager.addProfile({
          displayName,
          projectId,
          ...(userLabel ? { userLabel } : {}),
        });
        const credential = await manager.addApiKey(profile.id, apiKey);
        process.stdout.write(
          `Added ${profile.displayName} (${profile.id}) with credential ${credential.id}.\n`,
        );
      }),
    );

  accounts
    .command("key-add <profile-id>")
    .description("Add an API key to a profile through hidden input")
    .action((profileId: string) =>
      runAccountAction(async (manager) => {
        const apiKey = await readHiddenInput("Gemini API key: ");
        const credential = await manager.addApiKey(profileId, apiKey);
        process.stdout.write(
          `Added credential ${credential.id} to ${profileId}.\n`,
        );
      }),
    );

  accounts
    .command("key-remove <credential-id>")
    .description("Remove a credential from its configured secret store")
    .action((credentialId: string) =>
      runAccountAction(async (manager) => {
        await manager.removeCredential(credentialId);
        process.stdout.write(`Removed credential ${credentialId}.\n`);
      }),
    );

  accounts
    .command("select <profile-id>")
    .description("Select the default account profile")
    .action((profileId: string) =>
      runAccountAction(async (manager) => {
        await manager.setDefaultProfile(profileId);
        process.stdout.write(`Selected account ${profileId}.\n`);
      }),
    );

  for (const [name, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    accounts
      .command(`${name} <profile-id>`)
      .description(
        `${name === "enable" ? "Enable" : "Disable"} an account profile`,
      )
      .action((profileId: string) =>
        runAccountAction(async (manager) => {
          await manager.setProfileEnabled(profileId, enabled);
          process.stdout.write(
            `${name === "enable" ? "Enabled" : "Disabled"} account ${profileId}.\n`,
          );
        }),
      );
  }

  accounts
    .command("remove <profile-id>")
    .description("Remove a profile and all its stored API keys")
    .action((profileId: string) =>
      runAccountAction(async (manager) => {
        await manager.removeProfile(profileId);
        process.stdout.write(`Removed account ${profileId}.\n`);
      }),
    );

  return accounts;
}

export async function readTaskPrompt(
  argument: string,
  input: AsyncIterable<unknown> = stdin,
): Promise<string> {
  if (argument !== "-") return argument;
  const chunks: string[] = [];
  let length = 0;
  for await (const chunk of input) {
    if (typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
      throw new Error("Standard input yielded an unsupported data type.");
    }
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    length += text.length;
    if (length > 20_000) {
      throw new Error(
        "Standard input exceeds the 20,000 character prompt limit.",
      );
    }
    chunks.push(text);
  }
  const prompt = chunks.join("").trim();
  if (!prompt) throw new Error("Standard input did not contain a task prompt.");
  return prompt;
}

async function runAccountAction(
  action: (manager: AccountManager) => Promise<void>,
): Promise<void> {
  let database: LocalDatabase | undefined;
  try {
    database = await openDefaultDatabase();
    const manager = new AccountManager(
      database,
      createCredentialService(getConfigDirectory()),
    );
    await action(manager);
  } catch (error) {
    logger.error(
      { operation: "account_command" },
      error instanceof Error
        ? redactSensitiveText(error.message)
        : "Account operation failed.",
    );
    process.exitCode = 1;
  } finally {
    database?.close();
  }
}

async function resolveGeminiApiKey(): Promise<string> {
  try {
    return getGeminiApiKey();
  } catch (error) {
    if (!(error instanceof ProviderConfigurationError)) throw error;
    const database = await openDefaultDatabase();
    try {
      const manager = new AccountManager(
        database,
        createCredentialService(getConfigDirectory()),
      );
      return await manager.getDefaultApiKey();
    } finally {
      database.close();
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  void createProgram().parseAsync();
}
