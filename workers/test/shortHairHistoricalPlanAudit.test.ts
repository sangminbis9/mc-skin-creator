// Offline authored-unit diagnosis. Historical git source is read, never checked out.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { transform } from "esbuild";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildSkinPlan } from "../src/skinPlan";
import { normalizeAnalysisForRendering } from "../src/generate";
import type { buildOutfitPlan } from "../src/outfitIdentity";
import { historicalHairMaterialPlan } from "./historicalHairMaterial";
import { freshAuditOutput } from "./freshAuditOutput";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");
it("isolates the authored short-hair historical plan difference against an immutable outfit contract", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const revision = "94f02b19a7efb1e3205b47545ab68fe20a9420c2";
    const source = execFileSync("git", ["show", `${revision}:workers/src/outfitIdentity.ts`], { encoding: "utf8", windowsHide: true });
    expect(hash(source)).toBe("a7ea900bba5c29f46c53c46900f359ffaa7f2f4ec228a211c240a569eace1dcf");
    const compiled = await transform(source, { loader: "ts", format: "cjs", target: "es2022" });
    const module = { exports: {} as { buildOutfitPlan: typeof buildOutfitPlan } };
    // Repository-owned historical code with type-only imports; no runtime dependencies.
    expect(compiled.code).not.toMatch(/\brequire\(/);
    new Function("module", "exports", compiled.code)(module, module.exports);
    const previous = JSON.parse(readFileSync("evaluation-artifacts/reference-short-hair-20261005-fUleYs/results.json", "utf8"));
    const cases = [];
    for (const [id, fringeEdge, bangs, length] of [
      ["shaggy-side", "staggered", "side", "ear"], ["shaggy-straight", "staggered", "straight", "ear"],
      ["soft-blunt", "blunt", "straight", "ear"], ["soft-cropped", "wispy", "side", "cropped"],
    ] as const) {
      // Same fully authored inputs as referenceShortHair.test.ts, not photo evidence.
      const raw = makeAnalysis(), hair = `short brown straight hair with ${bangs} bangs and ${fringeEdge} fringe`;
      raw.observed = { ...raw.observed, hair, face: "smooth complexion and neutral expression", clothing: "black sweatshirt", accessories: "none" };
      raw.identityPrompt = hair; raw.outfitPrompt = raw.observed.clothing;
      raw.canonicalIdentity.overallImpression = hair;
      raw.canonicalIdentity.mustPreserve = [hair, "brown hair", "black sweatshirt"];
      raw.canonicalIdentity.features = [
        { feature: hair, category: "hair", priority: 5, confidence: "high", evidence: hair, targetRegions: ["head.front", "head.back"] },
        { feature: "brown hair", category: "hair", priority: 4, confidence: "high", evidence: "visible brown hair", targetRegions: ["head.front"] },
        { feature: raw.observed.face, category: "face", priority: 4, confidence: "high", evidence: raw.observed.face, targetRegions: ["head.front"] },
        { feature: raw.observed.clothing, category: "outfit", priority: 3, confidence: "high", evidence: raw.observed.clothing, targetRegions: ["torso.front"] },
      ];
      Object.assign(raw.renderHints, { overallHairLength: length, sideHairLength: "short", hairTexture: "straight", hairBackShape: "tapered", bangs, bangsLength: "short", fringeEdge, fringeOpening: "none", neckAccessory: "none" });
      Object.assign(raw.fallbackFeatures, { hairstyle: "short", hairColor: "brown", glasses: "none", facialHair: "none", hat: "none", earrings: false, topType: "sweater", topColor: "black", expression: "neutral" });
      const analysis = normalizeAnalysisForRendering(raw), current = historicalHairMaterialPlan(buildSkinPlan(analysis));
      const oldOutfit = module.exports.buildOutfitPlan(analysis);
      const projected = { ...current, outfitPlan: oldOutfit };
      const changes: Array<{ path: string; before: unknown; after: unknown }> = [];
      function diff(a: unknown, b: unknown, path: string) {
        if (JSON.stringify(a) === JSON.stringify(b)) return;
        if (a && b && typeof a === "object" && typeof b === "object") {
          const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
          for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) diff(x[key], y[key], `${path}.${key}`);
        } else changes.push({ path, before: a, after: b });
      }
      diff(oldOutfit, current.outfitPlan, "outfitPlan");
      cases.push({ id, currentHash: hash(JSON.stringify(current)), projectedHash: hash(JSON.stringify(projected)),
        expectedHash: previous.cases.find((c: { id: string }) => c.id === id).sourceHash, changes });
    }
    const out = freshAuditOutput("evaluation-artifacts/short-hair-historical-plan-audit-20261010-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ providerCalls: 0, revision, historicalSourceHash: hash(source), cases }, null, 2), { flag: "wx" });
    console.info("SHORT_HAIR_PLAN_AUDIT", out);
    for (const c of cases) {
      expect(c.projectedHash, c.id).toBe(c.expectedHash);
      expect(c.changes).toEqual([
        { path: "outfitPlan.upper.leftSleeve.source", before: "observed", after: "strongly_implied" },
        { path: "outfitPlan.upper.rightSleeve.source", before: "observed", after: "strongly_implied" },
        { path: "outfitPlan.upper.pattern.evidence", before: "", after: "black sweatshirt" },
        { path: "outfitPlan.provenance.2.source", before: "observed", after: "strongly_implied" },
        { path: "outfitPlan.provenance.2.confidence", before: 0.85, after: 0.58 },
      ]);
    }
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});
