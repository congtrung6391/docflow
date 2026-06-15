/**
 * Diagram tools for docflow — Excalidraw & Mermaid
 *
 * AI describes diagrams in simple English. The tool generates valid JSON.
 * AI never touches raw Excalidraw format.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { join, dirname, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// Excalidraw element types (simplified for AI)
// ────────────────────────────────────────────────────────────────────────────

type Shape = "box" | "circle" | "diamond" | "text" | "note" | "image" | "frame";
type Arrow = "arrow" | "line" | "connector";

const SHAPE_MAP: Record<Shape, string> = {
  box: "rectangle",
  circle: "ellipse",
  diamond: "diamond",
  text: "text",
  note: "rectangle",
  image: "image",
  frame: "frame",
};

const COLOR_MAP: Record<string, string> = {
  blue: "#1b73e8",
  green: "#36b37e",
  red: "#ff4854",
  orange: "#ffb800",
  purple: "#784be3",
  teal: "#00b4d8",
  gray: "#6e6e6e",
  black: "#000000",
};

const BACKGROUND_MAP: Record<string, string> = {
  blue: "#ddf4ff",
  green: "#def7ec",
  red: "#ffe6e6",
  orange: "#fff3d6",
  purple: "#ebd9fe",
  teal: "#cffbff",
  gray: "#f0f0f0",
  light: "#ffffff",
};

const STROKE_WIDTH_MAP: Record<number, number> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
};

// ────────────────────────────────────────────────────────────────────────────
// Helper: auto-layout calculator
// ────────────────────────────────────────────────────────────────────────────

interface LayoutElement {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  index: number;
}

function autoLayout(elements: { x?: number; y?: number; label?: string; type?: string }[], canvasSize: number = 1200): { x: number; y: number }[] {
  // If all elements have positions, return as-is
  const hasPositions = elements.every((e) => e.x !== undefined && e.y !== undefined);
  if (hasPositions) return elements.map((e) => ({ x: e.x!, y: e.y! }));

  // Simple grid auto-layout
  const n = elements.length;
  if (n === 0) return [];

  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const spacing = 160;
  const startX = canvasSize / 2 - (cols * spacing) / 2;
  const startY = 80;

  return elements.map((_, i) => ({
    x: startX + ((i % cols) * spacing),
    y: startY + (Math.floor(i / cols) * spacing),
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: create Excalidraw element
// ────────────────────────────────────────────────────────────────────────────

function createExcalidrawElement(
  type: string,
  x: number,
  y: number,
  width: number,
  height: number,
  label: string,
  style: Record<string, unknown>
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: `el_${Math.random().toString(36).slice(2, 9)}`,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: style.strokeColor || COLOR_MAP.blue,
    backgroundColor: style.backgroundColor || BACKGROUND_MAP.light,
    fillStyle: style.fillStyle || "hachure" as "hachure" | "solid" | "cross-hatch" | "scribble" | "none",
    strokeWidth: style.strokeWidth || 2,
    strokeStyle: style.strokeStyle || "solid" as "solid" | "dashed" | "dotted" | "heron",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: type !== "line" ? { type: 2 } as { type: number } : null,
    boundElements: null,
    locked: false,
  };

  if (type === "text" || type === "frame") {
    base.text = label;
    base.fontSize = style.fontSize || 20;
    base.font = style.font || "sans" as "sans" | "serif" | "mono";
    base.fontWeight = style.fontWeight || 400;
    base.textAlign = "center" as "center" | "left" | "right";
    base.verticalAlign = "middle" as "middle" | "top" | "bottom";
  } else {
    base.text = label;
    base.fontSize = style.fontSize || 16;
    base.font = style.font || "sans" as "sans" | "serif" | "mono";
    base.fontWeight = style.fontWeight || 400;
    base.textAlign = "center" as "center" | "left" | "right";
    base.verticalAlign = "middle" as "middle" | "top" | "bottom";
  }

  if (type === "arrow" || type === "connector") {
    base.startArrowHead = style.arrowStart || null;
    base.endArrowHead = style.arrowEnd || "arrow";
    base.startPoint = style.startPoint || "outside" as "outside" | "point";
    base.endPoint = style.endPoint || "outside" as "outside" | "point";
    base.route = style.route || [];
  }

  if (type === "image") {
    base.imageId = `img_${Math.random().toString(36).slice(2, 9)}`;
    base.mimeType = style.mimeType || "image/png";
  }

  return base;
}

function createArrowElement(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  label: string,
  style: Record<string, unknown>
): Record<string, unknown> {
  return {
    id: `el_${Math.random().toString(36).slice(2, 9)}`,
    type: "arrow",
    x: x1,
    y: y1,
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    angle: 0,
    strokeColor: style.strokeColor || COLOR_MAP.gray,
    backgroundColor: "transparent",
    fillStyle: "none" as const,
    strokeWidth: style.strokeWidth || 2,
    strokeStyle: style.strokeStyle || "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: { type: 2 },
    boundElements: null,
    locked: false,
    // Arrow-specific
    startBinding: null,
    endBinding: null,
    startArrowHead: style.arrowStart || null,
    endArrowHead: style.arrowEnd || "arrow",
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    points: [
      [0, 0],
      [x2 - x1, y2 - y1],
    ],
    // Optional: label positioning
    label: label || "",
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: build complete Excalidraw scene
// ────────────────────────────────────────────────────────────────────────────

function buildExcalidrawScene(
  elements: Record<string, unknown>[],
  title: string,
  canvasWidth: number = 1600,
  canvasHeight: number = 900
): string {
  const scene: Record<string, unknown> = {
    type: "excalidraw",
    version: 2,
    source: "docflow",
    appState: {
      zoom: { value: 1 },
      viewBackgroundColor: "ffffff",
      gridSize: 20,
      gridStep: 20,
      gridModeEnabled: true,
    },
    files: {},
    elements,
  };

  if (title) {
    scene.appState.title = title;
  }

  return JSON.stringify(scene, null, 2);
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: update existing Excalidraw file
// ────────────────────────────────────────────────────────────────────────────

function updateExcalidrawFile(
  filePath: string,
  changes: Array<{ id: string; changes: Record<string, unknown> }>
): { success: boolean; message: string } {
  if (!existsSync(filePath)) {
    return { success: false, message: `File not found: ${filePath}` };
  }

  try {
    const content = JSON.parse(readFileSync(filePath, "utf-8"));
    if (content.type !== "excalidraw") {
      return { success: false, message: `File is not an Excalidraw scene: ${filePath}` };
    }

    let updated = 0;
    for (const change of changes) {
      const idx = content.elements.findIndex((e: Record<string, unknown>) => e.id === change.id);
      if (idx >= 0) {
        Object.assign(content.elements[idx], change.changes);
        updated++;
      }
    }

    writeFileSync(filePath, JSON.stringify(content, null, 2), "utf-8");
    return {
      success: true,
      message: `Updated ${updated}/${changes.length} element(s) in ${filePath}`,
    };
  } catch (err) {
    return {
      success: false,
      message: `Error updating ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Mermaid DSL generation
// ────────────────────────────────────────────────────────────────────────────

interface MermaidBlock {
  type: string;
  content: string;
}

function generateMermaidBlock(type: string, params: Record<string, string>): MermaidBlock {
  switch (type) {
    case "sequence":
      return {
        type: "sequenceDiagram",
        content: generateSequenceDiagram(params),
      };
    case "flowchart":
      return {
        type: "flowchart",
        content: generateFlowchart(params),
      };
    case "state":
      return {
        type: "stateDiagram-v2",
        content: generateStateDiagram(params),
      };
    case "gantt":
      return {
        type: "gantt",
        content: generateGantt(params),
      };
    case "class":
      return {
        type: "classDiagram-v2",
        content: generateClassDiagram(params),
      };
    case "er":
      return {
        type: "erDiagram",
        content: generateERDiagram(params),
      };
    default:
      return {
        type: "flowchart",
        content: `flowchart TD\n    A[Default]`,
      };
  }
}

function generateSequenceDiagram(params: Record<string, string>): string {
  const actors = params.actors?.split(",") || ["A", "B"];
  const messages = params.messages?.split(";").filter(Boolean) || [];

  let block = "sequenceDiagram\n";
  actors.forEach((actor, i) => {
    block += `    participant ${actor.trim()}\n`;
  });
  block += "\n";

  messages.forEach((msg, i) => {
    const parts = msg.split("->");
    if (parts.length >= 2) {
      const from = actors[parseInt(parts[0].trim()) || 0];
      const text = parts.slice(1).join("->").trim().replace(/<-$/, "");
      const isRight = text.includes(">>");
      const arrow = isRight ? "-->>" : "->";
      block += `    ${from.trim()} ${arrow} ${actors[(parseInt(parts[0].trim()) || 0) + 1].trim()}: ${text.replace(/>>|<-/g, "").trim()}\n`;
    }
  });

  return block;
}

function generateFlowchart(params: Record<string, string>): string {
  const nodes = params.nodes?.split(";").filter(Boolean) || [];
  const edges = params.edges?.split(";").filter(Boolean) || [];

  let block = "flowchart TD\n";

  // Define nodes
  nodes.forEach((node, i) => {
    const [id, label] = node.split("=").map((s) => s.trim()) || [`N${i}`, `Node ${i + 1}`];
    const shape = params.shape?.[i] || "[]";
    block += `    ${id}["${label}"]\n`;
  });

  // Define edges
  edges.forEach((edge) => {
    const parts = edge.split("->").map((s) => s.trim());
    if (parts.length >= 2 && parts.length <= 3) {
      const from = parts[0];
      const to = parts[1];
      const label = parts[2] || "";
      if (label) {
        block += `    ${from} -->|${label}| ${to}\n`;
      } else {
        block += `    ${from} --> ${to}\n`;
      }
    }
  });

  return block;
}

function generateStateDiagram(params: Record<string, string>): string {
  const states = params.states?.split(";").filter(Boolean) || ["idle", "running", "done"];
  const transitions = params.transitions?.split(";").filter(Boolean) || [];

  let block = "stateDiagram-v2\n";

  if (params.initial) {
    block += `    [*] --> ${params.initial}\n`;
  }

  states.forEach((state) => {
    if (state.trim() !== params.initial) {
      block += `    ${state.trim()}\n`;
    }
  });

  transitions.forEach((t) => {
    const [from, to, label] = t.split(":").map((s) => s.trim());
    if (from && to) {
      block += `    ${from} --> ${to}`;
      if (label) block += ` : ${label}`;
      block += "\n";
    }
  });

  return block;
}

function generateGantt(params: Record<string, string>): string {
  const tasks = params.tasks?.split(";").filter(Boolean) || [];

  let block = "gantt\n    title Project Timeline\n    dateFormat  YYYY-MM-DD\n\n";

  tasks.forEach((task) => {
    const [name, start, end] = task.split("=").map((s) => s.trim());
    if (name && start && end) {
      block += `    section ${name}\n    Task :${start}, ${end}\n`;
    }
  });

  return block;
}

function generateClassDiagram(params: Record<string, string>): string {
  const classes = params.classes?.split(";").filter(Boolean) || [];

  let block = "classDiagram-v2\n";

  classes.forEach((cls) => {
    const [name, methods] = cls.split("|").map((s) => s.trim());
    if (name) {
      block += `    class ${name}\n`;
      if (methods) {
        block += `    ${methods}\n`;
      }
    }
  });

  const relationships = params.relationships?.split(";").filter(Boolean) || [];
  relationships.forEach((rel) => {
    block += `    ${rel}\n`;
  });

  return block;
}

function generateERDiagram(params: Record<string, string>): string {
  const entities = params.entities?.split(";").filter(Boolean) || [];

  let block = "erDiagram\n";

  entities.forEach((entity) => {
    const [name, fields] = entity.split("|").map((s) => s.trim());
    if (name && fields) {
      block += `    ${name} {\n`;
      fields.split(",").forEach((field) => {
        block += `        ${field.trim()}\n`;
      });
      block += `    }\n`;
    }
  });

  const relations = params.relationships?.split(";").filter(Boolean) || [];
  relations.forEach((rel) => {
    block += `    ${rel}\n`;
  });

  return block;
}

function renderMermaidBlock(block: MermaidBlock, title: string): string {
  let content = `---\ntitle: ${title}\n---\n\n`;
  content += `mermaid\n`;
  content += block.content;
  return content;
}

// ────────────────────────────────────────────────────────────────────────────
// Extension Registration
// ────────────────────────────────────────────────────────────────────────────

export function registerDiagramTools(pi: ExtensionAPI, resolveProjectPath: (slug: string, relativePath: string) => string | null, getCurrentProject: () => string | null): void {
  // ──────────────────────────────────────────────────────────────────
  // Tool: draw_excalidraw
  // ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "draw_excalidraw",
    label: "draw_excalidraw",
    description:
      "Create or update a free-form Excalidraw diagram. Describe elements in plain English — the tool generates valid JSON. Best for architecture diagrams, wireframes, sketches, and brainstorming. Use draw_mermaid for standard diagrams (sequence, flowchart, state).",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
      filePath: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      elements: Type.Optional(Type.Array(Type.Object({
        type: StringEnum(["box", "circle", "diamond", "text", "note", "image", "frame"]) as const,
        label: Type.String(),
        x: Type.Optional(Type.Number()),
        y: Type.Optional(Type.Number()),
        width: Type.Optional(Type.Number()),
        height: Type.Optional(Type.Number()),
        strokeColor: Type.Optional(Type.String()),
        backgroundColor: Type.Optional(Type.String()),
        fontSize: Type.Optional(Type.Number()),
        fontWeight: Type.Optional(Type.Number()),
        strokeStyle: Type.Optional(Type.String()),
      }))),
      arrows: Type.Optional(Type.Array(Type.Object({
        from: Type.String(),  // label of source element
        to: Type.String(),    // label of target element
        label: Type.Optional(Type.String()),
        strokeColor: Type.Optional(Type.String()),
      }))),
      canvasSize: Type.Optional(Type.Number()),
    }),
    promptSnippet: "Create an Excalidraw diagram",
    promptGuidelines: [
      "Use draw_excalidraw for free-form diagrams: architecture, wireframes, sketches.",
      "Describe elements in English — x/y positions can be omitted for auto-layout.",
      "Use draw_mermaid for structured diagrams: sequence, flowchart, state, gantt, class, ER.",
      "Use a canvasSize of 1200-1600 for most diagrams.",
    ],
    async execute(_toolCallId, params) {
      const slug = params.project || "_unassigned";
      const filePath = params.filePath || resolveProjectPath(slug, "docflow/<slug>/diagrams/_Sketch.md");

      // Parse elements
      const elements: Record<string, unknown>[] = [];
      const labeledElements: Record<string, Record<string, unknown>> = {};

      if (params.elements) {
        const positions = autoLayout(
          params.elements.map((e) => ({
            x: e.x,
            y: e.y,
            label: e.label,
            type: e.type,
          })),
          params.canvasSize || 1200
        );

        params.elements.forEach((e, i) => {
          const pos = positions[i];
          const excalidrawType = SHAPE_MAP[e.type];
          const strokeColor = COLOR_MAP[e.strokeColor] || e.strokeColor || COLOR_MAP.blue;
          const bgColor = COLOR_MAP[e.backgroundColor] || e.backgroundColor || BACKGROUND_MAP.light;

          const el = createExcalidrawElement(
            excalidrawType,
            pos.x,
            pos.y,
            e.width || 160,
            e.height || 60,
            e.label,
            {
              strokeColor,
              backgroundColor: bgColor,
              fontSize: e.fontSize,
              fontWeight: e.fontWeight,
              strokeStyle: e.strokeStyle,
            }
          );

          elements.push(el);
          labeledElements[e.label] = el;
        });
      }

      // Parse arrows
      if (params.arrows) {
        params.arrows.forEach((arrow) => {
          const fromEl = labeledElements[arrow.from];
          const toEl = labeledElements[arrow.to];

          if (fromEl && toEl) {
            const arrowEl = createArrowElement(
              fromEl.x + (fromEl.width || 160) / 2,
              fromEl.y + (fromEl.height || 60) / 2,
              toEl.x + (toEl.width || 160) / 2,
              toEl.y + (toEl.height || 60) / 2,
              arrow.label || "",
              {
                arrowEnd: "arrow",
                strokeColor: COLOR_MAP[arrow.strokeColor] || arrow.strokeColor || COLOR_MAP.gray,
              }
            );
            elements.push(arrowEl);
          }
        });
      }

      // Build scene
      const scene = buildExcalidrawScene(elements, params.title || "Untitled", params.canvasSize || 1600, params.canvasSize ? params.canvasSize * 0.5625 : 900);

      // Write as Excalidraw JSON
      ensureDir(dirname(filePath));
      writeFileSync(filePath, scene, "utf-8");

      // Also write a Markdown wrapper so Obsidian renders the diagram
      const mdPath = filePath.replace(/\.json$/, ".md");
      const wrapper = `## ${params.title || "Diagram"}\n\n![Diagram](${basename(filePath).replace(/\.\w+$/, "")})\n\n${params.description ? `\n> ${params.description}\n` : ""}`;
      writeFileSync(mdPath, wrapper, "utf-8");

      // Create Excalidraw embed file
      const embedPath = filePath.replace(/\.json$/, ".excalidraw");
      const embed = `%%EXCALIDRAW%%\n${JSON.parse(scene).elements.length} elements\n${scene}`;
      writeFileSync(embedPath, embed, "utf-8");

      return {
        content: [
          {
            type: "text",
            text: `✓ Diagram created: ${basename(filePath)}\n  Elements: ${elements.length}\n  File: ${filePath}`,
          },
        ],
        details: {
          action: "draw_excalidraw",
          project: slug,
          filePath: basename(filePath),
          elementCount: elements.length,
        },
      };
    },
  });

  // ──────────────────────────────────────────────────────────────────
  // Tool: draw_mermaid
  // ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "draw_mermaid",
    label: "draw_mermaid",
    description:
      "Create a standard diagram in Mermaid format. Use for structured diagrams: sequence, flowchart, state, gantt, class, ER. For free-form sketches, use draw_excalidraw instead.",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
      filePath: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      type: StringEnum(["sequence", "flowchart", "state", "gantt", "class", "er"]) as const,
      description: Type.Optional(Type.String()),
      // Parameters vary by type
      nodes: Type.Optional(Type.String()),
      edges: Type.Optional(Type.String()),
      actors: Type.Optional(Type.String()),
      messages: Type.Optional(Type.String()),
      states: Type.Optional(Type.String()),
      transitions: Type.Optional(Type.String()),
      initial: Type.Optional(Type.String()),
      tasks: Type.Optional(Type.String()),
      entities: Type.Optional(Type.String()),
      relationships: Type.Optional(Type.String()),
      classes: Type.Optional(Type.String()),
    }),
    promptSnippet: "Create a Mermaid diagram",
    promptGuidelines: [
      "Use draw_mermaid for structured diagrams: sequence, flowchart, state, gantt, class, ER.",
      "Use draw_excalidraw for free-form: architecture, wireframes, sketches.",
      "Describe the diagram structure, not the Mermaid syntax — the tool generates the code.",
    ],
    async execute(_toolCallId, params) {
      const slug = params.project || "_unassigned";
      const filePath = params.filePath || resolveProjectPath(slug, "docflow/<slug>/diagrams/_Sketch.md");

      const mermaidBlock = generateMermaidBlock(params.type, {
        nodes: params.nodes,
        edges: params.edges,
        actors: params.actors,
        messages: params.messages,
        states: params.states,
        transitions: params.transitions,
        initial: params.initial,
        tasks: params.tasks,
        entities: params.entities,
        relationships: params.relationships,
        classes: params.classes,
      });

      const content = renderMermaidBlock(mermaidBlock, params.title || `${params.type} Diagram`);

      ensureDir(dirname(filePath));
      writeFileSync(filePath, content, "utf-8");

      return {
        content: [
          {
            type: "text",
            text: `✓ Mermaid ${params.type} diagram created: ${basename(filePath)}`,
          },
        ],
        details: {
          action: "draw_mermaid",
          project: slug,
          filePath: basename(filePath),
          type: params.type,
        },
      };
    },
  });

  // ──────────────────────────────────────────────────────────────────
  // Tool: excalidraw_update
  // ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "excalidraw_update",
    label: "excalidraw_update",
    description:
      "Update an existing Excalidraw diagram file. Change element positions, styles, labels, or add arrows between existing elements.",
    parameters: Type.Object({
      filePath: Type.String(),
      changes: Type.Array(Type.Object({
        elementId: Type.String(),
        changes: Type.Object({}),
      })),
    }),
    promptSnippet: "Update an existing Excalidraw diagram",
    async execute(_toolCallId, params) {
      const result = updateExcalidrawFile(params.filePath, params.changes);

      return {
        content: [{ type: "text", text: result.success ? result.message : `Error: ${result.message}` }],
        details: { action: "excalidraw_update", filePath: params.filePath },
      };
    },
  });

  // ──────────────────────────────────────────────────────────────────
  // Tool: diagram_status
  // ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "diagram_status",
    label: "diagram_status",
    description: "List all diagrams in a project or check if a diagram file exists.",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
      filePath: Type.Optional(Type.String()),
    }),
    promptSnippet: "Check diagram status",
    async execute(_toolCallId, params) {
      const slug = params.project || "_unassigned";
      const diagramsDir = params.filePath || resolveProjectPath(slug, "docflow/<slug>/diagrams/");

      if (!existsSync(diagramsDir)) {
        return {
          content: [{ type: "text", text: `No diagrams directory found for project: ${slug}` }],
        };
      }

      try {
        const files = readdirSync(diagramsDir);
        const diagramFiles = files.filter((f) => f.endsWith(".json") || f.endsWith(".excalidraw") || f.endsWith(".md"));

        return {
          content: [
            {
              type: "text",
              text: diagramFiles.length > 0
                ? `Found ${diagramFiles.length} diagram(s) in ${diagramsDir}:\n${diagramFiles.map((f) => `  - ${f}`).join("\n")}`
                : `No diagrams in ${diagramsDir}`,
            },
          ],
        };
      } catch {
        return {
          content: [{ type: "text", text: `Error reading diagrams directory: ${diagramsDir}` }],
        };
      }
    },
  });

  // ──────────────────────────────────────────────────────────────────
  // Command: diagram
  // ──────────────────────────────────────────────────────────────────

  pi.registerCommand("diagram-excalidraw", {
    description: "Create an Excalidraw diagram for the current project",
    handler: async (args, ctx) => {
      const slug = getCurrentProject() || "_unassigned";
      const dir = resolveProjectPath(slug, "docflow/<slug>/diagrams/");
      ensureDir(dir);
      ctx.ui.notify(`📐 Diagram directory ready: ${basename(dir)}`, "info");
    },
  });

  pi.registerCommand("diagram-mermaid", {
    description: "Create a Mermaid diagram for the current project",
    handler: async (args, ctx) => {
      const slug = getCurrentProject() || "_unassigned";
      const dir = resolveProjectPath(slug, "docflow/<slug>/diagrams/");
      ensureDir(dir);
      ctx.ui.notify(`📐 Diagram directory ready: ${basename(dir)}`, "info");
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Utility
// ────────────────────────────────────────────────────────────────────────────

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}
