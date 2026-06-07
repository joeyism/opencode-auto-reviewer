import { describe, it, expect, vi, afterEach } from "vitest";
import { createHooks } from "../src/hooks.js";
import { createState } from "../src/state.js";
import { resolveOptions } from "../src/config.js";
import * as review from "../src/review.js";
import type { PluginInput } from "@opencode-ai/plugin";
import type { EventMessagePartUpdated, EventSessionStatus } from "@opencode-ai/sdk";

describe("hooks", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createMockCtx = () =>
    ({
      client: {
        session: {
          abort: vi.fn(),
          summarize: vi.fn(),
        },
      },
    }) as unknown as PluginInput;

  it("intercepts tool execution before and throws if pending feedback", async () => {
    const state = createState(resolveOptions());
    state.pendingFeedback = { text: "Feedback string", severity: "critical" };
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);
    
    await expect(hooks["tool.execute.before"]!({ tool: "test", sessionID: "s", callID: "c" }, { args: {} })).rejects.toThrow("🚨 AUTO-REVIEWER INTERVENTION 🚨\n\nFeedback string");
    expect(state.pendingFeedback).toBeNull();
    expect(state.interventionCount).toBe(1);
  });

  it("increments interventionCount on each delivered intervention", async () => {
    const state = createState(resolveOptions());
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    state.pendingFeedback = { text: "First", severity: "critical" };
    await expect(hooks["tool.execute.before"]!({ tool: "t", sessionID: "s", callID: "c" }, { args: {} })).rejects.toThrow();
    expect(state.interventionCount).toBe(1);

    state.pendingFeedback = { text: "Second", severity: "critical" };
    await expect(hooks["tool.execute.before"]!({ tool: "t", sessionID: "s", callID: "c" }, { args: {} })).rejects.toThrow();
    expect(state.interventionCount).toBe(2);
  });

  it("compacts the session on the 1st intervention", async () => {
    const state = createState(resolveOptions());
    state.pendingFeedback = { text: "Feedback", severity: "critical" };
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    await expect(hooks["tool.execute.before"]!({ tool: "t", sessionID: "s", callID: "c" }, { args: {} })).rejects.toThrow(
      "🚨 AUTO-REVIEWER INTERVENTION 🚨\n\nFeedback"
    );

    expect(mockCtx.client.session.summarize).toHaveBeenCalledWith({ path: { id: "s" } });
    expect(mockCtx.client.session.abort).not.toHaveBeenCalled();
  });

  it("compacts (but does not abort) on the 2nd intervention", async () => {
    const state = createState(resolveOptions());
    state.interventionCount = 1;
    state.pendingFeedback = { text: "Feedback", severity: "critical" };
    state.mainSessionID = "test-session";
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    await expect(hooks["tool.execute.before"]!({ tool: "t", sessionID: "s", callID: "c" }, { args: {} })).rejects.toThrow(
      "🚨 AUTO-REVIEWER INTERVENTION 🚨\n\nFeedback"
    );

    expect(mockCtx.client.session.summarize).toHaveBeenCalledWith({ path: { id: "s" } });
    expect(mockCtx.client.session.abort).not.toHaveBeenCalled();
  });

  it("never calls session.abort regardless of intervention count", async () => {
    const state = createState(resolveOptions());
    state.interventionCount = 5;
    state.pendingFeedback = { text: "Feedback", severity: "critical" };
    state.mainSessionID = "test-session";
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    await expect(hooks["tool.execute.before"]!({ tool: "t", sessionID: "s", callID: "c" }, { args: {} })).rejects.toThrow();

    expect(mockCtx.client.session.abort).not.toHaveBeenCalled();
    expect(mockCtx.client.session.summarize).toHaveBeenCalledWith({ path: { id: "s" } });
  });

  it("discards stale pending feedback after enough completed steps", async () => {
    const state = createState(resolveOptions({ feedbackExpirySteps: 2 }));
    state.pendingFeedback = { text: "Stale feedback", severity: "hint" };
    state.pendingFeedbackAtStep = 1;
    state.completedSteps = 3;
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    await hooks["tool.execute.before"]!({ tool: "test", sessionID: "s", callID: "c" }, { args: {} });

    expect(state.pendingFeedback).toBeNull();
    expect(state.currentStep.actions).toEqual(["TOOL: test args: {}"]);
  });

  it("does not discard pending feedback before expiry", async () => {
    const state = createState(resolveOptions({ feedbackExpirySteps: 3, reviewIntervalSteps: 1 }));
    state.pendingFeedback = { text: "Not stale feedback", severity: "hint" };
    state.pendingFeedbackAtStep = 1;
    state.completedSteps = 3;
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    await hooks["tool.execute.before"]!({ tool: "test", sessionID: "s", callID: "c" }, { args: {} });
    expect(state.pendingFeedback).toBeNull();
    expect(state.deferredFeedback).toContain("Not stale feedback");
  });

  it("does not expire warning or critical feedback", async () => {
    for (const severity of ["critical"] as const) {
      const state = createState(resolveOptions({ feedbackExpirySteps: 1 }));
      state.pendingFeedback = { text: `${severity} feedback`, severity };
      state.pendingFeedbackAtStep = 1;
      state.completedSteps = 10;
      const mockCtx = createMockCtx();
      const hooks = createHooks(mockCtx, state);

      await expect(hooks["tool.execute.before"]!({ tool: "test", sessionID: "s", callID: "c" }, { args: {} })).rejects.toThrow(
        `🚨 AUTO-REVIEWER INTERVENTION 🚨\n\n${severity} feedback`
      );
    }

    const warningState = createState(resolveOptions({ feedbackExpirySteps: 1 }));
    warningState.pendingFeedback = { text: "warning feedback", severity: "warning" };
    warningState.pendingFeedbackAtStep = 1;
    warningState.completedSteps = 10;
    const warningCtx = createMockCtx();
    const warningHooks = createHooks(warningCtx, warningState);

    await warningHooks["tool.execute.before"]!({ tool: "test", sessionID: "s", callID: "c" }, { args: {} });
    expect(warningState.deferredFeedback).toContain("warning feedback");
    expect(warningState.pendingFeedback).toBeNull();
  });

  it("expires hint feedback", async () => {
    const state = createState(resolveOptions({ feedbackExpirySteps: 2 }));
    state.pendingFeedback = { text: "hint feedback", severity: "hint" };
    state.pendingFeedbackAtStep = 1;
    state.completedSteps = 3;
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    await hooks["tool.execute.before"]!({ tool: "test", sessionID: "s", callID: "c" }, { args: {} });

    expect(state.pendingFeedback).toBeNull();
    expect(state.currentStep.actions).toEqual(["TOOL: test args: {}"]);
  });

  it("intercepts tool execution before and records tool", async () => {
    const state = createState(resolveOptions());
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);
    
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: { command: "ls" } });
    expect(state.currentStep.actions).toEqual(["TOOL: bash args: {\"command\":\"ls\"}"]);
    
    await hooks["tool.execute.before"]!({ tool: "write", sessionID: "s", callID: "c" }, { args: { file: "test.txt" } });
    expect(state.currentStep.actions).toEqual(["TOOL: bash args: {\"command\":\"ls\"}", "TOOL: write args: {\"file\":\"test.txt\"}"]);

    await hooks["tool.execute.before"]!({ tool: "empty", sessionID: "s", callID: "c" }, { args: {} });
    expect(state.currentStep.actions).toEqual(["TOOL: bash args: {\"command\":\"ls\"}", "TOOL: write args: {\"file\":\"test.txt\"}", "TOOL: empty args: {}"]);

    await hooks["tool.execute.before"]!({ tool: "undefined", sessionID: "s", callID: "c" }, {} as any);
    expect(state.currentStep.actions).toEqual(["TOOL: bash args: {\"command\":\"ls\"}", "TOOL: write args: {\"file\":\"test.txt\"}", "TOOL: empty args: {}", "TOOL: undefined args: {}"]);
  });

  it("intercepts tool execution after and records output", async () => {
    const state = createState(resolveOptions());
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);
    
    await hooks["tool.execute.after"]!({ tool: "t", sessionID: "s", callID: "c", args: {} }, { title: "", output: "success", metadata: {} });
    expect(state.currentStep.actions).toEqual(["OUTPUT: success"]);
    
    await hooks["tool.execute.after"]!({ tool: "t", sessionID: "s", callID: "c", args: {} }, { title: "", output: "", metadata: {} });
    expect(state.currentStep.actions).toEqual(["OUTPUT: success", "OUTPUT: "]);

    await hooks["tool.execute.after"]!({ tool: "t", sessionID: "s", callID: "c", args: {} }, {} as any);
    expect(state.currentStep.actions).toEqual(["OUTPUT: success", "OUTPUT: ", "OUTPUT: "]);
  });

  it("defers hint feedback instead of throwing", async () => {
    const state = createState(resolveOptions());
    state.pendingFeedback = { text: "Hint feedback", severity: "hint" };
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: {} });
    expect(state.deferredFeedback).toContain("Hint feedback");
    expect(state.pendingFeedback).toBeNull();
    expect(state.interventionCount).toBe(1);
  });

  it("defers warning feedback instead of throwing", async () => {
    const state = createState(resolveOptions());
    state.pendingFeedback = { text: "Warning feedback", severity: "warning" };
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: {} });
    expect(state.deferredFeedback).toContain("Warning feedback");
    expect(state.pendingFeedback).toBeNull();
    expect(state.interventionCount).toBe(1);
  });

  it("still throws for critical feedback", async () => {
    const state = createState(resolveOptions());
    state.pendingFeedback = { text: "Critical feedback", severity: "critical" };
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    await expect(
      hooks["tool.execute.before"]!({ tool: "bash", sessionID: "s", callID: "c" }, { args: {} })
    ).rejects.toThrow("🚨 AUTO-REVIEWER INTERVENTION 🚨\n\nCritical feedback");
    expect(state.deferredFeedback).toBeNull();
  });

  it("appends deferred feedback to tool output", async () => {
    const state = createState(resolveOptions());
    state.deferredFeedback = "🚨 AUTO-REVIEWER INTERVENTION 🚨\n\nSome advice";
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    const output = { title: "", output: "real command output", metadata: {} };
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c", args: {} }, output);

    expect(output.output).toBe("real command output\n\n🚨 AUTO-REVIEWER INTERVENTION 🚨\n\nSome advice");
    expect(state.deferredFeedback).toBeNull();
  });

  it("does not modify output when no deferred feedback", async () => {
    const state = createState(resolveOptions());
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    const output = { title: "", output: "just output", metadata: {} };
    await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "s", callID: "c", args: {} }, output);

    expect(output.output).toBe("just output");
  });

  it("ignores non-message.part.updated events", async () => {
    const state = createState(resolveOptions());
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);
    
    const mockEvent: EventSessionStatus = { type: "session.status", properties: { sessionID: "s", status: "idle" } };
    await hooks.event!({ event: mockEvent });
    expect(state.stepsBuffer.length).toBe(0);
  });

  it("ignores non-step-finish parts", async () => {
    const state = createState(resolveOptions());
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);
    
    const mockEvent: EventMessagePartUpdated = { 
      type: "message.part.updated", 
      properties: { 
        part: { type: "text", text: "hello", id: "1", messageID: "m1", sessionID: "s1" } 
      } 
    };
    await hooks.event!({ event: mockEvent });
    expect(state.stepsBuffer.length).toBe(0);
  });

  it("records reasoning updates on message parts", async () => {
    const state = createState(resolveOptions());
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    const mockEvent: EventMessagePartUpdated = {
      type: "message.part.updated",
      properties: {
        part: { type: "reasoning", text: "thinking", id: "1", messageID: "m1", sessionID: "s1" },
      },
    };

    await hooks.event!({ event: mockEvent });
    expect(state.currentStep.reasoning).toBe("thinking");
  });

  it("stores an empty string when reasoning text is missing", async () => {
    const state = createState(resolveOptions());
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);

    const mockEvent: EventMessagePartUpdated = {
      type: "message.part.updated",
      properties: {
        part: { type: "reasoning", id: "1", messageID: "m1", sessionID: "s1" } as any,
      },
    };

    await hooks.event!({ event: mockEvent });
    expect(state.currentStep.reasoning).toBe("");
  });

  it("records step finish and triggers review", async () => {
    const state = createState(resolveOptions({ reviewIntervalSteps: 2 }));
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);
    
    const spy = vi.spyOn(review, "runReviewBackground").mockRejectedValue(new Error("silent error"));

    const mockEventReasoning: EventMessagePartUpdated = { 
      type: "message.part.updated", 
      properties: { 
        part: { type: "reasoning", text: "reason", id: "0", messageID: "m1", sessionID: "s1" } 
      } 
    };
    await hooks.event!({ event: mockEventReasoning });
    
    const mockEvent1: EventMessagePartUpdated = { 
      type: "message.part.updated", 
      properties: { 
        part: { type: "step-finish", reason: "stop", cost: 0, id: "1", messageID: "m1", sessionID: "s1", tokens: { reasoning: 10, total: 10, input: 0, output: 0, cache: { read: 0, write: 0 } } } 
      } 
    };
    await hooks.event!({ event: mockEvent1 });
    expect(state.stepsBuffer.length).toBe(1);
    expect(state.stepsBuffer[0].reasoning).toBe("reason");
    
    const mockEvent2: EventMessagePartUpdated = { 
      type: "message.part.updated", 
      properties: { 
        part: { type: "step-finish", reason: "stop", cost: 0, id: "2", messageID: "m2", sessionID: "s2", tokens: { reasoning: 10, total: 10, input: 0, output: 0, cache: { read: 0, write: 0 } } } 
      } 
    };
    await hooks.event!({ event: mockEvent2 });
    
    // We should give the promise a tick to catch
    await new Promise(r => setTimeout(r, 0));
    
    expect(state.stepsBuffer.length).toBe(0); // cleared because review triggered
    expect(spy).toHaveBeenCalledWith(mockCtx, expect.any(Array), state);
  });

  it("does not trigger review if already reviewing", async () => {
    const state = createState(resolveOptions({ reviewIntervalSteps: 1 }));
    state.isReviewing = true;
    const mockCtx = createMockCtx();
    const hooks = createHooks(mockCtx, state);
    
    const spy = vi.spyOn(review, "runReviewBackground").mockResolvedValue();

    const mockEvent: EventMessagePartUpdated = { 
      type: "message.part.updated", 
      properties: { 
        part: { type: "step-finish", reason: "stop", cost: 0, id: "1", messageID: "m1", sessionID: "s1", tokens: { reasoning: 10, total: 10, input: 0, output: 0, cache: { read: 0, write: 0 } } } 
      } 
    };
    await hooks.event!({ event: mockEvent });
    expect(state.stepsBuffer.length).toBe(1);
    expect(spy).not.toHaveBeenCalled();
  });
});
