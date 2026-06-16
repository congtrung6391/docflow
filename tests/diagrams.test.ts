import { describe, it, expect } from "vitest";

describe("diagrams", () => {
  describe("module exports", () => {
    it("can be imported without error", async () => {
      // This verifies that diagrams.ts has valid TypeScript and exports
      const mod = await import("../src/diagrams");
      expect(mod.registerDiagramTools).toBeDefined();
    });
  });
});
