import type { DocflowConfig } from "./types";
import { writeDoc } from "./utils";
import type { TaskRecord } from "./types";

// ────────────────────────────────────────────────────────────────────────────
// Kanban Markdown Generation
// ────────────────────────────────────────────────────────────────────────────

export function generateKanbanMarkdown(columns: Record<string, TaskRecord[]>, includeBacklog: boolean = true): string {
  let md = "# Tasks\n\n";

  // Backlog (user-owned, opaque)
  if (includeBacklog && columns["Backlog"]?.length > 0) {
    md += "## Backlog\n\n";
    for (const task of columns["Backlog"]) {
      md += `- [ ] ${task.text}\n`;
      if (task.why) md += `  - Why: ${task.why}\n`;
      if (task.implementation_hints) md += `  - Hints: ${task.implementation_hints}\n`;
    }
    md += "\n";
  }

  // Reconciler-owned columns
  for (const col of ["Doing", "Blocked", "Done", "Archive"]) {
    if (columns[col]?.length > 0) {
      md += `## ${col}\n\n`;
      for (const task of columns[col]) {
        md += `- [x] **${task.id}** ${task.text}`;
        if (task.sessions.length > 0) md += ` (@${shortenId(task.sessions[0], 4)})`;
        if (task.blockedReason) md += ` — **BLOCKED**: ${task.blockedReason}`;
        md += "\n";
      }
      md += "\n";
    }
  }

  return md;
}

function shortenId(id: string, length = 5): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, length);
}

export function parseKanbanColumns(content: string): Record<string, TaskRecord[]> {
  const columns: Record<string, TaskRecord[]> = {
    Backlog: [],
    Doing: [],
    Blocked: [],
    Done: [],
    Archive: [],
  };

  if (!content) return columns;

  const lines = content.split("\n");
  let currentColumn: string | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^##\s+(Backlog|Doing|Blocked|Done|Archive)/);
    if (headerMatch) {
      currentColumn = headerMatch[1];
      continue;
    }

    if (line.startsWith("- [x] **")) {
      // Task in reconciler-owned column
      if (!currentColumn) continue;
      const text = line.replace(/^-\s*\[x\]\s*\*\*TASK-\d+\*\*\s*/, "").trim();
      columns[currentColumn].push({
        id: line.match(/\*\*(TASK-\d+)\*\*/)?.[1] || `TASK-${Date.now()}`,
        column: currentColumn as TaskRecord["column"],
        text,
        sessions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else if (line.match(/^-\s*\[ \]/)) {
      // Backlog task (user-owned)
      if (!currentColumn) continue;
      const text = line.replace(/^- \[ \]\s*/, "").trim();
      columns["Backlog"].push({
        id: `TODO-${Date.now()}`,
        column: "Backlog",
        text,
        sessions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  return columns;
}

export function getNextTaskId(content: string): string {
  const matches = content.match(/TASK-(\d+)/g);
  if (!matches || matches.length === 0) return "TASK-001";
  const max = Math.max(...matches.map((m) => parseInt(m.replace("TASK-", ""))));
  return `TASK-${String(max + 1).padStart(3, "0")}`;
}

export function rebuildKanban(config: DocflowConfig, slug: string, columns: Record<string, TaskRecord[]>): void {
  const md = generateKanbanMarkdown(columns, true);
  writeDoc(config, slug, "Tasks.md", md);
}
