import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DocflowConfig, SessionCard } from "./types";
import { getProjectPath, ensureDir, shortenId, minutesAgo, safeRead } from "./utils";

// ────────────────────────────────────────────────────────────────────────────
// Session Management
// ────────────────────────────────────────────────────────────────────────────

export function createSessionCard(sessionId: string, cwd: string): SessionCard {
  return {
    id: `sess-${Date.now()}-${shortenId(sessionId, 4)}`,
    sessionId,
    project: "_unassigned",
    status: "active",
    startedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    lastPrompt: "Session started",
    branch: "",
    cwd,
    claimedTask: "",
  };
}

export function updateSessionInMarkdown(config: DocflowConfig, card: SessionCard): void {
  const content = safeRead(getProjectPath(config, card.project, "docflow/<slug>/Sessions.md")!);
  const lines = content.split("\n");

  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(card.id)) {
      lines[i] = `- **${shortenId(card.id, 5)}**`;
      if (card.project !== "_unassigned") lines[i] += ` [${card.project}]`;
      if (card.claimedTask) lines[i] += ` → ${card.claimedTask}`;
      lines[i] += ` | ${minutesAgo(card.lastActivity)}m ago`;
      found = true;
      break;
    }
  }

  if (!found) {
    const status = card.status === "ended" ? "Ended" : card.status;
    const headerIdx = lines.findIndex((l) => l === `## ${status}`);
    const insertAt = headerIdx >= 0 ? headerIdx + 1 : lines.length;

    lines.splice(
      insertAt,
      0,
      `- **${shortenId(card.id, 5)}** | ${minutesAgo(card.lastActivity)}m ago`
    );
  }

  const path = getProjectPath(config, card.project, "docflow/<slug>/Sessions.md");
  if (path) writeFileSync(path, lines.join("\n"), "utf-8");
}
