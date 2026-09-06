import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { observedTiedHair, headCellKey, quantizeTiedMassGeometry } from "../src/headOwnership";
import { applyHeadIdentityPlan, DEFAULT_FACE_STYLE } from "../src/skinPack";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { headCellOffset, traceHeadIntegration } from "../src/headIntegrationTrace";
import { makeAnalysis } from "./helpers";

const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
function tied() { const a = makeAnalysis(); a.observed.hair = "high brown bun with short sides"; a.canonicalIdentity.features = []; a.fallbackFeatures.hairstyle = "short"; a.fallbackFeatures.glasses = "none"; a.renderHints.hairAccessory = "none"; return a; }

describe("head identity integration contracts", () => {
  it("observed tied evidence wins over short fallback without modifying input", () => {
    const a = tied(), before = JSON.stringify(a), p = buildIdentityPixelPlans(a);
    expect(p.hairPlan.template).toBe("tied_bun");
    expect(p.headIdentityPlan.ownership?.tiedMass?.attachmentRegion).toBe("crown_back");
    expect(JSON.stringify(a)).toBe(before);
  });
  it("does not let a contradictory bald fallback erase an observed bun foundation", () => {
    const a = tied(); a.fallbackFeatures.hairstyle = "bald";
    const p = buildIdentityPixelPlans(a);
    expect(p.hairPlan.template).toBe("tied_bun");
    expect(p.hairPlan.lengthClass).not.toBe("none");
  });
  it("does not invent a bun or covering from negative evidence", () => {
    const a = tied(); a.observed.hair = "short hair without a high bun"; a.observed.accessories = "no headscarf"; a.fallbackFeatures.hat = "none";
    const p = buildIdentityPixelPlans(a);
    expect(p.headIdentityPlan.ownership?.tiedMass).toBeNull();
    expect(p.headIdentityPlan.ownership?.covering).toBe(false);
  });
  it("isolates body adjectives and accessories from head grammar", () => {
    const a = tied(); a.observed.hair = "short straight hair";
    const before = buildIdentityPixelPlans(a);
    a.canonicalIdentity.features = [{ category: "outfit", feature: "broad blazer, large bag, dread lock print, high bun logo", evidence: "body only", priority: 5, confidence: "high", targetRegions: ["torso.front"] }];
    a.canonicalIdentity.mustPreserve = ["large bag with a high bun logo"];
    expect(observedTiedHair(a)).toBe(false);
    const after = buildIdentityPixelPlans(a);
    expect(after.hairPlan.template).toBe(before.hairPlan.template);
    expect(after.hairPlan.structure.grammar).toBe(before.hairPlan.structure.grammar);
    expect(after.headIdentityPlan.ownership?.tiedMass).toBeNull();
  });
  it("does not let a round necklace reclassify thin rectangular glasses", () => {
    const a = tied(); a.fallbackFeatures.glasses = "regular";
    a.observed.accessories = "round necklace and thin rectangular glasses";
    expect(buildIdentityPixelPlans(a).headIdentityPlan.glasses.topology).toBe("rectangular_thin");
  });
  it("uses a narrow attachment and seam-matched front silhouette, not texture dots or a full shell", () => {
    const p = buildIdentityPixelPlans(tied()).headIdentityPlan.ownership!;
    const mass = p.cells.filter(c => c.owner === "tied_hair");
    expect(mass.length).toBeGreaterThanOrEqual(24);
    expect(new Set(mass.map(c => c.face))).toEqual(new Set(["top", "front", "back"]));
    expect(mass.filter(c => c.face === "front" && c.y === 0 && c.sourceGroupId === "tied-mass")).toHaveLength(2);
    expect(mass.filter(c => c.face === "front" && c.y === 1 && c.sourceGroupId === "tied-attachment")).toHaveLength(2);
    const attachmentBase = p.cells.filter(c => c.layer === "base" && c.sourceGroupId === "tied-attachment");
    expect(attachmentBase.length).toBeGreaterThan(0);
    expect(Math.max(...attachmentBase.filter(c => c.face === "front").map(c => c.x)) - Math.min(...attachmentBase.filter(c => c.face === "front").map(c => c.x)) + 1).toBe(2);
    expect(p.continuities.some(c => c.sourceGroupIds.includes("tied-mass"))).toBe(true);
    for (const face of ["top", "front", "back"] as const) expect(mass.filter(c => c.face === face).length).toBeLessThan(64);
    expect(mass.length).toBeLessThan(64);
  });
  it("quantizes high/low, size, and slight source bias without inventing asymmetry", () => {
    const geometry = (hair: string) => { const a = tied(); a.observed.hair = hair; return quantizeTiedMassGeometry(a); };
    expect(geometry("near-symmetric high bun")).toMatchObject({ position: "high_back", horizontalBias: "center", massWidth: 4, attachmentWidth: 2, verticalProminence: 2 });
    expect(geometry("small low bun at the nape")).toMatchObject({ position: "low_back", horizontalBias: "center", massWidth: 2, verticalProminence: 0 });
    expect(geometry("large bun slightly left-biased")).toMatchObject({ horizontalBias: "left", massWidth: 6 });
    expect(geometry("high bun slightly right-biased")).toMatchObject({ horizontalBias: "right", verticalProminence: 2 });
  });
  it("renders low/small and biased buns as bounded source-directed footprints", () => {
    const outer = (hair: string) => {
      const a = tied(); a.observed.hair = hair;
      return buildIdentityPixelPlans(a).headIdentityPlan.ownership!.cells.filter(c => c.owner === "tied_hair");
    };
    const high = outer("near-symmetric high bun"), low = outer("small low bun at the nape");
    expect(low.length).toBeLessThan(high.length);
    expect(low.some(c => c.face === "front")).toBe(false);
    expect(new Set(low.map(c => c.face))).toEqual(new Set(["top", "back"]));
    const centerTop = high.filter(c => c.face === "top");
    expect([...new Set(centerTop.map(c => c.x))].sort()).toEqual([...new Set(centerTop.map(c => 7 - c.x))].sort());
    const meanTopX = (cells: typeof high) => { const xs = cells.filter(c => c.face === "top" && c.sourceGroupId === "tied-mass").map(c => c.x); return xs.reduce((sum, x) => sum + x, 0) / xs.length; };
    expect(meanTopX(outer("high bun slightly left-biased"))).toBeLessThan(meanTopX(high));
    expect(meanTopX(outer("high bun slightly right-biased"))).toBeGreaterThan(meanTopX(high));
  });
  it("keeps every high tied outer cell in one physical surface component", () => {
    const p = buildIdentityPixelPlans(tied()).headIdentityPlan.ownership!;
    const mass = p.cells.filter(c => c.owner === "tied_hair");
    const keys = new Set(mass.map(headCellKey));
    const neighbors = new Map([...keys].map(key => [key, new Set<string>()]));
    for (const a of mass) for (const b of mass) if (a.face === b.face && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1) {
      neighbors.get(headCellKey(a))!.add(headCellKey(b));
    }
    for (const continuity of p.continuities) {
      const members = continuity.cells.filter(key => keys.has(key));
      for (const a of members) for (const b of members) if (a !== b) neighbors.get(a)!.add(b);
    }
    const reached = new Set<string>(), pending = [[...keys][0]];
    while (pending.length) { const key = pending.pop()!; if (reached.has(key)) continue; reached.add(key); pending.push(...neighbors.get(key)!); }
    expect(reached.size).toBe(keys.size);
  });
  it("pairs every resolved continuity with common material ownership", () => {
    const p = buildIdentityPixelPlans(tied()).headIdentityPlan.ownership!;
    const cells = new Map(p.cells.map(c => [headCellKey(c), c]));
    for (const g of p.continuities) {
      expect(g.cells.length).toBeGreaterThanOrEqual(2);
      expect(new Set(g.cells.map(k => cells.get(k)?.owner)).size).toBe(1);
      expect(g.cells.every(k => cells.get(k)?.continuityGroupId === g.id)).toBe(true);
    }
  });
  it("covering and face window supersede hair but keep glasses topology", () => {
    const a = tied(); a.fallbackFeatures.hat = "headscarf"; a.fallbackFeatures.glasses = "round"; a.observed.accessories = "round glasses and a headscarf";
    const p = buildIdentityPixelPlans(a).headIdentityPlan;
    expect(p.ownership?.covering).toBe(true);
    expect(p.ownership?.tiedMass).toBeNull();
    expect(p.ownership?.cells.some(c => c.owner === "hair_outer" || c.owner === "tied_hair")).toBe(false);
    expect(p.glasses.lensOpenings.length).toBe(2);
    for (const c of p.glasses.framePixels) expect(p.ownership?.cells.find(p => p.layer === "outer" && p.face === c.face && p.x === c.x && p.y === c.y)?.owner).toBe("glasses");
  });
  it("retains semantic wavy groups in resolved final ownership", () => {
    const a = tied(); a.observed.hair = "long wavy hair"; a.renderHints.hairTexture = "wavy"; a.renderHints.overallHairLength = "chest";
    const p = buildIdentityPixelPlans(a);
    expect(p.hairPlan.structure.source).toBe("semantic_analysis");
    expect(p.headIdentityPlan.ownership?.execution).toBe("resolved");
    expect(p.headIdentityPlan.ownership?.cells.some(c => c.sourceGroupId.startsWith("wavy_bands"))).toBe(true);
  });
  it("executes resolved ownership without changing body pixels and detects later overwrite", () => {
    const p = buildIdentityPixelPlans(tied());
    const atlas = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4).fill(120) };
    const body = CLASSIC_LAYOUT.body.base.front, at = (body.y * 64 + body.x) * 4;
    const bodyBefore = [...atlas.rgba.slice(at, at + 4)];
    applyHeadIdentityPlan(atlas, p.headIdentityPlan, p.hairPlan, [90, 60, 40], [180, 120, 90], { ...DEFAULT_FACE_STYLE, glasses: "none" });
    expect([...atlas.rgba.slice(at, at + 4)]).toEqual(bodyBefore);
    const checkpoint = { ...atlas, rgba: atlas.rgba.slice() };
    const point = p.headIdentityPlan.ownership!.cells.find(c => c.owner === "tied_hair")!;
    atlas.rgba.fill(0, headCellOffset(point), headCellOffset(point) + 4);
    const trace = traceHeadIntegration(p.headIdentityPlan, p.hairPlan, atlas, { after_authoritative_head: checkpoint });
    expect(trace.cues.find(c => c.cue === "tied_hair")?.missing).toBe(1);
    expect(trace.ownerDiffs.some(d => d.plannedOwner === "tied_hair")).toBe(true);
  });
  it.skipIf(!existsSync("evaluation-artifacts/head-integration-20260906/after/summary.json"))("keeps frozen analyses and previously approved subjects intact (local frozen assets)", async () => {
    const root = "evaluation-artifacts/head-integration-20260906";
    const before = JSON.parse(await readFile(`${root}/before/summary.json`, "utf8"));
    const after = JSON.parse(await readFile(`${root}/after/summary.json`, "utf8"));
    expect(before.accepted).toBe(9); expect(after.accepted).toBeGreaterThanOrEqual(11);
    for (const c of before.results) if (c.accepted) expect(after.results.find((r: { caseId: string }) => r.caseId === c.caseId).accepted).toBe(true);
    const manifest = JSON.parse(await readFile("evaluation-artifacts/generalization-20260905/frozen-manifest.json", "utf8"));
    for (const e of manifest.sources) {
      const stored = JSON.parse(await readFile(`evaluation-artifacts/generalization-20260905/after/${e.caseId}/analysis-and-plan.json`, "utf8"));
      expect(hash(JSON.stringify(stored.analysis))).toBe(e.adapterAnalysisHash);
    }
  });
});
