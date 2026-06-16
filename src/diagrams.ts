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
import { dirname, basename, join, isAbsolute } from "node:path";
import { DATA_DIR } from "./utils";

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

type Pt = { x: number; y: number };

interface LayoutResult {
  positions: Pt[];
  direction: Direction;
  // Interior waypoints for edges that span more than one layer, keyed by
  // `edgeKey(srcIndex, dstIndex)`. These are the centres of the virtual "dummy"
  // nodes Sugiyama inserts on long edges — they mark the clear routing lane the
  // arrow should bend through instead of slashing diagonally across the diagram.
  edgeRoutes: Map<string, Pt[]>;
}

// Stable key for an edge between two node indices (direction-sensitive).
const edgeKey = (a: number, b: number): string => `${a}-${b}`;

const MARGIN = 80;
const GAP_MAIN = 130; // gap between layers (along the flow direction)
const GAP_CROSS = 48; // gap between siblings within a layer
const DUMMY_THICK = 14; // cross-axis width reserved by a routed long edge (its lane)

function layeredLayout(
  nodes: LayoutNode[],
  edges: Array<[number, number]>,
  requested: Direction | "auto",
  hasFrames: boolean,
  // Insert dummy routing lanes on long edges. On for flat graphs (where every
  // layer has a real node, so chains align into clean lanes); OFF at the frame
  // and member levels — there, big frames push thin dummies around and the chain
  // zigzags, so frames are kept in clean bands and cross-frame edges route as
  // simple fanned elbows instead.
  insertDummies = true
): LayoutResult {
  const n = nodes.length;
  if (n === 0) return { positions: [], direction: requested === "auto" ? "LR" : requested, edgeRoutes: new Map() };

  // Real edges only, used for layering + direction inference.
  const ed = edges.filter(([a, b]) => a !== b && a >= 0 && b >= 0 && a < n && b < n);

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
  // Compact away empty layers (cycles inflate layer numbers and leave gaps that
  // otherwise scatter nodes across dead space). After this every layer 0..max
  // holds at least one real node — which also keeps dummy lanes aligned.
  const usedLayers = [...new Set<number>(layer)].sort((a, b) => a - b);
  const remap = new Map(usedLayers.map((l, i) => [l, i]));
  for (let i = 0; i < n; i++) layer[i] = remap.get(layer[i])!;
  const maxLayer = Math.max(0, ...layer);

  const layersReal: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (let i = 0; i < n; i++) layersReal[layer[i]].push(i);

  // ── Direction: explicit, else inferred from the graph's shape ──
  const breadth = Math.max(1, ...layersReal.map((l) => l.length));
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

  // ── Inject dummy nodes on long edges (the Sugiyama step that was missing) ──
  // Every edge that skips a layer is rerouted through a chain of zero-content
  // "dummy" nodes, one per intermediate layer. Dummies take part in ordering and
  // coordinate assignment exactly like real nodes, so they reserve a clear lane;
  // the arrow then bends through that lane instead of cutting straight across the
  // whole canvas. Indices [0, n) are real nodes; [n, N) are dummies.
  const extLayer = layer.slice();
  const extW = nodes.map((nd) => nd.w);
  const extH = nodes.map((nd) => nd.h);
  const extEdges: Array<[number, number]> = [];
  const chainOf = new Map<string, number[]>(); // edgeKey(realA, realB) -> dummy indices, flow order
  const addDummy = (lyr: number): number => {
    const idx = extLayer.length;
    extLayer.push(lyr);
    extW.push(DUMMY_THICK);
    extH.push(DUMMY_THICK);
    return idx;
  };
  for (const [a, b] of ed) {
    if (!insertDummies || layer[b] - layer[a] <= 1) {
      extEdges.push([a, b]); // adjacent (or back/flat edge) → no rerouting needed
      continue;
    }
    const chain: number[] = [];
    for (let L = layer[a] + 1; L <= layer[b] - 1; L++) chain.push(addDummy(L));
    let prev = a;
    for (const d of chain) {
      extEdges.push([prev, d]);
      prev = d;
    }
    extEdges.push([prev, b]);
    chainOf.set(edgeKey(a, b), chain);
  }

  const N = extLayer.length;
  const inc: number[][] = Array.from({ length: N }, () => []);
  const out: number[][] = Array.from({ length: N }, () => []);
  for (const [a, b] of extEdges) {
    out[a].push(b);
    inc[b].push(a);
  }

  const mainSize = (i: number) => (direction === "LR" ? extW[i] : extH[i]);
  const crossSize = (i: number) => (direction === "LR" ? extH[i] : extW[i]);

  const layers: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (let i = 0; i < N; i++) layers[extLayer[i]].push(i);

  // ── Phase 2: crossing reduction via barycenter ordering (real + dummies) ──
  const order = new Array(N).fill(0);
  layers.forEach((l) => {
    l.sort((a, b) => a - b);
    l.forEach((id, o) => (order[id] = o));
  });

  const barycenter = (id: number, refLayer: number): number => {
    const neigh = (refLayer < extLayer[id] ? inc[id] : out[id]).filter((x) => extLayer[x] === refLayer);
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
  const cross = new Array(N).fill(0);
  for (let L = 0; L <= maxLayer; L++) {
    let c = MARGIN;
    for (const id of layers[L]) {
      cross[id] = c + crossSize(id) / 2;
      c += crossSize(id) + GAP_CROSS;
    }
  }

  // Same-frame siblings attract weakly, so frames stay compact (real nodes only).
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
        const fr = id < n ? nodes[id].frame : undefined;
        const sibs = fr ? frameSiblings.get(fr) || [] : [];
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
  for (let i = 0; i < N; i++) minCross = Math.min(minCross, cross[i] - crossSize(i) / 2);
  const shift = MARGIN - minCross;

  // Scene-space centre of any extended node (dummies included).
  const sceneCenter = (i: number): Pt => {
    const mainC = layerMainStart[extLayer[i]] + layerMainSize[extLayer[i]] / 2;
    const crossC = cross[i] + shift;
    return direction === "LR" ? { x: Math.round(mainC), y: Math.round(crossC) } : { x: Math.round(crossC), y: Math.round(mainC) };
  };

  const positions = nodes.map((_, i) => {
    const mainStart = layerMainStart[layer[i]] + (layerMainSize[layer[i]] - mainSize(i)) / 2;
    const crossTopLeft = cross[i] + shift - crossSize(i) / 2;
    return direction === "LR"
      ? { x: Math.round(mainStart), y: Math.round(crossTopLeft) }
      : { x: Math.round(crossTopLeft), y: Math.round(mainStart) };
  });

  const edgeRoutes = new Map<string, Pt[]>();
  for (const [key, chain] of chainOf) edgeRoutes.set(key, chain.map(sceneCenter));

  return { positions, direction, edgeRoutes };
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
  edgeRoutes: Map<string, Pt[]>; // keyed by node-index pair, in scene coords
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
  // One edge per distinct frame pair — the frame graph drives layout + routing.
  const groupEdges: Array<[number, number]> = [];
  const seenGroupEdge = new Set<string>();
  for (const [a, b] of edges) {
    const ga = groupIndex.get(groupKey[a])!;
    const gb = groupIndex.get(groupKey[b])!;
    if (ga === gb) continue;
    const key = edgeKey(ga, gb);
    if (seenGroupEdge.has(key)) continue;
    seenGroupEdge.add(key);
    groupEdges.push([ga, gb]);
  }

  // Top-level direction (reuse the inference in layeredLayout).
  const topDir = layeredLayout(
    keys.map(() => ({ w: 100, h: 100 })),
    groupEdges,
    requested,
    false,
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
      local = layeredLayout(subNodes, internal, perp, false, false).positions;
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

  // Lay the frames out as super-nodes. Frame-level routes are in the same
  // coordinate space as the frame positions, i.e. already scene coords.
  const groupLayout = layeredLayout(clusterSizes, groupEdges, topDir, false, false);
  const groupPos = groupLayout.positions;

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

  // Cross-frame edges inherit their frame pair's routing lane; arrows fan across
  // the boxes via ports/focus, so they stay distinguishable even when they share
  // a lane. Intra-frame edges are short and route directly (no interior lane).
  const edgeRoutes = new Map<string, Pt[]>();
  for (const [a, b] of edges) {
    const ga = groupIndex.get(groupKey[a])!;
    const gb = groupIndex.get(groupKey[b])!;
    if (ga === gb) continue;
    const route = groupLayout.edgeRoutes.get(edgeKey(ga, gb));
    if (route && route.length) edgeRoutes.set(edgeKey(a, b), route);
  }

  return { positions, frameRects, direction: topDir, edgeRoutes };
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

function centerOf(b: Bounds): Pt {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

type Side = "top" | "bottom" | "left" | "right";

// A connection point on one side of a box, `t` in [0,1] along that side.
function portPoint(b: Bounds, side: Side, t: number): Pt {
  switch (side) {
    case "top": return { x: b.x + b.width * t, y: b.y };
    case "bottom": return { x: b.x + b.width * t, y: b.y + b.height };
    case "left": return { x: b.x, y: b.y + b.height * t };
    case "right": return { x: b.x + b.width, y: b.y + b.height * t };
  }
}

// Which sides the arrow should leave `from` and enter `to`, based on their
// relative position along the flow axis. Arrows always exit/enter perpendicular
// to the flow so the direction reads at a glance.
function chooseSides(from: Bounds, to: Bounds, direction: Direction): { fromSide: Side; toSide: Side } {
  const fc = centerOf(from);
  const tc = centerOf(to);
  if (direction === "TB") {
    return tc.y >= fc.y ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
  }
  return tc.x >= fc.x ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
}

// Excalidraw `focus` ∈ (−1,1) is the perpendicular offset of the binding point
// from the box's centre. `t` (0..1 along the side) maps to a centred fan; the
// 0.85 keeps connections off the very corners.
function focusFromT(t: number): number {
  return Number(((t - 0.5) * 2 * 0.85).toFixed(3));
}

// Drop consecutive duplicate / collinear points so straight runs stay 2-point.
function simplifyPath(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 0.5 && Math.abs(last.y - p.y) < 0.5) continue;
    out.push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const a = out[i - 1], b = out[i], c = out[i + 1];
    const collinear =
      (Math.abs(a.x - b.x) < 0.5 && Math.abs(b.x - c.x) < 0.5) ||
      (Math.abs(a.y - b.y) < 0.5 && Math.abs(b.y - c.y) < 0.5);
    if (collinear) out.splice(i, 1);
  }
  return out;
}

// Build an orthogonal (Manhattan) route start → waypoints → end. Every turn
// happens in the gutter *between* layers (at the main-axis midline of each gap),
// so segments crossing a layer ride the clear lane the dummy nodes reserved.
function orthogonalRoute(start: Pt, end: Pt, waypoints: Pt[], direction: Direction): Pt[] {
  const isLR = direction === "LR";
  const mainOf = (p: Pt) => (isLR ? p.x : p.y);
  const crossOf = (p: Pt) => (isLR ? p.y : p.x);
  const mk = (mainV: number, crossV: number): Pt => (isLR ? { x: mainV, y: crossV } : { x: crossV, y: mainV });

  const seq = [start, ...waypoints, end];
  const pts: Pt[] = [start];
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1];
    const cur = seq[i];
    const midMain = (mainOf(prev) + mainOf(cur)) / 2;
    pts.push(mk(midMain, crossOf(prev))); // step along the flow into the gutter
    pts.push(mk(midMain, crossOf(cur))); // jog across within the gutter
  }
  pts.push(end);
  return simplifyPath(pts);
}

// Point halfway along a polyline by arc length — used to place arrow labels.
function pathMidpoint(pts: Pt[]): Pt {
  if (pts.length === 1) return pts[0];
  let total = 0;
  const seg: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    seg.push(d);
    total += d;
  }
  let half = total / 2;
  for (let i = 0; i < seg.length; i++) {
    if (half <= seg[i] || i === seg.length - 1) {
      const f = seg[i] ? half / seg[i] : 0;
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f };
    }
    half -= seg[i];
  }
  return pts[Math.floor(pts.length / 2)];
}

// A long edge whose straight path would cross other boxes is routed out to a
// margin "trunk" lane and back, so it never overlaps the box field. `kind` names
// the margin the trunk runs along (perpendicular to the flow).
type ChannelKind = "above" | "below" | "left" | "right";

// Route: exit the box *forward* (perpendicular) into the clear gutter, slide
// across to the margin trunk, run along the trunk past the intervening boxes,
// slide back in the gutter beside the target, and enter it perpendicular.
// `cross` is the trunk's coordinate on the perpendicular axis.
function sideChannelRoute(start: Pt, end: Pt, cross: number, direction: Direction, gutter = 26): Pt[] {
  let pts: Pt[];
  if (direction === "TB") {
    // Flow is vertical; trunk runs vertically at x = cross (a side margin).
    const fy = end.y >= start.y ? 1 : -1;
    const stepFrom = start.y + fy * gutter;
    const stepTo = end.y - fy * gutter;
    pts = [start, { x: start.x, y: stepFrom }, { x: cross, y: stepFrom }, { x: cross, y: stepTo }, { x: end.x, y: stepTo }, end];
  } else {
    // Flow is horizontal; trunk runs horizontally at y = cross (top/bottom margin).
    const fx = end.x >= start.x ? 1 : -1;
    const stepFrom = start.x + fx * gutter;
    const stepTo = end.x - fx * gutter;
    pts = [start, { x: stepFrom, y: start.y }, { x: stepFrom, y: cross }, { x: stepTo, y: cross }, { x: stepTo, y: end.y }, end];
  }
  return simplifyPath(pts);
}

// True when another box sits between `from` and `to` along the flow axis — the
// signal that a straight elbow would plough through unrelated boxes.
function hasIntermediateBox(from: Bounds, to: Bounds, others: Bounds[], direction: Direction): boolean {
  const mainC = (b: Bounds) => (direction === "LR" ? b.x + b.width / 2 : b.y + b.height / 2);
  const lo = Math.min(mainC(from), mainC(to));
  const hi = Math.max(mainC(from), mainC(to));
  for (const b of others) {
    const c = mainC(b);
    if (c > lo + 30 && c < hi - 30) return true;
  }
  return false;
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
  style: { strokeColor?: string; strokeStyle?: string; gap?: number; startFocus?: number; endFocus?: number }
): El {
  const gap = style.gap ?? 3;
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
    // Elbow-connector look: clean Manhattan route (roughness 0) with gently
    // ROUNDED corners (roundness type 2) — not sharp pointy corners. We bind
    // every arrow to both endpoints below, so it always points at a real box
    // edge and never floats. (We deliberately do NOT emit native `elbowed`
    // arrows — they bind unreliably in the Obsidian plugin and end up pointing
    // to nowhere; our bound orthogonal route gives the elbow look dependably.)
    roughness: 0,
    roundness: { type: 2 },
    startArrowhead: null,
    endArrowhead: "arrow",
    startBinding: { elementId: fromId, focus: style.startFocus ?? 0, gap },
    endBinding: { elementId: toId, focus: style.endFocus ?? 0, gap },
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

export type Routing = "straight" | "orthogonal" | "elbow";

export interface PlanInput {
  elements?: PlanElement[];
  arrows?: PlanArrow[];
  title?: string;
  direction?: Direction | "auto";
  routing?: Routing;
}

export interface PlannedScene {
  scene: Record<string, unknown>;
  texts: Array<{ id: string; text: string }>;
  elementCount: number;
  direction: Direction | "none";
  // The routing actually applied. May differ from the request: "elbow" falls
  // back to "orthogonal" when frames are present (Obsidian #2187).
  routing: Routing;
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
  let edgeRoutes: Map<string, Pt[]> = new Map();

  if (allPositioned) {
    positions = nodeInputs.map((e) => ({ x: e.x!, y: e.y! }));
    direction = input.direction === "TB" ? "TB" : "LR";
  } else if (hasFrames) {
    // Two-level clustered layout — keeps frame members together, frames apart.
    const result = layoutWithFrames(layoutNodes, edges, input.direction || "auto");
    positions = result.positions;
    direction = result.direction;
    computedFrameRects = result.frameRects;
    edgeRoutes = result.edgeRoutes;
  } else if (edges.length === 0) {
    positions = gridLayout(layoutNodes);
    direction = input.direction === "TB" ? "TB" : "LR";
  } else {
    const result = layeredLayout(layoutNodes, edges, input.direction || "auto", hasFrames);
    positions = result.positions;
    direction = result.direction;
    edgeRoutes = result.edgeRoutes;
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
  // Two passes so every arrow is easy to trace:
  //   1. Resolve geometry + which side of each box the arrow touches. Edges that
  //      would plough through other boxes are flagged for a margin "trunk" lane.
  //   2. Fan each (box, side) group across that side (distinct ports + matching
  //      `focus`), then route: flat-graph long edges ride their reserved Sugiyama
  //      lane; framed long edges bow out to a margin lane; everything else is a
  //      crisp perpendicular elbow. No pile-ups at box centres, no diagonals.
  const arrowEls: El[] = [];
  const arrowLabelEls: El[] = [];
  // Every arrow is our own orthogonal route with solid bindings (so it always
  // points at a real box edge) and rounded corners (the elbow look). "elbow" and
  // "orthogonal" route identically here — native Excalidraw elbow arrows bind
  // unreliably in the Obsidian plugin, so we don't emit them. "straight" stays a
  // direct line.
  const routingUsed: Routing = input.routing === "straight" ? "straight" : "orthogonal";
  const useOrthogonal = routingUsed !== "straight";

  type ArrowPlan = {
    a: PlanArrow;
    from: El;
    to: El;
    fromBounds: Bounds;
    toBounds: Bounds;
    fromSide: Side;
    toSide: Side;
    waypoints: Pt[];
    channel: ChannelKind | null;
    laneIdx: number;
    startT: number;
    endT: number;
  };

  // Bounding box of the whole drawing — margin trunk lanes sit just outside it.
  const fieldRects = [...frameEls, ...elements].map((e) => ({ x: e.x as number, y: e.y as number, w: e.width as number, h: e.height as number }));
  const fieldMinX = Math.min(...fieldRects.map((r) => r.x));
  const fieldMinY = Math.min(...fieldRects.map((r) => r.y));
  const fieldMaxX = Math.max(...fieldRects.map((r) => r.x + r.w));
  const fieldMaxY = Math.max(...fieldRects.map((r) => r.y + r.h));
  const allBounds: Bounds[] = elements.map((e) => ({ x: e.x as number, y: e.y as number, width: e.width as number, height: e.height as number }));

  // Order along a box side: top/bottom fan along x, left/right fan along y.
  const sideCoord = (side: Side, c: Pt) => (side === "left" || side === "right" ? c.y : c.x);

  const plans: ArrowPlan[] = [];
  const portGroups = new Map<string, Array<{ plan: ArrowPlan; end: "start" | "end"; order: number }>>();

  for (const a of inputArrows) {
    const from = shapeByLabel.get(a.from);
    const to = shapeByLabel.get(a.to);
    if (!from || !to) continue;

    const fromBounds: Bounds = { x: from.x as number, y: from.y as number, width: from.width as number, height: from.height as number };
    const toBounds: Bounds = { x: to.x as number, y: to.y as number, width: to.width as number, height: to.height as number };

    const fi = nodeIndexByLabel.get(a.from);
    const ti = nodeIndexByLabel.get(a.to);
    const waypoints: Pt[] = (fi !== undefined && ti !== undefined && edgeRoutes.get(edgeKey(fi, ti))) || [];

    // A framed edge that would cross other boxes → margin trunk.
    const isEndpoint = (b: Bounds) => (b.x === fromBounds.x && b.y === fromBounds.y) || (b.x === toBounds.x && b.y === toBounds.y);
    const others = allBounds.filter((b) => !isEndpoint(b));
    const wantsChannel = hasFrames && useOrthogonal && waypoints.length === 0 && hasIntermediateBox(fromBounds, toBounds, others, direction);

    // Channel edges still exit/enter perpendicular to the flow (forward sides);
    // only the middle of the route detours to the margin. The trunk runs along
    // the nearer perpendicular margin to keep the detour short.
    let { fromSide, toSide } = chooseSides(fromBounds, toBounds, direction);
    let channel: ChannelKind | null = null;
    if (wantsChannel) {
      const fc = centerOf(fromBounds), tc = centerOf(toBounds);
      if (direction === "LR") {
        const avg = (fc.y + tc.y) / 2;
        channel = avg - fieldMinY <= fieldMaxY - avg ? "above" : "below";
      } else {
        const avg = (fc.x + tc.x) / 2;
        channel = avg - fieldMinX <= fieldMaxX - avg ? "left" : "right";
      }
    }

    const plan: ArrowPlan = { a, from, to, fromBounds, toBounds, fromSide, toSide, waypoints, channel, laneIdx: 0, startT: 0.5, endT: 0.5 };
    plans.push(plan);

    const register = (boxId: string, side: Side, end: "start" | "end", otherCenter: Pt) => {
      const key = `${boxId}|${side}`;
      if (!portGroups.has(key)) portGroups.set(key, []);
      portGroups.get(key)!.push({ plan, end, order: sideCoord(side, otherCenter) });
    };
    register(from.id as string, fromSide, "start", centerOf(toBounds));
    register(to.id as string, toSide, "end", centerOf(fromBounds));
  }

  // Spread connections across the middle ~60% of each side, ordered by the other
  // endpoint so neighbouring arrows don't tangle at the box.
  for (const members of portGroups.values()) {
    members.sort((p, q) => p.order - q.order);
    const k = members.length;
    members.forEach((m, i) => {
      const t = k === 1 ? 0.5 : 0.2 + 0.6 * (i / (k - 1));
      if (m.end === "start") m.plan.startT = t;
      else m.plan.endT = t;
    });
  }

  // Give each margin-routed edge its own lane so their trunks don't overlap.
  const laneCounter = new Map<ChannelKind, number>();
  for (const plan of plans) {
    if (!plan.channel) continue;
    const n = laneCounter.get(plan.channel) || 0;
    plan.laneIdx = n;
    laneCounter.set(plan.channel, n + 1);
  }
  const channelCross = (kind: ChannelKind, lane: number): number => {
    const off = 40 + lane * 26;
    switch (kind) {
      case "above": return fieldMinY - off;
      case "below": return fieldMaxY + off;
      case "left": return fieldMinX - off;
      case "right": return fieldMaxX + off;
    }
  };

  for (const plan of plans) {
    const { a, from, to, fromBounds, toBounds, fromSide, toSide, waypoints, channel } = plan;
    const start = portPoint(fromBounds, fromSide, plan.startT);
    const end = portPoint(toBounds, toSide, plan.endT);
    const route = channel
      ? sideChannelRoute(start, end, channelCross(channel, plan.laneIdx), direction)
      : useOrthogonal
        ? orthogonalRoute(start, end, waypoints, direction)
        : [start, end];
    const midPoints = route.slice(1, -1).map((p) => [p.x, p.y] as [number, number]);

    const arrow = createBoundArrow(start, end, from.id as string, to.id as string, midPoints, {
      strokeColor: resolveColor(COLOR_MAP, a.strokeColor, COLOR_MAP.gray),
      strokeStyle: a.strokeStyle,
      startFocus: focusFromT(plan.startT),
      endFocus: focusFromT(plan.endT),
    });
    (from.boundElements as Array<Record<string, unknown>>).push({ id: arrow.id, type: "arrow" });
    (to.boundElements as Array<Record<string, unknown>>).push({ id: arrow.id, type: "arrow" });
    arrowEls.push(arrow);

    if (a.label) {
      const mid = pathMidpoint(route);
      const lbl = createBoundText(a.label, arrow.id, { x: mid.x - 60, y: mid.y - 12, width: 120, height: 24 }, {
        fontSize: 13,
        strokeColor: COLOR_MAP.gray,
      });
      (arrow.boundElements as Array<Record<string, unknown>>).push({ type: "text", id: lbl.id });
      arrowLabelEls.push(lbl);
      texts.push({ id: lbl.id, text: a.label });
    }
  }

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
    routing: routingUsed,
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
// Readability heuristics
// ────────────────────────────────────────────────────────────────────────────

// Surface cleanliness problems in the tool result so the agent gets feedback
// in-loop — the skill guidance is easy to skip, but a tool result is not. These
// are non-blocking nudges (the diagram is still created); the agent decides
// whether to redraw. Mirrors the "fewer arrows" rules in the diagrams skill.
function assessDiagramDensity(elements: PlanElement[], arrows: PlanArrow[]): string[] {
  const nBoxes = elements.filter((e) => e.type !== "frame").length;
  const nArrows = arrows.length;
  const warnings: string[] = [];

  if (nArrows > nBoxes && nArrows > 6) {
    warnings.push(
      `${nArrows} arrows for ${nBoxes} boxes — too dense to read. Clean diagrams keep arrows ≤ boxes. ` +
        `Group related boxes into a 'frame', drop relationships that grouping/order already implies, ` +
        `or split into smaller scoped diagrams (e.g. C4 context/container/component).`,
    );
  }

  const degree = new Map<string, number>();
  for (const a of arrows) {
    degree.set(a.from, (degree.get(a.from) || 0) + 1);
    degree.set(a.to, (degree.get(a.to) || 0) + 1);
  }
  const hubs = [...degree.entries()].filter(([, d]) => d > 5).map(([l]) => l);
  if (hubs.length) {
    warnings.push(`Hairball box(es) with >5 connections: ${hubs.join(", ")}. Add a grouping frame or split the diagram.`);
  }

  const directed = new Set(arrows.map((a) => `${a.from} ${a.to}`));
  const bidi = arrows.filter((a) => a.from < a.to && directed.has(`${a.to} ${a.from}`)).length;
  if (bidi) warnings.push(`${bidi} bidirectional arrow pair(s) — keep one arrow in the dominant direction.`);

  return warnings;
}

// ────────────────────────────────────────────────────────────────────────────
// Extension Registration
// ────────────────────────────────────────────────────────────────────────────

export function registerDiagramTools(pi: ExtensionAPI, resolveProjectPath: (slug: string, relativePath: string) => string | null, getCurrentProject: () => string | null): void {
  // Resolve where a diagram file should be written. Diagrams have one home:
  // `<project-root>/diagrams/`. This NEVER returns a repo-relative path (the old
  // `${slug}/diagrams/...` fallback was written relative to cwd, so diagrams
  // landed in the working repo instead of the vault):
  //   • an absolute filePath is honoured verbatim (explicit escape hatch);
  //   • a relative filePath is normalised under `<slug>/diagrams/` — a redundant
  //     leading `docs/` is stripped (the project folder is already the doc root)
  //     and a `diagrams/` prefix is ensured, so `docs/diagrams/x`, `docs/x` and
  //     `x` all land in `<slug>/diagrams/x`;
  //   • an unresolvable project falls back to an absolute path under the data dir.
  const resolveDiagramPath = (slug: string, userFilePath: string | undefined, defaultName: string): string => {
    if (userFilePath && isAbsolute(userFilePath)) return userFilePath;
    let name = (userFilePath || defaultName).replace(/^\/+/, "").replace(/^docs\//i, "");
    if (!/^diagrams\//i.test(name)) name = `diagrams/${name}`;
    return resolveProjectPath(slug, `<slug>/${name}`) || join(DATA_DIR, slug, name);
  };

  // ──────────────────────────────────────────────────────────────────
  // Tool: draw_excalidraw
  // ──────────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "draw_excalidraw",
    label: "draw_excalidraw",
    description:
      "Create or update a free-form Excalidraw diagram (architecture/C4, wireframes, screenflow, brainstorm, data-flow). Describe boxes and arrows in plain English; the tool auto-lays-out nodes and binds arrows to box edges. CLEAN DIAGRAMS USE FEW ARROWS: aim for arrows ≤ number of boxes — show relationships with frames/grouping/layout instead of lines, and split a busy diagram by scope (e.g. C4 levels) rather than cramming. The tool warns when a diagram is too dense; act on the warning. Use draw_mermaid for strict standard diagrams (sequence, flowchart, state, ER, class, gantt).",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
      filePath: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      direction: Type.Optional(StringEnum(["auto", "LR", "TB"])),
      routing: Type.Optional(StringEnum(["straight", "orthogonal", "elbow"])),
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
      "Use draw_excalidraw for spatial/creative diagrams: C4/architecture, UI wireframes, screenflow, brainstorm, data-flow, scrum boards.",
      "FEWER ARROWS = CLEARER. Budget arrows ≤ number of boxes; a diagram with >15-20 arrows is unreadable — split it by scope (e.g. C4 levels) instead. See the 'diagrams' skill for per-type playbooks.",
      "Express relationships WITHOUT arrows where possible: put related boxes in a 'frame' (containment), or rely on column/row order (a pipeline). Only draw an arrow for a relationship that proximity/grouping can't show.",
      "Keep one flow direction; avoid back-edges, bidirectional pairs, and high fan-out (a box with >4 arrows is a hairball — group or split).",
      "Omit x/y — nodes auto-lay-out from the arrows; arrows bind to box edges. Leave direction 'auto' unless forcing 'LR'/'TB'. Label only non-obvious arrows.",
      "Routing default gives elbow-style arrows: orthogonal routes with rounded corners, every arrow bound to both box edges (never floating/pointing at nothing). Pass 'straight' for simple direct lines.",
      "Use draw_mermaid for strict standard types (sequence, flowchart, state, gantt, class, ER) — it auto-lays-out and prevents arrow soup.",
    ],
    async execute(_toolCallId, params) {
      const slug = params.project || getCurrentProject() || "_unassigned";
      const filePath = resolveDiagramPath(slug, params.filePath, "_Sketch.excalidraw.md");

      const planned = planExcalidrawScene({
        elements: params.elements as PlanElement[] | undefined,
        arrows: params.arrows as PlanArrow[] | undefined,
        title: params.title,
        direction: (params.direction as Direction | "auto" | undefined) || "auto",
        // Elbow-style: orthogonal route with rounded corners, every arrow bound
        // to both box edges. "elbow"/"orthogonal" are equivalent; default to it.
        routing: (params.routing as Routing | undefined) || "orthogonal",
      });

      const routingNote =
        planned.routing === "straight"
          ? "\n  Arrows: straight (bound to box edges)"
          : "\n  Arrows: elbow-style — rounded corners, bound to both box edges";

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

      const warnings = assessDiagramDensity(
        (params.elements as PlanElement[] | undefined) || [],
        (params.arrows as PlanArrow[] | undefined) || [],
      );
      const warnBlock = warnings.length
        ? `⚠ Readability — this diagram is hard to read; redraw cleaner:\n${warnings.map((w) => `  • ${w}`).join("\n")}\n\n`
        : "";

      return {
        content: [
          {
            type: "text",
            text: `${warnBlock}✓ Diagram created: ${basename(filePath)}\n  Elements: ${planned.elementCount}  Layout: ${planned.direction}${routingNote}\n  File: ${filePath}`,
          },
        ],
        details: {
          action: "draw_excalidraw",
          project: slug,
          filePath: basename(filePath),
          elementCount: planned.elementCount,
          direction: planned.direction,
          routing: planned.routing,
          warnings,
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
      const slug = params.project || getCurrentProject() || "_unassigned";
      const filePath = resolveDiagramPath(slug, params.filePath, "_Sketch.md");

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
      const slug = params.project || getCurrentProject() || "_unassigned";
      const diagramsDir =
        params.filePath && isAbsolute(params.filePath)
          ? params.filePath
          : resolveProjectPath(slug, "<slug>/diagrams/") || join(DATA_DIR, "diagrams", slug);

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
