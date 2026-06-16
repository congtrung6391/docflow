/**
 * Diagram tools for docflow — Excalidraw & Mermaid
 *
 * AI describes diagrams in simple English. The tool generates valid JSON.
 * AI never touches raw Excalidraw format.
 *
 * Excalidraw engine notes
 * ───────────────────────
 * The scene is generated to look like something drawn by hand on excalidraw.com:
 *
 *   1. Bound text   — box labels are real Excalidraw "bound text" (`containerId` +
 *                     the container's `boundElements`). Excalidraw centres, wraps
 *                     and clips them automatically, so labels never spill out.
 *   2. Bound arrows — arrows carry `startBinding`/`endBinding` (`{elementId,focus,
 *                     gap}`) and are registered in each endpoint's `boundElements`.
 *                     Excalidraw clips them to the box edge, so arrowheads stop at
 *                     the border instead of landing on the text inside.
 *   3. Layout       — a Sugiyama-style layered layout (assign layers → reduce
 *                     crossings by barycenter ordering → size-aware coordinate
 *                     assignment). This removes the overlapping boxes and the
 *                     long crossing diagonals that a naive grid produces.
 *
 * Output targets the Obsidian Excalidraw plugin (`excalidraw-plugin: parsed`),
 * not the standalone web app — element ids are Obsidian `^block-ref` safe and the
 * drawing JSON is wrapped in a `%%` comment block like the plugin writes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, basename } from "node:path";

// ────────────────────────────────────────────────────────────────────────────
// Excalidraw element types (simplified for AI)
// ────────────────────────────────────────────────────────────────────────────

type Shape = "box" | "circle" | "diamond" | "text" | "note" | "image" | "frame";

const SHAPE_MAP: Record<string, string> = {
  box: "rectangle",
  circle: "ellipse",
  diamond: "diamond",
  text: "text",
  note: "rectangle",
  image: "image",
  frame: "frame",
};

const COLOR_MAP: Record<string, string> = {
  blue: "#1971c2",
  green: "#2f9e44",
  red: "#e03131",
  orange: "#f08c00",
  purple: "#7048e8",
  teal: "#0c8599",
  yellow: "#f08c00",
  gray: "#495057",
  grey: "#495057",
  black: "#1e1e1e",
} as const;

const BACKGROUND_MAP: Record<string, string> = {
  blue: "#a5d8ff",
  green: "#b2f2bb",
  red: "#ffc9c9",
  orange: "#ffec99",
  yellow: "#ffec99",
  purple: "#d0bfff",
  teal: "#99e9f2",
  gray: "#e9ecef",
  grey: "#e9ecef",
  light: "#ffffff",
  white: "#ffffff",
  none: "transparent",
  transparent: "transparent",
  "light blue": "#a5d8ff",
  "light green": "#b2f2bb",
  "light red": "#ffc9c9",
  "light orange": "#ffec99",
  "light purple": "#d0bfff",
  "light teal": "#99e9f2",
  "light gray": "#e9ecef",
} as const;

// Excalidraw frame background — a faint tint so groups read as containers.
const FRAME_FILL = "#f8f9fa";

// ────────────────────────────────────────────────────────────────────────────
// Ids — alphanumeric so they are valid Excalidraw ids AND Obsidian ^block-refs
// ────────────────────────────────────────────────────────────────────────────

const ID_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

function genId(): string {
  // Start with a letter; Obsidian block refs dislike a leading digit.
  let s = ID_CHARS[Math.floor(Math.random() * 52)];
  for (let i = 0; i < 9; i++) s += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return s;
}

// ────────────────────────────────────────────────────────────────────────────
// Text measurement & sizing
// ────────────────────────────────────────────────────────────────────────────

function wrapText(text: string, maxChars = 28): string {
  return text
    .split("\n")
    .flatMap((line) => {
      if (line.length <= maxChars) return [line];
      const words = line.split(/\s+/);
      const lines: string[] = [];
      let current = "";

      for (const word of words) {
        if (!current) {
          current = word;
        } else if (`${current} ${word}`.length <= maxChars) {
          current = `${current} ${word}`;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current) lines.push(current);
      return lines;
    })
    .join("\n");
}

// Hand-drawn font (fontFamily 1, Virgil) is roughly this wide per char.
const CHAR_W = 0.6;
const LINE_H = 1.25;

interface NodeSize {
  w: number;
  h: number;
  wrapped: string;
}

function nodeSize(label: string, type: string, fontSize: number): NodeSize {
  const fs = fontSize || 16;
  const maxChars = type === "diamond" ? 16 : 24;
  const wrapped = wrapText(label || "", maxChars);
  const lines = wrapped.split("\n");
  const longest = Math.max(1, ...lines.map((l) => l.length));

  let w = Math.ceil(longest * fs * CHAR_W) + 44;
  let h = Math.ceil(lines.length * fs * LINE_H) + 32;
  w = Math.max(140, Math.min(380, w));
  h = Math.max(60, h);

  if (type === "diamond") {
    // Text sits in the middle third of a diamond — needs extra room.
    w = Math.ceil(w * 1.5);
    h = Math.ceil(h * 1.7);
  } else if (type === "circle") {
    const d = Math.max(w, Math.ceil(h * 1.6));
    w = d;
    h = Math.ceil(d * 0.72);
  }

  return { w, h, wrapped };
}

// ────────────────────────────────────────────────────────────────────────────
// Layout — Sugiyama-style layered layout
//
// Three classic phases (Sugiyama, Tagawa & Toda 1981):
//   1. Layer assignment   — longest-path ranking of the DAG.
//   2. Crossing reduction — order nodes within each layer by the barycenter
//                           (average position) of their neighbours, swept up and
//                           down a few times. This is what untangles the edges.
//   3. Coordinate assign  — size-aware placement: each layer is a band sized to
//                           its widest/tallest node; within a layer nodes are
//                           pulled toward the barycenter of their neighbours and
//                           then spread apart to remove overlaps.
// ────────────────────────────────────────────────────────────────────────────

interface LayoutNode {
  w: number;
  h: number;
  frame?: string; // frame membership, used as a weak clustering bias
}

type Direction = "LR" | "TB";

interface LayoutResult {
  positions: { x: number; y: number }[];
  direction: Direction;
}

const MARGIN = 80;
const GAP_MAIN = 130; // gap between layers (along the flow direction)
const GAP_CROSS = 48; // gap between siblings within a layer

function layeredLayout(
  nodes: LayoutNode[],
  edges: Array<[number, number]>,
  requested: Direction | "auto",
  hasFrames: boolean
): LayoutResult {
  const n = nodes.length;
  if (n === 0) return { positions: [], direction: requested === "auto" ? "LR" : requested };

  const inc: number[][] = Array.from({ length: n }, () => []);
  const out: number[][] = Array.from({ length: n }, () => []);
  const ed = edges.filter(([a, b]) => a !== b && a >= 0 && b >= 0 && a < n && b < n);
  for (const [a, b] of ed) {
    out[a].push(b);
    inc[b].push(a);
  }

  // ── Phase 1: longest-path layering (cycles broken by the pass cap) ──
  const layer = new Array(n).fill(0);
  for (let pass = 0; pass <= n; pass++) {
    let changed = false;
    for (const [a, b] of ed) {
      if (layer[b] <= layer[a]) {
        layer[b] = layer[a] + 1;
        changed = true;
      }
    }
    if (!changed) break;
  }
  const maxLayer = Math.max(0, ...layer);

  const layers: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (let i = 0; i < n; i++) layers[layer[i]].push(i);

  // ── Direction: explicit, else inferred from the graph's shape ──
  const breadth = Math.max(1, ...layers.map((l) => l.length));
  const depth = maxLayer + 1;
  let direction: Direction;
  if (requested === "LR" || requested === "TB") {
    direction = requested;
  } else if (hasFrames) {
    direction = "LR"; // swimlane / architecture diagrams read left→right
  } else if (breadth > depth) {
    direction = "TB"; // wide & branching → hierarchy reads top→down
  } else {
    direction = "LR"; // long chains → lay the pipeline out horizontally
  }

  const mainSize = (i: number) => (direction === "LR" ? nodes[i].w : nodes[i].h);
  const crossSize = (i: number) => (direction === "LR" ? nodes[i].h : nodes[i].w);

  // ── Phase 2: crossing reduction via barycenter ordering ──
  const order = new Array(n).fill(0);
  layers.forEach((l) => {
    l.sort((a, b) => a - b);
    l.forEach((id, o) => (order[id] = o));
  });

  const barycenter = (id: number, refLayer: number): number => {
    const neigh = (refLayer < layer[id] ? inc[id] : out[id]).filter((x) => layer[x] === refLayer);
    if (neigh.length === 0) return order[id];
    return neigh.reduce((s, x) => s + order[x], 0) / neigh.length;
  };

  for (let sweep = 0; sweep < 8; sweep++) {
    const apply = (L: number, ref: number) => {
      if (ref < 0 || ref > maxLayer) return;
      const keyed = layers[L].map((id) => ({ id, k: barycenter(id, ref) }));
      keyed.sort((p, q) => p.k - q.k || order[p.id] - order[q.id]);
      layers[L] = keyed.map((e) => e.id);
      layers[L].forEach((id, o) => (order[id] = o));
    };
    for (let L = 1; L <= maxLayer; L++) apply(L, L - 1); // sweep down
    for (let L = maxLayer - 1; L >= 0; L--) apply(L, L + 1); // sweep up
  }

  // ── Phase 3a: main-axis position of each layer (size-aware bands) ──
  const layerMainSize = layers.map((l) => Math.max(0, ...l.map(mainSize)));
  const layerMainStart: number[] = [];
  let acc = MARGIN;
  for (let L = 0; L <= maxLayer; L++) {
    layerMainStart[L] = acc;
    acc += layerMainSize[L] + GAP_MAIN;
  }

  // ── Phase 3b: cross-axis coordinates (barycenter pull + overlap removal) ──
  const cross = new Array(n).fill(0);
  for (let L = 0; L <= maxLayer; L++) {
    let c = MARGIN;
    for (const id of layers[L]) {
      cross[id] = c + crossSize(id) / 2;
      c += crossSize(id) + GAP_CROSS;
    }
  }

  // Same-frame siblings attract weakly, so frames stay compact.
  const frameSiblings: Map<string, number[]> = new Map();
  if (hasFrames) {
    for (let i = 0; i < n; i++) {
      const f = nodes[i].frame;
      if (!f) continue;
      if (!frameSiblings.has(f)) frameSiblings.set(f, []);
      frameSiblings.get(f)!.push(i);
    }
  }

  for (let iter = 0; iter < 16; iter++) {
    for (let L = 0; L <= maxLayer; L++) {
      for (const id of layers[L]) {
        const neigh = [...inc[id], ...out[id]];
        let sum = 0;
        let weight = 0;
        for (const x of neigh) {
          sum += cross[x];
          weight += 1;
        }
        const sibs = nodes[id].frame ? frameSiblings.get(nodes[id].frame!) || [] : [];
        for (const x of sibs) {
          if (x === id) continue;
          sum += cross[x] * 0.4;
          weight += 0.4;
        }
        if (weight > 0) cross[id] = sum / weight;
      }
      // Re-establish order + minimum separation within the layer.
      const ord = layers[L];
      for (let k = 1; k < ord.length; k++) {
        const min = cross[ord[k - 1]] + crossSize(ord[k - 1]) / 2 + GAP_CROSS + crossSize(ord[k]) / 2;
        if (cross[ord[k]] < min) cross[ord[k]] = min;
      }
      for (let k = ord.length - 2; k >= 0; k--) {
        const max = cross[ord[k + 1]] - crossSize(ord[k + 1]) / 2 - GAP_CROSS - crossSize(ord[k]) / 2;
        if (cross[ord[k]] > max) cross[ord[k]] = max;
      }
    }
  }

  // Shift so the whole drawing starts at the margin.
  let minCross = Infinity;
  for (let i = 0; i < n; i++) minCross = Math.min(minCross, cross[i] - crossSize(i) / 2);
  const shift = MARGIN - minCross;

  const positions = nodes.map((_, i) => {
    const mainStart = layerMainStart[layer[i]] + (layerMainSize[layer[i]] - mainSize(i)) / 2;
    const crossTopLeft = cross[i] + shift - crossSize(i) / 2;
    return direction === "LR"
      ? { x: Math.round(mainStart), y: Math.round(crossTopLeft) }
      : { x: Math.round(crossTopLeft), y: Math.round(mainStart) };
  });

  return { positions, direction };
}

function gridLayout(nodes: LayoutNode[]): { x: number; y: number }[] {
  const n = nodes.length;
  if (n === 0) return [];
  const cols = Math.ceil(Math.sqrt(n));
  const cellW = Math.max(...nodes.map((nd) => nd.w)) + 60;
  const cellH = Math.max(...nodes.map((nd) => nd.h)) + 60;
  return nodes.map((nd, i) => ({
    x: MARGIN + (i % cols) * cellW + (cellW - nd.w - 60) / 2,
    y: MARGIN + Math.floor(i / cols) * cellH,
  }));
}

// Single line of nodes — a column (TB) or a row (LR). Used inside frames that
// have no internal edges, so members stack neatly instead of fanning out.
function stackLayout(nodes: LayoutNode[], dir: Direction): { x: number; y: number }[] {
  const pos: { x: number; y: number }[] = [];
  let cur = MARGIN;
  if (dir === "TB") {
    const maxW = Math.max(...nodes.map((n) => n.w));
    for (const n of nodes) {
      pos.push({ x: MARGIN + (maxW - n.w) / 2, y: cur });
      cur += n.h + GAP_CROSS;
    }
  } else {
    const maxH = Math.max(...nodes.map((n) => n.h));
    for (const n of nodes) {
      pos.push({ x: cur, y: MARGIN + (maxH - n.h) / 2 });
      cur += n.w + GAP_CROSS;
    }
  }
  return pos;
}

interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FramedLayout {
  positions: { x: number; y: number }[];
  frameRects: Map<string, FrameRect>;
  direction: Direction;
}

// Two-level (clustered) layout for diagrams that use frames.
//   1. Decide the top-level flow direction from the *frame* graph.
//   2. Lay out each frame's members locally (perpendicular to the top flow, so
//      frames read as stacked columns / rows like swimlanes).
//   3. Treat each frame as a super-node and lay the frames out with the same
//      layered algorithm. Frame bands never overlap, so members never collide
//      across frames — and each member stays inside its own frame.
function layoutWithFrames(
  nodes: LayoutNode[],
  edges: Array<[number, number]>,
  requested: Direction | "auto"
): FramedLayout {
  const n = nodes.length;
  const PAD = 28;
  const HEADER = 30; // space at the top of a frame for its name

  // Group nodes by frame; un-framed nodes become their own singleton group.
  const groupKey = nodes.map((nd, i) => nd.frame || `__free_${i}`);
  const keys = [...new Set(groupKey)];
  const members = new Map<string, number[]>();
  keys.forEach((k) => members.set(k, []));
  for (let i = 0; i < n; i++) members.get(groupKey[i])!.push(i);

  const groupIndex = new Map(keys.map((k, idx) => [k, idx] as const));
  const groupEdges: Array<[number, number]> = [];
  for (const [a, b] of edges) {
    const ga = groupIndex.get(groupKey[a])!;
    const gb = groupIndex.get(groupKey[b])!;
    if (ga !== gb) groupEdges.push([ga, gb]);
  }

  // Top-level direction (reuse the inference in layeredLayout).
  const topDir = layeredLayout(
    keys.map(() => ({ w: 100, h: 100 })),
    groupEdges,
    requested,
    false
  ).direction;
  const perp: Direction = topDir === "LR" ? "TB" : "LR";

  // Local layout per frame → relative member positions + cluster size.
  const localPos = new Array<{ x: number; y: number }>(n);
  const clusterSizes: { w: number; h: number }[] = [];
  const offsets: { x: number; y: number }[] = [];

  keys.forEach((k, idx) => {
    const mem = members.get(k)!;
    const isFree = k.startsWith("__free_");
    const subNodes = mem.map((i) => nodes[i]);
    const memSet = new Set(mem);
    const internal = edges
      .filter(([a, b]) => memSet.has(a) && memSet.has(b))
      .map(([a, b]) => [mem.indexOf(a), mem.indexOf(b)] as [number, number]);

    let local: { x: number; y: number }[];
    if (subNodes.length === 1) {
      local = [{ x: 0, y: 0 }];
    } else if (internal.length > 0) {
      local = layeredLayout(subNodes, internal, perp, false).positions;
    } else {
      local = stackLayout(subNodes, perp);
    }

    const minX = Math.min(...local.map((p) => p.x));
    const minY = Math.min(...local.map((p) => p.y));
    let maxR = 0;
    let maxB = 0;
    mem.forEach((nodeIdx, j) => {
      const rel = { x: local[j].x - minX, y: local[j].y - minY };
      localPos[nodeIdx] = rel;
      maxR = Math.max(maxR, rel.x + nodes[nodeIdx].w);
      maxB = Math.max(maxB, rel.y + nodes[nodeIdx].h);
    });

    const pad = isFree ? 0 : PAD;
    const header = isFree ? 0 : HEADER;
    clusterSizes[idx] = { w: maxR + pad * 2, h: maxB + pad * 2 + header };
    offsets[idx] = { x: pad, y: pad + header };
  });

  // Lay the frames out as super-nodes.
  const groupPos = layeredLayout(clusterSizes, groupEdges, topDir, false).positions;

  const positions = new Array<{ x: number; y: number }>(n);
  const frameRects = new Map<string, FrameRect>();
  keys.forEach((k, idx) => {
    const gp = groupPos[idx];
    const off = offsets[idx];
    for (const nodeIdx of members.get(k)!) {
      positions[nodeIdx] = { x: Math.round(gp.x + off.x + localPos[nodeIdx].x), y: Math.round(gp.y + off.y + localPos[nodeIdx].y) };
    }
    if (!k.startsWith("__free_")) {
      frameRects.set(k, { x: Math.round(gp.x), y: Math.round(gp.y), w: clusterSizes[idx].w, h: clusterSizes[idx].h });
    }
  });

  return { positions, frameRects, direction: topDir };
}

// Final safety net: nudge any remaining overlaps apart (size-aware, 2-D).
function resolveOverlaps(
  rects: Array<{ x: number; y: number; w: number; h: number }>,
  gap = 28
): void {
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + gap;
        const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + gap;
        if (overlapX <= 0 || overlapY <= 0) continue;
        moved = true;
        const ca = a.x + a.w / 2;
        const cb = b.x + b.w / 2;
        if (overlapX < overlapY) {
          const d = overlapX / 2;
          if (ca <= cb) {
            a.x -= d;
            b.x += d;
          } else {
            a.x += d;
            b.x -= d;
          }
        } else {
          const d = overlapY / 2;
          const cay = a.y + a.h / 2;
          const cby = b.y + b.h / 2;
          if (cay <= cby) {
            a.y -= d;
            b.y += d;
          } else {
            a.y += d;
            b.y -= d;
          }
        }
      }
    }
    if (!moved) break;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Geometry — connection points & routing
// ────────────────────────────────────────────────────────────────────────────

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function centerOf(b: Bounds): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

// Point on `from`'s boundary, on the ray toward `to`'s centre, pushed out by gap.
function connectionPoint(from: Bounds, to: Bounds, gap = 4): { x: number; y: number } {
  const a = centerOf(from);
  const b = centerOf(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const halfW = from.width / 2;
  const halfH = from.height / 2;
  const scale = 1 / Math.max(Math.abs(dx) / halfW || 0, Math.abs(dy) / halfH || 0, 0.0001);
  const edgeX = a.x + dx * scale;
  const edgeY = a.y + dy * scale;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: edgeX + (dx / length) * gap,
    y: edgeY + (dy / length) * gap,
  };
}

// Orthogonal (elbow) route between two edge points. Splits on the dominant axis
// so the route exits and enters perpendicular to the boxes it touches.
function orthogonalMidpoints(
  start: { x: number; y: number },
  end: { x: number; y: number },
  direction: Direction
): Array<[number, number]> {
  const dx = Math.abs(end.x - start.x);
  const dy = Math.abs(end.y - start.y);
  if (dx < 24 || dy < 24) return [];
  if (direction === "LR") {
    const midX = (start.x + end.x) / 2;
    return [
      [midX, start.y],
      [midX, end.y],
    ];
  }
  const midY = (start.y + end.y) / 2;
  return [
    [start.x, midY],
    [end.x, midY],
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// Excalidraw element factories
// ────────────────────────────────────────────────────────────────────────────

interface El extends Record<string, unknown> {
  id: string;
  type: string;
}

function baseDefaults(): Record<string, unknown> {
  return {
    angle: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    boundElements: [],
    seed: Math.floor(Math.random() * 2 ** 31),
    version: 1,
    versionNonce: Math.floor(Math.random() * 2 ** 31),
    isDeleted: false,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

function createShape(
  shapeType: string,
  x: number,
  y: number,
  width: number,
  height: number,
  style: {
    strokeColor?: string;
    backgroundColor?: string;
    fillStyle?: string;
    strokeWidth?: number;
    strokeStyle?: string;
  }
): El {
  return {
    id: genId(),
    type: shapeType,
    x,
    y,
    width,
    height,
    strokeColor: style.strokeColor || COLOR_MAP.blue,
    backgroundColor: style.backgroundColor ?? "transparent",
    fillStyle: style.fillStyle || "solid",
    strokeWidth: style.strokeWidth || 2,
    strokeStyle: style.strokeStyle || "solid",
    roughness: 1,
    roundness: shapeType === "rectangle" ? { type: 3 } : shapeType === "diamond" ? { type: 2 } : null,
    ...baseDefaults(),
  };
}

// Text bound to a container (box label / arrow label). Excalidraw lays it out.
function createBoundText(
  text: string,
  containerId: string,
  container: Bounds,
  style: { fontSize?: number; strokeColor?: string }
): El {
  const fontSize = style.fontSize || 16;
  const lines = text.split("\n");
  const width = Math.max(20, Math.min(container.width - 16, Math.max(...lines.map((l) => l.length)) * fontSize * CHAR_W + 8));
  const height = Math.max(fontSize * LINE_H, lines.length * fontSize * LINE_H);
  return {
    id: genId(),
    type: "text",
    x: container.x + (container.width - width) / 2,
    y: container.y + (container.height - height) / 2,
    width,
    height,
    text,
    originalText: text,
    rawText: text,
    fontSize,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    containerId,
    lineHeight: LINE_H,
    autoResize: true,
    strokeColor: style.strokeColor || COLOR_MAP.black,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    roundness: null,
    ...baseDefaults(),
  };
}

// Free-floating text (no container).
function createText(
  x: number,
  y: number,
  text: string,
  style: { fontSize?: number; strokeColor?: string } = {}
): El {
  const fontSize = style.fontSize || 16;
  const lines = text.split("\n");
  const width = Math.max(...lines.map((l) => l.length)) * fontSize * CHAR_W + 8;
  const height = lines.length * fontSize * LINE_H;
  return {
    id: genId(),
    type: "text",
    x,
    y,
    width,
    height,
    text,
    originalText: text,
    rawText: text,
    fontSize,
    fontFamily: 1,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    lineHeight: LINE_H,
    autoResize: true,
    strokeColor: style.strokeColor || COLOR_MAP.black,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    roundness: null,
    ...baseDefaults(),
  };
}

function createBoundArrow(
  start: { x: number; y: number },
  end: { x: number; y: number },
  fromId: string,
  toId: string,
  midPoints: Array<[number, number]>,
  style: { strokeColor?: string; strokeStyle?: string; gap?: number }
): El {
  const gap = style.gap ?? 4;
  const points: Array<[number, number]> = [
    [0, 0],
    ...midPoints.map(([px, py]) => [px - start.x, py - start.y] as [number, number]),
    [end.x - start.x, end.y - start.y],
  ];
  return {
    id: genId(),
    type: "arrow",
    x: start.x,
    y: start.y,
    width: end.x - start.x,
    height: end.y - start.y,
    points,
    strokeColor: style.strokeColor || COLOR_MAP.gray,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: style.strokeStyle || "solid",
    roughness: 1,
    roundness: midPoints.length > 0 ? { type: 2 } : null,
    startArrowhead: null,
    endArrowhead: "arrow",
    startBinding: { elementId: fromId, focus: 0, gap },
    endBinding: { elementId: toId, focus: 0, gap },
    ...baseDefaults(),
  };
}

function createFrame(x: number, y: number, width: number, height: number, name: string): El {
  return {
    id: genId(),
    type: "frame",
    x,
    y,
    width,
    height,
    name,
    strokeColor: "#bbbbbb",
    backgroundColor: FRAME_FILL,
    fillStyle: "solid",
    strokeWidth: 1,
    strokeStyle: "solid",
    roughness: 0,
    roundness: null,
    ...baseDefaults(),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Scene planning — the heart of draw_excalidraw
// ────────────────────────────────────────────────────────────────────────────

export interface PlanElement {
  type: Shape;
  label: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  strokeColor?: string;
  backgroundColor?: string;
  fontSize?: number;
  fontWeight?: number;
  strokeStyle?: string;
  frame?: string; // label of the frame this element belongs to
}

export interface PlanArrow {
  from: string;
  to: string;
  label?: string;
  strokeColor?: string;
  strokeStyle?: string;
}

export interface PlanInput {
  elements?: PlanElement[];
  arrows?: PlanArrow[];
  title?: string;
  direction?: Direction | "auto";
  routing?: "straight" | "orthogonal";
}

export interface PlannedScene {
  scene: Record<string, unknown>;
  texts: Array<{ id: string; text: string }>;
  elementCount: number;
  direction: Direction | "none";
}

function resolveColor(map: Record<string, string>, value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return map[value.toLowerCase()] || (value.startsWith("#") ? value : fallback);
}

export function planExcalidrawScene(input: PlanInput): PlannedScene {
  const inputEls = input.elements || [];
  const inputArrows = input.arrows || [];

  // Split frames from graph nodes. Frames are containers, not layout nodes.
  const frameInputs = inputEls.filter((e) => e.type === "frame");
  const nodeInputs = inputEls.filter((e) => e.type !== "frame");
  const hasFrames = frameInputs.length > 0;

  const nodeIndexByLabel = new Map<string, number>();
  nodeInputs.forEach((e, i) => nodeIndexByLabel.set(e.label, i));

  // Measure every node.
  const sizes: NodeSize[] = nodeInputs.map((e) =>
    nodeSize(e.label, e.type, e.fontSize || 16)
  );

  // Build the edge list as node-index pairs.
  const edges: Array<[number, number]> = [];
  for (const a of inputArrows) {
    const f = nodeIndexByLabel.get(a.from);
    const t = nodeIndexByLabel.get(a.to);
    if (f !== undefined && t !== undefined) edges.push([f, t]);
  }

  // ── Positions ──
  const layoutNodes: LayoutNode[] = nodeInputs.map((e, i) => ({
    w: Math.max(e.width || 0, sizes[i].w),
    h: Math.max(e.height || 0, sizes[i].h),
    frame: e.frame,
  }));

  const allPositioned = nodeInputs.length > 0 && nodeInputs.every((e) => e.x !== undefined && e.y !== undefined);
  let positions: { x: number; y: number }[];
  let direction: Direction;
  let computedFrameRects: Map<string, FrameRect> | null = null;

  if (allPositioned) {
    positions = nodeInputs.map((e) => ({ x: e.x!, y: e.y! }));
    direction = input.direction === "TB" ? "TB" : "LR";
  } else if (hasFrames) {
    // Two-level clustered layout — keeps frame members together, frames apart.
    const result = layoutWithFrames(layoutNodes, edges, input.direction || "auto");
    positions = result.positions;
    direction = result.direction;
    computedFrameRects = result.frameRects;
  } else if (edges.length === 0) {
    positions = gridLayout(layoutNodes);
    direction = input.direction === "TB" ? "TB" : "LR";
  } else {
    const result = layeredLayout(layoutNodes, edges, input.direction || "auto", hasFrames);
    positions = result.positions;
    direction = result.direction;
  }

  // Safety: remove any residual overlaps. Skipped when frames are present — the
  // clustered layout is already collision-free and nudging would break frames.
  if (!hasFrames && !allPositioned) {
    const rects = positions.map((p, i) => ({ x: p.x, y: p.y, w: layoutNodes[i].w, h: layoutNodes[i].h }));
    resolveOverlaps(rects);
    positions = rects.map((r) => ({ x: r.x, y: r.y }));
  }

  // ── Build shape elements with bound labels ──
  const elements: El[] = [];
  const texts: Array<{ id: string; text: string }> = [];
  const shapeByLabel = new Map<string, El>();
  const labelEls: El[] = [];

  nodeInputs.forEach((e, i) => {
    const shapeType = SHAPE_MAP[e.type] || "rectangle";
    const bounds: Bounds = { x: positions[i].x, y: positions[i].y, width: layoutNodes[i].w, height: layoutNodes[i].h };
    const shape = createShape(shapeType, bounds.x, bounds.y, bounds.width, bounds.height, {
      strokeColor: resolveColor(COLOR_MAP, e.strokeColor, COLOR_MAP.blue),
      backgroundColor: resolveColor(BACKGROUND_MAP, e.backgroundColor, "#ffffff"),
    });
    elements.push(shape);
    shapeByLabel.set(e.label, shape);

    if (e.label) {
      const label = createBoundText(sizes[i].wrapped, shape.id, bounds, {
        fontSize: e.fontSize || 16,
      });
      (shape.boundElements as Array<Record<string, unknown>>).push({ type: "text", id: label.id });
      labelEls.push(label);
      texts.push({ id: label.id, text: sizes[i].wrapped });
    }
  });

  // ── Build frames wrapping their members ──
  const frameEls: El[] = [];
  const childFrameId = new Map<string, string>(); // node label -> frame id
  frameInputs.forEach((f) => {
    const members = nodeInputs
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.frame === f.label);
    let fx: number, fy: number, fw: number, fh: number;
    const precomputed = computedFrameRects?.get(f.label);
    if (precomputed) {
      ({ x: fx, y: fy, w: fw, h: fh } = precomputed);
    } else if (members.length > 0) {
      const pad = 28;
      const headroom = 30; // room for the frame name at the top
      const minX = Math.min(...members.map(({ i }) => positions[i].x));
      const minY = Math.min(...members.map(({ i }) => positions[i].y));
      const maxX = Math.max(...members.map(({ i }) => positions[i].x + layoutNodes[i].w));
      const maxY = Math.max(...members.map(({ i }) => positions[i].y + layoutNodes[i].h));
      fx = minX - pad;
      fy = minY - pad - headroom;
      fw = maxX - minX + pad * 2;
      fh = maxY - minY + pad * 2 + headroom;
    } else {
      fx = f.x ?? MARGIN;
      fy = f.y ?? MARGIN;
      fw = f.width ?? 360;
      fh = f.height ?? 240;
    }
    const frame = createFrame(fx, fy, fw, fh, f.label);
    frameEls.push(frame);
    members.forEach(({ e }) => childFrameId.set(e.label, frame.id));
  });

  // Attach children to their frame (frameId) so Excalidraw treats them as contained.
  for (const [label, frameId] of childFrameId) {
    const shape = shapeByLabel.get(label);
    if (shape) shape.frameId = frameId;
  }

  // ── Build arrows with bindings + bound labels ──
  const arrowEls: El[] = [];
  const arrowLabelEls: El[] = [];
  inputArrows.forEach((a) => {
    const from = shapeByLabel.get(a.from);
    const to = shapeByLabel.get(a.to);
    if (!from || !to) return;

    const fromBounds: Bounds = {
      x: from.x as number,
      y: from.y as number,
      width: from.width as number,
      height: from.height as number,
    };
    const toBounds: Bounds = {
      x: to.x as number,
      y: to.y as number,
      width: to.width as number,
      height: to.height as number,
    };
    const start = connectionPoint(fromBounds, toBounds);
    const end = connectionPoint(toBounds, fromBounds);
    const midPoints = input.routing === "orthogonal" ? orthogonalMidpoints(start, end, direction) : [];

    const arrow = createBoundArrow(start, end, from.id, to.id, midPoints, {
      strokeColor: resolveColor(COLOR_MAP, a.strokeColor, COLOR_MAP.gray),
      strokeStyle: a.strokeStyle,
    });
    (from.boundElements as Array<Record<string, unknown>>).push({ id: arrow.id, type: "arrow" });
    (to.boundElements as Array<Record<string, unknown>>).push({ id: arrow.id, type: "arrow" });
    arrowEls.push(arrow);

    if (a.label) {
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      const lbl = createBoundText(a.label, arrow.id, { x: midX - 60, y: midY - 12, width: 120, height: 24 }, {
        fontSize: 13,
        strokeColor: COLOR_MAP.gray,
      });
      (arrow.boundElements as Array<Record<string, unknown>>).push({ type: "text", id: lbl.id });
      arrowLabelEls.push(lbl);
      texts.push({ id: lbl.id, text: a.label });
    }
  });

  // ── Assemble in z-order: frames (back) → shapes → labels → arrows → arrow labels ──
  const ordered: El[] = [...frameEls, ...elements, ...labelEls, ...arrowEls, ...arrowLabelEls];

  const scene: Record<string, unknown> = {
    type: "excalidraw",
    version: 2,
    source: "docflow",
    elements: ordered,
    appState: {
      gridSize: 20,
      viewBackgroundColor: "#ffffff",
      ...(input.title ? { name: input.title } : {}),
    },
    files: {},
  };

  return {
    scene,
    texts,
    elementCount: ordered.length,
    direction: nodeInputs.length === 0 ? "none" : direction,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Obsidian Excalidraw markdown wrapper
// ────────────────────────────────────────────────────────────────────────────

function buildObsidianExcalidrawMarkdown(sceneJson: string, texts: Array<{ id: string; text: string }>): string {
  const textElements = texts
    .map((t) => `${t.text} ^${t.id}`)
    .join("\n\n");

  return [
    "---",
    "",
    "excalidraw-plugin: parsed",
    "tags: [excalidraw]",
    "",
    "---",
    "==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==",
    "",
    "",
    "# Excalidraw Data",
    "",
    "## Text Elements",
    textElements,
    "",
    "%%",
    "## Drawing",
    "```json",
    sceneJson,
    "```",
    "%%",
    "",
  ].join("\n");
}

function buildSceneJson(scene: Record<string, unknown>): string {
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
      "Create or update a free-form Excalidraw diagram (architecture, wireframes, sketches). Describe boxes and arrows in plain English — the tool auto-lays-out the nodes, binds arrows to box edges, and centres labels inside boxes. Use draw_mermaid for standard diagrams (sequence, flowchart, state).",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
      filePath: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      direction: Type.Optional(StringEnum(["auto", "LR", "TB"])),
      routing: Type.Optional(StringEnum(["straight", "orthogonal"])),
      elements: Type.Optional(Type.Array(Type.Object({
        type: StringEnum(["box", "circle", "diamond", "text", "note", "image", "frame"]),
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
        frame: Type.Optional(Type.String()),
      }))),
      arrows: Type.Optional(Type.Array(Type.Object({
        from: Type.String(),  // label of source element
        to: Type.String(),    // label of target element
        label: Type.Optional(Type.String()),
        strokeColor: Type.Optional(Type.String()),
        strokeStyle: Type.Optional(Type.String()),
      }))),
      canvasSize: Type.Optional(Type.Number()),
    }),
    promptSnippet: "Create an Excalidraw diagram",
    promptGuidelines: [
      "Use draw_excalidraw for free-form diagrams: architecture, wireframes, sketches.",
      "Omit x/y — the tool auto-lays-out nodes from the arrows (Sugiyama layered layout) and binds arrows to box edges. Only set x/y to override.",
      "Leave direction as 'auto' (inferred from the graph) unless you want to force 'LR' or 'TB'.",
      "Group related nodes by giving each element a 'frame' (the label of a frame element); the frame auto-sizes to wrap its members.",
      "Reference elements in arrows by their label. Arrow labels are drawn on the line, clear of the boxes.",
      "Use draw_mermaid for structured diagrams: sequence, flowchart, state, gantt, class, ER.",
    ],
    async execute(_toolCallId, params) {
      const slug = params.project || "_unassigned";
      const filePath = params.filePath || resolveProjectPath(slug, "<slug>/diagrams/_Sketch.excalidraw.md") || `${slug}/diagrams/_Sketch.excalidraw.md`;

      const planned = planExcalidrawScene({
        elements: params.elements as PlanElement[] | undefined,
        arrows: params.arrows as PlanArrow[] | undefined,
        title: params.title,
        direction: (params.direction as Direction | "auto" | undefined) || "auto",
        routing: (params.routing as "straight" | "orthogonal" | undefined) || "straight",
      });

      const sceneJson = buildSceneJson(planned.scene);

      ensureDir(dirname(filePath));
      if (filePath.endsWith(".excalidraw.md")) {
        writeFileSync(filePath, buildObsidianExcalidrawMarkdown(sceneJson, planned.texts), "utf-8");
        writeFileSync(filePath.replace(/\.excalidraw\.md$/, ".json"), sceneJson, "utf-8");
      } else {
        // Raw Excalidraw JSON, importable by excalidraw.com and compatible tools.
        writeFileSync(filePath, sceneJson, "utf-8");
        // Obsidian Excalidraw plugin format.
        writeFileSync(filePath.replace(/\.(json|excalidraw)$/, ".excalidraw.md"), buildObsidianExcalidrawMarkdown(sceneJson, planned.texts), "utf-8");
      }

      return {
        content: [
          {
            type: "text",
            text: `✓ Diagram created: ${basename(filePath)}\n  Elements: ${planned.elementCount}  Layout: ${planned.direction}\n  File: ${filePath}`,
          },
        ],
        details: {
          action: "draw_excalidraw",
          project: slug,
          filePath: basename(filePath),
          elementCount: planned.elementCount,
          direction: planned.direction,
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
      type: StringEnum(["sequence", "flowchart", "state", "gantt", "class", "er"]),
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
      const filePath = params.filePath || resolveProjectPath(slug, "<slug>/diagrams/_Sketch.md") || `${slug}/diagrams/_Sketch.md`;

      const mermaidBlock = generateMermaidBlock(params.type, {
        nodes: params.nodes ?? "",
        edges: params.edges ?? "",
        actors: params.actors ?? "",
        messages: params.messages ?? "",
        states: params.states ?? "",
        transitions: params.transitions ?? "",
        initial: params.initial ?? "",
        tasks: params.tasks ?? "",
        entities: params.entities ?? "",
        relationships: params.relationships ?? "",
        classes: params.classes ?? "",
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
      const changesWithId: Array<{ id: string; changes: Record<string, unknown> }> = params.changes.map((c) => ({
        id: c.elementId,
        changes: c.changes as Record<string, unknown>,
      }));
      const result = updateExcalidrawFile(params.filePath, changesWithId);

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
      const diagramsDir = params.filePath || resolveProjectPath(slug, "<slug>/diagrams/") || `${slug}/diagrams/`;

      if (!existsSync(diagramsDir)) {
        return {
          content: [{ type: "text", text: `No diagrams directory found for project: ${slug}` }],
          details: { action: "diagram_status", project: slug, count: 0, error: "directory not found" },
        };
      }

      try {
        const files = readdirSync(diagramsDir);
        const diagramFiles = files.filter((f: string) => f.endsWith(".json") || f.endsWith(".excalidraw") || f.endsWith(".md"));

        return {
          content: [
            {
              type: "text",
              text: diagramFiles.length > 0
                ? `Found ${diagramFiles.length} diagram(s) in ${diagramsDir}:\n${diagramFiles.map((f: string) => `  - ${f}`).join("\n")}`
                : `No diagrams in ${diagramsDir}`,
            },
          ],
          details: { action: "diagram_status", project: slug, count: diagramFiles.length, error: undefined as string | undefined },
        };
      } catch {
        return {
          content: [{ type: "text", text: `Error reading diagrams directory: ${diagramsDir}` }],
          details: { action: "diagram_status", project: slug, count: 0, error: "read failed" },
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
      const dir = resolveProjectPath(slug, "<slug>/diagrams/") || `${slug}/diagrams/`;
      ensureDir(dir);
      ctx.ui.notify(`📐 Diagram directory ready: ${basename(dir)}`, "info");
    },
  });

  pi.registerCommand("diagram-mermaid", {
    description: "Create a Mermaid diagram for the current project",
    handler: async (args, ctx) => {
      const slug = getCurrentProject() || "_unassigned";
      const dir = resolveProjectPath(slug, "<slug>/diagrams/") || `${slug}/diagrams/`;
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
