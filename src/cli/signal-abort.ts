import type { EventEmitter } from "node:events";

export type SignalSource = Pick<EventEmitter, "once" | "removeListener">;

export function attachAbortSignals(
  controller: AbortController,
  source: SignalSource = process,
): () => void {
  const abort = (): void => controller.abort();
  source.once("SIGINT", abort);
  source.once("SIGTERM", abort);
  return () => {
    source.removeListener("SIGINT", abort);
    source.removeListener("SIGTERM", abort);
  };
}
