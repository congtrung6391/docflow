import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DocflowConfig, SessionCard } from "./types";
import { resolveProject, nowISO, readDoc } from "./utils";
import { regenerateContextIndex, regenerateMasterIndex } from "./briefing";
import { updateSessionInMarkdown, createSessionCard } from "./session";

export interface DocflowState {
  config: DocflowConfig;
  currentProject: string | null;
  currentSessionCard: SessionCard | null;
  ensureProject: (slug: string) => void;
}

const STALE_MINUTES = 120;
const IDLE_MINUTES = 5;

function minutesAgo(dateStr: string): number {
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.max(0, Math.floor(diff / 60000));
}

export function registerDocflowEvents(state: DocflowState, pi: ExtensionAPI): void {
  // ──────────────────────────────────────────────────────────────────────
  // Event: session_start
  // ──────────────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getLeafId();
    const cwd = process.cwd();

    const resolved = resolveProject(cwd, state.config);
    const slug = resolved || state.currentProject || "_unassigned";

    if (slug !== "_unassigned") state.ensureProject(slug);

    state.currentSessionCard = createSessionCard(sessionId, cwd);
    state.currentSessionCard.project = slug;
    state.currentProject = slug;

    if (slug !== "_unassigned") {
      updateSessionInMarkdown(state.config, state.currentSessionCard);
      regenerateMasterIndex(state.config);
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Event: session_tree
  // ──────────────────────────────────────────────────────────────────────

  pi.on("session_tree", async (_event, ctx) => {
    const cwd = process.cwd();
    const resolved = resolveProject(cwd, state.config);

    if (resolved && state.currentProject) {
      state.currentProject = resolved;
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Event: session_shutdown
  // ──────────────────────────────────────────────────────────────────────

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state.currentSessionCard) {
      const slug = state.currentSessionCard.project;
      if (slug && slug !== "_unassigned") {
        state.currentSessionCard.endedAt = nowISO();
        state.currentSessionCard.status = "ended";
        updateSessionInMarkdown(state.config, state.currentSessionCard);
        regenerateMasterIndex(state.config);
      }
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Event: before_agent_start
  // ──────────────────────────────────────────────────────────────────────

  pi.on("before_agent_start", async (event, ctx) => {
    const slug = state.currentProject || "_unassigned";
    if (slug === "_unassigned") return;

    state.ensureProject(slug);
    const context = readDoc(state.config, slug, "_Context.md");
    if (!context) return;

    const lines = context.split("\n");
    const projectName = state.config.projects[slug]?.name || slug;

    const briefing = [
      `# Project: ${projectName}`,
      "",
      ...lines.filter((l) => !l.startsWith("# Project Context")),
    ].join("\n");

    if (event.message) {
      event.message = `${briefing}\n\n---\n\n${event.message}`;
    } else {
      event.message = briefing;
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Event: context (every LLM call)
  // ──────────────────────────────────────────────────────────────────────

  pi.on("context", async (_event, ctx) => {
    if (!state.currentSessionCard) return;

    state.currentSessionCard.lastActivity = nowISO();

    const mins = minutesAgo(state.currentSessionCard.lastActivity);
    if (mins > STALE_MINUTES) {
      state.currentSessionCard.status = "stale";
    } else if (mins > IDLE_MINUTES) {
      state.currentSessionCard.status = "idle";
    } else {
      state.currentSessionCard.status = "active";
    }

    const slug = state.currentSessionCard.project;
    if (slug && slug !== "_unassigned") {
      updateSessionInMarkdown(state.config, state.currentSessionCard);
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Event: agent_end
  // ──────────────────────────────────────────────────────────────────────

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.currentSessionCard) return;
    state.currentSessionCard.lastActivity = nowISO();

    const slug = state.currentSessionCard.project;
    if (slug && slug !== "_unassigned") {
      updateSessionInMarkdown(state.config, state.currentSessionCard);
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // Event: tool_call (detect direct doc writes)
  // ──────────────────────────────────────────────────────────────────────

  pi.on("tool_call", async (event, ctx) => {
    if (event.input?.tool_name === "Write" && state.currentProject && state.currentProject !== "_unassigned") {
      const args = event.input?.arguments as Record<string, unknown>;
      const filePath = args?.path as string;
      if (filePath) {
        const fileName = filePath.split("/").pop() || "";
        const docMap = ["Plan.md", "Design.md", "Decisions.md", "Tasks.md"];
        if (docMap.includes(fileName)) {
          regenerateContextIndex(state.config, state.currentProject);
        }
      }
    }
  });
}
