import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import {
  ProviderConfigurationError,
  ProviderRequestError,
  type ModelInfo,
  type TextGenerationRequest,
  type TextProvider,
  type ProviderErrorCategory,
} from "./provider.js";

interface GeminiSdkModel {
  name?: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedActions?: string[];
}

interface GeminiSdkChunk {
  text?: string | undefined;
  promptFeedback?: { blockReason?: string | undefined };
  candidates?: Array<{ finishReason?: string | undefined }>;
}

interface GeminiSdkClient {
  models: {
    list(params?: {
      config?: { pageSize?: number };
    }): Promise<AsyncIterable<GeminiSdkModel>>;
    generateContentStream(params: {
      model: string;
      contents:
        | string
        | Array<{
            role: "user";
            parts: Array<
              | { text: string }
              | { inlineData: { mimeType: string; data: string } }
            >;
          }>;
      config?: { abortSignal?: AbortSignal };
    }): Promise<AsyncIterable<GeminiSdkChunk>>;
  };
}

export class GeminiProvider implements TextProvider {
  constructor(private readonly client: GeminiSdkClient) {}

  async listModels(): Promise<readonly ModelInfo[]> {
    try {
      const page = await this.client.models.list({ config: { pageSize: 100 } });
      const models: ModelInfo[] = [];

      for await (const model of page) {
        if (!model.name || !model.supportedActions?.includes("generateContent"))
          continue;
        models.push({
          id: model.name,
          displayName: model.displayName || model.name,
          ...(model.description ? { description: model.description } : {}),
          ...(model.inputTokenLimit !== undefined
            ? { inputTokenLimit: model.inputTokenLimit }
            : {}),
          ...(model.outputTokenLimit !== undefined
            ? { outputTokenLimit: model.outputTokenLimit }
            : {}),
          capabilities: ["textGeneration"],
        });
      }

      return models;
    } catch (error) {
      throw normalizeGeminiError(
        error,
        "Unable to list Gemini models. Check the API key and project access.",
      );
    }
  }

  async *streamText(request: TextGenerationRequest): AsyncIterable<string> {
    const images = z
      .array(
        z.object({
          mimeType: z.enum([
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
          ]),
          data: z.base64(),
        }),
      )
      .max(4)
      .parse(request.images ?? []);
    const imageBytes = images.reduce(
      (total, image) => total + Buffer.from(image.data, "base64").byteLength,
      0,
    );
    if (imageBytes > 8_000_000)
      throw new ProviderConfigurationError(
        "Attached images exceed the 8 MB total limit.",
      );
    const contents = images.length
      ? [
          {
            role: "user" as const,
            parts: [
              { text: request.prompt },
              ...images.map((image) => ({
                inlineData: { mimeType: image.mimeType, data: image.data },
              })),
            ],
          },
        ]
      : request.prompt;
    try {
      const stream = await this.client.models.generateContentStream({
        model: request.model,
        contents,
        ...(request.signal ? { config: { abortSignal: request.signal } } : {}),
      });

      for await (const chunk of stream) {
        const blockedBySafety =
          Boolean(chunk.promptFeedback?.blockReason) ||
          chunk.candidates?.some((candidate) =>
            containsAny(candidate.finishReason?.toLowerCase() ?? "", [
              "safety",
              "blocklist",
              "prohibited_content",
            ]),
          );
        if (blockedBySafety) {
          throw new ProviderRequestError(
            "safety_or_policy",
            "Gemini rejected the request under its safety or policy rules. Review the prompt before submitting again.",
          );
        }
        if (chunk.text) yield chunk.text;
      }
    } catch (error) {
      throw normalizeGeminiError(
        error,
        "Gemini text generation failed. Review the model and request, then try again.",
      );
    }
  }
}

export function createGeminiProvider(apiKey: string): GeminiProvider {
  const normalizedKey = apiKey.trim();
  if (!normalizedKey) {
    throw new ProviderConfigurationError(
      "Gemini API key is empty. Set GEMINI_API_KEY or GOOGLE_API_KEY in the environment.",
    );
  }

  return new GeminiProvider(new GoogleGenAI({ apiKey: normalizedKey }));
}

export function getGeminiApiKey(env: NodeJS.ProcessEnv = process.env): string {
  const apiKey = env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
  if (!apiKey?.trim()) {
    throw new ProviderConfigurationError(
      "Gemini API key is missing. Set GEMINI_API_KEY or GOOGLE_API_KEY in the environment. NellXCLI does not save API keys to settings.",
    );
  }
  return apiKey;
}

export function normalizeGeminiError(
  error: unknown,
  context: string,
): ProviderRequestError {
  const statusCode = readStatusCode(error);
  const message = readErrorMessage(error).toLowerCase();
  const category = classifyGeminiError(error, statusCode, message);

  const safeMessage = safeErrorMessage(category, context);
  return new ProviderRequestError(category, safeMessage, statusCode);
}

function classifyGeminiError(
  error: unknown,
  statusCode: number | undefined,
  message: string,
): ProviderErrorCategory {
  if (error instanceof Error && error.name === "AbortError") return "cancelled";
  if (
    containsAny(message, [
      "safety",
      "blocked",
      "policy violation",
      "prohibited content",
    ])
  ) {
    return "safety_or_policy";
  }

  if (
    containsAny(message, [
      "api key not valid",
      "invalid api key",
      "api_key_invalid",
    ])
  ) {
    return "authentication";
  }
  if (statusCode === 401) return "authentication";
  if (statusCode === 403) {
    return containsAny(message, ["quota", "billing", "daily limit"])
      ? "quota_exhausted"
      : "permission";
  }
  if (statusCode === 429) {
    return containsAny(message, ["quota", "billing", "daily limit"])
      ? "quota_exhausted"
      : "rate_limit";
  }
  if (
    statusCode === 408 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504
  ) {
    return "temporary_server";
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 422)
    return "invalid_request";
  if (
    error instanceof TypeError ||
    containsAny(message, ["econnreset", "enotfound", "fetch failed", "network"])
  ) {
    return "network";
  }
  return "unknown";
}

function safeErrorMessage(
  category: ProviderErrorCategory,
  context: string,
): string {
  switch (category) {
    case "authentication":
      return "Gemini rejected the API key. Check GEMINI_API_KEY or GOOGLE_API_KEY.";
    case "permission":
      return "Gemini denied access. Check API enablement, project permissions, and model availability.";
    case "rate_limit":
      return "Gemini rate limit reached. Wait before retrying.";
    case "quota_exhausted":
      return "Gemini project/model quota is exhausted. Check project quota and billing; changing keys in the same project will not reset it.";
    case "temporary_server":
      return "Gemini is temporarily unavailable. Retry later.";
    case "network":
      return "Could not reach Gemini. Check the network connection and retry.";
    case "invalid_request":
      return `${context} Check the selected model and request parameters.`;
    case "safety_or_policy":
      return "Gemini rejected the request under its safety or policy rules. Review the prompt before submitting again.";
    case "cancelled":
      return "Gemini request was cancelled.";
    case "unknown":
      return context;
  }
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string") return message;
  }
  return typeof error === "string" ? error : "";
}

function readStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error))
    return undefined;
  const status = error.status;
  return typeof status === "number" ? status : undefined;
}

function containsAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}
