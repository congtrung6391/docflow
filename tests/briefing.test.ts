import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateBriefing, regenerateContextIndex, regenerateMasterIndex, ensureProjectDocs } from "../src/briefing";
import type { DocflowConfig } from "../src/types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("briefing", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docflow-briefing-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("generateBriefing", () => {
    it("returns empty string when no documents exist", () => {
      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          emptyproject: {
            name: "Empty Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/emptyproject",
          },
        },
      };
      const result = generateBriefing(config, "emptyproject");
      expect(result).toBe("");
    });

    it("includes plan content in briefing", () => {
      const planPath = path.join(tmpDir, "docflow", "bp", "Plan.md");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, "# Plan\n\nThis is the project plan.\n\n## Scope\n\nBuild a thing.");

      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          bp: {
            name: "Briefing Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/bp",
          },
        },
      };

      const result = generateBriefing(config, "bp");
      expect(result).toContain("Plan");
      expect(result).toContain("This is the project plan.");
    });

    it("includes design content in briefing", () => {
      const designPath = path.join(tmpDir, "docflow", "dp", "Design.md");
      fs.mkdirSync(path.dirname(designPath), { recursive: true });
      fs.writeFileSync(designPath, "# Design\n\nArchitecture decision: use SQLite.");

      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          dp: {
            name: "Design Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/dp",
          },
        },
      };

      const result = generateBriefing(config, "dp");
      expect(result).toContain("Design");
      expect(result).toContain("use SQLite");
    });

    it("includes decisions in briefing", () => {
      const decisionsPath = path.join(tmpDir, "docflow", "dec", "Decisions.md");
      fs.mkdirSync(path.dirname(decisionsPath), { recursive: true });
      fs.writeFileSync(decisionsPath, "# Decisions\n\n## 2025-01-01\n\nChose TypeScript.");

      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          dec: {
            name: "Decisions Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/dec",
          },
        },
      };

      const result = generateBriefing(config, "dec");
      expect(result).toContain("Decisions");
      expect(result).toContain("TypeScript");
    });

    it("limits content length per section", () => {
      const planPath = path.join(tmpDir, "docflow", "lp", "Plan.md");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      // Write a very long plan
      const longContent = "# Plan\n\n" + "Line ".repeat(1000) + "more text.";
      fs.writeFileSync(planPath, longContent);

      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          lp: {
            name: "Long Plan",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/lp",
          },
        },
      };

      const result = generateBriefing(config, "lp");
      // Should not be the full plan - should be truncated
      expect(result.length).toBeLessThan(longContent.length);
    });
  });

  describe("ensureProjectDocs", () => {
    it("creates Tasks.md if it doesn't exist", () => {
      const projectDir = path.join(tmpDir, "docflow", "epd");
      fs.mkdirSync(projectDir, { recursive: true });

      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          epd: {
            name: "Ensure Project Docs",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/epd",
          },
        },
      };

      ensureProjectDocs(config, "epd");

      expect(fs.existsSync(path.join(projectDir, "Tasks.md"))).toBe(true);
    });

    it("creates Sessions.md if it doesn't exist", () => {
      const projectDir = path.join(tmpDir, "docflow", "sp");
      fs.mkdirSync(projectDir, { recursive: true });

      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          sp: {
            name: "Sessions Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/sp",
          },
        },
      };

      ensureProjectDocs(config, "sp");

      expect(fs.existsSync(path.join(projectDir, "Sessions.md"))).toBe(true);
    });

    it("creates _Context.md if it doesn't exist", () => {
      const projectDir = path.join(tmpDir, "docflow", "cp");
      fs.mkdirSync(projectDir, { recursive: true });

      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          cp: {
            name: "Context Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/cp",
          },
        },
      };

      ensureProjectDocs(config, "cp");

      expect(fs.existsSync(path.join(projectDir, "_Context.md"))).toBe(true);
    });

    it("creates Decisions.md if it doesn't exist", () => {
      const projectDir = path.join(tmpDir, "docflow", "dp");
      fs.mkdirSync(projectDir, { recursive: true });

      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          dp: {
            name: "Decisions Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/dp",
          },
        },
      };

      ensureProjectDocs(config, "dp");

      expect(fs.existsSync(path.join(projectDir, "Decisions.md"))).toBe(true);
    });

    it("does not overwrite existing Tasks.md", () => {
      const projectDir = path.join(tmpDir, "docflow", "nop");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "Tasks.md"), "# Custom Tasks\n\n- [ ] My custom task");

      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          nop: {
            name: "No Overwrite",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/nop",
          },
        },
      };

      ensureProjectDocs(config, "nop");

      const content = fs.readFileSync(path.join(projectDir, "Tasks.md"), "utf-8");
      expect(content).toContain("My custom task");
      expect(content).not.toContain("# Tasks");
    });
  });

  describe("regenerateMasterIndex", () => {
    it("creates _Index.md in vault root", () => {
      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          mp: {
            name: "Master Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/mp",
          },
        },
      };

      regenerateMasterIndex(config);

      // _Index.md is created at vaultPath/_Index.md
      expect(fs.existsSync(path.join(tmpDir, "_Index.md"))).toBe(true);
    });

    it("lists projects in the index", () => {
      const projectDir = path.join(tmpDir, "mp2");
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, "Sessions.md"), "# Sessions\n\n## Active\n");

      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          mp2: {
            name: "Master Project 2",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/mp2",
          },
        },
      };

      regenerateMasterIndex(config);

      const indexContent = fs.readFileSync(path.join(tmpDir, "_Index.md"), "utf-8");
      expect(indexContent).toContain("Master Project 2");
    });
  });
});
