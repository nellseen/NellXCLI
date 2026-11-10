#!/usr/bin/env node
import { resolve, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
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
import { createGeminiProvider } from "./providers/gemini.js";
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
import { SetupConfig } from "./setup/setup-config.js";
import { runOnboarding } from "./setup/onboarding.js";
import { canonicalModelId } from "./providers/provider.js";

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
        const database = await openDefaultDatabase();
        let models: Awaited<ReturnType<ProviderRouter["listModels"]>>;
        try {
          const accounts = await createRuntimeAccounts(database);
          models = await new ProviderRouter(accounts, (key) =>
            createGeminiProvider(key),
          ).listModels();
        } finally {
          database.close();
        }
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
  program.addCommand(
    new Command("setup")
      .description("Set up or repair NellXCLI")
      .action(async () => startInteractiveChat(true)),
  );

  return program;
}

async function startInteractiveChat(forceSetup = false): Promise<void> {
  const database = await openDefaultDatabase();
  try {
    const sessions = new SessionStore(database);
    let accounts = await createRuntimeAccounts(database);
    const setupConfig = new SetupConfig(database);
    let preferences = setupConfig.get();
    if (forceSetup || !(await isSetupUsable(accounts, preferences))) {
      const configured = await runOnboarding({
        accounts,
        createAccounts: () =>
          new AccountManager(
            database,
            createCredentialService(getConfigDirectory()),
          ),
        config: setupConfig,
        workspace: process.cwd(),
      });
      if (!configured) return;
      accounts = await createRuntimeAccounts(database);
      preferences = setupConfig.get();
    }
    const workspace = preferences.defaultWorkspace ?? process.cwd();
    const model = preferences.defaultModel ?? "gemini-2.5-flash";
    const activeProfileId = accounts.getDefaultProfileId();
    const activeProfile = activeProfileId
      ? await accounts.getProfile(activeProfileId)
      : undefined;
    const accountLabel = activeProfile
      ? `${activeProfile.displayName} (${activeProfile.projectId})`
      : "No account";
    const session = await sessions.create(workspace, "New Chat", model);
    let activeSessionId = session.id;
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
        sessionTitle: session.title,
        model,
        accountLabel,
        workspace,
        onSubmit: async (
          sessionId,
          prompt,
          requestModel,
          mode,
          onChunk,
          requestApproval,
          onActivity,
          signal,
        ) => {
          activeSessionId = sessionId;
          await sessions.setModel(sessionId, canonicalModelId(requestModel));
          await runtime.run({
            sessionId,
            prompt,
            model: requestModel,
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
            .map(({ id, title, workspace, model: sessionModel }) => ({
              id,
              title,
              workspace,
              ...(sessionModel ? { model: sessionModel } : {}),
            })),
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
            ...(resumed.model ? { model: resumed.model } : {}),
            history,
          };
        },
        onNew: async () => {
          const nextWorkspace = preferences.defaultWorkspace ?? process.cwd();
          const next = await sessions.create(
            nextWorkspace,
            "New Chat",
            preferences.defaultModel,
          );
          activeSessionId = next.id;
          return {
            id: next.id,
            title: next.title,
            workspace: next.workspace,
            ...(next.model ? { model: next.model } : {}),
          };
        },
        onListModels: async () => router.listModels(),
        onSetModel: async (sessionId, nextModel) => {
          await sessions.setModel(sessionId, canonicalModelId(nextModel));
          await setupConfig.save({
            defaultProfileId: preferences.defaultProfileId!,
            defaultModel: canonicalModelId(nextModel),
            defaultWorkspace: preferences.defaultWorkspace!,
          });
          preferences.defaultModel = canonicalModelId(nextModel);
        },
        onListAccounts: async () => {
          const selectedId = accounts.getDefaultProfileId();
          const choices = [];
          for (const profile of await accounts.listProfiles()) {
            if (!profile.enabled) continue;
            const credentials = await accounts.listCredentials(profile.id);
            if (
              !credentials.some(
                (credential) =>
                  credential.enabled && credential.status === "active",
              )
            ) {
              continue;
            }
            choices.push({
              id: profile.id,
              label: `${profile.displayName} · ${profile.projectId}`,
              active: profile.id === selectedId,
            });
          }
          return choices;
        },
        onSelectAccount: async (profileId) => {
          await accounts.setDefaultProfile(profileId);
          preferences.defaultProfileId = profileId;
          const selected = await accounts.getProfile(profileId);
          return `${selected.displayName} (${selected.projectId})`;
        },
        onPrepareWorkspace: async (path) => {
          const workspaceInfo = await stat(path).catch(() => undefined);
          if (!workspaceInfo?.isDirectory())
            throw new Error("That path is not an accessible directory.");
          return await realpath(path);
        },
        onSetWorkspace: async (sessionId, nextWorkspace) => {
          await sessions.setWorkspace(sessionId, nextWorkspace);
          await setupConfig.save({
            defaultProfileId: preferences.defaultProfileId!,
            defaultModel: preferences.defaultModel!,
            defaultWorkspace: nextWorkspace,
          });
          preferences.defaultWorkspace = nextWorkspace;
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
  } catch (error) {
    if (error instanceof Error && /cancel/i.test(error.message)) {
      process.exitCode = 130;
      logger.info("Interactive setup cancelled.");
    } else {
      logger.error(
        { operation: "interactive_startup" },
        error instanceof Error
          ? redactSensitiveText(error.message)
          : "Interactive startup failed.",
      );
      process.exitCode = 1;
    }
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
    .option("-m, --model <model>", "Gemini model")
    .option("-w, --workspace <path>", "Workspace directory")
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
          model?: string;
          workspace?: string;
          session?: string;
          mode: "normal" | "auto" | "plan";
          image: string[];
        },
      ) => {
        let database: LocalDatabase | undefined;
        try {
          database = await openDefaultDatabase();
          const accounts = await createRuntimeAccounts(database);
          const sessions = new SessionStore(database);
          const selectedModel = canonicalModelId(
            options.model ??
              new SetupConfig(database).get().defaultModel ??
              "gemini-2.5-flash",
          );
          const selectedWorkspace = resolve(
            options.workspace ??
              new SetupConfig(database).get().defaultWorkspace ??
              process.cwd(),
          );
          const taskPrompt = await readTaskPrompt(prompt, stdin);
          if (options.image.length > 4)
            throw new Error(
              "At most four images can be attached to one request.",
            );
          const session = options.session
            ? sessions.get(options.session)
            : await sessions.create(
                selectedWorkspace,
                taskPrompt.slice(0, 80),
                selectedModel,
              );
          await sessions.setModel(session.id, selectedModel);
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
              model: selectedModel,
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
          `${session.id}\t${session.state}\t${session.title}\t${session.workspace}\t${session.model ?? ""}\n`,
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
        await validateGeminiApiKey(apiKey);
        const profile = await manager.addProfile({
          displayName,
          projectId,
          ...(userLabel ? { userLabel } : {}),
        });
        let credential: Awaited<ReturnType<AccountManager["addApiKey"]>>;
        try {
          credential = await manager.addApiKey(profile.id, apiKey);
        } catch (error) {
          await manager.removeProfile(profile.id);
          throw error;
        }
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
        await validateGeminiApiKey(apiKey);
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
    .option("-y, --yes", "Confirm profile and credential removal")
    .description("Remove a profile and all its stored API keys")
    .action((profileId: string, options: { yes?: boolean }) =>
      runAccountAction(async (manager) => {
        if (!options.yes) {
          if (!stdin.isTTY || !stdout.isTTY) {
            throw new Error(
              'Profile removal requires confirmation. Use "nellx accounts remove <profile-id> --yes" in a trusted terminal.',
            );
          }
          const profile = await manager.getProfile(profileId);
          const rl = createInterface({ input: stdin, output: stdout });
          let answer: string;
          try {
            answer = await rl.question(
              `Remove ${profile.displayName} and all stored API keys? [y/N] `,
            );
          } finally {
            rl.close();
          }
          if (answer.trim().toLowerCase() !== "y") {
            process.stdout.write("Profile removal cancelled.\n");
            return;
          }
        }
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

async function validateGeminiApiKey(apiKey: string): Promise<void> {
  const models = await createGeminiProvider(apiKey).listModels();
  if (models.length === 0) {
    throw new ProviderConfigurationError(
      "The key returned no text generation models. Check Gemini API access before saving it.",
    );
  }
}

async function createRuntimeAccounts(
  database: LocalDatabase,
): Promise<AccountManager> {
  const configDirectory = getConfigDirectory();
  const vaultPath = join(configDirectory, "credentials.vault");
  if (
    !process.env.NELLX_VAULT_PASSPHRASE &&
    existsSync(vaultPath) &&
    stdin.isTTY &&
    stdout.isTTY
  ) {
    const passphrase = await readHiddenInput("Vault passphrase: ");
    if (passphrase.length < 12) {
      throw new Error("Vault passphrase must contain at least 12 characters.");
    }
    process.env.NELLX_VAULT_PASSPHRASE = passphrase;
  }
  return new AccountManager(database, createCredentialService(configDirectory));
}

async function isSetupUsable(
  accounts: AccountManager,
  preferences: ReturnType<SetupConfig["get"]>,
): Promise<boolean> {
  if (
    !preferences.defaultProfileId ||
    !preferences.defaultModel ||
    !preferences.defaultWorkspace
  ) {
    return false;
  }
  try {
    const profile = await accounts.getProfile(preferences.defaultProfileId);
    if (!profile.enabled) return false;
    const key = await accounts.getDefaultApiKey();
    const models = await createGeminiProvider(key).listModels();
    const workspaceInfo = await stat(preferences.defaultWorkspace);
    return (
      workspaceInfo.isDirectory() &&
      models.some(
        (model) => canonicalModelId(model.id) === preferences.defaultModel,
      )
    );
  } catch (error) {
    process.stderr.write(
      `Saved setup needs repair: ${redactSensitiveText(error instanceof Error ? error.message : "configuration is unavailable")}\n`,
    );
    return false;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href
) {
  void createProgram().parseAsync();
}
