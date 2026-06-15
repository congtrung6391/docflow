import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import type { DocflowConfig } from "./types";

// ────────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────────

export const DATA_DIR = join(process.env.HOME || ".", ".pi", "data", "docflow");
export const CONFIG_FILE = join(DATA_DIR, "config.json");
export const STALE_MINUTES = 120;
export const IDLE_MINUTES = 5;

// ────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ────────────────────────────────────────────────────────────────────────────

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function minutesAgo(dateStr: string): number {
  const diff = Date.now() - new Date(dateStr).getTime();
  return Math.max(0, Math.floor(diff / 60000));
}

export function shortenId(id: string, length = 5): string {
  return id.replace(/[^a-zA-Z0-9]/g, "").slice(0, length);
}

export function safeRead(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : "";
  } catch {
    return "";
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Config Management
// ────────────────────────────────────────────────────────────────────────────

export function loadConfig(): DocflowConfig {
  try {
    if (!existsSync(CONFIG_FILE)) return { projects: {}, worktreeMap: {} };
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return { projects: {}, worktreeMap: {} };
  }
}

export function saveConfig(config: DocflowConfig): void {
  ensureDir(DATA_DIR);
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

// ────────────────────────────────────────────────────────────────────────────
// Project Resolution (3-layer, highest precedence first)
// ────────────────────────────────────────────────────────────────────────────

export function resolveProject(cwd: string, config: DocflowConfig): string | null {
  // Layer 1: worktree-map.json
  for (const [path, slug] of Object.entries(config.worktreeMap)) {
    if (cwd.startsWith(path)) return slug;
  }

  // Layer 2: .pi/docflow-project file (walk up)
  let dir = cwd;
  const root = "/" + dir.split("/")[1];
  while (dir !== root && dir !== "/" && dir !== ".") {
    const projFile = join(dir, ".pi", "docflow-project");
    if (existsSync(projFile)) {
      const slug = safeRead(projFile).trim();
      if (slug && config.projects[slug]) return slug;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return null;
}

export function getProjectPath(config: DocflowConfig, slug: string, relativePath: string): string | null {
  const project = config.projects[slug];
  if (!project) return null;

  const path =
    project.docStorage === "repo"
      ? resolve(project.worktreePath, relativePath.replace("<slug>", slug))
      : resolve(config.vaultPath || resolve(process.env.HOME || ".", "Documents", "vault"), relativePath.replace("<slug>", slug));

  return existsSync(path) ? path : null;
}

// ────────────────────────────────────────────────────────────────────────────
// Document I/O
// ────────────────────────────────────────────────────────────────────────────

export function readDoc(config: DocflowConfig, slug: string, docName: string): string | null {
  const path = getProjectPath(config, slug, `docflow/<slug>/${docName}`);
  return path ? safeRead(path) : null;
}

export function writeDoc(config: DocflowConfig, slug: string, docName: string, content: string): void {
  const path = getProjectPath(config, slug, `docflow/<slug>/${docName}`);
  if (!path) return;
  ensureDir(dirname(path));
  writeFileSync(path, content, "utf-8");
}

export function appendDoc(config: DocflowConfig, slug: string, docName: string, content: string): void {
  const path = getProjectPath(config, slug, `docflow/<slug>/${docName}`);
  if (!path) return;
  ensureDir(dirname(path));

  const existing = safeRead(path);
  if (existing) {
    // Avoid duplicate lines
    const newLines = content.split("\n").filter((l) => l.trim() && !existing.includes(l.trim()));
    if (newLines.length > 0) {
      appendFileSync(path, "\n" + newLines.join("\n"), "utf-8");
    }
  } else {
    writeFileSync(path, content, "utf-8");
  }
}
