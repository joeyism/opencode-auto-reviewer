import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runReviewBackground, buildTrajectoryPrompt, parseReviewResult } from "../src/review.js";
import { createState } from "../src/state.js";
import { resolveOptions } from "../src/config.js";
import type { PluginInput } from "@opencode-ai/plugin";

describe("review", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createMockCtx = () => {
    return {
      client: {
        session: {
          create: vi.fn().mockResolvedValue({ data: { id: "test-session-id" } }),
          prompt: vi.fn().mockResolvedValue({
            data: {
              parts: [{ type: "text", text: JSON.stringify({ stuck: true, severity: "critical", reason: "Stuck in a loop" }) }]
            }
          }),
          delete: vi.fn().mockResolvedValue({}),
        }
      }
    } as unknown as PluginInput;
  };

  describe("parseReviewResult", () => {
    it("parses valid JSON", () => {
      const result = parseReviewResult(JSON.stringify({ stuck: true, severity: "warning", reason: "testing" }));
      expect(result).toEqual({ stuck: true, severity: "warning", reason: "testing", directive: null });
    });

    it("handles markdown fences", () => {
      const result = parseReviewResult("```json\n" + JSON.stringify({ stuck: true, severity: "warning", reason: "testing" }) + "\n```");
      expect(result).toEqual({ stuck: true, severity: "warning", reason: "testing", directive: null });
    });

    it("handles double JSON (the failure case)", () => {
      const input = "```json\n{ \"stuck\": true, \"severity\": \"warning\", \"reason\": \"first attempt\", \"directive\": \"truncated\n{ \"stuck\": true, \"severity\": \"critical\", \"reason\": \"second attempt\", \"directive\": \"complete\" }\n```";
      const result = parseReviewResult(input);
      expect(result).toEqual({ stuck: true, severity: "critical", reason: "second attempt", directive: "complete" });
    });

    it("picks the last valid JSON from multiple objects", () => {
      const input = JSON.stringify({ stuck: false, reason: "one" }) + "\n" + JSON.stringify({ stuck: true, severity: "hint", reason: "two" });
      const result = parseReviewResult(input);
      expect(result?.reason).toBe("two");
    });

    it("extracts JSON from surrounding text", () => {
      const input = "Analysis: { \"stuck\": true, \"severity\": \"hint\", \"reason\": \"text extraction\" } Hope this helps.";
      const result = parseReviewResult(input);
      expect(result?.reason).toBe("text extraction");
    });

    it("returns null for non-JSON content", () => {
      expect(parseReviewResult("not json")).toBeNull();
    });

    it("returns null for truncated JSON only", () => {
      expect(parseReviewResult("{ \"stuck\": true, \"reason\": \"incomplete")).toBeNull();
    });
  });

  describe("runReviewBackground with retry", () => {
    it("retries once if first response is malformed", async () => {
      const mockCtx = createMockCtx();
      vi.mocked(mockCtx.client.session.prompt)
        .mockResolvedValueOnce({ data: { parts: [{ type: "text", text: "garbage" }] } })
        .mockResolvedValueOnce({ data: { parts: [{ type: "text", text: JSON.stringify({ stuck: true, severity: "critical", reason: "Recovered" }) }] } });

      const state = createState(resolveOptions());
      await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

      expect(mockCtx.client.session.prompt).toHaveBeenCalledTimes(2);
      expect(state.pendingFeedback?.text).toContain("Recovered");
      expect(state.isReviewing).toBe(false);
    });

    it("fails if retry also returns malformed response", async () => {
      const mockCtx = createMockCtx();
      vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({ data: { parts: [{ type: "text", text: "still garbage" }] } });

      const state = createState(resolveOptions());
      await runReviewBackground(mockCtx, [], state);

      expect(mockCtx.client.session.prompt).toHaveBeenCalledTimes(2);
      expect(state.pendingFeedback).toBeNull();
      expect(state.isReviewing).toBe(false);
    });
  });

  it("uses reason for feedback text even when directive is present", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ stuck: true, severity: "critical", reason: "Stuck in a loop", directive: "Write code now." }) }]
      }
    });
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Stuck in a loop");
    expect(state.pendingFeedback?.text).not.toContain("Write code now.");
    expect(state.pendingFeedback?.text).toContain("CRITICAL MANDATE");
    expect(state.isReviewing).toBe(false);
  });

  it("falls back to reason if directive is missing", async () => {
    const mockCtx = createMockCtx();
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Stuck in a loop");
    expect(state.pendingFeedback?.text).toContain("CRITICAL MANDATE");
    expect(state.isReviewing).toBe(false);
  });

  it("sets pending feedback if stuck (hint)", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ stuck: true, severity: "hint", reason: "Inefficient downloads" }) }]
      }
    });
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Inefficient downloads");
    expect(state.pendingFeedback?.text).toContain("Consider adjusting your approach based on the above feedback.");
    expect(state.pendingFeedback?.text).not.toContain("CRITICAL MANDATE");
    expect(state.isReviewing).toBe(false);
  });

  it("sets pending feedback if stuck (warning)", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ stuck: true, severity: "warning", reason: "Not converging" }) }]
      }
    });
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Not converging");
    expect(state.pendingFeedback?.text).toContain("You should change your strategy.");
    expect(state.pendingFeedback?.text).not.toContain("CRITICAL MANDATE");
    expect(state.isReviewing).toBe(false);
  });

  it("sets default to critical if severity is missing", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ stuck: true, reason: "Stuck in a loop" }) }]
      }
    });
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Stuck in a loop");
    expect(state.pendingFeedback?.text).toContain("CRITICAL MANDATE");
    expect(state.isReviewing).toBe(false);
  });

  it("sets default to critical if severity is invalid", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ stuck: true, severity: "invalid_severity", reason: "Stuck in a loop" }) }]
      }
    });
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Stuck in a loop");
    expect(state.pendingFeedback?.text).toContain("CRITICAL MANDATE");
    expect(state.isReviewing).toBe(false);
  });

  it("does not set pending feedback if not stuck", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ stuck: false, reason: "All good" }) }]
      }
    });

    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [], state);

    expect(state.pendingFeedback).toBeNull();
    expect(state.isReviewing).toBe(false);
  });

  it("handles session create errors gracefully", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.create).mockRejectedValue(new Error("Network error"));
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [], state);
    expect(state.pendingFeedback).toBeNull();
    expect(state.isReviewing).toBe(false);
    expect(mockCtx.client.session.prompt).not.toHaveBeenCalled();
    expect(mockCtx.client.session.delete).not.toHaveBeenCalled();
  });

  it("handles prompt errors gracefully and deletes session", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockRejectedValue(new Error("Timeout error"));
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [], state);
    expect(state.pendingFeedback).toBeNull();
    expect(state.isReviewing).toBe(false);
    expect(mockCtx.client.session.delete).toHaveBeenCalledWith({ path: { id: "test-session-id" } });
  });

  it("handles invalid JSON format gracefully", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: "this is not json" }]
      }
    });
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [], state);
    expect(state.pendingFeedback).toBeNull();
    expect(state.isReviewing).toBe(false);
  });

  it("handles a null timeout handle gracefully", async () => {
    const mockCtx = createMockCtx();
    const state = createState(resolveOptions());
    vi.spyOn(globalThis, "setTimeout").mockReturnValueOnce(null as any);

    await runReviewBackground(mockCtx, [], state);

    expect(state.isReviewing).toBe(false);
    expect(mockCtx.client.session.delete).toHaveBeenCalledWith({ path: { id: "test-session-id" } });
  });

  it("returns early when already reviewing", async () => {
    const mockCtx = createMockCtx();
    const state = createState(resolveOptions());
    state.isReviewing = true;

    await runReviewBackground(mockCtx, [], state);

    expect(mockCtx.client.session.create).not.toHaveBeenCalled();
    expect(mockCtx.client.session.prompt).not.toHaveBeenCalled();
    expect(mockCtx.client.session.delete).not.toHaveBeenCalled();
    expect(state.isReviewing).toBe(true);
  });

  it("handles delete failure gracefully", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.delete).mockRejectedValue(new Error("Delete failed"));
    const state = createState(resolveOptions({ logLevel: "warn" }));
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    // Should still succeed at setting feedback
    expect(state.pendingFeedback?.text).toContain("Stuck in a loop");
    expect(state.isReviewing).toBe(false);
    expect(console.warn).toHaveBeenCalledWith("[Auto-Reviewer]", "Auto-Reviewer failed to delete session:", expect.any(Error));
  });

  it("handles json wrapped in json markdown fences", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: "```json\n" + JSON.stringify({ stuck: true, reason: "Stuck in a loop" }) + "\n```" }]
      }
    });

    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Stuck in a loop");
  });

  it("handles json wrapped in plain markdown fences", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: "```\n" + JSON.stringify({ stuck: true, reason: "Stuck in a loop" }) + "\n```" }]
      }
    });

    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Stuck in a loop");
  });

  it("handles json missing required fields", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ stuck: true }) }] // missing reason
      }
    });

    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [], state);

    expect(state.pendingFeedback).toBeNull();
  });

  it("handles session create returning no data", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.create).mockResolvedValue({}); // no data
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [], state);
    
    expect(state.pendingFeedback).toBeNull();
    expect(mockCtx.client.session.prompt).not.toHaveBeenCalled();
  });

  it("handles prompt returning no data", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({}); // no data
    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [], state);
    
    expect(state.pendingFeedback).toBeNull();
    expect(mockCtx.client.session.delete).toHaveBeenCalled();
  });

  it("handles empty parts or non-text parts", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "file" }]
      }
    } as any);

    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [], state);

    expect(state.pendingFeedback).toBeNull();
  });

  it("handles undefined parts array", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: undefined as any
      }
    } as any);

    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [], state);

    expect(state.pendingFeedback).toBeNull();
  });

  it("handles text part with undefined text", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: undefined as any }]
      }
    } as any);

    const state = createState(resolveOptions());
    await runReviewBackground(mockCtx, [], state);

    expect(state.pendingFeedback).toBeNull();
  });

  it("buildTrajectoryPrompt includes state context", () => {
    const state = createState(resolveOptions());
    state.completedSteps = 42;
    state.interventionCount = 3;

    const prompt = buildTrajectoryPrompt(
      [{ reasoning: "Thinking hard", actions: ["TOOL: bash"] }],
      state
    );

    expect(prompt).toContain("Steps completed so far: 42");
    expect(prompt).toContain("Prior interventions delivered: 3");
    expect(prompt).toContain("review of the last 1 steps");
    expect(prompt).toContain("Thinking hard");
    expect(prompt).toContain("TOOL: bash");
  });

  it("buildTrajectoryPrompt includes write actions and format-check instructions", () => {
    const state = createState(resolveOptions());
    const prompt = buildTrajectoryPrompt(
      [{ reasoning: "Writing file", actions: ["TOOL: write args: {\"filePath\":\"out.txt\",\"content\":\"PASSWORD=secret\"}"] }],
      state
    );

    expect(prompt).toContain("Recent file writes by the agent:");
    expect(prompt).toContain("TOOL: write args: {\"filePath\":\"out.txt\",\"content\":\"PASSWORD=secret\"}");
    expect(prompt).toContain("Do the written files appear to match the format requested");
  });

  it("uses diminishing returns suffix after 2+ prior interventions", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ stuck: true, severity: "critical", reason: "Still looping" }) }]
      }
    });

    const state = createState(resolveOptions());
    state.interventionCount = 2;
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Still looping");
    expect(state.pendingFeedback?.text).toContain("redirected multiple times");
    expect(state.pendingFeedback?.text).toContain("single, targeted change");
    expect(state.pendingFeedback?.text).not.toContain("CRITICAL MANDATE");
  });

  it("uses diminishing returns suffix even for hint severity after 2+ interventions", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ stuck: true, severity: "hint", reason: "Minor issue" }) }]
      }
    });

    const state = createState(resolveOptions());
    state.interventionCount = 3;
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Minor issue");
    expect(state.pendingFeedback?.text).toContain("redirected multiple times");
    expect(state.pendingFeedback?.text).not.toContain("Consider adjusting");
  });

  it("uses normal severity suffix when interventionCount is below 2", async () => {
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockResolvedValue({
      data: {
        parts: [{ type: "text", text: JSON.stringify({ stuck: true, severity: "warning", reason: "Drifting" }) }]
      }
    });

    const state = createState(resolveOptions());
    state.interventionCount = 1;
    await runReviewBackground(mockCtx, [{ reasoning: "Thinking", actions: ["TOOL: test"] }], state);

    expect(state.pendingFeedback?.text).toContain("Drifting");
    expect(state.pendingFeedback?.text).toContain("You should change your strategy.");
    expect(state.pendingFeedback?.text).not.toContain("redirected multiple times");
  });

  it("handles review timeout gracefully and resets isReviewing", async () => {
    vi.useFakeTimers();
    const mockCtx = createMockCtx();
    vi.mocked(mockCtx.client.session.prompt).mockImplementation(() => new Promise(() => {})); // Never resolves
    const state = createState(resolveOptions({ logLevel: "warn" }));

    const promise = runReviewBackground(mockCtx, [], state);
    
    vi.advanceTimersByTime(180000); // Trigger timeout
    await promise;
    
    expect(state.isReviewing).toBe(false);
    expect(state.pendingFeedback).toBeNull();
    vi.useRealTimers();
  });
});
