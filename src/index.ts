/**
 * docflow — Document-driven kanban for Pi
 *
 * Combines document-first-wf's document generation & linking
 * with session tracking & kanban boards.
 * No phase gates, no ceremony. Lightweight and automatic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDocflowRead, registerDocflowWrite, registerDocflowTask, registerDocflowSession, registerDocflowContext } from "./tools";
import { registerDocflowCommands, CommandState } from "./commands";
import { registerDocflowEvents } from "./events";
import { registerDiagramTools } from "./diagrams";
import { loadConfig, saveConfig, nowISO, ensureProjectDocs } from "./utils";
import { regenerateContextIndex, regenerateMasterIndex } from "./briefing";
import type { DocflowConfig, SessionCard } from "./types";

export default function docflowExtension(pi: ExtensionAPI): void {
  const config: DocflowConfig = loadConfig();

  // ──────────────────────────────────────────────────────────────────────
  // Shared State (wrapped for mutability across modules)
  // ──────────────────────────────────────────────────────────────────────

  const state = {
    currentProject: null as string | null,
    currentSessionCard: null as SessionCard | null,
    lastCwd: process.cwd(),
  };

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────

  const getProject = (): string => state.currentProject || "_unassigned";

  const ensureProject = (slug: string, docStorage: "vault" | "repo" = "vault"): void => {
    if (!config.projects[slug]) {
      config.projects[slug] = {
        name: slug,
        createdAt: nowISO(),
        worktreePath: state.lastCwd,
        docStorage,
      };
      saveConfig(config);
    }
    ensureProjectDocs(config, slug);
    regenerateContextIndex(config, slug);
    regenerateMasterIndex(config);
  };

  const resolveProjectPath = (slug: string, relativePath: string): string | null =>
    getProjectPath(config, slug, relativePath);

  // ──────────────────────────────────────────────────────────────────────
  // Register Tools
  // ──────────────────────────────────────────────────────────────────────

  registerDocflowRead(pi, config, getProject);
  registerDocflowWrite(pi, config, getProject, ensureProject);
  registerDocflowTask(pi, config, getProject, ensureProject, () => state.currentSessionCard);
  registerDocflowSession(pi, config, getProject, () => state.currentSessionCard);
  registerDocflowContext(pi, config, getProject, ensureProject);

  // ──────────────────────────────────────────────────────────────────────
  // Register Diagram Tools
  // ──────────────────────────────────────────────────────────────────────

  registerDiagramTools(pi, resolveProjectPath, getProject);

  // ──────────────────────────────────────────────────────────────────────
  // Register Commands
  // ──────────────────────────────────────────────────────────────────────

  registerDocflowCommands(
    {
      config,
      get currentProject() { return state.currentProject; },
      get lastCwd() { return state.lastCwd; },
      set currentProject(val) { state.currentProject = val; },
      set lastCwd(val) { state.lastCwd = val; },
      saveConfig,
      ensureProject,
      getProject,
    } as CommandState,
    pi
  );

  // ──────────────────────────────────────────────────────────────────────
  // Register Events
  // ──────────────────────────────────────────────────────────────────────

  registerDocflowEvents(
    {
      config,
      get currentProject() { return state.currentProject; },
      get currentSessionCard() { return state.currentSessionCard; },
      ensureProject,
    } as any,
    pi
  );
}
