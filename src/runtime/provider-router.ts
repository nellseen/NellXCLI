import { AccountManager } from "../accounts/account-manager.js";
import {
  ProviderConfigurationError,
  ProviderRequestError,
  type ModelInfo,
  type ProviderErrorCategory,
  type TextGenerationRequest,
  type TextProvider,
} from "../providers/provider.js";

export interface ProviderRouteEvent {
  type:
    | "provider_attempt"
    | "provider_failover"
    | "provider_quarantined"
    | "provider_cooldown";
  projectId: string;
  credentialId: string;
  model: string;
  category?: ProviderErrorCategory;
  attempt: number;
  at: string;
}

export interface ProviderRouterOptions {
  maxTransientRetries?: number;
  baseDelayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  now?: () => Date;
  onEvent?: (event: ProviderRouteEvent) => Promise<void> | void;
}

interface Candidate {
  projectId: string;
  credentialId: string;
  priority: number;
}

const cooldownMs: Partial<Record<ProviderErrorCategory, number>> = {
  rate_limit: 60_000,
  quota_exhausted: 5 * 60_000,
  temporary_server: 15_000,
  network: 5_000,
};

export class ProviderRouter {
  private readonly maxTransientRetries: number;
  private readonly baseDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly onEvent?: ProviderRouterOptions["onEvent"];

  constructor(
    private readonly accounts: AccountManager,
    private readonly createProvider: (apiKey: string) => TextProvider,
    options: ProviderRouterOptions = {},
  ) {
    this.maxTransientRetries = options.maxTransientRetries ?? 2;
    this.baseDelayMs = options.baseDelayMs ?? 250;
    this.wait =
      options.wait ??
      ((milliseconds) =>
        new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.onEvent = options.onEvent;
  }

  async listModels(): Promise<readonly ModelInfo[]> {
    const candidates = await this.collectCandidates("");
    const models = new Map<string, ModelInfo>();
    for (const candidate of candidates) {
      try {
        const key = await this.accounts.getApiKey(candidate.credentialId);
        const available = await this.createProvider(key).listModels();
        for (const model of available) models.set(model.id, model);
      } catch (error) {
        const normalized = this.normalize(
          error,
          "Unable to list models for the configured accounts.",
        );
        if (normalized.category === "authentication") {
          await this.accounts.quarantineCredential(candidate.credentialId);
          continue;
        }
        if (normalized.category === "permission") {
          await this.accounts.recordProjectFailure(
            candidate.projectId,
            "*",
            "permission",
          );
          continue;
        }
        if (
          normalized.category === "rate_limit" ||
          normalized.category === "quota_exhausted"
        ) {
          await this.cooldownProject(candidate, "*", normalized.category, 1);
          continue;
        }
        throw normalized;
      }
    }
    return [...models.values()];
  }

  async *streamText(request: TextGenerationRequest): AsyncIterable<string> {
    const candidates = await this.collectCandidates(request.model);
    const groups = groupByProject(candidates);
    let lastError: Error | undefined;
    let attempts = 0;

    for (const [projectIndex, [projectId, projectCandidates]] of [
      ...groups.entries(),
    ].entries()) {
      const firstCandidate = projectCandidates[0];
      if (
        projectIndex > 0 &&
        firstCandidate &&
        lastError instanceof ProviderRequestError
      ) {
        await this.emit({
          type: "provider_failover",
          projectId,
          credentialId: firstCandidate.credentialId,
          model: request.model,
          category: lastError.category,
          attempt: attempts,
          at: this.now().toISOString(),
        });
      }
      let projectUnavailable = false;
      for (const candidate of projectCandidates) {
        let transientRetries = 0;
        while (true) {
          attempts += 1;
          await this.emit({
            type: "provider_attempt",
            projectId,
            credentialId: candidate.credentialId,
            model: request.model,
            attempt: attempts,
            at: this.now().toISOString(),
          });
          let emittedText = false;
          try {
            const apiKey = await this.accounts.getApiKey(
              candidate.credentialId,
            );
            const provider = this.createProvider(apiKey);
            const models = await provider.listModels();
            if (
              !models.some(
                (model) =>
                  model.id === request.model &&
                  model.capabilities.includes("textGeneration"),
              )
            ) {
              lastError = new ProviderConfigurationError(
                `Model "${request.model}" is unavailable for project ${projectId}.`,
              );
              projectUnavailable = true;
              break;
            }
            for await (const chunk of provider.streamText(request)) {
              emittedText = true;
              yield chunk;
            }
            await this.accounts.recordProjectSuccess(projectId, request.model);
            return;
          } catch (error) {
            const normalized = this.normalize(error, "Gemini request failed.");
            lastError = normalized;
            if (emittedText) throw normalized;

            if (normalized.category === "authentication") {
              await this.accounts.quarantineCredential(candidate.credentialId);
              await this.emit({
                type: "provider_quarantined",
                projectId,
                credentialId: candidate.credentialId,
                model: request.model,
                category: normalized.category,
                attempt: attempts,
                at: this.now().toISOString(),
              });
              break;
            }

            if (normalized.category === "permission") {
              await this.accounts.recordProjectFailure(
                projectId,
                request.model,
                "permission",
              );
              throw normalized;
            }

            if (
              normalized.category === "quota_exhausted" ||
              normalized.category === "rate_limit"
            ) {
              await this.cooldownProject(
                candidate,
                request.model,
                normalized.category,
                attempts,
              );
              projectUnavailable = true;
              break;
            }

            if (
              normalized.category === "temporary_server" ||
              normalized.category === "network"
            ) {
              if (transientRetries < this.maxTransientRetries) {
                const delay = getRetryDelay(
                  transientRetries,
                  this.baseDelayMs,
                  this.random,
                );
                transientRetries += 1;
                await this.wait(delay);
                continue;
              }
              await this.cooldownProject(
                candidate,
                request.model,
                normalized.category,
                attempts,
              );
              projectUnavailable = true;
              break;
            }

            throw normalized;
          }
        }
        if (projectUnavailable) break;
      }
    }

    throw (
      lastError ??
      new ProviderConfigurationError(
        "No configured project has an active credential and an eligible text generation model.",
      )
    );
  }

  private async collectCandidates(model: string): Promise<Candidate[]> {
    const eligibleProjectIds = new Set(
      await this.accounts.getEligibleProjectIds(model),
    );
    const profiles = await this.accounts.listProfiles();
    const credentials = await this.accounts.listCredentials();
    return credentials
      .filter(
        (credential) =>
          credential.enabled &&
          credential.status === "active" &&
          profiles.some(
            (profile) =>
              profile.id === credential.accountProfileId && profile.enabled,
          ) &&
          eligibleProjectIds.has(credential.projectId),
      )
      .map((credential) => ({
        projectId: credential.projectId,
        credentialId: credential.id,
        priority:
          profiles.find((profile) => profile.id === credential.accountProfileId)
            ?.priority ?? 0,
      }))
      .sort((left, right) => right.priority - left.priority);
  }

  private normalize(error: unknown, fallback: string): ProviderRequestError {
    return error instanceof ProviderRequestError
      ? error
      : new ProviderRequestError("unknown", fallback);
  }

  private async cooldownProject(
    candidate: Candidate,
    model: string,
    category: ProviderErrorCategory,
    attempt: number,
  ): Promise<void> {
    const duration = cooldownMs[category];
    const until = duration
      ? new Date(this.now().getTime() + duration).toISOString()
      : undefined;
    await this.accounts.recordProjectFailure(
      candidate.projectId,
      model,
      category,
      until,
    );
    await this.emit({
      type: "provider_cooldown",
      projectId: candidate.projectId,
      credentialId: candidate.credentialId,
      model,
      category,
      attempt,
      at: this.now().toISOString(),
    });
  }

  private async emit(event: ProviderRouteEvent): Promise<void> {
    await this.onEvent?.(event);
  }
}

export function getRetryDelay(
  retryIndex: number,
  baseDelayMs: number,
  random: () => number,
): number {
  const jitter = Math.min(Math.max(random(), 0), 1);
  return Math.round(baseDelayMs * 2 ** retryIndex * (0.5 + jitter));
}

function groupByProject(
  candidates: readonly Candidate[],
): Map<string, Candidate[]> {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const group = groups.get(candidate.projectId) ?? [];
    group.push(candidate);
    groups.set(candidate.projectId, group);
  }
  return groups;
}
