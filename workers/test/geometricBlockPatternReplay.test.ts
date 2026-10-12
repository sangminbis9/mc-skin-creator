// Same-run evidence only: no remote runner or missing prompt reconstruction.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
it("recovers D007's observed five-color geometry from the exact live PNG baseline with a pattern-only transfer", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-007";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("052dd1dbb382c385f9fa50314b01f69bce36707a678a1467f119c473f3d77b70");
    const run = JSON.parse(bytes.toString()).currentDefaultE2E, t = run.result.propagationTrace;
    const saved: SkinPlan = t.skinPlan.skinPlan, plan = structuredClone(saved);
    const observed: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis, identityPrompt: "", outfitPrompt: "", negativePrompt: "" };
    const immutable = JSON.stringify([saved, t]);
    expect(t.primary.observed.clothing).toBe(t.renderAnalysis.observed.clothing);
    expect(t.primary.observed.clothing).toContain("pastel-colored oversized hoodie");
    expect(saved.outfitPlan.upper.pattern.kind).toBe("none");
    const pattern = buildOutfitPlan(observed).upper.pattern;
    expect(pattern).toMatchObject({ kind: "checker_block", construction: "pixel_blocks", source: "observed",
      blockColors: ["#d9a5af", "#a38cab", "#cdbfd9", "#e1c87d", "#a9d5eb"] });
    // Missing prose remains unavailable. Do not rebuild other plan fields from
    // partial analysis or quietly change source-observed short sleeves.
    plan.outfitPlan.upper.pattern = pattern;
    expect({ ...plan.outfitPlan.upper, pattern: saved.outfitPlan.upper.pattern }).toEqual(saved.outfitPlan.upper);
    expect(plan.hairPlan).toEqual(saved.hairPlan); expect(plan.facePixelPlan).toEqual(saved.facePixelPlan);
    expect(plan.headIdentityPlan).toEqual(saved.headIdentityPlan);
    const render = (p: SkinPlan) => {
      const base = buildProceduralSourceAtlas(t.injectedParameters.features, t.injectedParameters.faceStyle, p)!;
      const result = composeReferenceStyleAtlas(base, p, t.referenceStyle.design, t.injectedParameters.faceStyle);
      const craft = validateReferenceAtlasCraft(result.atlas, base, p, t.injectedParameters.faceStyle,
        buildReferenceCraftPlan(p, t.referenceStyle.design, result));
      expect(craft.ok, JSON.stringify(craft)).toBe(true);
      expect(validateFinalAtlas(result.atlas).ok).toBe(true);
      return result.atlas;
    };
    const before = render(saved), actual = await decodePng(png), after = render(plan);
    expect(before.rgba).toEqual(actual.rgba);
    expect(sha(before.rgba)).toBe("2b01efc5cb47b905ad9211564de683586100edf77b57cb7d2881c288fbc61b91");
    expect(render(plan).rgba).toEqual(after.rgba);
    const parts = ["body", "leftArm", "rightArm"] as const;
    const rects = parts.flatMap(part => Object.values(CLASSIC_LAYOUT[part].base));
    let changed = 0;
    for (let i = 0; i < 4096; i++) {
      expect(after.rgba[i * 4 + 3]).toBe(before.rgba[i * 4 + 3]);
      if (after.rgba.slice(i * 4, i * 4 + 4).some((v, ch) => v !== before.rgba[i * 4 + ch])) {
        changed++; const x = i % 64, y = Math.floor(i / 64);
        expect(rects.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h), `non_cloth:${x},${y}`).toBe(true);
      }
    }
    expect(changed).toBeGreaterThan(0);
    const visiblePalette = pattern.blockColors!.map(hex => {
      const rgb = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
      let count = 0;
      for (const part of parts) {
        const base = CLASSIC_LAYOUT[part].base.front, overlay = CLASSIC_LAYOUT[part].overlay.front;
        for (let y = 0; y < base.h; y++) for (let x = 0; x < base.w; x++) {
          const b = ((base.y + y) * 64 + base.x + x) * 4, o = ((overlay.y + y) * 64 + overlay.x + x) * 4;
          const at = after.rgba[o + 3] === 255 ? o : b;
          if (rgb.every((c, i) => after.rgba[at + i] === c)) count++;
        }
      }
      expect(count, `visible_palette:${hex}`).toBeGreaterThan(0);
      return { color: hex, visibleFrontPixels: count };
    });
    const out = freshAuditOutput("evaluation-artifacts/geometric-block-pattern-offline-20261010-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      const encoded = await encodePng(atlas); expect((await decodePng(encoded)).rgba).toEqual(atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      const front = renderSkinViews(atlas).find(v => v.name === "front")!.image;
      writeFileSync(`${out}/${name}-front.png`, await encodePng(scaleNearestNeighbor(front, 384, 576)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_D007_exact_baseline_pattern_only_replay", runId: run.runId,
      sourceSummarySha256: sha(bytes), sourcePngSha256: sha(png), providerCalls: 0,
      actualLivePngExactReplay: true, beforeRgbaSha256: sha(before.rgba), afterRgbaSha256: sha(after.rgba),
      earliestLoss: "NORMALIZED_PRESERVED_PLAN_LOST", pattern, visiblePalette, changedPixels: changed,
      unrelatedPixelDiff: 0, alphaUnchanged: true, craftPass: true, finalAtlasPass: true,
      missingPromptsReconstructed: false, analysisOrOtherParametersChanged: false,
      freshLiveDeliveryVerified: false, unresolved: ["primary_sleeve_observation", "invalid_localization"] }, null, 2), { flag: "wx" });
    expect(JSON.stringify([saved, t])).toBe(immutable);
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("GEOMETRIC_BLOCK_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
