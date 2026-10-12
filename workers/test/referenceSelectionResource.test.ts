// Saved/frozen inputs only; missing D008 analysis is not reconstructed.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { cpuUsage } from "node:process";
import { expect, it, vi } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import type { ReferenceStylePlan } from "../src/referenceStyleTemplates";
import { normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis, fallbackFeaturesToHex,
  buildFaceStyle, buildProceduralSourceAtlas } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { buildReferenceStylePlan } from "../src/referenceStyleTemplates";
import { selectReferenceStyleAtlas } from "../src/referenceStyleSelection";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
interface Input { id: string; source: SkinPlan; style: FaceStyle; design: ReferenceStylePlan; baseline: NonNullable<ReturnType<typeof buildProceduralSourceAtlas>> }
it("profiles reference selection and pins every candidate verdict plus selected output", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  const session = new Session(); session.connect();
  try {
    const inputs: Input[] = [];
    const frozen = readFileSync("evaluation-artifacts/generalization-20260905/annotations.json");
    const fixtures: AnnotatedCase[] = JSON.parse(frozen.toString());
    for (const fixture of fixtures) {
      const raw = strictBoundaryAnalysisFromAnnotation(fixture).analysis;
      if (fixture.existing) raw.identityGeometry = parseIdentityGeometry(JSON.parse(readFileSync(
        `evaluation-artifacts/head-structure-iteration-final/${fixture.id}/metrics.json`, "utf8")).sourceGeometryAfter)!;
      const a = normalizeAnalysisForRendering(raw), source = buildSkinPlan(a);
      const features = refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures, a.renderHints.skinUndertone));
      const style = buildFaceStyle(a, features, source.hairPlan);
      inputs.push({ id: fixture.id, source, style, design: buildReferenceStylePlan(a), baseline: buildProceduralSourceAtlas(features, style, source)! });
    }
    const savedBytes = readFileSync("evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261010-007/summary.json");
    expect(sha(savedBytes)).toBe("052dd1dbb382c385f9fa50314b01f69bce36707a678a1467f119c473f3d77b70");
    const t = JSON.parse(savedBytes.toString()).currentDefaultE2E.result.propagationTrace;
    for (const variant of ["saved_D007", "D007_pattern_only_transfer"]) {
      const source: SkinPlan = structuredClone(t.skinPlan.skinPlan);
      if (variant !== "saved_D007") source.outfitPlan.upper.pattern = buildOutfitPlan({ ...t.primary, ...t.renderAnalysis,
        identityPrompt: "", outfitPrompt: "", negativePrompt: "" }).upper.pattern;
      const style: FaceStyle = t.injectedParameters.faceStyle;
      inputs.push({ id: variant, source, style, design: t.referenceStyle.design,
        baseline: buildProceduralSourceAtlas(t.injectedParameters.features, style, source)! });
    }
    await session.post("Profiler.enable"); await session.post("Profiler.setSamplingInterval", { interval: 500 });
    await session.post("Profiler.start");
    const cases = [];
    for (const input of inputs) {
      const { id, source, style, design, baseline } = input, immutable = sha(JSON.stringify(input));
      const wall = performance.now(), cpu = cpuUsage();
      const result = selectReferenceStyleAtlas(baseline, source, design, style), used = cpuUsage(cpu);
      expect(result.selected, id).not.toBeNull();
      cases.push({ id, inputHash: immutable, candidatesHash: sha(JSON.stringify(result.candidates)),
        renderAttempts: result.renderAttempts, designHash: sha(JSON.stringify(result.selected!.design)),
        selectedAtlasHash: sha(result.selected!.composition.atlas.rgba),
        selectedDiagnosticHash: sha(JSON.stringify(result.selected!.composition.diagnostic)),
        wallMs: performance.now() - wall, processCpuMs: (used.user + used.system) / 1000 });
      expect(sha(JSON.stringify(input)), id).toBe(immutable);
    }
    const { profile } = await session.post("Profiler.stop");
    const nodes = new Map(profile.nodes.map(n => [n.id, n.callFrame])), totals = new Map<string, number>();
    for (const [i, sample] of (profile.samples ?? []).entries()) {
      const frame = nodes.get(sample)!;
      const file = frame.url.replaceAll("\\", "/").split("/workers/")[1];
      // Persist aggregated local function timing only, no source text/profile payload.
      const key = file ? `${file}:${frame.lineNumber + 1}:${frame.functionName || "anonymous"}` : frame.functionName === "(garbage collector)" ? "garbage_collector" : "other_runtime";
      totals.set(key, (totals.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
    }
    const semantic = ({ wallMs: _wall, processCpuMs: _cpu, ...rest }: typeof cases[number]) => { void _wall; void _cpu; return rest; };
    const beforeBytes = readFileSync("evaluation-artifacts/reference-selection-resource-20261010-Iw5jPr/summary.json");
    expect(sha(beforeBytes)).toBe("e57e9c18a221815bd50251ce2e7b7faff5fee347173cd41bec5727d217db5825");
    const previous = JSON.parse(beforeBytes.toString());
    expect(cases.map(semantic)).toEqual(previous.cases.map(semantic));
    const out = freshAuditOutput("evaluation-artifacts/reference-selection-resource-20261010-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_local_node_sampling",
      providerCalls: 0, sourceSummaryHash: sha(savedBytes), annotationHash: sha(frozen), nodeVersion: process.version,
      selectionHash: sha(readFileSync("src/referenceStyleSelection.ts")),
      retentionHash: sha(readFileSync("src/referenceOutfitRetention.ts")), baselineSha256: sha(beforeBytes), cases,
      selfSamples: [...totals].map(([location, ms]) => ({ location, ms })).sort((a, b) => b.ms - a.ms),
      limitations: ["not recovered D008 input", "not remote CPU or peak memory", "sampling includes assertion overhead",
        "no inference of CPU versus memory failure from HTML 1102 alone"],
    }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info("REFERENCE_SELECTION_RESOURCE", out);
  } finally { session.disconnect(); network.mockRestore(); }
}, 120_000);
