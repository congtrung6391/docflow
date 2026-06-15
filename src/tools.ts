import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type { DocflowConfig, SessionCard } from "./types";
import { readDoc, writeDoc, appendDoc, shortenId, minutesAgo } from "./utils";
import { parseKanbanColumns, getNextTaskId, rebuildKanban } from "./kanban";
import { updateSessionInMarkdown, createSessionCard } from "./session";
import { generateBriefing, regenerateContextIndex, regenerateMasterIndex, ensureProjectDocs } from "./briefing";

// ────────────────────────────────────────────────────────────────────────────
// Tool: docflow_read
// ────────────────────────────────────────────────────────────────────────────

export function registerDocflowRead(pi: ExtensionAPI, config: DocflowConfig, getProject: () => string): void {
  pi.registerTool({
    name: "docflow_read",
    label: "docflow_read",
    description:
      "Read a project document from the shared vault. Use to check Plan.md, Design.md, Tasks.md, Decisions.md, _Context.md for a project.",
    parameters: Type.Object({
      document: StringEnum(["plan", "design", "tasks", "sessions", "decisions", "context"]) as const,
      project: Type.Optional(Type.String()),
    }),
    promptSnippet: "Read a project document (plan, design, tasks, decisions, context)",
    promptGuidelines: [
      "Use docflow_read when Claude needs to reference a project document.",
      "Always read _Context.md first to get project overview.",
      "Read Plan.md and Design.md at the start of work to understand scope and architecture.",
    ],
    async execute(_toolCallId, params) {
      const slug = params.project || getProject();
      const docMap: Record<string, string> = {
        plan: "Plan.md",
        design: "Design.md",
        tasks: "Tasks.md",
        sessions: "Sessions.md",
        decisions: "Decisions.md",
        context: "_Context.md",
      };
      const docName = docMap[params.document];
      const content = readDoc(config, slug, docName);

      if (!content) {
        return { content: [{ type: "text", text: `Document not found: ${docName}` }] };
      }

      return {
        content: [{ type: "text", text: `--- ${slug}/${docName} ---\n${content}` }],
        details: { document: params.document, project: slug, length: content.length },
      };
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: docflow_write
// ────────────────────────────────────────────────────────────────────────────

export function registerDocflowWrite(
  pi: ExtensionAPI,
  config: DocflowConfig,
  getProject: () => string,
  ensureProject: (slug: string) => void
): void {
  pi.registerTool({
    name: "docflow_write",
    label: "docflow_write",
    description:
      "Append to a project document. Use to log planning decisions, technical decisions, or track decisions with rejection rationale. Entries are append-only — one paragraph each.",
    parameters: Type.Object({
      document: StringEnum(["plan", "design", "decisions"]) as const,
      content: Type.String(),
      project: Type.Optional(Type.String()),
    }),
    promptSnippet: "Append to project document (plan, design, decisions)",
    promptGuidelines: [
      "Use docflow_write (plan) for scope changes, milestone reordering, resolved open questions.",
      "Use docflow_write (design) for architecture choices, trade-offs, new constraints, accepted risks.",
      "Use docflow_write (decisions) for overriding AI suggestions — capture rejection rationale.",
      "Keep entries to one paragraph. The doc keeps growing; never overwrite.",
    ],
    async execute(_toolCallId, params) {
      const slug = params.project || getProject();
      ensureProject(slug);

      const docMap: Record<string, string> = {
        plan: "Plan.md",
        design: "Design.md",
        decisions: "Decisions.md",
      };
      const docName = docMap[params.document];

      const timestamp = new Date().toISOString();
      const entry = `## ${timestamp}\n\n${params.content}\n`;

      appendDoc(config, slug, docName, entry);
      regenerateContextIndex(config, slug);

      return {
        content: [
          {
            type: "text",
            text: `✓ ${slug}/${docName}: ${params.content.slice(0, 120)}${params.content.length > 120 ? "..." : ""}`,
          },
        ],
        details: { document: params.document, project: slug, timestamp, content: params.content.slice(0, 200) },
      };
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: docflow_task
// ────────────────────────────────────────────────────────────────────────────

export function registerDocflowTask(
  pi: ExtensionAPI,
  config: DocflowConfig,
  getProject: () => string,
  ensureProject: (slug: string) => void,
  getCurrentSessionCard: () => SessionCard | null
): void {
  pi.registerTool({
    name: "docflow_task",
    label: "docflow_task",
    description:
      "Manage tasks: create new, claim existing, mark done, block, or list. Use when splitting work into tasks, claiming work, or tracking progress.",
    parameters: Type.Object({
      action: StringEnum(["new", "claim", "done", "block", "list"]) as const,
      text: Type.Optional(Type.String()),
      reason: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
    }),
    promptSnippet: "Manage tasks (new/claim/done/block/list)",
    promptGuidelines: [
      "Use docflow_task (new, text) to create a task in Backlog.",
      "Use docflow_task (claim, exact-text) when starting work — moves task to Doing, attaches session.",
      "Use docflow_task (done) when the claimed task is complete.",
      "Use docflow_task (block, reason) when you can't make progress on a claimed task.",
      "Use docflow_task (list) to see the current task board.",
    ],
    async execute(_toolCallId, params) {
      const slug = params.project || getProject();
      ensureProject(slug);

      const content = readDoc(config, slug, "Tasks.md") || "";
      let columns = parseKanbanColumns(content);

      switch (params.action) {
        case "new": {
          const text = params.text;
          if (!text) return { content: [{ type: "text", text: "Error: 'text' is required for 'new' action" }] };

          const id = getNextTaskId(content);
          columns["Backlog"].push({
            id,
            column: "Backlog",
            text,
            sessions: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
          break;
        }

        case "claim": {
          const text = params.text;
          if (!text) return { content: [{ type: "text", text: "Error: 'text' is required for 'claim' action" }] };

          const backlog = columns["Backlog"];
          const matchIdx = backlog.findIndex((t) => t.text === text);

          if (matchIdx >= 0) {
            const task = backlog.splice(matchIdx, 1)[0];
            const id = task.id.startsWith("TODO-") ? getNextTaskId(content) : task.id;
            task.id = id;
            task.column = "Doing";
            const sessionCard = getCurrentSessionCard();
            task.sessions = sessionCard ? [sessionCard.id] : [];
            columns["Doing"] = columns["Doing"] || [];
            columns["Doing"].push(task);
          } else {
            // No match — create new Doing task
            const id = getNextTaskId(content);
            columns["Doing"] = columns["Doing"] || [];
            const sessionCard = getCurrentSessionCard();
            columns["Doing"].push({
              id,
              column: "Doing",
              text,
              sessions: sessionCard ? [sessionCard.id] : [],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          }

          // Update session's claimed task
          const sessionCard = getCurrentSessionCard();
          if (sessionCard) {
            sessionCard.claimedTask = columns["Doing"][columns["Doing"].length - 1].id;
            updateSessionInMarkdown(config, sessionCard);
          }
          break;
        }

        case "done": {
          const doing = columns["Doing"] || [];
          if (doing.length === 0) {
            return { content: [{ type: "text", text: "No task in Doing" }] };
          }
          const task = doing[doing.length - 1];
          columns["Doing"] = doing.filter((t) => t.id !== task.id);
          task.column = "Done";
          task.updatedAt = new Date().toISOString();
          columns["Done"] = columns["Done"] || [];
          columns["Done"].push(task);

          const sessionCard = getCurrentSessionCard();
          if (sessionCard) {
            sessionCard.claimedTask = "";
            updateSessionInMarkdown(config, sessionCard);
          }
          break;
        }

        case "block": {
          const doing = columns["Doing"] || [];
          if (doing.length === 0) {
            return { content: [{ type: "text", text: "No task in Doing" }] };
          }
          const task = doing[doing.length - 1];
          columns["Doing"] = doing.filter((t) => t.id !== task.id);
          task.column = "Blocked";
          task.blockedReason = params.reason;
          task.updatedAt = new Date().toISOString();
          columns["Blocked"] = columns["Blocked"] || [];
          columns["Blocked"].push(task);
          break;
        }

        case "list": {
          return {
            content: [{ type: "text", text: content || "No tasks yet." }],
            details: { action: "list", project: slug, length: content.length },
          };
        }
      }

      rebuildKanban(config, slug, columns);
      regenerateMasterIndex(config);

      return {
        content: [{ type: "text", text: `Task ${params.action} applied to ${slug}` }],
        details: { action: params.action, project: slug },
      };
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: docflow_session
// ────────────────────────────────────────────────────────────────────────────

export function registerDocflowSession(
  pi: ExtensionAPI,
  config: DocflowConfig,
  getProject: () => string,
  getCurrentSessionCard: () => SessionCard | null
): void {
  pi.registerTool({
    name: "docflow_session",
    label: "docflow_session",
    description:
      "Check session status or generate a context briefing. Shows project assignment, current task, and activity level.",
    parameters: Type.Object({
      action: StringEnum(["status", "briefing"]) as const,
      project: Type.Optional(Type.String()),
    }),
    promptSnippet: "Check session status or get briefing",
    async execute(_toolCallId, params) {
      const slug = params.project || getProject();

      if (params.action === "status") {
        const sessionCard = getCurrentSessionCard();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  project: slug,
                  session: sessionCard
                    ? {
                        id: shortenId(sessionCard.id, 5),
                        task: sessionCard.claimedTask,
                        status: sessionCard.status,
                        activityMinAgo: minutesAgo(sessionCard.lastActivity),
                      }
                    : null,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      if (params.action === "briefing") {
        const briefing = generateBriefing(config, slug);
        return {
          content: [{ type: "text", text: briefing || "No briefing content available." }],
        };
      }

      return { content: [{ type: "text", text: `Unknown action: ${params.action}` }] };
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Tool: docflow_context
// ────────────────────────────────────────────────────────────────────────────

export function registerDocflowContext(
  pi: ExtensionAPI,
  config: DocflowConfig,
  getProject: () => string,
  ensureProject: (slug: string) => void
): void {
  pi.registerTool({
    name: "docflow_context",
    label: "docflow_context",
    description:
      "Regenerate the project context index (_Context.md). Use after making significant changes to project documents.",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
    }),
    promptSnippet: "Regenerate project context index",
    async execute(_toolCallId, params) {
      const slug = params.project || getProject();
      ensureProject(slug);
      regenerateContextIndex(config, slug);
      regenerateMasterIndex(config);
      return {
        content: [{ type: "text", text: `Context index regenerated for ${slug}` }],
        details: { action: "regen", project: slug },
      };
    },
  });
}
