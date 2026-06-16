// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export interface DocflowConfig {
  vaultPath?: string;   // shared-vault root (used when docStorage === "vault")
  projects: Record<string, ProjectConfig>;
}

export interface ProjectConfig {
  name: string;
  createdAt: string;
  worktreePath: string;
  docStorage: "vault" | "repo"; // where project docs are stored (default: "vault")
}

export interface SessionCard {
  id: string;
  sessionId: string;
  project: string;
  status: "active" | "idle" | "stale" | "ended";
  startedAt: string;
  lastActivity: string;
  lastPrompt: string;
  branch: string;
  cwd: string;
  claimedTask: string;
  endedAt?: string;
}

export interface TaskRecord {
  id: string;
  column: "Backlog" | "Doing" | "Blocked" | "Done" | "Archive";
  text: string;
  why?: string;
  implementation_hints?: string;
  test_approach?: string;
  definition_of_done?: string;
  sessions: string[];
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
}
