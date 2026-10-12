import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import type { SkinPlan } from "../src/skinPlan";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildProceduralSourceAtlas, refineFeatureColorsFromAnalysis } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";
import * as layeredCrown from "../src/referenceLayeredCrown";
import { makeAnalysis } from "./helpers";
import { referenceGarmentFoldPlan } from "../src/referenceGarmentFinish";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("verifies F016's actual gray hair and Gothic cross delivery with an exact saved-plan PNG replay", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-016";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("7a43795730df7086d472520a83ace44105f20dea8d896169428de5d7b8357653");
    expect(sha(png)).toBe("fa7b8dacd7bc9b15e7f9bef8f597935a5b75375629c6fa4c8b351a6881e51b0a");
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    const versions = readdirSync(root).filter(f => /^summary\.json\.checkpoint-\d+\.json$/.test(f)).sort();
    expect(versions).toHaveLength(69);
    for (const [i, f] of versions.entries()) {
      const c = JSON.parse(readFileSync(`${root}/${f}`, "utf8"));
      expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
      if (i === versions.length - 1) { expect(c.event).toBe("auditLifecycleFinalized"); expect(c.snapshot).toEqual(s); }
    }
    expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
      qSentCount: 1, wrapperExitCode: 0, wrapperCloseObserved: true, ptyExitObserved: true, ptyExitCode: 0,
      ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownerExitCode: 0,
      ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
      temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(e).toMatchObject({ httpStatus: 200, elapsedMs: 31189, generationPosts: 1, providerRetry: 0, accounting: "known", diskRecovery: true });
    expect(r.bindingAttempts).toEqual([
      { stage: "geminiPrimary", started: true, completion: "returned", elapsedMs: 15445, httpStatus: 200,
        deadlineMs: 45000, schemaSha256: "935e78cdc850ff234281e23020e3547ee8999fd06d2f51f2950f955366372986" },
      { stage: "faceGeometry", started: true, completion: "returned", elapsedMs: 12638, httpStatus: null,
        deadlineMs: 25000, schemaSha256: "3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469" },
    ]);
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.localization.status).toBe("VALID");
    expect(r.diagnostics.geometry).toMatchObject({ providerShapePass: true, semanticPass: true, errors: [] });
    expect(Object.values(e.propagationLink).every(v => v === true)).toBe(true);
    expect(Object.values(s.prohibited).every(v => v === 0)).toBe(true);
    expect(t.primary.observed.clothing).toBe(t.renderAnalysis.observed.clothing);
    expect(t.primary.observed.clothing).toContain("large tonal black gothic cross graphic on the center chest");
    const saved: SkinPlan = t.skinPlan.skinPlan, params = t.injectedParameters, design = t.referenceStyle.design;
    expect(saved.outfitPlan.upper.pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross",
      color: "#242326", source: "observed", surfaceParts: ["body"] });
    expect(params.features.hairColor).toBe("#9a9a9a"); expect(params.faceStyle.hairColor).toBe("#9a9a9a");
    const actual = await decodePng(png), out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-016-delivery-review-20261011-");
    const results = [];
    for (const mode of ["actual-live", "cross-shape-ablated"] as const) {
      const p = structuredClone(saved);
      if (mode !== "actual-live") delete p.outfitPlan.upper.pattern.graphicShape;
      const base = buildProceduralSourceAtlas(params.features, params.faceStyle, p)!;
      const composition = composeReferenceStyleAtlas(base, p, design, params.faceStyle);
      if (mode === "actual-live") {
        expect(composition.atlas.rgba).toEqual(actual.rgba);
        expect(selectReferenceStyleAtlas(base, p, design, params.faceStyle).selected!.composition.atlas.rgba).toEqual(actual.rgba);
        expect(validateReferenceAtlasCraft(composition.atlas, base, p, params.faceStyle,
          buildReferenceCraftPlan(p, design, composition)).ok).toBe(true);
      }
      let changed = 0; const front = CLASSIC_LAYOUT.body.base.front;
      for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(c => actual.rgba[i * 4 + c] !== composition.atlas.rgba[i * 4 + c])) {
        changed++; expect(i % 64 >= front.x && i % 64 < front.x + front.w
          && Math.floor(i / 64) >= front.y && Math.floor(i / 64) < front.y + front.h).toBe(true);
        expect(composition.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
      }
      if (mode !== "actual-live") expect(changed).toBeGreaterThan(0);
      expect(validateFinalAtlas(composition.atlas)).toEqual({ ok: true, problems: [] });
      results.push({ mode, changedPixels: changed, rgbaSha256: sha(composition.atlas.rgba), atlasPass: true });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, runId: e.runId, sourceSummarySha256: sha(bytes),
      actualPngExactReplay: true, checkpointIntegrity: true, currentGrayHairLiveDelivered: true,
      newAttachmentFixLiveVerified: true, observedAttachment: saved.outfitPlan.upper.pattern.evidence,
      primaryValidationPass: true, geometryShapeAndSemanticPass: true, liveGeminiPrimary: 1, liveGemmaFallback: 0,
      liveGemmaGeometry: 1, retry: 0, offlineProviderCalls: 0, unrelatedPixels: 0, alphaChanges: 0,
      fullAnalysisReconstructed: false, results }, null, 2), { flag: "wx" });
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("F016_DELIVERY_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);
it("isolates F015's observed centered Gothic cross without changing its delivered gray hair or other saved plans", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const root = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-015";
    const bytes = readFileSync(`${root}/summary.json`), png = readFileSync(`${root}/skin.png`);
    expect(sha(bytes)).toBe("d07e7e349cd44db92d05918bbdd47e86e999fe115f67eae964f7eda5f85860a4");
    expect(sha(png)).toBe("4a03a7d65452019710123e863babb132e4944b304602d2809d372ab107bcca92");
    const e = JSON.parse(bytes.toString()).currentDefaultE2E, t = e.result.propagationTrace;
    const saved: SkinPlan = t.skinPlan.skinPlan, params = t.injectedParameters, design = t.referenceStyle.design;
    const immutable = JSON.stringify(t), actual = await decodePng(png);
    expect(t.primary.observed.clothing).toBe(t.renderAnalysis.observed.clothing);
    expect(params.features.hairColor).toBe("#9a9a9a");
    expect(params.faceStyle.hairColor).toBe("#9a9a9a");
    expect(saved.outfitPlan.upper.pattern.graphicShape).toBeUndefined();
    // Complete authored parser carrier; no missing live context reconstruction.
    const carrier = makeAnalysis(); carrier.observed.clothing = t.renderAnalysis.observed.clothing;
    carrier.visibleRegions.upperBody = t.renderAnalysis.visibleRegions.upperBody;
    carrier.renderHints.outerGarment = t.renderAnalysis.renderHints.outerGarment;
    carrier.renderHints.garmentTexture = t.renderAnalysis.renderHints.garmentTexture;
    carrier.fallbackFeatures = structuredClone(t.primary.fallbackFeatures); carrier.outfitPrompt = "";
    const recovered = buildOutfitPlan(carrier).upper.pattern;
    expect(recovered).toMatchObject({ graphicShape: "cross", color: "#242326", source: "observed", surfaceParts: ["body"] });
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-015-attachment-review-20261011-");
    const results = [];
    for (const mode of ["actual-live", "offline-attachment-after"] as const) {
      const p = structuredClone(saved);
      if (mode !== "actual-live") p.outfitPlan.upper.pattern = recovered;
      const base = buildProceduralSourceAtlas(params.features, params.faceStyle, p)!;
      const composition = composeReferenceStyleAtlas(base, p, design, params.faceStyle);
      expect(selectReferenceStyleAtlas(base, p, design, params.faceStyle).selected!.composition.atlas.rgba).toEqual(composition.atlas.rgba);
      if (mode === "actual-live") expect(composition.atlas.rgba).toEqual(actual.rgba);
      let changed = 0;
      const front = CLASSIC_LAYOUT.body.base.front;
      for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(c => actual.rgba[i * 4 + c] !== composition.atlas.rgba[i * 4 + c])) {
        changed++;
        expect(i % 64 >= front.x && i % 64 < front.x + front.w
          && Math.floor(i / 64) >= front.y && Math.floor(i / 64) < front.y + front.h).toBe(true);
        expect(composition.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
      }
      if (mode !== "actual-live") expect(changed).toBeGreaterThan(0);
      expect(validateFinalAtlas(composition.atlas)).toEqual({ ok: true, problems: [] });
      expect(validateReferenceAtlasCraft(composition.atlas, base, p, params.faceStyle,
        buildReferenceCraftPlan(p, design, composition)).ok).toBe(true);
      writeFileSync(`${out}/${mode}.png`, await encodePng(composition.atlas), { flag: "wx" });
      const v = renderSkinViews(composition.atlas).find(v => v.name === "front")!;
      writeFileSync(`${out}/${mode}-front.png`, await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, changedPixels: changed, rgbaSha256: sha(composition.atlas.rgba), craftPass: true, atlasPass: true });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot: root, runId: e.runId,
      sourceSummarySha256: sha(bytes), actualPngExactReplay: true, classification: "NORMALIZED_PRESERVED_PLAN_LOST",
      currentGrayHairLiveDelivered: true, newAttachmentFixLiveVerified: false,
      observedAttachment: recovered.evidence, recoveredPattern: recovered,
      fullAnalysisReconstructed: false, offlineProviderCalls: 0, unrelatedPixels: 0, alphaChanges: 0, results }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable);
    expect(readFileSync(`${root}/summary.json`)).toEqual(bytes); expect(readFileSync(`${root}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("F015_ATTACHMENT_REVIEW", out);
  } finally { network.mockRestore(); }
}, 60_000);
it("preserves F002 and replays the attached graphic / sleeve plan with exact changed-region accounting", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  // This pinned F002 comparison isolates the historical outfit/material change,
  // predating crown relief. Keep exact old pixels; current crown composition is
  // independently asserted by referenceLayeredCrown and F005 live recovery.
  const historicalCrown = vi.spyOn(layeredCrown, "retainLayeredCrownAccent").mockReturnValue(true);
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-002";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("830ab974ceeeb9608bcac42209de483702760ca5761527fd88710ebae0b53b3a");
    const e = JSON.parse(bytes.toString()).currentDefaultE2E, t = e.result.propagationTrace;
    const saved: SkinPlan = t.skinPlan.skinPlan, immutable = JSON.stringify(t), old = t.injectedParameters;
    const a: PhotoAnalysis = { ...t.primary, ...t.renderAnalysis };
    expect(t.primary.observed).toEqual(t.renderAnalysis.observed);
    expect(old.faceStyle.sleeveLength).toBe("long"); expect(saved.outfitPlan.upper.leftSleeve.length).toBe("short");
    expect(a.observed.clothing).toContain("black cross graphic on the center chest");
    expect(saved.outfitPlan.upper.pattern.kind).toBe("none");
    const resolved = buildOutfitPlan(a), colors = refineFeatureColorsFromAnalysis(a, old.features);
    expect(resolved.upper.leftSleeve).toMatchObject({ length: "long", source: "strongly_implied" });
    expect(resolved.upper.pattern).toMatchObject({ graphicShape: "cross", color: "#242326", surfaceParts: ["body"] });
    expect(resolved.outerLayer.regions).not.toContain("graphic_depth");
    const actual = await decodePng(png), root = freshAuditOutput("evaluation-artifacts/attached-chest-graphic-replay-20261011-");
    const results = [];
    for (const mode of ["before", "outfit-only", "cumulative"] as const) {
      const p = structuredClone(saved), features = { ...old.features }, style = { ...old.faceStyle }, design = t.referenceStyle.design;
      if (mode !== "before") {
        for (const key of ["leftSleeve", "rightSleeve"] as const) p.outfitPlan.upper[key] = structuredClone(resolved.upper[key]);
        p.outfitPlan.upper.pattern = structuredClone(resolved.upper.pattern);
        p.outfitPlan.outerLayer = structuredClone(resolved.outerLayer);
        p.outfitPlan.outerLayerRegions = [...resolved.outerLayerRegions];
        p.outfitPlan.provenance = p.outfitPlan.provenance.map(x => x.target === "upper.sleeves"
          ? resolved.provenance.find(y => y.target === "upper.sleeves")! : x);
      }
      if (mode === "cumulative") features.hairColor = style.hairColor = colors.hairColor;
      const base = buildProceduralSourceAtlas(features, style, p)!;
      const composed = composeReferenceStyleAtlas(base, p, design, style);
      if (mode === "before") expect(composed.atlas.rgba).toEqual(actual.rgba);
      else {
        const selected = selectReferenceStyleAtlas(base, p, design, style).selected!;
        expect(selected).toBeTruthy(); expect(selected.composition.atlas.rgba).toEqual(composed.atlas.rgba);
      }
      expect(composeReferenceStyleAtlas(base, p, design, style).atlas.rgba).toEqual(composed.atlas.rgba);
      expect(validateFinalAtlas(composed.atlas)).toEqual({ ok: true, problems: [] });
      const craft = validateReferenceAtlasCraft(composed.atlas, base, p, style, buildReferenceCraftPlan(p, design, composed));
      expect(craft.ok, JSON.stringify(craft)).toBe(true);
      const parts = mode === "cumulative" ? ["head", "body", "rightArm", "leftArm"] as const : ["body", "rightArm", "leftArm"] as const;
      const allowed = parts.flatMap(k => [...Object.values(CLASSIC_LAYOUT[k].base), ...Object.values(CLASSIC_LAYOUT[k].overlay)]);
      let changed = 0;
      for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== composed.atlas.rgba[i * 4 + ch])) {
        changed++; const x = i % 64, y = Math.floor(i / 64);
        expect(allowed.some(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h), `outside:${mode}:${i}`).toBe(true);
      }
      if (mode !== "before") expect(changed).toBeGreaterThan(0);
      expect(p.facePixelPlan).toEqual(saved.facePixelPlan); expect(p.hairPlan).toEqual(saved.hairPlan);
      expect(p.headIdentityPlan).toEqual(saved.headIdentityPlan); expect(p.outfitPlan.lower).toEqual(saved.outfitPlan.lower);
      const encoded = await encodePng(composed.atlas); expect((await decodePng(encoded)).rgba).toEqual(composed.atlas.rgba);
      writeFileSync(`${root}/${mode}.png`, encoded, { flag: "wx" });
      for (const v of renderSkinViews(composed.atlas)) writeFileSync(`${root}/${mode}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, changed, unrelatedPixels: 0, craftPass: true, atlasPass: true, rgbaSha256: sha(composed.atlas.rgba),
        sleeve: p.outfitPlan.upper.leftSleeve, pattern: p.outfitPlan.upper.pattern, hairColor: style.hairColor });
    }
    writeFileSync(`${root}/summary.json`, JSON.stringify({ sourceRoot, sourceSummarySha256: sha(bytes), runId: e.runId,
      providerCalls: 0, mode: "offline_saved_plan_contract_transfer_not_live", actualPngExactBaseline: true,
      fullAnalysisReconstructed: false, freshLiveDeliveryVerified: false, originalPrimarySleeve: a.fallbackFeatures.sleeveLength,
      sleeveClassification: "PARAMETER_PRESERVED_PLAN_LOST", sleeveProvenance: "strongly_implied_not_observed_length",
      graphicClassification: "NORMALIZED_PRESERVED_PLAN_LOST", results }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("ATTACHED_CHEST_REPLAY", root);
  } finally { historicalCrown.mockRestore(); network.mockRestore(); }
}, 90_000);

it("recovers F013 gray delivery and replays only its rejected existing chest attachment offline", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-013";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("9d0dfe7f86e32e83d4b0d13caeb3ceb5852a91c852f6a6a47bc47714e66a3c25");
    expect(sha(png)).toBe("695fd4b0d19cd873e5fa6308a6c14d74bd6bcfb838f19c7876dd4ea114b27412");
    const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E, r = e.result, t = r.propagationTrace;
    expect(e).toMatchObject({ httpStatus: 200, elapsedMs: 38788, generationPosts: 1, providerRetry: 0, diskRecovery: true });
    expect(r.bindingAttempts.map((a: { stage: string }) => a.stage)).toEqual(["geminiPrimary", "gemmaPrimary"]);
    expect(r.bindingAttempts[0]).toMatchObject({ completion: "returned", httpStatus: 503 });
    expect(r.diagnostics.primaryValidation).toEqual({ providerShapePass: true, providerErrors: [], strictRuntimePass: true,
      strictErrors: [], normalizationPass: true, richValidationPass: true });
    expect(r.diagnostics.geometry).toBeNull(); expect(e.cropReplay.geometryAttemptObserved).toBe(false);
    expect(Object.values(e.propagationLink).every(v => v === true)).toBe(true);
    expect(s).toMatchObject({ qSentCount: 1, wrapperExitCode: 0, wrapperCloseObserved: true, ptyExitObserved: true,
      ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true, ownedProcessInventoryClean: true,
      cleanupFailed: false, temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false });
    expect(t.primary.observed.hair).toContain("ash-grey hair");
    expect(t.primary.observed.hair).toBe(t.renderAnalysis.observed.hair);
    expect(t.injectedParameters.features.hairColor).toBe("#9a9a9a");
    expect(t.injectedParameters.faceStyle.hairColor).toBe("#9a9a9a");
    expect(t.primary.fallbackFeatures.hairColor).toBe("dark-brown");
    const saved: SkinPlan = t.skinPlan.skinPlan, params = t.injectedParameters, design = t.referenceStyle.design;
    const actual = await decodePng(png), immutable = JSON.stringify(t);
    expect(actual.width).toBe(64); expect(actual.height).toBe(64);
    expect(t.primary.observed.clothing).toBe(t.renderAnalysis.observed.clothing);
    expect(t.primary.observed.clothing).toContain("matte black graphic of a stylized cross on the center chest");
    expect(saved.outfitPlan.upper.pattern.kind).toBe("none"); expect(saved.outfitPlan.upper.leftSleeve.length).toBe("short");
    // This complete authored carrier exercises only the observation parser.
    // It is not reconstructed live PhotoAnalysis: missing prompts/identity are
    // not used, and only the rejected attachment's existing consumers transfer.
    const carrier = makeAnalysis(); carrier.observed.clothing = t.renderAnalysis.observed.clothing;
    carrier.visibleRegions.upperBody = t.renderAnalysis.visibleRegions.upperBody;
    carrier.renderHints.outerGarment = t.renderAnalysis.renderHints.outerGarment;
    carrier.renderHints.garmentTexture = t.renderAnalysis.renderHints.garmentTexture;
    carrier.fallbackFeatures = structuredClone(t.primary.fallbackFeatures); carrier.outfitPrompt = "";
    const recovered = buildOutfitPlan(carrier);
    expect(recovered.upper.pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross", color: "#242326", source: "observed" });
    expect(recovered.upper.leftSleeve).toMatchObject({ length: "long", source: "strongly_implied" });
    const out = freshAuditOutput("evaluation-artifacts/reference-gray-hoodie-013-delivery-review-20261011-");
    const results = [];
    for (const mode of ["actual-live", "offline-attachment-after"] as const) {
      const p = structuredClone(saved);
      if (mode !== "actual-live") {
        p.outfitPlan.upper.pattern = recovered.upper.pattern;
        p.outfitPlan.upper.leftSleeve = recovered.upper.leftSleeve;
        p.outfitPlan.upper.rightSleeve = recovered.upper.rightSleeve;
        expect(recovered.outerLayer.regions).toContain("cuffs");
        if (!p.outfitPlan.outerLayer.regions.includes("cuffs")) p.outfitPlan.outerLayer.regions.push("cuffs");
      }
      const base = buildProceduralSourceAtlas(params.features, params.faceStyle, p)!;
      const composition = composeReferenceStyleAtlas(base, p, design, params.faceStyle);
      expect(selectReferenceStyleAtlas(base, p, design, params.faceStyle).selected!.composition.atlas.rgba).toEqual(composition.atlas.rgba);
      if (mode === "actual-live") expect(composition.atlas.rgba).toEqual(actual.rgba);
      const allowed = [CLASSIC_LAYOUT.body.base.front,
        ...Object.values(CLASSIC_LAYOUT.leftArm.base), ...Object.values(CLASSIC_LAYOUT.leftArm.overlay),
        ...Object.values(CLASSIC_LAYOUT.rightArm.base), ...Object.values(CLASSIC_LAYOUT.rightArm.overlay)];
      let changed = 0;
      for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(c => actual.rgba[i * 4 + c] !== composition.atlas.rgba[i * 4 + c])) {
        changed++; const x = i % 64, y = Math.floor(i / 64);
        expect(allowed.some(b => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)).toBe(true);
      }
      if (mode !== "actual-live") expect(changed).toBeGreaterThan(0);
      expect(validateFinalAtlas(composition.atlas)).toEqual({ ok: true, problems: [] });
      expect(validateReferenceAtlasCraft(composition.atlas, base, p, params.faceStyle,
        buildReferenceCraftPlan(p, design, composition)).ok).toBe(true);
      writeFileSync(`${out}/${mode}.png`, await encodePng(composition.atlas), { flag: "wx" });
      for (const v of renderSkinViews(composition.atlas)) writeFileSync(`${out}/${mode}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, changedPixels: changed, rgbaSha256: sha(composition.atlas.rgba), craftPass: true, atlasPass: true });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot, runId: e.runId, summarySha256: sha(bytes), pngSha256: sha(png),
      currentGrayHairLiveDelivered: true, priorSlashAliasRepeatedLive: false, actualPngExactReplay: true,
      classification: "NORMALIZED_PRESERVED_PLAN_LOST", observedAttachment: "matte black graphic of a stylized cross on the center chest",
      sleevesProvenance: "existing_strongly_implied_pullover_rule_not_observed_length", offlineProviderCalls: 0,
      newAttachmentFixLiveVerified: false, fullAnalysisReconstructed: false, unrelatedPixels: 0, results }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("F013_DELIVERY_REVIEW", out);
  } finally { network.mockRestore(); }
}, 90_000);

it("replays only the F011 observed emblem pattern while preserving every other saved plan and live byte", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261011-011";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("7fc5628e3a5c1180f15a2031a15c924702fb709ff5cb782b109d3f0f94fd56a5");
    expect(sha(png)).toBe("45820cb806fdfd8a43c9ed3d3a1c7a6d922a87b39f4b14c1c3a9587da02815cf");
    const e = JSON.parse(bytes.toString()).currentDefaultE2E, t = e.result.propagationTrace;
    const p: SkinPlan = t.skinPlan.skinPlan, immutable = JSON.stringify(t), params = t.injectedParameters;
    expect(t.primary.observed.clothing).toBe(t.renderAnalysis.observed.clothing);
    expect(t.primary.observed.clothing).toContain("tonal dark cross emblem printed/embossed on the center chest");
    expect(p.outfitPlan.upper.pattern.kind).toBe("none");
    // Complete authored carrier for the bounded observed-clothing parser only.
    // Do not reconstruct omitted live prompts or rebuild the whole analysis.
    const carrier = makeAnalysis();
    carrier.observed.clothing = t.primary.observed.clothing;
    carrier.visibleRegions.upperBody = t.primary.visibleRegions.upperBody;
    carrier.renderHints.outerGarment = t.primary.renderHints.outerGarment;
    carrier.renderHints.garmentTexture = t.primary.renderHints.garmentTexture;
    carrier.outfitPrompt = "";
    const pattern = buildOutfitPlan(carrier).upper.pattern;
    expect(pattern).toMatchObject({ kind: "center_graphic", graphicShape: "cross", color: "#242326",
      surfaceParts: ["body"], source: "observed" });
    // Unrelated authored context cannot supply the symbol/color/placement.
    carrier.outfitPrompt = "white shirt with blue stripes";
    carrier.fallbackFeatures.topAccentColor = "red";
    expect(buildOutfitPlan(carrier).upper.pattern).toEqual(pattern);
    const actual = await decodePng(png), out = freshAuditOutput("evaluation-artifacts/tonal-emblem-saved-plan-replay-20261011-");
    const results = [];
    for (const mode of ["before", "pattern-only"] as const) {
      const plan = structuredClone(p);
      if (mode === "pattern-only") plan.outfitPlan.upper.pattern = structuredClone(pattern);
      const base = buildProceduralSourceAtlas(params.features, params.faceStyle, plan)!;
      const composition = composeReferenceStyleAtlas(base, plan, t.referenceStyle.design, params.faceStyle);
      const selected = selectReferenceStyleAtlas(base, plan, t.referenceStyle.design, params.faceStyle).selected!;
      expect(selected).toBeTruthy(); expect(selected.composition.atlas.rgba).toEqual(composition.atlas.rgba);
      if (mode === "before") expect(composition.atlas.rgba).toEqual(actual.rgba);
      const chest = CLASSIC_LAYOUT.body.base.front, changed: string[] = [];
      for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => actual.rgba[i * 4 + ch] !== composition.atlas.rgba[i * 4 + ch])) {
        const x = i % 64 - chest.x, y = Math.floor(i / 64) - chest.y;
        expect(x >= 0 && x < chest.w && y >= 0 && y < chest.h).toBe(true);
        expect(composition.atlas.rgba[i * 4 + 3]).toBe(actual.rgba[i * 4 + 3]);
        changed.push(`${x}:${y}`);
      }
      if (mode === "pattern-only") {
        const ink = Array.from({ length: 6 }, (_, y) => [`3:${y + 3}`, `4:${y + 3}`]).flat().concat(["2:5", "5:5"]);
        // Existing reference finish excludes a printed torso face from plain
        // cloth folds. The 10 removed front folds are a known pattern consumer,
        // not unexplained renderer drift or permission to change other surfaces.
        const removedFolds = referenceGarmentFoldPlan(p.outfitPlan)
          .filter(f => f.part === "body" && f.face === "front").map(f => `${f.x}:${f.y}`);
        expect(removedFolds).toHaveLength(10);
        expect(referenceGarmentFoldPlan(plan.outfitPlan).some(f => f.part === "body" && f.face === "front")).toBe(false);
        expect(changed.sort()).toEqual([...new Set([...ink, ...removedFolds])].sort());
      }
      const restored = structuredClone(plan); restored.outfitPlan.upper.pattern = structuredClone(p.outfitPlan.upper.pattern);
      expect(restored).toEqual(p);
      expect(validateFinalAtlas(composition.atlas)).toEqual({ ok: true, problems: [] });
      expect(validateReferenceAtlasCraft(composition.atlas, base, plan, params.faceStyle,
        buildReferenceCraftPlan(plan, t.referenceStyle.design, composition)).ok).toBe(true);
      const encoded = await encodePng(composition.atlas);
      expect((await decodePng(encoded)).rgba).toEqual(composition.atlas.rgba);
      writeFileSync(`${out}/${mode}.png`, encoded, { flag: "wx" });
      for (const v of renderSkinViews(composition.atlas)) writeFileSync(`${out}/${mode}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
      results.push({ mode, changedPixels: changed.length, unrelatedPixels: 0, alphaChanges: 0,
        craftPass: true, atlasPass: true, rgbaSha256: sha(composition.atlas.rgba) });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot, summarySha256: sha(bytes), runId: e.runId,
      classification: "NORMALIZED_PRESERVED_PLAN_LOST", evidence: "tonal dark cross emblem printed/embossed on the center chest",
      mode: "offline_saved_plan_pattern_transfer", actualPngExactBaseline: true,
      fullAnalysisReconstructed: false, freshLiveDeliveryVerified: false, providerCalls: 0, results }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable); expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes);
    expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png); expect(network).not.toHaveBeenCalled();
    console.info("TONAL_EMBLEM_REPLAY", out);
  } finally { network.mockRestore(); }
}, 90_000);
