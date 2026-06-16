import { describe, it, expect } from "vitest";
import { planExcalidrawScene, type PlanElement, type PlanArrow } from "../src/diagrams";

type El = Record<string, any>;

function rectsOverlap(a: El, b: El, gap = 0): boolean {
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

// The architecture from the screenshot the user shared.
const ARCH: { elements: PlanElement[]; arrows: PlanArrow[] } = {
  elements: [
    { type: "frame", label: "Pi Runtime" },
    { type: "frame", label: "docflow Extension" },
    { type: "frame", label: "Docflow Data" },
    { type: "frame", label: "Shared Obsidian Vault" },
    { type: "box", label: "Pi Coding Agent", frame: "Pi Runtime" },
    { type: "box", label: "Slash Commands /docflow-*", frame: "Pi Runtime" },
    { type: "box", label: "Agent Tools docflow_*", frame: "Pi Runtime" },
    { type: "box", label: "Extension Entry Point index.ts", frame: "docflow Extension" },
    { type: "box", label: "Command + Tool Handlers", frame: "docflow Extension" },
    { type: "box", label: "Events + Session Tracking", frame: "docflow Extension" },
    { type: "box", label: "Config config.json", frame: "Docflow Data" },
    { type: "box", label: "Project Docs pi-test", frame: "Shared Obsidian Vault" },
    { type: "box", label: "README.md", frame: "Shared Obsidian Vault" },
  ],
  arrows: [
    { from: "Pi Coding Agent", to: "Extension Entry Point index.ts", label: "loads extension" },
    { from: "Slash Commands /docflow-*", to: "Command + Tool Handlers", label: "invoke" },
    { from: "Agent Tools docflow_*", to: "Command + Tool Handlers", label: "call" },
    { from: "Command + Tool Handlers", to: "Config config.json", label: "read/write config" },
    { from: "Command + Tool Handlers", to: "Project Docs pi-test", label: "update docs" },
    { from: "Events + Session Tracking", to: "Project Docs pi-test", label: "track sessions" },
  ],
};

describe("diagrams", () => {
  it("exports the registration entry point", async () => {
    const mod = await import("../src/diagrams");
    expect(mod.registerDiagramTools).toBeDefined();
  });

  describe("planExcalidrawScene — scene validity", () => {
    const { scene, texts } = planExcalidrawScene(ARCH);
    const els: El[] = scene.elements as El[];

    it("produces a serialisable excalidraw scene", () => {
      expect(scene.type).toBe("excalidraw");
      expect(() => JSON.stringify(scene)).not.toThrow();
      const round = JSON.parse(JSON.stringify(scene));
      expect(round.elements.length).toBe(els.length);
    });

    it("binds every arrow to its endpoints (no floating arrows)", () => {
      const arrows = els.filter((e) => e.type === "arrow");
      expect(arrows.length).toBe(ARCH.arrows.length);
      for (const a of arrows) {
        expect(a.startBinding?.elementId).toBeTruthy();
        expect(a.endBinding?.elementId).toBeTruthy();
        expect(a.endArrowhead).toBe("arrow"); // lowercase 'h' — the real Excalidraw prop
      }
    });

    it("registers each arrow in both endpoints' boundElements", () => {
      const byId = new Map(els.map((e) => [e.id, e]));
      for (const a of els.filter((e) => e.type === "arrow")) {
        const from = byId.get(a.startBinding.elementId)!;
        const to = byId.get(a.endBinding.elementId)!;
        const refs = (e: El) => (e.boundElements || []).filter((b: El) => b.type === "arrow").map((b: El) => b.id);
        expect(refs(from)).toContain(a.id);
        expect(refs(to)).toContain(a.id);
      }
    });

    it("uses bound text for labels (centred inside containers, not floating)", () => {
      const boundTexts = els.filter((e) => e.type === "text" && e.containerId);
      // every box + every labelled arrow has a bound text
      const boxes = els.filter((e) => e.type === "rectangle");
      const labelledArrows = ARCH.arrows.filter((a) => a.label).length;
      expect(boundTexts.length).toBe(boxes.length + labelledArrows);
      for (const t of boundTexts) {
        const container = els.find((e) => e.id === t.containerId)!;
        expect(container).toBeTruthy();
        expect(container.boundElements.some((b: El) => b.type === "text" && b.id === t.id)).toBe(true);
        expect(t.textAlign).toBe("center");
        expect(t.verticalAlign).toBe("middle");
      }
    });

    it("places nodes without overlaps", () => {
      const boxes = els.filter((e) => e.type === "rectangle");
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          expect(rectsOverlap(boxes[i], boxes[j])).toBe(false);
        }
      }
    });

    it("wraps frames around their members", () => {
      const frames = els.filter((e) => e.type === "frame");
      expect(frames.length).toBe(4);
      const boxes = els.filter((e) => e.type === "rectangle" && e.frameId);
      for (const box of boxes) {
        const frame = frames.find((f) => f.id === box.frameId)!;
        expect(frame).toBeTruthy();
        expect(box.x).toBeGreaterThanOrEqual(frame.x);
        expect(box.y).toBeGreaterThanOrEqual(frame.y);
        expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
        expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
      }
    });

    it("emits Obsidian-safe ids (alphanumeric, leading letter) for every text element", () => {
      for (const t of texts) {
        expect(t.id).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      }
      // text-element list covers exactly the text elements in the scene
      const sceneTextIds = els.filter((e) => e.type === "text").map((e) => e.id).sort();
      expect(texts.map((t) => t.id).sort()).toEqual(sceneTextIds);
    });
  });

  describe("planExcalidrawScene — layout direction inference", () => {
    it("infers LR for a long chain", () => {
      const chain: PlanElement[] = ["A", "B", "C", "D", "E"].map((l) => ({ type: "box", label: l }));
      const arrows: PlanArrow[] = [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
        { from: "C", to: "D" },
        { from: "D", to: "E" },
      ];
      const { direction } = planExcalidrawScene({ elements: chain, arrows });
      expect(direction).toBe("LR");
    });

    it("infers TB for a wide fan-out", () => {
      const fan: PlanElement[] = ["Root", "C1", "C2", "C3", "C4"].map((l) => ({ type: "box", label: l }));
      const arrows: PlanArrow[] = [
        { from: "Root", to: "C1" },
        { from: "Root", to: "C2" },
        { from: "Root", to: "C3" },
        { from: "Root", to: "C4" },
      ];
      const { direction } = planExcalidrawScene({ elements: fan, arrows });
      expect(direction).toBe("TB");
    });

    it("respects an explicit direction override", () => {
      const fan: PlanElement[] = ["Root", "C1", "C2", "C3"].map((l) => ({ type: "box", label: l }));
      const arrows: PlanArrow[] = [
        { from: "Root", to: "C1" },
        { from: "Root", to: "C2" },
        { from: "Root", to: "C3" },
      ];
      const { direction } = planExcalidrawScene({ elements: fan, arrows, direction: "LR" });
      expect(direction).toBe("LR");
    });
  });
});
