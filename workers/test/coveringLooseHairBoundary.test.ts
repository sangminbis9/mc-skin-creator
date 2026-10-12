// Offline diagnosis: distinguish full head covering from bounded hat ownership.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { buildSkinPlan, type SkinPlan } from "../src/skinPlan";
import { resolveHeadOwnership } from "../src/headOwnership";
import { buildFaceStyle, fallbackFeaturesToHex } from "../src/generate";
import { buildReferenceStylePlan, type ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { buildReferenceLooseHair } from "../src/referenceLooseHair";
import type { FaceStyle } from "../src/skinPack";
import { makeAnalysis } from "./helpers";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");

it("rejects the blanket-hat-block hypothesis for saved D005 without inventing front drape", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  try {
    const path = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-005/summary.json";
    const bytes = readFileSync(path);
    expect(sha(bytes)).toBe("c68f89606fd8bbd98a0936a4809a9e5628c8d9533d6ee5dba0dc550675f4efa3");
    const t = JSON.parse(bytes.toString()).currentDefaultE2E.result.propagationTrace;
    const a = { ...t.primary, ...t.renderAnalysis } as PhotoAnalysis;
    const p: SkinPlan = structuredClone(t.skinPlan.skinPlan);
    p.headIdentityPlan.ownership = resolveHeadOwnership(a, p.hairPlan, p.facePixelPlan);
    const design: ReferenceStylePlan = t.referenceStyle.design, style: FaceStyle = t.injectedParameters.faceStyle;
    const immutable = JSON.stringify(p);
    expect(p.headIdentityPlan.ownership.covering).toBe(false);
    expect(p.headIdentityPlan.ownership.cells.some(c => c.owner === "covering")).toBe(true);
    expect(p.headIdentityPlan.ownership.execution).toBe("resolved");
    expect(design.drape).toMatchObject({ eligible: false, rearCompletion: "source_supported" });
    const ownedRearRoots = p.headIdentityPlan.ownership.cells.filter(c => c.layer === "base" && c.face === "back"
      && c.y === 7 && c.owner === "hair_base" && c.x >= 1 && c.x <= 6).map(c => c.x).sort();
    expect(ownedRearRoots).toEqual([1, 2, 3, 4, 5, 6]);
    const current = buildReferenceLooseHair(p, design, style);
    expect(current.rearEvidence).toBe("source_supported_unseen_completion");
    expect(current.points.filter(c => c.face === "back")).toHaveLength(44);
    expect(current.frontEvidence).toBeNull();
    expect(current.points.filter(c => c.face === "front")).toEqual([]);
    expect(JSON.stringify(p)).toBe(immutable);
    expect(readFileSync(path)).toEqual(bytes);
    const out = freshAuditOutput("evaluation-artifacts/covering-loose-hair-boundary-20261010-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_saved_evidence_hypothesis_rejected",
      sourceSummarySha256: sha(bytes), fullCoveringFlag: false, hatOwnedCellsPresent: true, ownedRearRoots,
      currentBodyHairPoints: current.points.length, rearProvenance: current.rearEvidence, frontDrapeAuthorized: false,
      classification: "HAT_DOES_NOT_BLOCK_SUPPORTED_REAR_HAIR",
      frontBoundary: "saved design has no observed front-drape authorization; length is not substituted",
      productionChangeNeededForThisHypothesis: false, providerCalls: 0, sourceEvidenceChanged: false,
    }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
}, 60_000);

it.each(["cap", "beanie"] as const)("preserves explicit authored front locks below a %s", hat => {
  const a = makeAnalysis();
  a.observed.hair = "chest-length straight hair with bangs drapes over shoulders";
  a.observed.accessories = `blue ${hat}`;
  a.observed.clothing = "plain white top";
  a.fallbackFeatures.hat = hat;
  a.fallbackFeatures.hairstyle = "long";
  a.fallbackFeatures.glasses = "none";
  a.renderHints.hairAccessory = "none";
  a.renderHints.overallHairLength = "chest";
  a.renderHints.hairBackShape = "long";
  a.renderHints.sideHairLength = "shoulder";
  a.canonicalIdentity.features = [{ category: "hair", feature: a.observed.hair, evidence: a.observed.hair,
    confidence: "high", priority: 5, targetRegions: ["head.front", "head.back"] }];
  const p = buildSkinPlan(a), design = buildReferenceStylePlan(a);
  const style = buildFaceStyle(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone), p.hairPlan);
  expect(design.drape.eligible).toBe(true);
  expect(p.headIdentityPlan.ownership!.covering).toBe(false);
  expect(p.headIdentityPlan.ownership!.cells.some(c => c.owner === "covering")).toBe(true);
  const diagnostic = buildReferenceLooseHair(p, design, style);
  expect(diagnostic.frontEvidence).toBe("observed_shoulder_drape");
  expect(diagnostic.points.filter(c => c.face === "front")).toHaveLength(16);
});
