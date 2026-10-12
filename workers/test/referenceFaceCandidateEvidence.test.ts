// Offline design comparison on immutable live evidence; no production override.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { measureReferenceRenderedQuality } from "../src/referenceStyleSelection";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { decodePng, encodePng } from "../src/png";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { validateAtlasCraftFoundation } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { freshAuditOutput } from "./freshAuditOutput";

it("compares existing source-eligible face candidates and a distinct offline palette study", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-neck-scarf-20261010-004";
    const bytes = readFileSync(`${root}/summary.json`), run = JSON.parse(bytes.toString()).currentDefaultE2E;
    const t = run.result.propagationTrace, plan: SkinPlan = t.skinPlan.skinPlan;
    const a = { ...t.primary, ...t.renderAnalysis } as PhotoAnalysis;
    const immutable = JSON.stringify([a, plan]), style = t.injectedParameters.faceStyle;
    const baseline = buildProceduralSourceAtlas(t.injectedParameters.features, style, plan)!;
    const design = buildReferenceStylePlan(a), output = freshAuditOutput("evaluation-artifacts/face-candidate-evidence-20261010-");
    const rows = [], prototypes = [], front = CLASSIC_LAYOUT.head.base.front;
    for (const face of design.candidates.face) {
      const choice = { ...t.referenceStyle.design, face };
      const composition = composeReferenceStyleAtlas(baseline, plan, choice, style);
      const quality = measureReferenceRenderedQuality(composition, baseline, plan, choice, style);
      expect(quality.violations).toEqual([]);
      expect(validateAtlasCraftFoundation(composition.atlas, style).ok).toBe(true);
      const eyes = plan.facePixelPlan.pixels.filter(p => p.role === "iris").map(p => {
        const i = ((front.y + p.y) * 64 + front.x + p.x) * 4;
        return { ...p, rgb: [...composition.atlas.rgba.slice(i, i + 3)] };
      });
      for (const [name, atlas] of [[face.family, composition.atlas], ...(face.family === t.selectedFamilies.face
        ? ["palette-prototype-not-production", "lowered-palette-prototype-not-production", "lowered-source-palette-not-production", "lowered-landmarks-not-production"]
          .map(name => [name, structuredClone(composition.atlas)] as const) : [])] as const) {
        if (name.includes("not-production")) {
          const eye = [1, 3, 5].map(i => parseInt(style.eyeColor.slice(i, i + 2), 16));
          const skin = [1, 3, 5].map(i => parseInt(style.skinTone.slice(i, i + 2), 16));
          const lowered = name.startsWith("lowered-");
          if (name === "lowered-landmarks-not-production") {
            const landmarks = plan.facePixelPlan.pixels.filter(p => ["left_eye", "right_eye", "mouth", "nose"].includes(p.cluster));
            const colors = landmarks.map(p => ({ ...p, color: [...atlas.rgba.slice(((front.y + p.y) * 64 + front.x + p.x) * 4, ((front.y + p.y) * 64 + front.x + p.x) * 4 + 3)] }));
            for (const p of landmarks) atlas.rgba.set(skin, ((front.y + p.y) * 64 + front.x + p.x) * 4);
            for (const p of colors) atlas.rgba.set(p.color, ((front.y + p.y + 1) * 64 + front.x + p.x) * 4);
          } else {
          if (lowered) for (const p of eyes) atlas.rgba.set(skin, ((front.y + p.y) * 64 + front.x + p.x) * 4);
          for (const p of eyes) {
            const color = name === "lowered-source-palette-not-production" ? p.rgb
              : p.y === Math.min(...eyes.map(e => e.y)) ? [248, 246, 240] : eye;
            atlas.rgba.set(color, ((front.y + p.y + Number(lowered)) * 64 + front.x + p.x) * 4);
          }
          }
          const errors = measureReferenceRenderedQuality({ ...composition, atlas }, baseline, plan, choice, style).violations;
          expect(errors.length).toBeGreaterThan(0);
          prototypes.push({ name, authorizedByCurrentContract: false, errors });
        }
        const view = renderSkinViews(atlas).find(v => v.name === "front")!.image;
        writeFileSync(`${output}/${name}.png`, await encodePng(scaleNearestNeighbor(view, 384, 576)), { flag: "wx" });
      }
      rows.push({ face, quality, eyes });
    }
    const referencePath = "C:/Users/sangm/.codex/attachments/797857e3-3c59-4de6-b014-726953cda51d/image-5.png";
    const referenceBytes = readFileSync(referencePath), reference = await decodePng(referenceBytes);
    const referenceView = renderSkinViews(reference).find(v => v.name === "front")!.image;
    writeFileSync(`${output}/reference-C.png`, await encodePng(scaleNearestNeighbor(referenceView, 384, 576)), { flag: "wx" });
    expect(JSON.stringify([a, plan])).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(network).not.toHaveBeenCalled();
    writeFileSync(`${output}/summary.json`, JSON.stringify({ mode: "offline_design_study_not_new_observation", providerCalls: 0,
      sourceSummarySha256: createHash("sha256").update(bytes).digest("hex"), currentSelected: t.selectedFamilies.face,
      currentMeasuredGeometryUnchanged: true, productionMutatedByTest: false, rows, prototypes }, null, 2), { flag: "wx" });
    console.info("FACE_CANDIDATE_STUDY", output);
  } finally { network.mockRestore(); }
}, 60_000);
