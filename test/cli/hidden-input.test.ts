import { Readable } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import { describe, expect, it } from "vitest";
import { readHiddenInput } from "../../src/cli/hidden-input.js";

describe("readHiddenInput", () => {
  it("reads piped secrets without echoing their value", async () => {
    const input = Readable.from(["secret-value\n"]) as unknown as ReadStream;
    let outputText = "";
    const output = {
      write: (chunk: string) => {
        outputText += chunk;
        return true;
      },
    } as unknown as WriteStream;

    await expect(readHiddenInput("API key: ", input, output)).resolves.toBe(
      "secret-value",
    );
    expect(outputText).toContain("API key: ");
    expect(outputText).not.toContain("secret-value");
  });
});
