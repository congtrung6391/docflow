import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DocflowConfig, SessionCard } from "./types";
import { getProjectPath, ensureDir, shortenId, minutesAgo, safeRead } from "./utils";

// ────────────────────────────────────────────────────────────────────────────
// Session Management
// ────────────────────────────────────────────────────────────────────────────

export function createSessionCard(sessionId: string, cwd: string): SessionCard {
  const now = new Date().toISOString();
  return {
    id: `sess-${Date.now()}-${shortenId(sessionId, 4)}`,
    sessionId,
    project: "_unassigned",
    status: "active",
    startedAt: now,
    lastActivity: now,
    lastPrompt: "Session started",
    branch: "",
    cwd,
    claimedTask: "",
    endedAt: now,
  };
}

export const SESSION_KANBAN_TEMPLATE = `---
kanban-plugin: board
---

# Sessions

## Active

## Idle

## Stale

## Ended

`;

function ensureSessionKanbanBoard(content: string | null): string[] {
  let md = content?.trimEnd() || SESSION_KANBAN_TEMPLATE.trimEnd();

  if (!md.startsWith("---\nkanban-plugin: board\n---")) {
    md = `---\nkanban-plugin: board\n---\n\n${md}`;
  }

  for (const column of ["Active", "Idle", "Stale", "Ended"]) {
    if (!md.match(new RegExp(`^## ${column}$`, "m"))) {
      md += `\n\n## ${column}\n`;
    }
  }

  return md.split("\n");
}

function sessionStatusColumn(status: SessionCard["status"]): string {
  return status.slice(0, 1).toUpperCase() + status.slice(1);
}

export function updateSessionInMarkdown(config: DocflowConfig, card: SessionCard): void {
  if (card.project === "_unassigned") return;

  const path = getProjectPath(config, card.project, "<slug>/Sessions.md");
  if (!path) return;

  const shortId = shortenId(card.id, 5);
  const content = safeRead(path);
  const lines = ensureSessionKanbanBoard(content).filter((line) => !line.includes(`**${shortId}**`));

  const status = sessionStatusColumn(card.status);
  let headerIdx = lines.findIndex((l) => l === `## ${status}`);
  if (headerIdx < 0) {
    lines.push("", `## ${status}`, "");
    headerIdx = lines.findIndex((l) => l === `## ${status}`);
  }

  let line = `- [ ] **${shortId}**`;
  if (card.project !== "_unassigned") line += ` [${card.project}]`;
  if (card.claimedTask) line += ` → ${card.claimedTask}`;
  line += ` | ${minutesAgo(card.lastActivity)}m ago`;

  lines.splice(headerIdx + 1, 0, line);

  ensureDir(dirname(path));
  writeFileSync(path, lines.join("\n") + "\n", "utf-8");
}
