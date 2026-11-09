import { describe, expect, it } from "vitest";
import { createProgram } from "../src/index.js";

describe("CLI program", () => {
  it("has the nellx name and version", () => {
    const program = createProgram();

    expect(program.name()).toBe("nellx");
    expect(program.version()).toBe("0.1.0");
  });

  it("provides help with the expected description", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain(
      "An independent Gemini-powered terminal coding agent",
    );
    expect(help).toContain("--version");
  });
});
