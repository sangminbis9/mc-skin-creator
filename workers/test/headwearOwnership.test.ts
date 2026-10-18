import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { resolveHeadOwnership } from "../src/headOwnership";
import { buildFaceStyle, buildProceduralSourceAtlas, fallbackFeaturesToHex } from "../src/generate";
import { renderReferencePrimaryAtlas } from "../src/referencePrimaryRenderer";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas, validateAtlasCraftFoundation } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import type { PhotoAnalysis } from "../src/analysis";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function input(hat: "none" | "cap" | "beanie" | "headscarf") {
  const a = makeAnalysis();
  a.observed.hair = "Long straight brown hair with bangs and shoulder side locks";
  a.observed.accessories = hat === "none" ? "No hat" : `A blue ${hat}`;
  a.fallbackFeatures.hat = hat; a.fallbackFeatures.hatColor = "blue";
  a.fallbackFeatures.hairstyle = "long"; a.renderHints.hairTexture = "straight";
  a.renderHints.overallHairLength = "chest"; a.renderHints.hairBackShape = "long";
  a.renderHints.sideHairLength = "shoulder"; a.renderHints.bangs = "straight";
  a.renderHints.hairAccessory = "none";
  return a;
}

it.each(["cap", "beanie"] as const)("preserves a %s on a bounded foundation, with hair below and selective depth", hat => {
  const a = input(hat), p = buildSkinPlan(a), head = p.headIdentityPlan.ownership!;
  expect(head.execution).toBe("resolved");
  const cloth = head.cells.filter(c => c.owner === "covering");
  expect(cloth.length).toBeGreaterThan(0);
  expect(cloth.filter(c => c.face === "top" && c.layer === "base")).toHaveLength(64);
  expect(cloth.some(c => c.face === "bottom")).toBe(false);
  expect(cloth.some(c => c.face !== "top" && c.y > 2)).toBe(false);
  expect(head.cells.some(c => c.owner === "hair_base" && c.face === "back" && c.y >= 4)).toBe(true);
  const features = fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone);
  const style = buildFaceStyle(a, features, p.hairPlan), baseline = buildProceduralSourceAtlas(features, style, p)!;
  const foundation = validateAtlasCraftFoundation(baseline, style);
  expect(foundation.ok, JSON.stringify(foundation)).toBe(true);
  const result = renderReferencePrimaryAtlas(baseline, p, a, style);
  expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error(result.reason);
  expect(result.summary.status).toBe("reference_style_accepted");
  expect(result.summary.craftValidation).toBe("pass");
  expect(validateFinalAtlas(result.atlas).ok).toBe(true);
  const top = CLASSIC_LAYOUT.head.base.top;
  const colors = Array.from({ length: 64 }, (_, i) => {
    const at = ((top.y + Math.floor(i / 8)) * 64 + top.x + i % 8) * 4;
    return [...result.atlas.rgba.slice(at, at + 4)];
  });
  expect(colors.every(c => c[2] > c[0] && c[3] === 255)).toBe(true);
  expect(result.summary.constraints?.ok).toBe(true);
});

it("does not infer a cap from unrelated prose or convert neck scarves into hats", () => {
  const a = input("none"), original = buildSkinPlan(a).headIdentityPlan.ownership!;
  a.observed.clothing = "blue cap sleeve shirt and a neck scarf";
  a.observed.accessories = "scarf around the neck";
  expect(buildSkinPlan(a).headIdentityPlan.ownership).toEqual(original);
  expect(original.cells.some(c => c.owner === "covering")).toBe(false);
  const scarf = buildSkinPlan(input("headscarf")).headIdentityPlan.ownership!;
  expect(scarf.covering).toBe(true);
  expect(scarf.cells.some(c => c.owner === "covering")).toBe(true);
});

it("leaves real eyes and glasses above an unusually low headwear boundary", () => {
  const a = input("cap"), p = buildSkinPlan(a), face = structuredClone(p.facePixelPlan);
  const iris = face.pixels.find(c => c.role === "iris")!;
  face.pixels.push({ ...iris, x: 1, y: 1 });
  const owners = resolveHeadOwnership(a, p.hairPlan, face);
  expect(owners.cells.find(c => c.face === "front" && c.layer === "base" && c.x === 1 && c.y === 1)?.owner).toBe("face");
  expect(owners.cells.find(c => c.face === "front" && c.layer === "outer" && c.x === 1 && c.y === 1)?.owner).toBe("clear");
  face.glassesPlan.topology = "rectangular_thin";
  face.glassesPlan.framePixels = [{ face: "front", x: 1, y: 1, role: "rim_mid" }];
  expect(resolveHeadOwnership(a, p.hairPlan, face).cells.find(c => c.face === "front" && c.layer === "outer" && c.x === 1 && c.y === 1)?.owner).toBe("glasses");
});

it("replays D005 without altering observations, and changes only head pixels for repaired cap ownership", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-005";
    const bytes = readFileSync(`${root}/summary.json`), run = JSON.parse(bytes.toString()).currentDefaultE2E;
    expect(sha(bytes)).toBe("c68f89606fd8bbd98a0936a4809a9e5628c8d9533d6ee5dba0dc550675f4efa3");
    const trace = run.result.propagationTrace, saved: SkinPlan = trace.skinPlan.skinPlan;
    const analysis = { ...trace.primary, ...trace.renderAnalysis } as PhotoAnalysis;
    const original = JSON.stringify([analysis, saved]);
    const plan = structuredClone(saved);
    plan.headIdentityPlan.ownership = resolveHeadOwnership(analysis, plan.hairPlan, plan.facePixelPlan);
    expect(plan.headIdentityPlan.ownership.cells.some(c => c.owner === "covering")).toBe(true);
    expect(plan.hairPlan).toEqual(saved.hairPlan); expect(plan.facePixelPlan).toEqual(saved.facePixelPlan);
    expect(plan.outfitPlan).toEqual(saved.outfitPlan);
    const style = trace.injectedParameters.faceStyle, features = trace.injectedParameters.features;
    const historical = await decodePng(readFileSync(`${root}/skin.png`));
    const oldBaseline = buildProceduralSourceAtlas(features, style, saved)!;
    const before = composeReferenceStyleAtlas(oldBaseline, saved, trace.referenceStyle.design, style).atlas;
    // This historical PNG also predates the committed garment/face finishing.
    // Validate the saved artifact, then isolate head ownership with the same
    // current renderer on both sides of the comparison below.
    const headRects = [...Object.values(CLASSIC_LAYOUT.head.base), ...Object.values(CLASSIC_LAYOUT.head.overlay)];
    expect(validateFinalAtlas(historical).ok).toBe(true);
    const baseline = buildProceduralSourceAtlas(features, style, plan)!;
    const foundation = validateAtlasCraftFoundation(baseline, style);
    expect(foundation.ok, JSON.stringify(foundation)).toBe(true);
    const after = composeReferenceStyleAtlas(baseline, plan, trace.referenceStyle.design, style).atlas;
    expect(validateFinalAtlas(after).ok).toBe(true);
    const changed: number[] = [];
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(c => before.rgba[i * 4 + c] !== after.rgba[i * 4 + c])) {
      expect(headRects.some(r => i % 64 >= r.x && i % 64 < r.x + r.w && Math.floor(i / 64) >= r.y && Math.floor(i / 64) < r.y + r.h)).toBe(true);
      changed.push(i);
    }
    expect(changed.length).toBeGreaterThan(0);
    const production = renderReferencePrimaryAtlas(baseline, plan, analysis, style);
    expect(production.ok, JSON.stringify(production)).toBe(true); if (!production.ok) throw Error(production.reason);
    expect(production.summary.status).toBe("reference_style_accepted");
    expect(production.summary.craftValidation).toBe("pass");
    const output = freshAuditOutput("evaluation-artifacts/headwear-ownership-offline-20261010-");
    for (const [name, image] of [["before", before], ["after-same-design", after], ["after-production-selection", production.atlas]] as const) {
      writeFileSync(`${output}/${name}.png`, await encodePng(image), { flag: "wx" });
      for (const view of renderSkinViews(image)) writeFileSync(`${output}/${name}-${view.name}.png`,
        await encodePng(scaleNearestNeighbor(view.image, view.image.width * 4, view.image.height * 4)), { flag: "wx" });
    }
    writeFileSync(`${output}/summary.json`, JSON.stringify({ sourceRun: run.runId, sourceSummarySha256: sha(bytes),
      providerCalls: 0, sourceObservationUnchanged: true, changedHeadPixels: changed.length,
      beforeMatchesLive: false, intentionalHeadwearPresentation: "authored_crown_and_rim",
      unrelatedPixelChanges: 0, sameDesignRgbaSha256: sha(after.rgba), selectedRgbaSha256: sha(production.atlas.rgba),
      craft: production.summary.craftValidation, finalAtlas: validateFinalAtlas(production.atlas),
      remaining: ["provider_hatColor_black_conflicts_with_observed_light_blue", "pixel_pattern_plan_none"],
    }, null, 2), { flag: "wx" });
    expect(JSON.stringify([analysis, saved])).toBe(original);
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(network).not.toHaveBeenCalled();
    console.info("HEADWEAR_REVIEW", output);
  } finally { network.mockRestore(); }
}, 60_000);
