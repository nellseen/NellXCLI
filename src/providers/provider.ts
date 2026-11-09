export type ProviderErrorCategory =
  | "authentication"
  | "permission"
  | "rate_limit"
  | "quota_exhausted"
  | "temporary_server"
  | "network"
  | "invalid_request"
  | "safety_or_policy"
  | "cancelled"
  | "unknown";

export type ModelCapability = "textGeneration";

export interface ModelInfo {
  id: string;
  displayName: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  capabilities: readonly ModelCapability[];
}

export interface ImageAttachment {
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}

export interface TextGenerationRequest {
  model: string;
  prompt: string;
  images?: readonly ImageAttachment[];
  signal?: AbortSignal;
}

export interface TextProvider {
  listModels(): Promise<readonly ModelInfo[]>;
  streamText(request: TextGenerationRequest): AsyncIterable<string>;
}

export class ProviderRequestError extends Error {
  readonly category: ProviderErrorCategory;
  readonly statusCode?: number;

  constructor(
    category: ProviderErrorCategory,
    message: string,
    statusCode?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
    this.category = category;
    if (statusCode !== undefined) this.statusCode = statusCode;
  }
}

export class ProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigurationError";
  }
}

export interface ModelSelectionRequirements {
  model?: string;
  capability?: ModelCapability;
}

export function selectModel(
  models: readonly ModelInfo[],
  requirements: ModelSelectionRequirements = {},
): ModelInfo {
  const capability = requirements.capability ?? "textGeneration";
  const usableModels = models.filter((model) =>
    model.capabilities.includes(capability),
  );

  if (requirements.model) {
    const match = usableModels.find((model) => model.id === requirements.model);
    if (match) return match;
    throw new ProviderConfigurationError(
      `Model "${requirements.model}" is unavailable or does not support ${capability}. Run "nellx models list" to see usable models.`,
    );
  }

  const first = usableModels[0];
  if (first) return first;
  throw new ProviderConfigurationError(
    `No available model supports ${capability}. Check the configured Gemini API key and project access.`,
  );
}
