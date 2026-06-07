import type { PluginInput } from "@opencode-ai/plugin";
import type { PluginState } from "./types.js";
import { runReviewBackground } from "./review.js";
import { createEmptyStep } from "./state.js";

export function createHooks(ctx: PluginInput, state: PluginState) {
  const compactSession = async (sessionID: string) => {
    if (!sessionID) return;
    try {
      await (ctx.client as any).session.summarize({ path: { id: sessionID } });
    } catch (e) {
      state.log.warn("Failed to compact session:", e);
    }
  };

  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: any }
    ) => {
      state.mainSessionID = input.sessionID;

      if (state.pendingFeedback) {
        if (
          state.pendingFeedback.severity === "hint" &&
          state.pendingFeedbackAtStep !== null &&
          state.completedSteps - state.pendingFeedbackAtStep >= state.options.feedbackExpirySteps
        ) {
          state.pendingFeedback = null;
          state.pendingFeedbackAtStep = null;
        } else {
          const feedback = state.pendingFeedback;
          state.pendingFeedback = null;
          state.pendingFeedbackAtStep = null;
          state.interventionCount += 1;

          const prefix = "🚨 AUTO-REVIEWER INTERVENTION 🚨\n\n";
          const feedbackText = prefix + feedback.text;

          // Compact session in the background
          (async () => {
            try {
              await compactSession(input.sessionID);
            } catch (e) {
              // ignore
            }
          })();

          if (feedback.severity === "critical") {
            throw new Error(feedbackText);
          } else {
            state.deferredFeedback = feedbackText;
          }
        }
      }

      const argsStr = JSON.stringify(output?.args || {});
      state.currentStep.actions.push(`TOOL: ${input.tool} args: ${argsStr}`);
    },
    "tool.execute.after": async (
      input: { tool: string; sessionID: string; callID: string; args: any },
      output: { title: string; output: string; metadata: any }
    ) => {
      if (state.deferredFeedback && output) {
        output.output = (output.output || "") + "\n\n" + state.deferredFeedback;
        state.deferredFeedback = null;
      }
      state.currentStep.actions.push(`OUTPUT: ${output?.output || ""}`);
    },
    event: async (input: { event: any }) => {
      const event = input?.event;
      state.log.info(`event received: type=${event?.type}`);
      if (event?.type !== "message.part.updated") return;
      const part = event?.part || event?.properties?.part;
      
      if (part?.type === "reasoning") {
        state.currentStep.reasoning = part.text || "";
        return;
      }

      if (part?.type !== "step-finish") return;

      state.completedSteps += 1;

      state.stepsBuffer.push(state.currentStep);
      state.log.info(`step-finish: completedSteps=${state.completedSteps}, buffer=${state.stepsBuffer.length}/${state.options.reviewIntervalSteps}`);
      state.currentStep = createEmptyStep();

      if (state.stepsBuffer.length >= state.options.reviewIntervalSteps && !state.isReviewing) {
        state.log.info(`TRIGGERING REVIEW at step ${state.completedSteps}`);
        const copiedBuffer = [...state.stepsBuffer];
        state.stepsBuffer = [];
        runReviewBackground(ctx, copiedBuffer, state).catch((err) => {
          state.log.error("Background task failed:", err);
        });
      }
    },
  };
}
