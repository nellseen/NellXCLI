import { describe, expect, it } from "vitest";
import {
  createGeminiProvider,
  getGeminiApiKey,
} from "../../src/providers/gemini.js";

const smokeEnabled =
  process.env.NELLX_GEMINI_SMOKE === "1" &&
  Boolean(
    process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim(),
  );

describe.skipIf(!smokeEnabled)("Gemini API smoke test", () => {
  it("discovers models available to the configured credential", async () => {
    const provider = createGeminiProvider(getGeminiApiKey());
    const models = await provider.listModels();

    expect(models.length).toBeGreaterThan(0);
    expect(
      models.every((model) => model.capabilities.includes("textGeneration")),
    ).toBe(true);
  }, 30_000);
});
