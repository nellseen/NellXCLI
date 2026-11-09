import { describe, expect, it } from "vitest";
import { redactSensitiveData } from "../../src/security/redaction.js";

describe("redactSensitiveData", () => {
  it("redacts secret properties and credential text recursively", () => {
    expect(
      redactSensitiveData({
        api_key: "raw-secret",
        nested: { geminiApiKey: "another-secret" },
        message: "received token=secret-value",
      }),
    ).toEqual({
      api_key: "[REDACTED]",
      nested: { geminiApiKey: "[REDACTED]" },
      message: "received token=[REDACTED]",
    });
  });
});
