import { describe, expect, it, vi } from "vitest";
import {
  createGeminiProvider,
  GeminiProvider,
  getGeminiApiKey,
  normalizeGeminiError,
} from "../../src/providers/gemini.js";
import {
  ProviderConfigurationError,
  selectModel,
} from "../../src/providers/provider.js";

async function* items<T>(...values: T[]): AsyncIterable<T> {
  for (const value of values) yield value;
}

describe("GeminiProvider", () => {
  it("lists only models that support text generation", async () => {
    const provider = new GeminiProvider({
      models: {
        list: vi.fn(async () =>
          items(
            {
              name: "models/gemini-flash",
              displayName: "Gemini Flash",
              supportedActions: ["generateContent"],
              inputTokenLimit: 1000,
            },
            {
              name: "models/gemini-image",
              supportedActions: ["generateImages"],
            },
            { name: "models/unknown-capability" },
          ),
        ),
        generateContentStream: vi.fn(),
      },
    });

    await expect(provider.listModels()).resolves.toEqual([
      {
        id: "models/gemini-flash",
        displayName: "Gemini Flash",
        inputTokenLimit: 1000,
        capabilities: ["textGeneration"],
      },
    ]);
  });

  it("streams text chunks and skips non-text chunks", async () => {
    const generateContentStream = vi.fn(async () =>
      items({ text: "hello " }, {}, { text: "world" }),
    );
    const provider = new GeminiProvider({
      models: {
        list: vi.fn(async () =>
          items<{ name?: string; supportedActions?: string[] }>(),
        ),
        generateContentStream,
      },
    });

    const chunks: string[] = [];
    for await (const chunk of provider.streamText({
      model: "models/gemini-flash",
      prompt: "hi",
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hello ", "world"]);
    expect(generateContentStream).toHaveBeenCalledWith({
      model: "models/gemini-flash",
      contents: "hi",
    });
  });

  it("streams a prompt with validated image attachments as Gemini parts", async () => {
    const generateContentStream = vi.fn(async () =>
      items({ text: "image answer" }),
    );
    const provider = new GeminiProvider({
      models: {
        list: vi.fn(async () =>
          items<{ name?: string; supportedActions?: string[] }>(),
        ),
        generateContentStream,
      },
    });
    const image = {
      mimeType: "image/png" as const,
      data: Buffer.from("image").toString("base64"),
    };
    for await (const chunk of provider.streamText({
      model: "models/gemini-flash",
      prompt: "describe",
      images: [image],
    })) {
      expect(chunk).toBe("image answer");
    }
    expect(generateContentStream).toHaveBeenCalledWith({
      model: "models/gemini-flash",
      contents: [
        { role: "user", parts: [{ text: "describe" }, { inlineData: image }] },
      ],
    });
  });

  it("passes cancellation signals to the SDK", async () => {
    const signal = new AbortController().signal;
    const generateContentStream = vi.fn(async () =>
      items<{ text?: string | undefined }>(),
    );
    const provider = new GeminiProvider({
      models: {
        list: vi.fn(async () =>
          items<{ name?: string; supportedActions?: string[] }>(),
        ),
        generateContentStream,
      },
    });

    const chunks: string[] = [];
    for await (const chunk of provider.streamText({
      model: "model",
      prompt: "hi",
      signal,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([]);

    expect(generateContentStream).toHaveBeenCalledWith({
      model: "model",
      contents: "hi",
      config: { abortSignal: signal },
    });
  });

  it("surfaces safety blocks returned as stream metadata", async () => {
    const provider = new GeminiProvider({
      models: {
        list: vi.fn(async () =>
          items<{ name?: string; supportedActions?: string[] }>(),
        ),
        generateContentStream: vi.fn(async () =>
          items({ promptFeedback: { blockReason: "SAFETY" } }),
        ),
      },
    });

    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of provider.streamText({
        model: "model",
        prompt: "unsafe",
      })) {
        chunks.push(chunk);
      }
    }).rejects.toMatchObject({ category: "safety_or_policy" });
    expect(chunks).toEqual([]);
  });

  it("does not replay a stream after partial output and a transport failure", async () => {
    async function* brokenStream() {
      yield { text: "partial" };
      throw Object.assign(new Error("temporary server failure"), {
        status: 503,
      });
    }
    const generateContentStream = vi.fn(async () => brokenStream());
    const provider = new GeminiProvider({
      models: {
        list: vi.fn(async () =>
          items<{ name?: string; supportedActions?: string[] }>(),
        ),
        generateContentStream,
      },
    });
    const visible: string[] = [];

    await expect(async () => {
      for await (const chunk of provider.streamText({
        model: "model",
        prompt: "task",
      })) {
        visible.push(chunk);
      }
    }).rejects.toMatchObject({ category: "temporary_server" });
    expect(visible).toEqual(["partial"]);
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  });

  it("normalizes SDK errors without exposing provider messages or credentials", async () => {
    const provider = new GeminiProvider({
      models: {
        list: vi.fn(async () => {
          throw Object.assign(new Error("bad api key: secret-value"), {
            status: 401,
          });
        }),
        generateContentStream: vi.fn(async () =>
          items<{ text?: string | undefined }>(),
        ),
      },
    });

    await expect(provider.listModels()).rejects.toMatchObject({
      name: "ProviderRequestError",
      category: "authentication",
      statusCode: 401,
      message:
        "Gemini rejected the API key. Check GEMINI_API_KEY or GOOGLE_API_KEY.",
    });
    await expect(provider.listModels()).rejects.not.toThrow("secret-value");
  });

  it("classifies quota, throttling, safety, server, and network failures", () => {
    expect(
      normalizeGeminiError(
        { status: 429, message: "daily quota exceeded" },
        "context",
      ).category,
    ).toBe("quota_exhausted");
    expect(
      normalizeGeminiError(
        { status: 429, message: "too many requests" },
        "context",
      ).category,
    ).toBe("rate_limit");
    expect(
      normalizeGeminiError(
        { status: 400, message: "safety blocked" },
        "context",
      ).category,
    ).toBe("safety_or_policy");
    expect(normalizeGeminiError({ status: 503 }, "context").category).toBe(
      "temporary_server",
    );
    expect(
      normalizeGeminiError(
        { status: 400, message: "API key not valid" },
        "context",
      ).category,
    ).toBe("authentication");
    expect(
      normalizeGeminiError(
        { status: 403, message: "project quota exceeded" },
        "context",
      ).category,
    ).toBe("quota_exhausted");
    expect(
      normalizeGeminiError(new TypeError("fetch failed"), "context").category,
    ).toBe("network");
  });
});

describe("provider configuration and model selection", () => {
  it("reads an API key from environment variables without persisting it", () => {
    expect(getGeminiApiKey({ GEMINI_API_KEY: "test-key" })).toBe("test-key");
    expect(getGeminiApiKey({ GOOGLE_API_KEY: "google-key" })).toBe(
      "google-key",
    );
    expect(() => getGeminiApiKey({})).toThrow(ProviderConfigurationError);
  });

  it("rejects unavailable and unsupported models", () => {
    const models = [
      {
        id: "gemini-flash",
        displayName: "Flash",
        capabilities: ["textGeneration"] as const,
      },
      { id: "image-model", displayName: "Image", capabilities: [] as const },
    ];

    expect(selectModel(models, { model: "gemini-flash" }).id).toBe(
      "gemini-flash",
    );
    expect(() => selectModel(models, { model: "image-model" })).toThrow(
      /unavailable or does not support/,
    );
    expect(() => selectModel([], {})).toThrow(/No available model supports/);
  });

  it("rejects an empty API key before creating the SDK client", () => {
    expect(() => createGeminiProvider(" ")).toThrow(/API key is empty/);
    expect(() => getGeminiApiKey({ GEMINI_API_KEY: " " })).toThrow(
      /API key is missing/,
    );
  });
});
