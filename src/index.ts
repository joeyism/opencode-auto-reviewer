import type { PluginInput, Hooks } from "@opencode-ai/plugin";
import { resolveOptions } from "./config.js";
import { createState } from "./state.js";
import { createHooks } from "./hooks.js";
import type { AutoReviewerOptions } from "./types.js";

const autoReviewer = async (ctx: PluginInput, options?: AutoReviewerOptions): Promise<Hooks> => {
  const resolved = resolveOptions(options);
  const state = createState(resolved);
  return createHooks(ctx, state);
};

export { autoReviewer };
export default autoReviewer;
