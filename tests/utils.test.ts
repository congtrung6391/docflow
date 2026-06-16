import { describe, it, expect, beforeEach } from "vitest";
import {
  nowISO,
  minutesAgo,
  shortenId,
  safeRead,
  resolveProject,
  getProjectPath,
} from "../src/utils";
import type { DocflowConfig } from "../src/types";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("utils", () => {
  describe("nowISO", () => {
    it("returns a valid ISO timestamp", () => {
      const before = new Date().toISOString();
      const result = nowISO();
      const after = new Date().toISOString();
      expect(new Date(result).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
      expect(new Date(result).getTime()).toBeLessThanOrEqual(new Date(after).getTime());
    });

    it("returns string matching ISO format", () => {
      const result = nowISO();
      expect(new Date(result).toISOString()).toBe(result);
    });
  });

  describe("minutesAgo", () => {
    it("returns 0 for future dates", () => {
      const future = new Date(Date.now() + 1000 * 60 * 10).toISOString();
      expect(minutesAgo(future)).toBe(0);
    });

    it("returns correct minutes for past dates", () => {
      const past = new Date(Date.now() - 1000 * 60 * 5).toISOString();
      expect(minutesAgo(past)).toBe(5);
    });

    it("returns correct minutes for 30 minutes ago", () => {
      const past = new Date(Date.now() - 1000 * 60 * 30).toISOString();
      expect(minutesAgo(past)).toBe(30);
    });
  });

  describe("shortenId", () => {
    it("shortens an ID to the specified length", () => {
      expect(shortenId("session-1234567890abcdef", 4)).toBe("sess");
    });

    it("keeps the full ID if it's already short enough", () => {
      expect(shortenId("abc", 5)).toBe("abc");
    });

    it("defaults to length 5", () => {
      expect(shortenId("session-1234567890abcdef")).toBe("sessi");
    });

    it("handles exact length match", () => {
      expect(shortenId("12345", 5)).toBe("12345");
    });
  });

  describe("safeRead", () => {
    it("returns null for non-existent file", () => {
      const result = safeRead("/tmp/does-not-exist-12345.md");
      expect(result).toBeNull();
    });

    it("returns content for existing file", () => {
      const tmpFile = path.join(os.tmpdir(), `docflow-test-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, "test content");
      try {
        const result = safeRead(tmpFile);
        expect(result).toBe("test content");
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe("resolveProject", () => {
    it("returns null when no projects are configured", () => {
      const config: DocflowConfig = {
        vaultPath: "",
        projects: {},
      };
      expect(resolveProject("/some/path", config)).toBeNull();
    });

    it("returns the project slug when project exists in config", () => {
      const config: DocflowConfig = {
        vaultPath: "/vault",
        projects: {
          myproject: {
            name: "My Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/myproject",
          },
        },
      };
      expect(resolveProject("/projects/myproject", config)).toBe("myproject");
    });

    it("does not match partial path segments", () => {
      const config: DocflowConfig = {
        vaultPath: "/vault",
        projects: {
          myproject: {
            name: "My Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/myproject",
          },
        },
      };
      // "/projects/myproject-other" should NOT match "myproject"
      expect(resolveProject("/projects/myproject-other", config)).toBeNull();
    });

    it("matches worktreePath at end of cwd", () => {
      const config: DocflowConfig = {
        vaultPath: "/vault",
        projects: {
          myproject: {
            name: "My Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/myproject",
          },
        },
      };
      // Subdirectory of worktree should still match
      expect(resolveProject("/projects/myproject/src", config)).toBe("myproject");
    });

    it("handles repo mode projects", () => {
      const config: DocflowConfig = {
        vaultPath: "/vault",
        projects: {
          repoproj: {
            name: "Repo Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/repos/repoproj",
            docStorage: "repo",
          },
        },
      };
      expect(resolveProject("/repos/repoproj", config)).toBe("repoproj");
    });

    it("returns null for unknown cwd", () => {
      const config: DocflowConfig = {
        vaultPath: "/vault",
        projects: {
          myproject: {
            name: "My Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/myproject",
          },
        },
      };
      expect(resolveProject("/unknown/path", config)).toBeNull();
    });
  });

  describe("getProjectPath", () => {
    it("returns vault path for vault-mode projects", () => {
      const config: DocflowConfig = {
        vaultPath: "/vault",
        projects: {
          myproject: {
            name: "My Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/myproject",
          },
        },
      };
      const result = getProjectPath(config, "myproject", "docflow/<slug>/Plan.md");
      expect(result).toBe("/vault/docflow/myproject/Plan.md");
    });

    it("returns repo path for repo-mode projects", () => {
      const config: DocflowConfig = {
        vaultPath: "/vault",
        projects: {
          myproject: {
            name: "My Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/repos/myproject",
            docStorage: "repo",
          },
        },
      };
      const result = getProjectPath(config, "myproject", "docflow/<slug>/Plan.md");
      expect(result).toBe("/repos/myproject/docflow/myproject/Plan.md");
    });

    it("handles vault path without trailing slash", () => {
      const config: DocflowConfig = {
        vaultPath: "/vault",
        projects: {
          myproject: {
            name: "My Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/myproject",
          },
        },
      };
      const result = getProjectPath(config, "myproject", "docflow/<slug>/Sub/Plan.md");
      expect(result).toBe("/vault/docflow/myproject/Sub/Plan.md");
    });

    it("returns null for non-existent project", () => {
      const config: DocflowConfig = {
        vaultPath: "/vault",
        projects: {},
      };
      const result = getProjectPath(config, "unknown", "Plan.md");
      expect(result).toBeNull();
    });

    it("handles missing vaultPath gracefully", () => {
      const config: DocflowConfig = {
        vaultPath: "",
        projects: {
          myproject: {
            name: "My Project",
            createdAt: "2025-01-01T00:00:00.000Z",
            worktreePath: "/projects/myproject",
          },
        },
      };
      const result = getProjectPath(config, "myproject", "Plan.md");
      // With empty vaultPath, falls back to ~/Documents/vault
      const expected = path.resolve(
        process.env.HOME || ".",
        "Documents",
        "vault",
        "Plan.md"
      );
      expect(result).toBe(expected);
    });
  });
});
