/**
 * docflow — Document-driven kanban for Pi
 *
 * Combines document-first-wf's document generation & linking
 * with session tracking & kanban boards.
 * No phase gates, no ceremony. Lightweight and automatic.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTools from "./tools";
import { registerDocflowCommands, type CommandState } from "./commands";
import { registerDocflowEvents, type DocflowState } from "./events";
import { loadConfig, saveConfig, nowISO, getProjectPath } from "./utils";
import { ensureProjectDocs, regenerateContextIndex, regenerateMasterIndex } from "./briefing";
import type { DocflowConfig } from "./types";

export default function docflowExtension(pi: ExtensionAPI): void {
  const config: DocflowConfig = loadConfig();

  // ──────────────────────────────────────────────────────────────────────
  // Shared mutable state — passed by reference to all modules
  // ──────────────────────────────────────────────────────────────────────

  const state: DocflowState = {
    config,
    currentProject: null,
    currentSessionCard: null,
    lastCwd: process.cwd(),
    ensureProject: (slug: string) => {
      if (!config.projects[slug]) {
        config.projects[slug] = {
          name: slug,
          createdAt: nowISO(),
          worktreePath: state.lastCwd,
          docStorage: "vault",
        };
        saveConfig(config);
      }
      ensureProjectDocs(config, slug);
      regenerateContextIndex(config, slug);
      regenerateMasterIndex(config);
    },
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

  const getCurrentSessionCard = () => state.currentSessionCard;

  // ──────────────────────────────────────────────────────────────────────
  // Register Tools
  // ──────────────────────────────────────────────────────────────────────

  registerTools({
    pi,
    config,
    getProject,
    ensureProject,
    getCurrentSessionCard, 
  })

  // ──────────────────────────────────────────────────────────────────────
  // Register Commands
  // ──────────────────────────────────────────────────────────────────────

  registerDocflowCommands(
    {
      get config() { return config; },
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

  registerDocflowEvents(state, pi);
}
