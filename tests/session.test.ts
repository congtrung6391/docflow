import { describe, it, expect, beforeEach } from "vitest";
import { createSessionCard, updateSessionInMarkdown } from "../src/session";
import type { DocflowConfig } from "../src/types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("session", () => {
  describe("createSessionCard", () => {
    it("creates a session card with required fields", () => {
      const card = createSessionCard("test-session-123", "/home/user/project");
      expect(card.id).toMatch(/sess-\d+-test/);
      expect(card.sessionId).toBe("test-session-123");
      expect(card.cwd).toBe("/home/user/project");
      expect(card.status).toBe("active");
      expect(card.project).toBe("_unassigned");
      expect(card.claimedTask).toBe("");
      expect(card.lastActivity).toBeDefined();
      expect(card.startedAt).toBeDefined();
      expect(card.endedAt).toBeDefined();
    });

    it("sets startedAt to current ISO time", () => {
      const before = new Date().toISOString();
      const card = createSessionCard("test-id", "/path");
      const after = new Date().toISOString();
      expect(new Date(card.startedAt).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      expect(new Date(card.startedAt).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
    });

    it("sets endedAt to startedAt", () => {
      const card = createSessionCard("test-id", "/path");
      expect(card.endedAt).toBe(card.startedAt);
    });

    it("generates unique IDs", () => {
      const card1 = createSessionCard("id-1", "/path1");
      const card2 = createSessionCard("id-2", "/path2");
      expect(card1.id).not.toBe(card2.id);
    });
  });

  describe("updateSessionInMarkdown", () => {
    it("updates Sessions.md with card data", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docflow-test-"));
      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          myproject: {
            name: "My Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/myproject",
          },
        },
      };

      // Ensure project docs exist (this creates Sessions.md with structure)
      const { ensureProjectDocs } = await import("../src/briefing");
      ensureProjectDocs(config, "myproject");

      const card = createSessionCard("session-abc", "/projects/myproject");
      card.project = "myproject";
      card.claimedTask = "TODO-001";
      card.status = "active";

      try {
        updateSessionInMarkdown(config, card);

        const sessionFile = path.join(tmpDir, "docflow", "myproject", "Sessions.md");
        expect(fs.existsSync(sessionFile)).toBe(true);

        const content = fs.readFileSync(sessionFile, "utf-8");
        // Card ID is written in shortened form (default 5 chars)
        const shortened = card.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 5);
        expect(content).toContain(shortened);
        expect(content).toContain(card.project);
        expect(content).toContain(card.claimedTask);
        // Card should appear under "## Active" section
        expect(content).toContain("## Active");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("handles project without existing Sessions.md", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docflow-test-"));
      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {
          newproject: {
            name: "New Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/newproject",
          },
        },
      };

      const card = createSessionCard("session-new", "/projects/newproject");
      card.project = "newproject";

      try {
        updateSessionInMarkdown(config, card);

        const sessionFile = path.join(tmpDir, "docflow", "newproject", "Sessions.md");
        expect(fs.existsSync(sessionFile)).toBe(true);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("skips _unassigned project", () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "docflow-test-"));
      const config: DocflowConfig = {
        vaultPath: tmpDir,
        projects: {},
      };

      const card = createSessionCard("session-x", "/path");
      card.project = "_unassigned";

      // This should not throw or create files
      expect(() => updateSessionInMarkdown(config, card)).not.toThrow();
    });
  });
});
