import type { AutoReviewerOptions, ResolvedOptions } from "./types.js";

export function resolveOptions(options?: AutoReviewerOptions): ResolvedOptions {
  return {
    reviewIntervalSteps: options?.reviewIntervalSteps ?? 25,
    feedbackExpirySteps: options?.feedbackExpirySteps ?? 5,
    agent: options?.agent ?? "momus",
    logLevel: options?.logLevel ?? "error",
  };
}
