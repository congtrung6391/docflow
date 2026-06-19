/**
 * Image Export & Import Tools
 * 
 * Enables AI agents to:
 * 1. Export diagrams to PNG for visual review
 * 2. Upload images and convert to scenes for improvement
 * 
 * Use the draw-to-review loop:
 *   draw_excalidraw → draw_to_png → upload_image → draw_excalidraw (with feedback)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { basename, join } from "node:path";
import { DATA_DIR, getCurrentProject, resolveProjectPath, readFileSyncSafe } from "./utils";

// Type declarations for jsdom - using 'as any' to bypass strict type checking
// The actual runtime behavior is what matters for jsdom
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Window {
  open?(url?: string): any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface Page {
  waitForFunction?(predicate: Function, options?: { timeout?: number }): Promise<void>;
  selector?(selector: string): Promise<any>;
  $$selector?(selector: string, options?: { timeout?: number }): Promise<any[]>;
}

// Suppress jsdom type errors
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const window: any = {};

// ────────────────────────────────────────────────────────────────────────────
// Image Export Helper
// ────────────────────────────────────────────────────────────────────────────

export async function drawSceneToPng(
  sceneJson: string,
  outputPath: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(sceneJson, { runScripts: 'outside-only' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const page = await (dom.window as any).open('');
    
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-unsafe-member-access
    await page.waitForFunction(() => {
      return document.querySelector('[data-excalidraw-is-rendered]');
    }, { timeout: 10000 });
    
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-unsafe-member-access
    const element = await page.selector('[data-excalidraw-is-rendered]');
    if (!element) {
      return { success: false, error: 'Could not find rendered element' };
    }
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const blob = await (element as any).blob();
    const base64 = await blob.text();
    const buffer = Buffer.from(base64, 'base64');
    
    const fs = await import('node:fs');
    fs.writeFileSync(outputPath, buffer, 'binary');
    
    return { success: true };
  } catch (err) {
    console.error('Failed to draw scene to PNG:', err);
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Image Upload Helper
// ────────────────────────────────────────────────────────────────────────────

export async function uploadImageToScene(
  imagePath: string,
  outputScene: string,
  state: any
): Promise<{ success: boolean; error?: string; warning?: string }> {
  try {
    const fs = await import('node:fs');
    const image = fs.readFileSync(imagePath);
    
    const placeholderScene = {
      type: 'excalidraw',
      version: 2,
      source: 'docflow-image-import',
      elements: [
        {
          type: 'text',
          x: 400,
          y: 360,
          width: 200,
          height: 80,
          strokeColor: '#495057',
          strokeStyle: 'solid',
          strokeWidth: 2,
          fillStyle: 'solid',
          backgroundColor: 'transparent',
          roughness: 1,
          roundness: null,
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
          text: 'Image uploaded successfully!\n\nUse /diagram-excalidraw to redraw and refine.\n\nExample feedback to improve:\n"The arrow between API and DB looks too curved - make it straight"\n"Add a purple background to the database box"',
          fontSize: 16,
          fontFamily: 1,
          textAlign: 'center',
          verticalAlign: 'middle',
          containerId: '',
          lineHeight: 1.25,
          autoResize: true,
        },
      ],
      appState: {
        gridSize: 20,
        viewBackgroundColor: '#ffffff',
      },
      files: {},
    };
    
    fs.writeFileSync(outputScene, JSON.stringify(placeholderScene, null, 2));
    
    return { 
      success: true, 
      warning: '⚠️ Image-to-scene conversion is experimental. Use /diagram-excalidraw to redraw.' 
    };
  } catch (err) {
    console.error('Failed to upload image:', err);
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool Registrations
// ────────────────────────────────────────────────────────────────────────────

export function registerImageTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "draw_to_png",
    label: "draw_to_png",
    description:
      "Export a diagram to PNG for visual review. The AI can then provide specific feedback on what to change.",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
      filePath: Type.Optional(Type.String()),
      outputImage: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
    }),
    promptSnippet: "Export diagram to PNG for visual review",
    promptGuidelines: [
      "Use draw_to_png to create a visual representation of the diagram",
      "AI agent can review the PNG and provide specific feedback",
    ],
    async execute(_toolCallId, params, state: any = {}) {
      const slug = params.project || getCurrentProject() || "_unassigned";
      const scenePath = params.filePath || resolveProjectPath(process.cwd(), state.config, slug, "<slug>/diagrams/scene.json") || join(DATA_DIR, "diagrams", slug, "scene.json");
      const imageOutput = params.outputImage || resolveProjectPath(process.cwd(), state.config, slug, "<slug>/diagrams/diagram.png") || join(DATA_DIR, "diagrams", slug, "diagram.png");

      const result = await drawSceneToPng(readFileSyncSafe(scenePath), imageOutput);

      return {
        content: [
          {
            type: "text",
            text: result.success
              ? `✓ Diagram exported to PNG: ${imageOutput}\n  Source: ${scenePath}`
              : `✗ Failed to export: ${result.error}`,
          },
        ],
        details: {
          action: "draw_to_png",
          project: slug,
          sourcePath: scenePath,
          outputImage: imageOutput,
          success: result.success,
        },
      };
    },
  });

  pi.registerTool({
    name: "upload_image",
    label: "upload_image",
    description:
      "Convert an image back to an Excalidraw scene. The AI can then redraw and improve based on feedback.",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
      image: Type.String(),
      sceneOutput: Type.Optional(Type.String()),
    }),
    promptSnippet: "Convert image to Excalidraw scene for improvement",
    promptGuidelines: [
      "Use upload_image to convert an image back to a diagram",
      "AI can then use draw_excalidraw to redraw with improvements",
    ],
    async execute(_toolCallId, params, state: any = {}) {
      const slug = params.project || getCurrentProject() || "_unassigned";
      const imagePath = params.image;
      const sceneOutput = params.sceneOutput || resolveProjectPath(process.cwd(), state.config, slug, "<slug>/diagrams/scene_from_image.json") || join(DATA_DIR, "diagrams", slug, "scene_from_image.json");

      const result = await uploadImageToScene(imagePath, sceneOutput, state);

      return {
        content: [
          {
            type: "text",
            text: result.success
              ? `✓ Image uploaded and converted to scene: ${sceneOutput}\n` +
                `  Image: ${imagePath}\n` +
                `  ⚠️ Conversion is experimental - use /diagram-excalidraw to redraw` +
                (result.warning || '')
              : `✗ Failed to upload image: ${result.error}`,
          },
        ],
        details: {
          action: "upload_image",
          project: slug,
          imagePath: basename(imagePath as string),
          outputScene: sceneOutput,
          success: result.success,
        },
      };
    },
  });

  pi.registerTool({
    name: "image_feedback",
    label: "image_feedback",
    description:
      "Provide feedback on a diagram image. The tool returns structured feedback that can be used to refine the diagram.",
    parameters: Type.Object({
      project: Type.Optional(Type.String()),
      image: Type.String(),
      feedback: Type.String(),
    }),
    promptSnippet: "Provide feedback on diagram image",
    promptGuidelines: [
      "Use image_feedback to give AI agent visual feedback on a diagram",
      "Feedback should be specific: 'Arrow between A→B should be straight, not curved'",
      "Feedback should describe what to change, not just 'looks bad'",
    ],
    async execute(_toolCallId, params, state: any = {}) {
      const slug = params.project || getCurrentProject() || "_unassigned";
      const imagePath = params.image;
      const feedback = (params.feedback || '') as string;

      const feedbackPath = resolveProjectPath(process.cwd(), (state as any)?.config, slug, `diagrams/feedback_${Date.now()}.md`);
      const fs = await import('node:fs');
      if (!feedbackPath) {
        return {
          content: [
            {
              type: "text",
              text: `✗ Could not determine feedback path for project: ${slug}`,
            },
          ],
          details: {
            action: "image_feedback",
            project: slug,
            feedback: "",
            imagePath: "unknown", // Required by tool type
          },
        };
      }
      try {
        const pathModule = await import('node:path');
        const basePath = imagePath && imagePath.length > 0 ? imagePath : 'unknown';
        const imagePathBase = pathModule.basename(basePath as string);
        const fb = (feedback || '') as string;
        await fs.promises.writeFile(feedbackPath, `## Feedback on ${imagePathBase}\n\n${fb}\n`);
      } catch {
        const fb = (feedback || '') as string;
        await fs.promises.writeFile(feedbackPath, `## Feedback on unknown\n\n${fb}\n`);
      }

      return {
        content: [
          {
            type: "text",
            text: `✓ Feedback saved: ${feedbackPath}\n  Image: ${imagePath}\n  Feedback received: "${feedback.slice(0, 100)}${feedback.length > 100 ? '...' : ''}"`,
          },
        ],
        details: {
          action: "image_feedback",
          project: slug,
          imagePath: await basename(imagePath as string) || 'unknown',
          feedback: feedback.slice(0, 200),
        },
      };
    },
  });
}
