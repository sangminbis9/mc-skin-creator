import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { buildEyeApertureV2Request, EYE_APERTURE_V2_PROMPT, EYE_APERTURE_V2_SCHEMA, EYE_APERTURE_V2_VERSION,
  eyeApertureV2ShapeErrors, projectAcceptedEyeApertureV2, reconstructEyeApertureV2, validateEyeApertureV2,
  type ApertureV2Eye, type EyeApertureV2Observation } from "./audit/eyeApertureV2Prototype";
import { deriveEyeApertureRatio, validateEyeApertureObservation } from "./audit/eyeAperturePrototype";
import { syntheticOffsets } from "./audit/eyeApertureChordDecision";

const dimensions = { widthPx: 200, heightPx: 100 };
function fixture(dU = -2, dL = 3): EyeApertureV2Observation {
  return { version: EYE_APERTURE_V2_VERSION, cropWidthPx: 200, cropHeightPx: 100, pose: "frontal",
    left: { visibility: "observed", outerCorner: { x: .2, y: .4 }, innerCorner: { x: .4, y: .4 },
      upperLidOffsetPx: dU, lowerLidOffsetPx: dL, confidence: .9 },
    right: { visibility: "observed", outerCorner: { x: .8, y: .4 }, innerCorner: { x: .6, y: .4 },
      upperLidOffsetPx: -4, lowerLidOffsetPx: 6, confidence: .7 } };
}
function unavailable(visibility: "unknown" | "blink" | "occluded" = "unknown"): ApertureV2Eye {
  return { visibility, outerCorner: { x: null, y: null }, innerCorner: { x: null, y: null },
    upperLidOffsetPx: null, lowerLidOffsetPx: null, confidence: 0 };
}
function accepted(v = fixture(), d = dimensions) {
  const result = validateEyeApertureV2(v, d);
  if (!result.ok) throw new Error(result.errors.join(","));
  return result.accepted;
}
function expectExactJsonNumbers(actual: unknown, expected: unknown) {
  // JSON has one zero. Compare exact numeric value, not Object.is(-0, 0).
  // This is not a geometric epsilon, runtime correction, or provider-value rewrite.
  if (typeof expected === "number") { expect(actual === expected).toBe(true); return; }
  if (expected !== null && typeof expected === "object") {
    expect(actual !== null && typeof actual === "object").toBe(true);
    expect(Object.keys(actual as object)).toEqual(Object.keys(expected));
    for (const key of Object.keys(expected))
      expectExactJsonNumbers((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]);
  } else expect(actual).toBe(expected);
}
const cases = [
  [-2, 3, "straddling"], [1, 6, "both_positive"], [-6, -1, "both_negative"], [0, 5, "upper_on_chord"],
] as const;
const network = vi.fn(() => { throw new Error("external_network_forbidden"); });
const sha = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const ROOT = path.resolve("evaluation-artifacts/eye-aperture-v2-central-section-implementation-20260926-001");
const writeArtifacts = process.env.WRITE_APERTURE_V2_ARTIFACTS === "approved-offline";
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name); return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  });
}
let baseline: Record<string, string> = {};
let start: Record<string, unknown> = {};
beforeAll(() => {
  vi.stubGlobal("fetch", network);
  if (!writeArtifacts) return;
  expect(fs.existsSync(ROOT), "fresh artifact root required").toBe(false);
  const files = new Set([...walk(path.resolve("evaluation-artifacts")),
    ...git("-C", "..", "ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
      .map(p => path.resolve("..", p)).filter(p => fs.existsSync(p) && fs.statSync(p).isFile())]);
  baseline = Object.fromEntries([...files].sort().map(p => [path.relative(process.cwd(), p).replaceAll("\\", "/"), sha(fs.readFileSync(p))]));
  start = { head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"), status: git("status", "--short", "--untracked-files=all"),
    numstat: git("diff", "--numstat"), diffSha256: sha(git("diff", "--no-ext-diff", "--binary")), hashes: baseline };
}, 120000);

for (const [dU, dL, relation] of cases) it(`synthetic_contract_test: ${dU},${dL}`, () => {
  const v = fixture(dU, dL), result = accepted(v), m = result.left.measurement!;
  expect(m.chordWidthPx).toBe(40); expect(m.gapPx).toBe(5); expect(m.ratio).toBe(.125);
  expect(m.upperPx).toEqual({ x: 60, y: 40 + dU }); expect(m.lowerPx).toEqual({ x: 60, y: 40 + dL });
  expect(m.baselineRelation).toBe(relation);
  expect(result.semanticContractValid).toBe(true); expect(result.measurementAvailable).toBe(true);
  const old = syntheticOffsets(dU, dL);
  expect(validateEyeApertureObservation(old).ok).toBe(relation === "straddling");
  expect(deriveEyeApertureRatio(old).left).toBe(relation === "straddling" ? .125 : null);
});
for (const [dU, dL] of [[3, -2], [2, 2]]) it(`rejects nonpositive gap ${dU},${dL} without repair`, () => {
  const v = fixture(dU, dL), snapshot = structuredClone(v), result = validateEyeApertureV2(v, dimensions);
  expect(result.ok).toBe(false); expect(result.errors).toContain("eyeApertureV2.left:nonpositive_or_nonfinite_gap");
  expect(v).toEqual(snapshot); expect(projectAcceptedEyeApertureV2(v, dimensions)).not.toHaveProperty("result");
});
it("rejects zero chord before division and vertical/reversed chords", () => {
  const v = fixture(); v.left.innerCorner = { ...v.left.outerCorner };
  expect(reconstructEyeApertureV2(v.left, -2, 3, dimensions, "left"))
    .toEqual({ ok: false, reason: "invalid_chord_width" });
  expect(validateEyeApertureV2(v, dimensions).ok).toBe(false);
  v.left.innerCorner.y = .6;
  expect(validateEyeApertureV2(v, dimensions).errors).toContain("eyeApertureV2.left:corner_order");
  v.left.innerCorner.x = .1;
  expect(validateEyeApertureV2(v, dimensions).ok).toBe(false);
});
for (const bad of [undefined, null, "3", NaN, Infinity, -Infinity]) it(`rejects observed invalid offset ${String(bad)}`, () => {
  const v = fixture(), raw = { ...v, left: { ...v.left, upperLidOffsetPx: bad } };
  expect(validateEyeApertureV2(raw, dimensions).ok).toBe(false);
  expect(projectAcceptedEyeApertureV2(raw, dimensions)).not.toHaveProperty("result");
});
it("rejects missing offset, corner range/nonfinite, partial corner and extra fields", () => {
  const v = fixture(); const partial: Partial<ApertureV2Eye> = { ...v.left }; delete partial.upperLidOffsetPx;
  expect(eyeApertureV2ShapeErrors({ ...v, left: partial })).toContain("eyeApertureV2.left.upperLidOffsetPx:required");
  for (const x of [-.1, 1.1, NaN, Infinity]) {
    const raw = fixture(); raw.left.outerCorner.x = x;
    expect(validateEyeApertureV2(raw, dimensions).ok).toBe(false);
  }
  v.left.outerCorner.y = null;
  expect(validateEyeApertureV2(v, dimensions).errors).toContain("eyeApertureV2.left:observed_requires_landmarks");
  expect(validateEyeApertureV2({ ...fixture(), prose: "not retained" }, dimensions).ok).toBe(false);
});
it("rejects reconstructed points outside without clamp; permits exact continuous boundaries", () => {
  for (const [u, l] of [[-41, 3], [-2, 61]]) {
    const v = fixture(u, l); expect(validateEyeApertureV2(v, dimensions).errors).toContain("eyeApertureV2.left:lid_outside_image");
    expect(v.left.upperLidOffsetPx).toBe(u); expect(v.left.lowerLidOffsetPx).toBe(l);
  }
  const m = accepted(fixture(-40, 60)).left.measurement!;
  expect(m.upperPx.y).toBe(0); expect(m.lowerPx.y).toBe(100);
  expect(accepted(fixture(-5, 0)).left.measurement!.baselineRelation).toBe("lower_on_chord");
});
it("uses caller dimensions, not provider dimensions", () => {
  const v = fixture(); v.cropWidthPx = 400;
  expect(validateEyeApertureV2(v, dimensions).errors).toEqual(["eyeApertureV2.crop:request_mismatch"]);
  for (const widthPx of [0, -1, 200.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(validateEyeApertureV2(fixture(), { widthPx, heightPx: 100 }).ok).toBe(false);
});
it("scales corners by separate axes; uniform pixel resize preserves ratio", () => {
  const v = fixture(); v.left.innerCorner = { x: .4, y: .7 };
  const m = accepted(v).left.measurement!;
  expect(m.chordWidthPx).toBeCloseTo(50); expect(m.normal.x).toBeCloseTo(-.6); expect(m.normal.y).toBeCloseTo(.8);
  expect(m.midpointPx).toEqual({ x: 60, y: 55 }); expect(m.upperPx.x).toBeCloseTo(61.2);
  expect(m.upperPx.y).toBeCloseTo(53.4); expect(m.ratio).toBeCloseTo(.1);
  const scaled = structuredClone(v); scaled.cropWidthPx *= 3; scaled.cropHeightPx *= 3;
  for (const side of ["left", "right"] as const) { scaled[side].upperLidOffsetPx! *= 3; scaled[side].lowerLidOffsetPx! *= 3; }
  const sm = accepted(scaled, { widthPx: 600, heightPx: 300 }).left.measurement!;
  expect(sm.ratio).toBeCloseTo(.1); expect(sm.upperPx.x).toBeCloseTo(m.upperPx.x * 3);
});
it("common offset translation changes baseline relation without changing gap", () => {
  const a = accepted(fixture(-2, 3)).left.measurement!, b = accepted(fixture(1, 6)).left.measurement!;
  expect(b.gapPx).toBe(a.gapPx); expect(b.ratio).toBe(a.ratio);
  expect(b.upperPx.y - a.upperPx.y).toBe(3); expect(b.baselineRelation).not.toBe(a.baselineRelation);
});
it("supports mild rotation with fixed positive-y normal and same-section reconstruction", () => {
  const v = fixture(); v.pose = "mild_tilt";
  const theta = Math.PI / 18, c = Math.cos(theta), s = Math.sin(theta);
  for (const side of ["left", "right"] as const) for (const p of [v[side].outerCorner, v[side].innerCorner]) {
    const x = p.x! * 200 - 100, y = p.y! * 100 - 40;
    p.x = (100 + c * x - s * y) / 200; p.y = (40 + s * x + c * y) / 100;
  }
  const result = accepted(v);
  expect(result.left.measurement!.ratio).toBeCloseTo(.125); expect(result.right.measurement!.ratio).toBeCloseTo(.25);
  for (const side of ["left", "right"] as const) {
    const m = result[side].measurement!, dx = m.innerPx.x - m.outerPx.x, dy = m.innerPx.y - m.outerPx.y;
    expect(m.normal.x).toBeCloseTo(-s); expect(m.normal.y).toBeCloseTo(c);
    for (const p of [m.upperPx, m.lowerPx])
      expect((p.x - m.midpointPx.x) * dx + (p.y - m.midpointPx.y) * dy).toBeCloseTo(0);
  }
});
it("keeps viewer-side offsets/confidence isolated and rejects side swaps", () => {
  const v = fixture(), r = accepted(v);
  expect(r.left.confidence).toBe(.9); expect(r.right.confidence).toBe(.7);
  expect(r.left.measurement!.upperPx).toEqual({ x: 60, y: 38 });
  expect(r.right.measurement!.upperPx).toEqual({ x: 140, y: 36 }); expect(r.meanRatio).toBe(.1875);
  [v.left, v.right] = [v.right, v.left]; expect(validateEyeApertureV2(v, dimensions).ok).toBe(false);
});
for (const state of ["unknown", "occluded", "blink"] as const) it(`valid ${state} is unavailable, not invalid`, () => {
  const v = fixture(); v.right = unavailable(state);
  const r = accepted(v); expect(r.semanticContractValid).toBe(true); expect(r.measurementAvailable).toBe(true);
  expect(r.right.measurementAvailable).toBe(false); expect(r.right.measurement).toBeNull(); expect(r.meanRatio).toBeNull();
  v.left = unavailable(state); const both = accepted(v);
  expect(both.measurementAvailable).toBe(false); expect(both.meanRatio).toBeNull();
  v.pose = "unsupported"; expect(accepted(v).measurementAvailable).toBe(false);
  v.left.confidence = .2; expect(validateEyeApertureV2(v, dimensions).ok).toBe(false);
});
it("rejects state contradictions distinctly from geometry; never coerces to unknown", () => {
  const v = fixture(); v.pose = "unsupported";
  expect(validateEyeApertureV2(v, dimensions).errors).toContain("eyeApertureV2.left:unknown_requires_null_and_zero_confidence");
  v.pose = "frontal"; v.left.visibility = "unknown";
  expect(validateEyeApertureV2(v, dimensions).errors).not.toContain("eyeApertureV2.left:nonpositive_or_nonfinite_gap");
  v.left = { ...unavailable(), visibility: "observed", confidence: .9 };
  expect(validateEyeApertureV2(v, dimensions).errors).toContain("eyeApertureV2.left:observed_requires_landmarks");
});
it("does not mutate input, and projects accepted JSON by allowlist without shared references", () => {
  const v = fixture(), before = structuredClone(v); Object.freeze(v.left.outerCorner); Object.freeze(v.left); Object.freeze(v);
  const r = projectAcceptedEyeApertureV2(v, dimensions); expect(v).toEqual(before);
  expect(r.ok).toBe(true); if (!r.ok) return;
  const roundTrip: unknown = JSON.parse(JSON.stringify(r));
  expectExactJsonNumbers(roundTrip, r);
  expect(JSON.stringify(roundTrip)).toBe(JSON.stringify(r)); expect(r.result.providerOrigin).toBe(false);
  expect(r.result.executionMode).toBe("offline_synthetic");
  r.result.left.outerCorner.x = .1; expect(v.left.outerCorner.x).toBe(.2);
  expect(Object.keys(r.result)).toEqual(["contractVersion", "providerOrigin", "executionMode", "cropWidthPx", "cropHeightPx", "pose",
    "semanticContractValid", "measurementAvailable", "binocularMeasurementAvailable", "left", "right", "meanRatio"]);
});
it("rejects v1 and unrelated version systems; no migration of old landmarks", () => {
  const v1 = syntheticOffsets(-2, 3);
  expect(validateEyeApertureV2(v1, dimensions).errors).toContain("eyeApertureV2.version:enum");
  for (const version of ["primary_compact_v4_structured_localization", "2", "eye_aperture_landmarks_v1"])
    expect(validateEyeApertureV2({ ...fixture(), version }, dimensions).ok).toBe(false);
  expect(validateEyeApertureV2({ ...fixture(), left: { ...fixture().left, upperLid: { x: .3, y: .38 } } }, dimensions).ok).toBe(false);
});
it("constructs a single-image local request without execution or source-label hints", () => {
  const req = buildEyeApertureV2Request("data:image/png;base64,AQID", dimensions);
  const stub = vi.fn((request: typeof req) => {
    expect(request.imageCount).toBe(1); expect(request.imageDataUrls).toHaveLength(1);
    expect(request.prompt).toBe(`${EYE_APERTURE_V2_PROMPT}\nCrop dimensions: 200 x 100 pixels.`);
    expect(request.responseSchema).toEqual(EYE_APERTURE_V2_SCHEMA);
    return fixture();
  });
  expect(validateEyeApertureV2(stub(req), dimensions).ok).toBe(true); expect(stub).toHaveBeenCalledTimes(1);
  expect(req.prompt).toContain("signed pixel offsets"); expect(req.prompt).toContain("exactly the normal line through M");
  expect(req.prompt).not.toMatch(/N_v4|O_v4|0\.50|0\.34|0\.68|wavy|\bNORMAL\b|\bOPEN\b|normal source/);
  // No source category/desired ratio interpolation. 'normalized' is coordinate language, not a label.
  expect(req.prompt).toContain("both offsets null");
  expect(() => buildEyeApertureV2Request("not-image", dimensions)).toThrow();
  expect(() => buildEyeApertureV2Request("data:image/png;base64,AQID", { widthPx: 0, heightPx: 100 })).toThrow();
});

afterAll(() => {
  expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  if (!writeArtifacts) return;
  const changed = Object.entries(baseline).filter(([p, h]) => !fs.existsSync(p) || sha(fs.readFileSync(p)) !== h).map(([p]) => p);
  expect(changed).toEqual([]); expect(sha(git("diff", "--no-ext-diff", "--binary"))).toBe(start.diffSha256);
  fs.mkdirSync(ROOT);
  const save = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  save("start-state.json", start);
  save("v2-contract.json", { version: EYE_APERTURE_V2_VERSION, providerOrigin: false, executionMode: "offline_synthetic",
    promptSha256: sha(EYE_APERTURE_V2_PROMPT), promptHashDomain: "UTF-8 exact EYE_APERTURE_V2_PROMPT, no BOM/newline/dimensions suffix",
    schemaSha256: sha(JSON.stringify(EYE_APERTURE_V2_SCHEMA)), schemaHashDomain: "UTF-8 JSON.stringify(EYE_APERTURE_V2_SCHEMA), insertion order, no whitespace/newline",
    sourceSha256: sha(fs.readFileSync("test/audit/eyeApertureV2Prototype.ts")), sourceHashDomain: "Exact module file bytes; includes schema, prompt, builder, validator and reconstruction",
    schema: EYE_APERTURE_V2_SCHEMA, remoteAcceptance: "NOT_TESTED", landmarkAccuracy: "NOT_TESTED", repeatability: "NOT_TESTED" });
  save("coordinate-and-unit-convention.json", { cornerOrder: "A=outer, B=inner; left outer.x<inner.x, right outer.x>inner.x; left.inner.x<right.inner.x",
    cornerPixels: "x*callerWidth, y*callerHeight, NOT W-1/H-1", imageDomain: "continuous [0,W] x [0,H], inclusive",
    section: "M=(A+B)/2; n=sign(D.x)*(-D.y,D.x)/length(D), positive image-y; U=M+dU*n; L=M+dL*n",
    offsets: "signed pixels, not normalized; no arbitrary bound", gap: "H=dL-dU>0; R=H/length(D)>0, finite",
    dimensions: "Caller dimensions mandatory; response equality before geometry", tolerance: "none; approximate comparisons in tests only",
    straddling: "baselineRelation diagnostic only, not validity gate", stateOrder: "caller -> shape -> dimension equality -> existing corner checks -> state -> geometry",
    abstention: "retained non-observed states; null corner components and offsets; confidence 0; measurement=null; mean=null unless both measured" });
  save("synthetic-regression.json", { providerOrigin: false, executionMode: "offline_synthetic", cases: cases.map(([u, l]) => projectAcceptedEyeApertureV2(fixture(u, l), dimensions)),
    unavailable: projectAcceptedEyeApertureV2({ ...fixture(), left: unavailable(), right: unavailable() }, dimensions),
    partial: projectAcceptedEyeApertureV2({ ...fixture(), right: unavailable() }, dimensions),
    rejectedCasesStorePayload: false, empiricalEvidence: false });
  save("v1-v2-behavior-difference.json", { cases: cases.map(([u, l, relation]) => ({ evidenceKind: "synthetic_contract_test", baselineRelation: relation,
    v1Valid: validateEyeApertureObservation(syntheticOffsets(u, l)).ok, v2Valid: validateEyeApertureV2(fixture(u, l), dimensions).ok })),
    migration: "none", historicalRejectedResponseReclassification: false, stateSemanticsUnchanged: true,
    acceptance: "Same-side and zero-endpoint positive fixed-section gaps allowed; free longitudinal points absent; invalid gaps remain invalid" });
  const req = buildEyeApertureV2Request("data:image/png;base64,AQID", dimensions);
  save("request-builder-check.json", { model: req.model, version: req.version, imageCount: req.imageCount, widthPx: req.cropWidthPx, heightPx: req.cropHeightPx,
    finalPromptSha256: sha(req.prompt), finalPromptHashDomain: "UTF-8 base prompt + LF + Crop dimensions: 200 x 100 pixels.",
    responseSchemaSha256: sha(JSON.stringify(req.responseSchema)), stubOnly: true, remoteSelectorUsed: false,
    fullRequestStored: false, imageStored: false, promptBodyStored: false, providerCalls: 0 });
  save("preservation.json", { comparedFiles: Object.keys(baseline).length, changed, trackedDiffUnchanged: true,
    productionIncrementalDiff: 0, v1Changed: false, remoteWrangler: 0, health: 0, providerCalls: 0, evaluator: 0, externalNetwork: 0, packageManager: 0 });
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Eye aperture v2: fixed central section, offline implementation

Implemented only test/audit/eyeApertureV2Prototype.ts and its synthetic test. Version: eye_aperture_midpoint_section_v2, distinct from primary localization V4 and localization trace v2. Production and remote selectors do not import this module. No activation.

The input contains normalized outer/inner corners and upperLidOffsetPx/lowerLidOffsetPx. Convert corners using caller W/H, never W-1/H-1 or unverified response dimensions. Chord A=outer to B=inner; M midpoint; n has fixed positive image-y. U=M+dU*n and L=M+dL*n encode a shared central section, not projection/correction of independent provider points. H=dL-dU; R=H/chordWidth. Continuous in-image bounds are [0,W] x [0,H]. No epsilon, clamp, swap, abs-gap or defaults.

For a synthetic horizontal 40px chord, (-2,3), (1,6), (-6,-1), (0,5) all yield H=5px and R=.125. Straddling is diagnostic only; v1 still accepts only the first. Inverted and zero gap are rejected. Offsets greater than 1px are legitimate; out-of-image reconstruction is not. These fixtures are not anatomical observations.

Caller/shape/dimension/corner/state/geometry stages are explicit. Correct unknown/blink/occluded with null fields and zero confidence is semantic-valid but unavailable. One measured eye is allowed; binocular mean stays null. Contradictory states and invalid geometry return errors, not corrected evidence. Invalid output has no accepted payload. Safe synthetic projections are allowlisted, copied and JSON round-trip tested; providerOrigin=false, executionMode=offline_synthetic.

Tests cover finite/range/missing/null/string offsets, dimensions, degenerate/order constraints, non-square scaling, uniform resize, shared offset translation, mild rotation/same section, viewer-side separation, no mutation, abstention/partial states, v1 and unrelated version rejection, a local request stub, and old v1 regression. Test floating comparison tolerances are not runtime tolerances.

Prompt/schema/source hash domains and before/after preserved hashes are in the JSON reports. No historical rejected response reconstructed or rejudged. Local construction does not establish remote schema acceptance or measurement accuracy.

Provider schema acceptance, landmark accuracy and repeatability: NOT_TESTED.
Existing subjective openness N_v4=.50 / O_v4=.50 is a different quantity; experimental aperture v2 NORMAL=unknown / OPEN=unknown. The .34/.68 thresholds are not applied.

External network, remote Wrangler, health, Gemini/Gemma, geometry/evaluator calls and package manager: 0. No commit/push/deploy. No automatic next-stage execution.

EYE_APERTURE_V2_CENTRAL_SECTION_IMPLEMENTED_OFFLINE
`, { flag: "wx" });
}, 120000);
