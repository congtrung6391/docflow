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

export function updateSessionInMarkdown(config: DocflowConfig, card: SessionCard): void {
  if (card.project === "_unassigned") return;

  const content = safeRead(getProjectPath(config, card.project, "<slug>/Sessions.md")!);
  const lines = content ? content.split("\n") : [];

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

    let line = `- **${shortenId(card.id, 5)}**`;
    if (card.project !== "_unassigned") line += ` [${card.project}]`;
    if (card.claimedTask) line += ` → ${card.claimedTask}`;
    line += ` | ${minutesAgo(card.lastActivity)}m ago`;

    lines.splice(insertAt, 0, line);
  }

  const path = getProjectPath(config, card.project, "<slug>/Sessions.md");
  if (path) {
    ensureDir(dirname(path));
    writeFileSync(path, lines.join("\n"), "utf-8");
  }
}
