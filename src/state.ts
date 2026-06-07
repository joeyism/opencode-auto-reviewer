import { createLogger } from "./logger.js";
import type { ResolvedOptions, PluginState, Step } from "./types.js";

export function createEmptyStep(): Step {
  return {
    reasoning: "",
    actions: [],
  };
}

export function createState(options: ResolvedOptions): PluginState {
  return {
    options,
    log: createLogger(options.logLevel),
    stepsBuffer: [],
    currentStep: createEmptyStep(),
    isReviewing: false,
    pendingFeedback: null,
    deferredFeedback: null,
    completedSteps: 0,
    pendingFeedbackAtStep: null,
    interventionCount: 0,
    mainSessionID: null,
  };
}
