// Same-run partial evidence, isolated color transfers; not primary reconstruction.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("isolates D010's headwear color and complete checker palette through exact saved-plan PNG replay", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-010";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("26c58761d0f08a862e8f4721194d02a8271236beb252c3700682c203a9ab8eb6");
    const run = JSON.parse(bytes.toString()).currentDefaultE2E, t = run.result.propagationTrace;
    const saved = t.skinPlan.skinPlan, immutable = JSON.stringify(t);
    // No absent prompt filled in. Only observed-field extraction is transferred,
    // never a newly reconstructed full plan from this incomplete evidence.
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    const old = t.injectedParameters;
    const headwear = refineFeatureColorsFromAnalysis(a, old.features).hatColor;
    const pattern = buildOutfitPlan(a).upper.pattern;
    expect(headwear).toBe("#2f7775"); expect(old.features.hatColor).toBe("#22201e");
    expect(pattern).toMatchObject({ construction: "pixel_blocks", source: "observed",
      blockColors: ["#d9a5af", "#cdbfd9", "#e1c87d", "#819cba"] });
    const actual = await decodePng(png);
    const out = freshAuditOutput("evaluation-artifacts/observed-material-morphology-20261010-");
    const results = [];
    for (const [name, hat, cloth] of [["before", false, false], ["hat-only", true, false],
      ["cloth-only", false, true], ["after", true, true]] as const) {
      const p = structuredClone(saved);
      if (cloth) p.outfitPlan.upper.pattern = pattern;
      const features = { ...old.features, ...(hat ? { hatColor: headwear } : {}) };
      const style = { ...old.faceStyle, ...(hat ? { hatColor: headwear } : {}) };
      const base = buildProceduralSourceAtlas(features, style, p)!;
      const local = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, style);
      const image = local.atlas;
      if (name === "before") expect(image.rgba).toEqual(actual.rgba);
      const craft = validateReferenceAtlasCraft(image, base, p, style,
        buildReferenceCraftPlan(p, t.referenceStyle.design, local));
      expect(craft.ok, JSON.stringify(craft)).toBe(true); expect(validateFinalAtlas(image).ok).toBe(true);
      const allowed = [
        ...(hat ? [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)] : []),
        ...(cloth ? ["body", "leftArm", "rightArm"].flatMap(part => Object.values(CLASSIC_LAYOUT[part as "body"].base)) : []),
      ];
      let changed = 0;
      for (let i = 0; i < 4096; i++) {
        expect(image.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
        if ([0, 1, 2].some(ch => image.rgba[i * 4 + ch] !== actual.rgba[i * 4 + ch])) {
          changed++;
          expect(allowed.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y
            && Math.floor(i / 64) < r.y + r.h), `outside_transfer:${name}:${i}`).toBe(true);
        }
      }
      if (name !== "before") expect(changed).toBeGreaterThan(0);
      expect(p.hairPlan).toEqual(saved.hairPlan); expect(p.facePixelPlan).toEqual(saved.facePixelPlan);
      expect(p.headIdentityPlan).toEqual(saved.headIdentityPlan);
      expect(p.outfitPlan.upper.leftSleeve).toEqual(saved.outfitPlan.upper.leftSleeve);
      expect(p.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
      const visibleColors = (cloth ? pattern.blockColors! : []).map(hex => {
        const rgb = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)); let count = 0;
        for (const part of ["body", "leftArm", "rightArm"] as const) {
          const b = CLASSIC_LAYOUT[part].base.front, o = CLASSIC_LAYOUT[part].overlay.front;
          for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
            const bi = ((b.y + y) * 64 + b.x + x) * 4, oi = ((o.y + y) * 64 + o.x + x) * 4;
            const at = image.rgba[oi + 3] === 255 ? oi : bi;
            if (rgb.every((c, i) => image.rgba[at + i] === c)) count++;
          }
        }
        expect(count, `${name}:${hex}`).toBeGreaterThan(0); return { color: hex, pixels: count };
      });
      const encoded = await encodePng(image); expect((await decodePng(encoded)).rgba).toEqual(image.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      for (const view of renderSkinViews(image)) writeFileSync(`${out}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 6, view.image.height * 6)), { flag: "wx" });
      results.push({ name, rgbaSha256: sha(image.rgba), changedPixels: changed, unrelatedPixels: 0,
        alphaUnchanged: true, craftPass: true, atlasPass: true, visibleColors });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, sourceSummarySha256: sha(bytes), runId: run.runId,
      providerCalls: 0, actualPngExactBaseline: true, missingPromptsReconstructed: false,
      beforeHatColor: old.features.hatColor, afterHatColor: headwear, pattern, results,
      sleeveLengthUnchanged: "short", freshLiveDeliveryVerified: false,
      remaining: ["source_long_sleeves_not_explicit_in_retained_primary", "long_hair_body_silhouette", "hat_shape_detail"]
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${root}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("MATERIAL_MORPHOLOGY_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
