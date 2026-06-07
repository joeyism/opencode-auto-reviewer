export interface AutoReviewerOptions {
  reviewIntervalSteps?: number;
  feedbackExpirySteps?: number;
  agent?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
}

export interface ResolvedOptions {
  reviewIntervalSteps: number;
  feedbackExpirySteps: number;
  agent: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export type Severity = "hint" | "warning" | "critical";

export interface Step {
  reasoning: string;
  actions: string[];
}

export interface PluginState {
  options: ResolvedOptions;
  log: {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
  stepsBuffer: Step[];
  currentStep: Step;
  isReviewing: boolean;
  pendingFeedback: { text: string; severity: Severity } | null;
  deferredFeedback: string | null;
  completedSteps: number;
  pendingFeedbackAtStep: number | null;
  interventionCount: number;
  mainSessionID: string | null;
}
