import { writeFileSync, existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DocflowConfig } from "./types";
import { readDoc, getProjectPath, nowISO, resolveProjectPath, getCurrentProject } from "./utils";
import { generateBriefing } from "./briefing";
import { drawSceneToPng, uploadImageToScene } from "./diagrams/image";

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
      const readmePath = getProjectPath(state.config, slug, "<slug>/README.md");
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

  // ────────────────────────────────────────────────────────────────────────────
  // Command: diagram-export
  // ────────────────────────────────────────────────────────────────────────────

  pi.registerCommand("diagram-export", {
    description: "Export diagram to PNG for visual review",
    handler: async (_args, ctx) => {
      const slug = state.currentProject || "_unassigned";
      const sceneOutput = resolveProjectPath(process.cwd(), state.config, slug,  "<slug>/diagrams/scene_from_image.json") || `${slug}/diagrams/scene_from_image.json`;

      const result = await uploadImageToScene("image", sceneOutput, state);
      
      if (result.success === true) {
        ctx.ui.notify(`✅ Image uploaded: ${"image"}`, "info");
        ctx.ui.notify(`⚠️ Conversion is approximate - redraw with /diagram-excalidraw for improvements`, "warning");
      } else {
        ctx.ui.notify(`❌ Upload failed: ${result.error}`, "error");
      }
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Command: diagram-review
  // ────────────────────────────────────────────────────────────────────────────

  pi.registerCommand("diagram-review", {
    description: "Open a diagram for review and feedback",
    handler: async (args, ctx) => {
      const slug = args.trim();
      if (!slug) {
        ctx.ui.notify("Usage: /diagram-review <slug>", "warning");
        return;
      }
      ctx.ui.notify(`📐 Opening diagram: ${slug} for review`, "info");
      // TODO: Implement diagram review UI
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Command: diagram-refresh
  // ────────────────────────────────────────────────────────────────────────────

  pi.registerCommand("diagram-refresh", {
    description: "Regenerate a diagram based on existing content",
    handler: async (args, ctx) => {
      const slug = args.trim();
      if (!slug) {
        ctx.ui.notify("Usage: /diagram-refresh <slug>", "warning");
        return;
      }
      ctx.ui.notify(`🔄 Regenerating diagram: ${slug}`, "info");
      // TODO: Implement diagram refresh
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Command: diagram-upload
  // ────────────────────────────────────────────────────────────────────────────

  pi.registerCommand("diagram-upload", {
    description: "Upload an image and convert to diagram",
    handler: async (_args, ctx) => {
      const slug = state.currentProject || "_unassigned";
      const sceneOutput = resolveProjectPath(process.cwd(), state.config, slug,  "<slug>/diagrams/scene_from_image.json") || `${slug}/diagrams/scene_from_image.json`;

      const result = await uploadImageToScene("image", sceneOutput, state);
      
      if (result.success === true) {
        ctx.ui.notify(`✅ Image uploaded: image`, "info");
        ctx.ui.notify(`⚠️ Conversion is approximate - redraw with /diagram-excalidraw for improvements`, "warning");
      } else {
        ctx.ui.notify(`❌ Upload failed: ${result.error}`, "error");
      }
    },
  });

  // ────────────────────────────────────────────────────────────────────────────
  // Command: diagram-feedback
  // ────────────────────────────────────────────────────────────────────────────

  pi.registerCommand("diagram-feedback", {
    description: "Provide feedback on a diagram image",
    handler: async (args, ctx) => {
      const feedback = args.trim();
      if (!feedback) {
        ctx.ui.notify("Usage: /diagram-feedback <image-path> <feedback>", "warning");
        return;
      }
      const imagePath = args.split(" ").slice(2).join(" ");
      
      ctx.ui.notify(`💭 Feedback: ${feedback.slice(0, 100)}${feedback.length > 100 ? '...' : ''}`, "info");
      ctx.ui.notify("💾 Feedback saved for AI agent reference", "info");
    },
  });
}

