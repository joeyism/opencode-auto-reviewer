import type { PluginInput } from "@opencode-ai/plugin";
import type { PluginState, Step, Severity } from "./types.js";

export function buildTrajectoryPrompt(steps: Step[], state: PluginState): string {
  const trajectory = steps
    .map((s, i) => `Step ${i + 1}:\nThoughts: ${s.reasoning}\nActions:\n${s.actions.join("\n")}`)
    .join("\n\n");

  const writeActions = steps.flatMap(s => s.actions)
    .filter(a => a.startsWith("TOOL: write") || a.startsWith("TOOL: edit"))
    .slice(-10); // last 10 writes

  let prompt = `You are a supervisor AI reviewing a coding agent's recent trajectory.

Context:
- Steps completed so far: ${state.completedSteps}
- Prior interventions delivered: ${state.interventionCount}
- This is a review of the last ${steps.length} steps only.

Question: Is the agent stuck in a conceptual loop, rabbit hole, or failing to make meaningful progress?

Important: "Iteration" (trying different approaches to the same problem) is NOT the same as "looping" (repeating the same failed approach). Only flag as stuck if the agent is not learning from its failures.

${trajectory}`;

  if (writeActions.length > 0) {
    prompt += `\n\nRecent file writes by the agent:\n${writeActions.join("\n")}\n`;
    prompt += `\nCheck: Do the written files appear to match the format requested in the original task? Look for common mistakes like including prefixes (e.g., "PASSWORD=") when only the value was requested, wrong delimiters, missing headers, etc.`;
  }

  return prompt;
}

export function extractTextFromParts(parts: any[] | undefined): string {
  if (!parts || !Array.isArray(parts)) return "";
  return parts
    .filter(p => p.type === "text")
    .map(p => p.text || "")
    .join("\n")
    .trim();
}

interface ReviewResult {
  stuck: boolean;
  severity: Severity;
  reason: string;
  directive: string | null;
}

function tryParseReviewJson(text: string): ReviewResult | null {
  try {
    const parsed = JSON.parse(text.trim());
    if (typeof parsed.stuck === "boolean" && typeof parsed.reason === "string") {
      let severity: Severity = "critical";
      if (parsed.severity === "hint") severity = "hint";
      else if (parsed.severity === "warning") severity = "warning";
      return {
        stuck: parsed.stuck,
        severity,
        reason: parsed.reason,
        directive: typeof parsed.directive === "string" ? parsed.directive : null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function parseReviewResult(text: string): ReviewResult | null {
  // Strip markdown fences globally
  let cleanText = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  // Try direct parse first (fast path for well-formed responses)
  const direct = tryParseReviewJson(cleanText);
  if (direct) return direct;

  // Scan for balanced-brace JSON candidates
  const candidates: string[] = [];
  let startIdx = -1;
  while ((startIdx = cleanText.indexOf("{", startIdx + 1)) !== -1) {
    let depth = 0;
    for (let i = startIdx; i < cleanText.length; i++) {
      if (cleanText[i] === "{") depth++;
      else if (cleanText[i] === "}") depth--;

      if (depth === 0) {
        candidates.push(cleanText.slice(startIdx, i + 1));
        break;
      }
    }
  }

  // Try each candidate in reverse order (last = most refined)
  for (let i = candidates.length - 1; i >= 0; i--) {
    const result = tryParseReviewJson(candidates[i]);
    if (result) return result;
  }

  return null;
}

export async function runReviewBackground(ctx: PluginInput, steps: Step[], state: PluginState): Promise<void> {
  if (state.isReviewing) return;
  state.isReviewing = true;
  let sessionID: string | null = null;
  
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Review timeout exceeded")), 180000);
  });

  try {
    const promptText = buildTrajectoryPrompt(steps, state);

    const sessionRes = await Promise.race([
      ctx.client.session.create({ body: { title: "auto-review" } }),
      timeoutPromise
    ]);
    if (!sessionRes.data || !sessionRes.data.id) {
      throw new Error("Failed to create review session");
    }
    sessionID = sessionRes.data.id;

    const systemPrompt = `You are a process observer classifying an agent's behavioral patterns. Respond ONLY with JSON: { "stuck": boolean, "severity": "hint" | "warning" | "critical", "reason": string }.

Severity levels:
- "hint": Agent is being inefficient but making progress (e.g. redundant downloads, verbose exploration). Nudge it.
- "warning": Agent appears stuck or is not converging. Recommend changing strategy.
- "critical": Agent is in a clear, repeated loop with no learning between iterations. Must abandon approach.

STRICT RULES:
1. You may ONLY observe behavioral patterns: whether the agent is repeating similar actions, whether outputs are changing between iterations, whether it is making measurable progress.
2. You MUST NOT make claims about the technical domain — no references to specific byte values, file formats, data structures, algorithms, encryption schemes, or correctness of the agent's approach. You lack the full context to judge these.
3. You MUST NOT tell the agent what technical approach to try. Do not suggest specific commands, tools, algorithms, or data interpretations.
4. Your "reason" field must describe ONLY the behavioral pattern you observed (e.g. "agent has run 6 similar XOR-decryption scripts with no change in output" or "agent is searching the same directories repeatedly"). Keep it to one sentence.
5. "Iteration" (trying genuinely different approaches to the same problem) is NOT "looping" (repeating the same failed approach without change). Only use "critical" for true loops.
6. If the agent has written deliverable files, check whether the file format matches what was requested in the original task (if visible in the trajectory). Common errors: including key=value format when only the value was requested, wrong delimiters, missing headers.

No other text. No directive field. Just the JSON object.`;

    const promptRes = await Promise.race([
      ctx.client.session.prompt({
        path: { id: sessionID },
        body: {
          agent: state.options.agent,
          system: systemPrompt,
          tools: {},
          parts: [{ type: "text", text: promptText }]
        }
      }),
      timeoutPromise
    ]);

    if (!promptRes.data) {
      throw new Error("Failed to prompt review session");
    }

    const responseText = extractTextFromParts(promptRes.data.parts);
    let result = parseReviewResult(responseText);

    if (!result) {
      // Retry once: ask the reviewer to re-emit valid JSON
      state.log.warn("Malformed review response, retrying once");
      const retryRes = await Promise.race([
        ctx.client.session.prompt({
          path: { id: sessionID },
          body: {
            agent: state.options.agent,
            system: systemPrompt,
            tools: {},
            parts: [{ 
              type: "text", 
              text: `Your previous response was not valid JSON. Please respond with ONLY a single JSON object matching this exact schema:\n\n{ "stuck": boolean, "severity": "hint" | "warning" | "critical", "reason": string }\n\nNo markdown fences. No extra text. Just the JSON object.` 
            }]
          }
        }),
        timeoutPromise
      ]);
      if (retryRes.data) {
        const retryText = extractTextFromParts(retryRes.data.parts);
        result = parseReviewResult(retryText);
      }
    }

    if (!result) {
      throw new Error(`Invalid response format from Reviewer API after retry: ${responseText.slice(0, 500)}`);
    }

    if (result.stuck) {
      const suffixes: Record<Severity, string> = {
        hint: "\n\nConsider adjusting your approach based on the above feedback.",
        warning: "\n\nYou should change your strategy. Your current approach is not converging on a solution.",
        critical: "\n\nCRITICAL MANDATE: You MUST abandon your current approach immediately. Delete problematic files and spawn a fresh subagent if your context is polluted."
      };

      let suffix = suffixes[result.severity];
      if (state.interventionCount >= 2) {
        suffix = "\n\nYou have been redirected multiple times. Do NOT restart from scratch again. Make a single, targeted change and verify it works before proceeding.";
      }
      
      const feedbackText = result.reason;
      state.pendingFeedback = { text: feedbackText + suffix, severity: result.severity };
      state.pendingFeedbackAtStep = state.completedSteps;
    }
  } catch (e) {
    state.log.error("API or execution failed:", e);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    if (sessionID) {
      try {
        await ctx.client.session.delete({ path: { id: sessionID } });
      } catch (e) {
        state.log.warn("Auto-Reviewer failed to delete session:", e);
      }
    }
    state.isReviewing = false;
  }
}
