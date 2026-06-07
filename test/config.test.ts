import { describe, it, expect } from "vitest";
import { resolveOptions } from "../src/config.js";

describe("config", () => {
  it("resolves default options", () => {
    const opts = resolveOptions();
    expect(opts.reviewIntervalSteps).toBe(25);
    expect(opts.feedbackExpirySteps).toBe(5);
    expect(opts.agent).toBe("momus");
  });

  it("resolves custom options", () => {
    const opts = resolveOptions({
      reviewIntervalSteps: 5,
      feedbackExpirySteps: 2,
      agent: "oracle"
    });
    expect(opts.reviewIntervalSteps).toBe(5);
    expect(opts.feedbackExpirySteps).toBe(2);
    expect(opts.agent).toBe("oracle");
  });
});
