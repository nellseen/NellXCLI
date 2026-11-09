import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { attachAbortSignals } from "../../src/cli/signal-abort.js";

describe("CLI abort signals", () => {
  it("aborts on SIGINT and SIGTERM and removes listeners after completion", () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const source = new EventEmitter();
      const controller = new AbortController();
      const detach = attachAbortSignals(controller, source);
      source.emit(signal);
      expect(controller.signal.aborted).toBe(true);
      detach();
      expect(source.listenerCount("SIGINT")).toBe(0);
      expect(source.listenerCount("SIGTERM")).toBe(0);
    }
  });
});
