import { writeFileSync, existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DocflowConfig } from "./types";
import { readDoc, getProjectPath, nowISO } from "./utils";
import { regenerateContextIndex, regenerateMasterIndex } from "./briefing";
import { generateBriefing } from "./briefing";

export interface CommandState {
  config: DocflowConfig;
  currentProject: string | null;
  lastCwd: string;
  saveConfig: (config: DocflowConfig) => void;
  ensureProject: (slug: string, docStorage?: "vault" | "repo") => void;
  getProject: () => string;
}

export function registerDocflowCommands(state: CommandState, pi: ExtensionAPI): void {
  // ──────────────────────────────────────────────────────────────────────
  // Command: docflow-setup
  // ──────────────────────────────────────────────────────────────────────

  pi.registerCommand("docflow-setup", {
    description: "Configure docflow: set vault path for shared documents",
    handler: async (_args, ctx) => {
      const vaultPath = await ctx.ui.input("Vault path (where docflow stores documents):");
      if (vaultPath) state.config.vaultPath = vaultPath;
      state.saveConfig(state.config);
      ctx.ui.notify("✅ docflow configured", "info");
    },
  });

  // ──────────────────────────────────────────────────────────────────────
  // Command: docflow-project
  // ──────────────────────────────────────────────────────────────────────

  pi.registerCommand("docflow-project", {
    description: "Assign current session to a project",
    handler: async (args, ctx) => {
      const slug = args.trim();
      if (!slug) {
        ctx.ui.notify("Usage: /docflow-project <slug>", "warning");
        return;
      }
      state.ensureProject(slug);
      state.currentProject = slug;
      state.lastCwd = ctx.cwd;
      ctx.ui.notify(`📂 Assigned to: ${slug}`, "info");
    },
  });

  // ──────────────────────────────────────────────────────────────────────
  // Command: docflow-project-new
  // ──────────────────────────────────────────────────────────────────────

  pi.registerCommand("docflow-project-new", {
    description: 'Register a new project. Defaults to vault storage; append "repo" to store in local repo.',
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const slug = parts[0];
      const rest = parts.slice(1);
      const name = rest.filter((p) => p !== "vault" && p !== "repo").join(" ") || slug;
      const docStorage = rest.includes("repo") ? "repo" : "vault";

      if (!slug) {
        ctx.ui.notify('Usage: /docflow-project-new <slug> [name] [vault|repo]  (default: vault)', "warning");
        return;
      }

      state.ensureProject(slug, docStorage);
      state.config.projects[slug] = {
        ...state.config.projects[slug],
        name,
        createdAt: state.config.projects[slug]?.createdAt || nowISO(),
        worktreePath: ctx.cwd,
        docStorage,
      };
      state.saveConfig(state.config);

      // Seed README if missing
      const readmePath = getProjectPath(state.config, slug, "docflow/<slug>/README.md");
      if (readmePath && !existsSync(readmePath)) {
        writeFileSync(
          readmePath,
          `# ${name}\n\n*Project charter — author directly in Obsidian*\n\n## Scope\n\n## Architecture\n\n## Status\n\n`,
          "utf-8"
        );
      }

      state.currentProject = slug;
      state.lastCwd = ctx.cwd;
      ctx.ui.notify(`✅ Project created: ${name} (${slug}, ${docStorage})`, "info");
    },
  });

  // ──────────────────────────────────────────────────────────────────────
  // Command: docflow-status
  // ──────────────────────────────────────────────────────────────────────

  pi.registerCommand("docflow-status", {
    description: "Show current project, session, and task status",
    handler: async (_args, ctx) => {
      const slug = state.currentProject || "_unassigned";
      const project = state.config.projects[slug] || { name: slug, createdAt: "—" };

      const tasks = readDoc(state.config, slug, "Tasks.md");
      const doing = tasks?.match(/## Doing[\s\S]*?## (Blocked|Done|Archive|$)/)?.[0] || "";
      const blocked = tasks?.match(/## Blocked[\s\S]*?## (Done|Archive|$)/)?.[0] || "";
      const done = tasks?.match(/## Done[\s\S]*?(Archive|$)/)?.[0] || "";

      const lines = [
        `📂 Project: **${project.name}** (${slug})`,
        `⏱ Started: ${project.createdAt.slice(0, 10)}`,
        "",
        `▶ Doing: ${(doing.match(/- \[x\]/g) || []).length} task(s)`,
        `⛔ Blocked: ${(blocked.match(/- \[x\]/g) || []).length} task(s)`,
        `✅ Done: ${(done.match(/- \[x\]/g) || []).length} task(s)`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ──────────────────────────────────────────────────────────────────────
  // Command: docflow-context
  // ──────────────────────────────────────────────────────────────────────

  pi.registerCommand("docflow-context", {
    description: "Display current context briefing",
    handler: async (_args, ctx) => {
      const slug = state.currentProject || "_unassigned";
      const briefing = generateBriefing(state.config, slug);
      ctx.ui.notify(briefing || "_No briefing available._", "info");
    },
  });
}
