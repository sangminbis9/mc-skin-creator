import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { deriveEyeApertureRatio, validateEyeApertureObservation } from "./audit/eyeAperturePrototype";
import { abstainingEye, measurableExample, tiltedExample } from "./audit/eyeApertureSemanticReview";
import { caseResults, contractDecision, currentFormula, inspectLeft, measurementDomain,
  nextContractSpec, projectSection, signCases, syntheticOffsets } from "./audit/eyeApertureChordDecision";

const ROOT = path.resolve("evaluation-artifacts/eye-aperture-chord-contract-decision-20260926-001");
const writeArtifacts = process.env.WRITE_APERTURE_CHORD_DECISION === "approved-offline";
const network = vi.fn(() => { throw new Error("offline_only"); });
const sha = (s: Uint8Array | string) => createHash("sha256").update(s).digest("hex");
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
  expect(fs.existsSync(ROOT), "never overwrite historical artifacts").toBe(false);
  // Hash all historical artifacts, not merely the immediately preceding report.
  const files = new Set([
    ...walk(path.resolve("evaluation-artifacts")),
    ...git("-C", "..", "ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean)
      .map(p => path.resolve("..", p)).filter(p => fs.existsSync(p) && fs.statSync(p).isFile()),
  ]);
  baseline = Object.fromEntries([...files].sort().map(p => [path.relative(process.cwd(), p).replaceAll("\\", "/"), sha(fs.readFileSync(p))]));
  start = { head: git("rev-parse", "HEAD"), branch: git("branch", "--show-current"),
    status: git("status", "--short", "--untracked-files=all"), numstat: git("diff", "--numstat"),
    diffSha256: sha(git("diff", "--no-ext-diff", "--binary")), preservedFileHashes: baseline };
}, 120000);

for (const c of signCases) it(`synthetic_contract_test: ${c.id}`, () => {
  const v = syntheticOffsets(c.dU, c.dL), p = inspectLeft(v)!;
  expect(validateEyeApertureObservation(v).ok).toBe(c.expectedValid);
  expect(p.dU).toBeCloseTo(c.dU); expect(p.dL).toBeCloseTo(c.dL);
  expect(p.separation).toBeCloseTo(c.expectedH); expect(p.unsignedSum).toBeCloseTo(c.expectedAbsSum);
  expect(p.normalProjection).toBeCloseTo(c.expectedH);
  expect(p.euclidean).toBeCloseTo(Math.abs(c.expectedH));
  expect(p.straddlesStrictly).toBe(c.expectedValid);
  if (c.expectedValid) expect(deriveEyeApertureRatio(v).left).toBeCloseTo(5 / 40);
  else expect(deriveEyeApertureRatio(v).left).toBeNull();
});

it("does not rotate normals or sort lids to force a positive gap", () => {
  const p = inspectLeft(syntheticOffsets(3, -2))!;
  expect(p.n).toEqual({ x: -0, y: 1 }); expect(p.separation).toBe(-5);
  const reversedChord = projectSection({ x: 80, y: 40 }, { x: 40, y: 40 }, { x: 60, y: 38 }, { x: 60, y: 43 })!;
  expect(reversedChord.n.y).toBe(1); expect(reversedChord.separation).toBe(5);
});

it("distinguishes exact section, common non-midpoint section, and tolerated misalignment", () => {
  const shifted = syntheticOffsets(-2, 3, .4, .4);
  expect(validateEyeApertureObservation(shifted).ok).toBe(true);
  expect(inspectLeft(shifted)!.upperAt).toBeCloseTo(.4); // not midpoint
  const mismatch = syntheticOffsets(-2, 3, .46, .54), p = inspectLeft(mismatch)!;
  expect(validateEyeApertureObservation(mismatch).ok).toBe(true);
  expect(p.separation).toBeCloseTo(5); expect(p.unsignedSum).toBeCloseTo(5);
  expect(p.euclidean).toBeGreaterThan(5);
  expect(p.euclidean ** 2).toBeCloseTo(25 + 3.2 ** 2);
  expect(validateEyeApertureObservation(syntheticOffsets(-2, 3, .4, .6)).ok).toBe(false);
  expect(validateEyeApertureObservation(syntheticOffsets(-2, 3, .25, .25)).ok).toBe(false);
});

it("uses equal pixel units and is uniform-resize invariant, not aspect-ratio invariant", () => {
  const v = measurableExample(), scaled = structuredClone(v), taller = structuredClone(v);
  scaled.cropWidthPx *= 3; scaled.cropHeightPx *= 3; taller.cropHeightPx *= 2;
  expect(inspectLeft(v)!.width).toBe(40); expect(inspectLeft(v)!.separation).toBe(10);
  expect(inspectLeft(v)!.ratio).toBe(.25);
  expect(inspectLeft(scaled)!.ratio).toBeCloseTo(.25);
  expect(inspectLeft(scaled)!.separation).toBeCloseTo(30);
  expect(deriveEyeApertureRatio(scaled).left).toBeCloseTo(.25);
  expect(deriveEyeApertureRatio(taller).left).toBeCloseTo(.5);
});

it("preserves projection under supported mild rotation and midpoint/outer origins agree", () => {
  const v = tiltedExample(), p = inspectLeft(v)!;
  expect(validateEyeApertureObservation(v).ok).toBe(true);
  expect(p.ratio).toBeCloseTo(.25); expect(deriveEyeApertureRatio(v).left).toBeCloseTo(.25);
  const eye = v.left;
  const fromOuter = (eye.upperLid.x! - eye.outerCorner.x!) * 200 * p.n.x
    + (eye.upperLid.y! - eye.outerCorner.y!) * 100 * p.n.y;
  expect(fromOuter).toBeCloseTo(p.dU);
});

for (const bad of [NaN, Infinity, -Infinity, -0.1, 1.1]) it(`rejects finite/range violation ${bad}`, () => {
  const v = measurableExample(); v.left.upperLid.x = bad;
  expect(validateEyeApertureObservation(v).errors).toContain("eyeAperture.left.upperLid.x:range");
});
it("rejects zero chord and vertical corner degeneracy without a ratio", () => {
  const v = measurableExample(); v.left.innerCorner = { ...v.left.outerCorner };
  expect(validateEyeApertureObservation(v).ok).toBe(false);
  expect(deriveEyeApertureRatio(v).left).toBeNull(); expect(inspectLeft(v)).toBeNull();
  expect(projectSection({ x: 1, y: 0 }, { x: 1, y: 4 }, { x: 0, y: 2 }, { x: 2, y: 2 })).toBeNull();
});
for (const visibility of ["unknown", "occluded", "blink"] as const) it(`preserves ${visibility} and partial measurement`, () => {
  const v = measurableExample(); v.right = abstainingEye(visibility);
  expect(validateEyeApertureObservation(v).ok).toBe(true);
  expect(deriveEyeApertureRatio(v)).toEqual({ left: .25, right: null, mean: null });
  v.left = abstainingEye(visibility);
  expect(validateEyeApertureObservation(v).ok).toBe(true);
  expect(deriveEyeApertureRatio(v)).toEqual({ left: null, right: null, mean: null });
  v.pose = "unsupported";
  expect(validateEyeApertureObservation(v).ok).toBe(true);
  v.left.confidence = .5; expect(validateEyeApertureObservation(v).ok).toBe(false);
});

it("keeps draft section encoding explicit without implementing a new runtime", () => {
  expect(contractDecision.decision).toBe("SEPARATE_STRADDLING_FROM_GAP_VALIDITY");
  expect(nextContractSpec.section).toContain("Exactly");
  expect(nextContractSpec.representation.reason).toContain("by construction");
  expect(nextContractSpec.numericalPolicy).toContain("No new geometric tolerance");
});

afterAll(() => {
  expect(network).not.toHaveBeenCalled(); vi.unstubAllGlobals();
  if (!writeArtifacts) return;
  const changed = Object.entries(baseline).filter(([p, hash]) => !fs.existsSync(p) || sha(fs.readFileSync(p)) !== hash).map(([p]) => p);
  expect(changed).toEqual([]);
  expect(sha(git("diff", "--no-ext-diff", "--binary"))).toBe(start.diffSha256);
  fs.mkdirSync(ROOT); // deliberate failure if another process used this root
  const save = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  save("start-state.json", start);
  save("current-formula.json", currentFormula);
  save("synthetic-math-cases.json", { evidenceKind: "synthetic_contract_test", cases: caseResults(),
    longitudinalMismatch: inspectLeft(syntheticOffsets(-2, 3, .46, .54)) });
  save("measurement-domain.json", measurementDomain);
  save("contract-decision.json", contractDecision);
  save("next-contract-spec.json", nextContractSpec);
  save("preservation.json", { comparedFiles: Object.keys(baseline).length, changed,
    trackedDiffUnchanged: true, networkCalls: 0, remoteWrangler: 0, health: 0,
    providerCalls: 0, evaluatorCalls: 0, packageManager: 0,
    historicalEvidenceReconstruction: false, productionOrV1Change: false });
  const table = caseResults().map(r => `| ${r.id} | ${r.dU} | ${r.dL} | ${r.currentValidator ? "PASS" : "FAIL"} | ${r.currentDerivedLeft ?? "null"} | ${r.expectedH} | ${r.expectedAbsSum} | ${r.math!.straddlesStrictly} |`).join("\n");
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Eye aperture chord applicability decision

Decision: **SEPARATE_STRADDLING_FROM_GAP_VALIDITY** (B). Draft only; v1 remains unchanged and inactive.

## Current mathematics

Read directly from test/audit/eyeAperturePrototype.ts. A=outer, B=inner in viewer-side order. Convert x*cropWidth and y*cropHeight before computing W=|B-A|. Fix n toward positive image-y, independently of lid outputs. d(P)=dot(P-A,n)=dot(P-M,n). H=dL-dU; R=H/W. It is NOT an unsigned-distance sum. Current strict dU<0<dL rejects equality, with no epsilon. The current exposed ratio is null on those failures.

| synthetic_contract_test | dU px | dL px | v1 validator | v1 ratio | H px | abs sum px | straddles |
| --- | ---: | ---: | --- | ---: | ---: | ---: | --- |
${table}

All six are constructed coordinates, not anatomy or recovered live data. Same-side cases have positive H=5; zero-endpoint also has H=5 despite current strict rejection. Inverted H remains negative; coincident H=0 remains invalid. No sign flip, sorting, clamp or coordinate repair.

## Mathematical necessity versus domain

H=dot(L-U,n) always. Unsigned sum equals H when dU<=0<=dL, including equality; same-side cases overcount. Euclidean gap equals H only for positive H on the same longitudinal section; otherwise its square adds W²(tL-tU)². Strict straddling alone does not imply Euclidean equality. Removing straddling alone would NOT break the current signed formula if positive finite H and the other guards stay, but would not establish a same-section measurement or landmark accuracy.

Straddling is an extra v1 domain restriction, not mathematically required or an established universal biological rule. A narrow straddling-only experiment could legitimately retain it if explicit in prompt and abstention rules; that narrower scientific target is not selected here. This decision is based on measurement definition, not admitting more historical failures.

## Central section decision

Current prompt says same central position, not exact midpoint or iris center. Runtime admits tU,tL in [.3,.7] with difference <=.1. It accepts both a shared .4 section and .46/.54 mismatch. The latter has H=5 but Euclidean gap=sqrt(25+3.2²). Thus v1 guarantees only a central-region projection, not one exact section.

Next version explicitly measures the intersections with the normal through chord midpoint M. To avoid inventing a numerical alignment tolerance, the draft uses provider-native signed pixel offsets on that fixed line, alongside unchanged normalized corners. U=M+dU*n and L=M+dL*n DEFINE the new encoding; they do not snap or project v1 coordinates. Provider must observe those intersections, abstaining when ambiguous. It must not infer them from unrelated points. Full definitions, prompt draft and validator predicates are in next-contract-spec.json, not executable code.

This is not a pure acceptance superset: valid same-side/zero-endpoint midpoint gaps become admissible; v1 off-midpoint or mismatched-section measurements no longer represent the chosen quantity. State meanings, confidence rules, one-eye availability and corner-check ordering are not redesigned. No geometric epsilon, fallback, synonym mapping or .34/.68 threshold transfer.

## Evidence limits and next boundary

Arithmetic computability, same-section definition, actual eyelid placement and validated model accuracy are distinct. Synthetic tests address only the first two. Previous rejected live coordinates/state remain unknown; saved errors were state/order errors, not chord-geometry errors. No salvage, new ratio, accuracy or repeatability claim.

Only next boundary: separately authorized audit-only v2 midpoint-section contract implementation with synthetic regression; no automatic provider connection or live run. Production, v1 prompt/schema/validator/request builder and historical artifacts stay unchanged. Start-state and preservation reports contain hash evidence; all network/provider/remote/package-manager calls are zero.

APERTURE_CHORD_APPLICABILITY_DECIDED
`, { flag: "wx" });
}, 120000);
