import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralSourceAtlas } from "../src/generate";
import { composeReferenceStyleAtlas } from "../src/referenceStyleRenderer";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { buildReferenceCraftPlan, validateReferenceAtlasCraft } from "../src/referenceCraftPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { freshAuditOutput } from "./freshAuditOutput";
import { historicalLooseHairCollision } from "./historicalLooseHairCollision";

const sha = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex");
it("restores only root-connected rear hair in the saved A001 plan without changing its belt or source contract", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-pastel-patch-20261011-001";
    const bytes = readFileSync(`${sourceRoot}/summary.json`), png = readFileSync(`${sourceRoot}/skin.png`);
    expect(sha(bytes)).toBe("2087712629e1f730296e371a0f522d1df0c41723b079bd7314e8d2ab6dbc92ec");
    expect(sha(png)).toBe("ffc0e7242d3a19042ad7328666f24edec6fdbc4b22d0b1b4caafb18079fa62d2");
    const e = JSON.parse(bytes.toString()).currentDefaultE2E, t = e.result.propagationTrace;
    const p = t.skinPlan.skinPlan, d = t.referenceStyle.design, params = t.injectedParameters;
    const immutable = JSON.stringify(t), style = params.faceStyle;
    const base = buildProceduralSourceAtlas(params.features, style, p)!;
    const before = await decodePng(png);
    const historical = historicalLooseHairCollision();
    try { expect(composeReferenceStyleAtlas(base, p, d, style).atlas.rgba).toEqual(before.rgba); }
    finally { historical.mockRestore(); }
    const after = composeReferenceStyleAtlas(base, p, d, style);
    const selected = selectReferenceStyleAtlas(base, p, d, style).selected!;
    expect(selected).toBeTruthy(); expect(selected.composition.atlas.rgba).toEqual(after.atlas.rgba);
    expect(composeReferenceStyleAtlas(base, p, d, style).atlas.rgba).toEqual(after.atlas.rgba);
    expect(after.diagnostic.looseHair).toMatchObject({ rows: 8, frontEvidence: null,
      rearEvidence: "source_supported_unseen_completion", occlusion: { accessoryPixels: 4, disconnectedPixels: 0 } });
    expect(after.diagnostic.looseHair.points).toHaveLength(40);
    const back = CLASSIC_LAYOUT.body.base.back;
    const allowed = new Set(after.diagnostic.looseHair.points.map(c => (back.y + c.y) * 64 + back.x + c.x));
    let changed = 0;
    for (let i = 0; i < 4096; i++) if ([0, 1, 2, 3].some(ch => before.rgba[i * 4 + ch] !== after.atlas.rgba[i * 4 + ch])) {
      changed++; expect(allowed.has(i), `unexpected pixel ${i}`).toBe(true);
    }
    expect(changed).toBe(40);
    expect(after.diagnostic.constraints.violations).toEqual([]);
    expect(selected.quality.violations).toEqual([]);
    expect(validateFinalAtlas(after.atlas)).toEqual({ ok: true, problems: [] });
    expect(validateReferenceAtlasCraft(after.atlas, base, p, style, buildReferenceCraftPlan(p, d, after)).ok).toBe(true);
    const out = freshAuditOutput("evaluation-artifacts/rear-hair-occlusion-replay-20261011-");
    for (const [name, atlas] of [["before", before], ["after", after.atlas]] as const) {
      const encoded = await encodePng(atlas);
      expect((await decodePng(encoded)).rgba).toEqual(atlas.rgba);
      writeFileSync(`${out}/${name}.png`, encoded, { flag: "wx" });
      for (const v of renderSkinViews(atlas)) writeFileSync(`${out}/${name}-${v.name}.png`,
        await encodePng(scaleNearestNeighbor(v.image, v.image.width * 6, v.image.height * 6)), { flag: "wx" });
    }
    writeFileSync(`${out}/summary.json`, JSON.stringify({ sourceRoot, runId: e.runId, sourceSummarySha256: sha(bytes),
      providerCalls: 0, fullAnalysisReconstructed: false, freshLiveDeliveryVerified: false,
      mode: "saved_executable_plan_replay", historicalBaselineExact: true, changedPixels: changed,
      changedRegion: "body.base.back root-connected hair only", unrelatedPixels: 0, beltUnchanged: true,
      sourcePlanUnchanged: true, originalRows: 8, craftPass: true, atlasPass: true,
      beforeRgbaSha256: sha(before.rgba), afterRgbaSha256: sha(after.atlas.rgba),
      construction: after.diagnostic.looseHair }, null, 2), { flag: "wx" });
    expect(JSON.stringify(t)).toBe(immutable);
    expect(readFileSync(`${sourceRoot}/summary.json`)).toEqual(bytes); expect(readFileSync(`${sourceRoot}/skin.png`)).toEqual(png);
    expect(network).not.toHaveBeenCalled(); console.info("REAR_HAIR_OCCLUSION_REPLAY", out);
  } finally { network.mockRestore(); }
}, 60_000);
