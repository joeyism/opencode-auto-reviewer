import { describe, it, expect } from "vitest";
import autoReviewer from "../src/index.js";

describe("index", () => {
  it("creates hooks successfully", async () => {
    const ctx = {} as any;
    const hooks = await autoReviewer(ctx);
    expect(hooks).toBeDefined();
    expect(hooks["tool.execute.before"]).toBeDefined();
    expect(hooks["tool.execute.after"]).toBeDefined();
    expect(hooks.event).toBeDefined();
  });
});
