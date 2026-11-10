import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import type {
  AccountManager,
  AccountProfile,
} from "../accounts/account-manager.js";
import { readHiddenInput } from "../cli/hidden-input.js";
import { createGeminiProvider } from "../providers/gemini.js";
import {
  ProviderConfigurationError,
  ProviderRequestError,
  canonicalModelId,
  type ModelInfo,
} from "../providers/provider.js";
import { SetupConfig } from "./setup-config.js";
import { selectOption } from "../tui-select.js";
import { redactSensitiveText } from "../security/redaction.js";

interface OnboardingDependencies {
  accounts: AccountManager;
  createAccounts?: () => AccountManager;
  config: SetupConfig;
  workspace?: string;
  isTTY?: boolean;
}

export async function runOnboarding(
  dependencies: OnboardingDependencies,
): Promise<boolean> {
  try {
    return await runOnboardingFlow(dependencies);
  } catch (error) {
    stdout.write(
      error instanceof Error &&
        (error.name === "AbortError" || /closed|SIGINT/i.test(error.message))
        ? "Setup cancelled.\n"
        : `Setup could not continue: ${safeSetupError(error)}\n`,
    );
    return false;
  }
}

async function runOnboardingFlow({
  accounts: initialAccounts,
  createAccounts,
  config,
  workspace = process.cwd(),
  isTTY = stdin.isTTY && stdout.isTTY,
}: OnboardingDependencies): Promise<boolean> {
  if (!isTTY) {
    process.stderr.write(
      'NellXCLI setup needs an interactive terminal. Run "nellx setup" from a terminal.\n',
    );
    return false;
  }

  stdout.write(
    "NellXCLI — Your terminal coding agent\n\nWelcome! Let's set up NellXCLI.\n\n",
  );

  let profile: AccountProfile | undefined;
  let accounts = initialAccounts;
  let createdProfileId: string | undefined;
  let pendingApiKey: string | undefined;
  let pendingProfile: { displayName: string; projectId: string } | undefined;
  let availableModels: readonly ModelInfo[] = [];
  const existingProfiles = await accounts.listProfiles();
  const profilesWithKeys = await getProfilesWithActiveKeys(
    accounts,
    existingProfiles,
  );

  if (profilesWithKeys.length) {
    const options = [
      ...profilesWithKeys.map(({ profile: item }) => ({
        label: item.displayName,
        detail: `project ${item.projectId}`,
        value: item,
      })),
      {
        label: "Connect a new Google AI Studio key",
        value: null,
      },
    ];
    const choice = await selectOption(
      "[1/4] Connect Google AI Studio",
      options,
    );
    if (choice === undefined) return false;
    profile = choice ?? undefined;
    if (profile) {
      const credential = profilesWithKeys.find(
        (entry) => entry.profile.id === profile?.id,
      )?.credentialId;
      if (!credential) throw new Error("Selected account has no active key.");
      const key = await accounts.getApiKey(credential);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          availableModels = await createGeminiProvider(key).listModels();
          break;
        } catch (error) {
          stdout.write(`${safeSetupError(error)}\n`);
          if (
            error instanceof ProviderRequestError &&
            error.category === "authentication"
          ) {
            await accounts.quarantineCredential(credential);
            profile = undefined;
            break;
          }
          const retryable =
            error instanceof ProviderRequestError &&
            ["network", "temporary_server", "rate_limit"].includes(
              error.category,
            );
          if (
            !retryable ||
            attempt === 2 ||
            !(await askYesNo("Retry model discovery? [Y/n]", true))
          ) {
            return false;
          }
        }
      }
    }
  }

  if (!profile) {
    const validated = await promptAndValidateKey();
    if (!validated) return false;
    pendingApiKey = validated.apiKey;
    availableModels = validated.models;
    const displayName = await askText("Account name", "Personal");
    const projectId = await askText("Google Cloud project ID");
    const sameProject = existingProfiles.some(
      (item) => item.projectId === projectId,
    );
    if (sameProject) {
      stdout.write(
        "This project is already used by another profile. Its API keys share the same project quota.\n",
      );
    }

    pendingProfile = { displayName, projectId };
  }

  if (!availableModels.length) {
    stdout.write(
      "No text generation models are available for this account. Check project access and try setup again.\n",
    );
    return false;
  }

  stdout.write("\n[2/4] Choose your default model\n");
  const selectedModel = await selectOption(
    "Available Gemini models",
    availableModels.map((model) => ({
      label: model.displayName,
      detail: [
        canonicalModelId(model.id),
        model.inputTokenLimit ? `input ${model.inputTokenLimit}` : undefined,
        model.outputTokenLimit ? `output ${model.outputTokenLimit}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      value: model,
    })),
  );
  if (!selectedModel) return false;

  stdout.write(
    `\n[3/4] Choose a workspace\nCurrent directory: ${resolve(workspace)}\n`,
  );
  const useCurrent = await askYesNo("Use this folder? [Y/n]", true);
  let selectedWorkspace = resolve(workspace);
  if (!useCurrent) {
    const path = await askText("Workspace path");
    selectedWorkspace = resolve(path);
    const info = await stat(selectedWorkspace).catch(() => undefined);
    if (!info?.isDirectory()) {
      stdout.write(
        "That path is not an accessible directory. Setup cancelled.\n",
      );
      return false;
    }
    stdout.write(`Selected workspace: ${selectedWorkspace}\n`);
    if (!(await askYesNo("Use this workspace? [y/N]", false))) return false;
  }

  stdout.write(
    `\n[4/4] Confirm setup\nAccount: ${profile?.displayName ?? pendingProfile?.displayName}\nProject: ${profile?.projectId ?? pendingProfile?.projectId}\nModel: ${selectedModel.displayName} (${canonicalModelId(selectedModel.id)})\nWorkspace: ${selectedWorkspace}\n`,
  );
  if (!(await askYesNo("Save and open chat? [Y/n]", true))) return false;

  try {
    if (!profile && pendingProfile && pendingApiKey) {
      profile = await accounts.addProfile(pendingProfile);
      createdProfileId = profile.id;
      try {
        await accounts.addApiKey(profile.id, pendingApiKey);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes("Configure NELLX_VAULT_PASSPHRASE") &&
          createAccounts
        ) {
          const passphrase = await readHiddenInput(
            "OS keyring unavailable. Type a new vault passphrase (12+ characters): ",
          ).catch(() => "");
          if (passphrase.length < 12) {
            throw new Error(
              "Vault passphrase must contain at least 12 characters.",
              { cause: error },
            );
          }
          process.env.NELLX_VAULT_PASSPHRASE = passphrase;
          accounts = createAccounts();
          await accounts.addApiKey(profile.id, pendingApiKey);
        } else {
          throw error;
        }
      }
    }
    if (!profile) throw new Error("No account was selected.");
    await accounts.setDefaultProfile(profile.id);
    await config.save({
      defaultProfileId: profile.id,
      defaultModel: canonicalModelId(selectedModel.id),
      defaultWorkspace: selectedWorkspace,
    });
  } catch (error) {
    if (createdProfileId) {
      try {
        await accounts.removeProfile(createdProfileId);
      } catch {
        stdout.write(
          "Setup could not be saved, and the temporary account could not be removed. Check `nellx accounts list` before retrying.\n",
        );
      }
    }
    stdout.write(`${safeSetupError(error)}\n`);
    return false;
  }
  stdout.write("Setup complete. Opening chat…\n");
  return true;
}

async function promptAndValidateKey(): Promise<
  { apiKey: string; models: readonly ModelInfo[] } | undefined
> {
  stdout.write(
    "[1/4] Connect Google AI Studio\nGet an API key: https://aistudio.google.com/app/apikey\n",
  );
  while (true) {
    let apiKey: string;
    try {
      apiKey = await readHiddenInput("Gemini API key: ");
    } catch {
      return undefined;
    }
    try {
      stdout.write("Checking API key…\n");
      const models = await createGeminiProvider(apiKey).listModels();
      if (!models.length) {
        stdout.write(
          "The key is valid, but no text generation models are available.\n",
        );
      } else {
        stdout.write("Connection successful.\n");
        return { apiKey, models };
      }
    } catch (error) {
      stdout.write(`${safeSetupError(error)}\n`);
      if (
        error instanceof ProviderRequestError &&
        (error.category === "quota_exhausted" ||
          error.category === "permission" ||
          error.category === "invalid_request" ||
          error.category === "safety_or_policy")
      ) {
        return undefined;
      }
    }
    if (!(await askYesNo("Try another key? [Y/n]", true))) return undefined;
  }
}

async function getProfilesWithActiveKeys(
  accounts: AccountManager,
  profiles: AccountProfile[],
): Promise<Array<{ profile: AccountProfile; credentialId: string }>> {
  const eligible: Array<{ profile: AccountProfile; credentialId: string }> = [];
  for (const profile of profiles) {
    if (!profile.enabled) continue;
    const credential = (await accounts.listCredentials(profile.id)).find(
      (item) => item.enabled && item.status === "active",
    );
    if (credential) eligible.push({ profile, credentialId: credential.id });
  }
  return eligible;
}

async function askText(label: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : "";
    const value = (await rl.question(`${label}${suffix}: `)).trim();
    return value || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function askYesNo(
  prompt: string,
  defaultValue: boolean,
): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${prompt} `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

function safeSetupError(error: unknown): string {
  if (error instanceof ProviderRequestError) {
    switch (error.category) {
      case "authentication":
        return "The API key was rejected. Check that it is copied correctly and active in Google AI Studio.";
      case "permission":
        return "Google denied access. Check that the Gemini API is enabled for this project.";
      case "quota_exhausted":
        return "This project's Gemini quota is exhausted. Another key in this project shares that quota.";
      case "rate_limit":
        return "Google is rate limiting requests. Wait briefly, then retry.";
      case "network":
        return "Could not reach Google. Check your internet connection and retry.";
      default:
        return error.message;
    }
  }
  if (error instanceof ProviderConfigurationError) return error.message;
  return error instanceof Error
    ? redactSensitiveText(error.message)
    : "Setup failed. Details were omitted.";
}
