import { describe, expect, it } from "vitest";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import type { PhotoAnalysis } from "../src/analysis";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

function analysisWith(texture: PhotoAnalysis["renderHints"]["hairTexture"], hairText = "textured hair"): PhotoAnalysis {
  const base = makeAnalysis();
  return makeAnalysis({
    identityGeometry: makeIdentityGeometry(),
    observed: { ...base.observed, hair: hairText },
    renderHints: { ...base.renderHints, hairTexture: texture, overallHairLength: "shoulder", sideHairLength: "shoulder" },
  });
}

function isConnected(points: Array<{ face: string; layer: string; x: number; y: number }>): boolean {
  if (points.length < 2) return false;
  const keys = new Set(points.map((point) => `${point.face}:${point.layer}:${point.x},${point.y}`));
  const seen = new Set<string>();
  const queue = [points[0]];
  while (queue.length) {
    const point = queue.shift()!;
    const key = `${point.face}:${point.layer}:${point.x},${point.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const next = points.find((candidate) => candidate.face === point.face && candidate.layer === point.layer && candidate.x === point.x + dx && candidate.y === point.y + dy);
      if (next && !seen.has(`${next.face}:${next.layer}:${next.x},${next.y}`)) queue.push(next);
    }
  }
  return seen.size === keys.size;
}

describe("source-derived head structure", () => {
  it.each([
    ["straight", "straight_bands"],
    ["wavy", "wavy_bands"],
    ["curly", "curl_lobes"],
    ["coily", "coily_clusters"],
    ["straight", "lock_groups", "long grouped dreadlocks and locs"],
  ] as const)("maps %s hair to connected %s groups", (texture, grammar, text) => {
    const plan = buildIdentityPixelPlans(analysisWith(texture, text)).hairPlan.structure;
    expect(plan.grammar).toBe(grammar);
    expect(plan.groups.length).toBeGreaterThan(0);
    expect(plan.groups.every((group) => group.points.length === 1
      ? group.identityImportance >= 4 && ["fringe", "temple", "curl_lobe"].includes(group.kind)
      : isConnected(group.points))).toBe(true);
    expect(plan.groups.every((group) => group.points.length >= 1)).toBe(true);
  });

  it("changes row contours and groups when normalized silhouette geometry changes", () => {
    const base = analysisWith("wavy");
    const narrow = buildIdentityPixelPlans({
      ...base,
      identityGeometry: makeIdentityGeometry({
        headSilhouette: { ...makeIdentityGeometry().headSilhouette, sideVolumeLeft: 0.2, sideVolumeRight: 0.25, hairEndpointLeftY: 0.58, hairEndpointRightY: 0.62 },
      }),
    }).hairPlan;
    const broad = buildIdentityPixelPlans({
      ...base,
      identityGeometry: makeIdentityGeometry({
        headSilhouette: { ...makeIdentityGeometry().headSilhouette, sideVolumeLeft: 0.9, sideVolumeRight: 0.84, hairEndpointLeftY: 0.94, hairEndpointRightY: 0.9 },
      }),
    }).hairPlan;
    expect(narrow.headMask.widthByRow).not.toEqual(broad.headMask.widthByRow);
    expect(narrow.structure.groups.map((group) => group.points)).not.toEqual(broad.structure.groups.map((group) => group.points));
    expect(new Set(broad.headMask.widthByRow.left.filter(Boolean)).size).toBeGreaterThan(1);
  });

  it("preserves hairline openings, directed part, ear exposure, and base/outer ownership", () => {
    const plans = buildIdentityPixelPlans(analysisWith("straight"));
    const structure = plans.hairPlan.structure;
    expect(structure.fringe.openingColumns.length).toBeGreaterThan(0);
    expect(structure.partChannel.direction).toBe("right");
    expect(structure.partChannel.points.length).toBeGreaterThan(0);
    expect(plans.hairPlan.headMask.earExposure.left).toBeGreaterThan(0);
    expect(plans.headIdentityPlan.baseHairGroupIds.length).toBeGreaterThan(0);
    expect(plans.headIdentityPlan.outerHairGroupIds.length).toBeGreaterThan(0);
  });
});

describe("glasses topology", () => {
  const glasses = (accessories: string, glasses: PhotoAnalysis["fallbackFeatures"]["glasses"] = "regular") => {
    const base = makeAnalysis();
    return buildIdentityPixelPlans(makeAnalysis({
      identityGeometry: makeIdentityGeometry(),
      observed: { ...base.observed, accessories },
      fallbackFeatures: { ...base.fallbackFeatures, glasses },
    })).facePixelPlan.glassesPlan;
  };

  it("uses different real footprints for thin, heavy, round, rectangular, and oversized frames", () => {
    const thin = glasses("thin wire rectangular glasses");
    const heavy = glasses("thick bold rectangular glasses");
    const round = glasses("thin circular glasses", "round");
    const oversized = glasses("oversized coke bottle circular glasses", "round");
    expect(thin.topology).toBe("rectangular_thin");
    expect(heavy.topology).toBe("rectangular_heavy");
    expect(round.topology).toBe("round_thin");
    expect(oversized.topology).toBe("oversized");
    expect(thin.framePixels.length).toBeLessThan(heavy.framePixels.length);
    expect(new Set([thin, heavy, round, oversized].map((plan) => JSON.stringify(plan.framePixels))).size).toBe(4);
  });

  it("keeps two lens openings, a bridge, and side arms for thin glasses", () => {
    const plan = glasses("thin silver wire glasses");
    expect(plan.preserveThinness).toBe(true);
    expect(plan.lensOpenings).toHaveLength(2);
    expect(plan.framePixels.some((pixel) => pixel.role === "bridge")).toBe(true);
    expect(new Set(plan.sideArms.map((pixel) => pixel.face))).toEqual(new Set(["left", "right"]));
  });
});
