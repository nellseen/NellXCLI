import { describe, expect, it } from "vitest";
import { readTaskPrompt } from "../../src/index.js";

async function* chunks(...values: unknown[]): AsyncGenerator<unknown> {
  for (const value of values) yield value;
}
describe("run prompt input", () => {
  it("reads a bounded prompt from mixed text and buffers", async () => {
    await expect(
      readTaskPrompt("-", chunks("Fix ", Buffer.from("the bug."))),
    ).resolves.toBe("Fix the bug.");
    await expect(
      readTaskPrompt("direct argument", chunks("ignored")),
    ).resolves.toBe("direct argument");
  });
  it("rejects empty, oversized, and unsupported piped input", async () => {
    await expect(readTaskPrompt("-", chunks("  "))).rejects.toThrow(
      /did not contain/i,
    );
    await expect(
      readTaskPrompt("-", chunks("x".repeat(20_001))),
    ).rejects.toThrow(/20,000 character/i);
    await expect(readTaskPrompt("-", chunks(42))).rejects.toThrow(
      /unsupported data type/i,
    );
  });
});
