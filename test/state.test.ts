import { describe, it, expect } from "vitest";
import { createEmptyStep, createState } from "../src/state.js";
import { resolveOptions } from "../src/config.js";

describe("state", () => {
  it("creates empty step", () => {
    const step = createEmptyStep();
    expect(step.reasoning).toBe("");
    expect(step.actions).toEqual([]);
  });

  it("creates state", () => {
    const opts = resolveOptions();
    const state = createState(opts);
    expect(state.options).toBe(opts);
    expect(state.stepsBuffer).toEqual([]);
    expect(state.currentStep).toEqual({ reasoning: "", actions: [] });
    expect(state.isReviewing).toBe(false);
    expect(state.pendingFeedback).toBeNull();
    expect(state.completedSteps).toBe(0);
    expect(state.pendingFeedbackAtStep).toBeNull();
    expect(state.interventionCount).toBe(0);
  });
});
