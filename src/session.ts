import { writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DocflowConfig, SessionCard } from "./types";
import { getProjectPath, ensureDir, shortenId, minutesAgo, safeRead, KANBAN_FRONTMATTER, stripLeadingFrontmatter } from "./utils";

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

export const SESSION_KANBAN_TEMPLATE = `${KANBAN_FRONTMATTER}

# Sessions

## Active

## Idle

## Stale

## Ended

`;

// Returns the board lines with canonical frontmatter guaranteed. Strips any
// existing (possibly malformed or duplicated) frontmatter first, then re-adds
// the canonical block — so editing a legacy board repairs it instead of
// stacking a second frontmatter on top.
function ensureSessionKanbanBoard(content: string | null): string[] {
  let body = stripLeadingFrontmatter((content ?? "").trim()).trim();
  if (!body) body = "# Sessions";

  for (const column of ["Active", "Idle", "Stale", "Ended"]) {
    if (!body.match(new RegExp(`^## ${column}$`, "m"))) {
      body += `\n\n## ${column}`;
    }
  }

  return `${KANBAN_FRONTMATTER}\n\n${body}`.split("\n");
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
