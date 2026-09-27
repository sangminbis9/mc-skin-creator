/** Synthetic mathematics only. Not a provider contract, runtime validator, or historical replay. */
import { deriveEyeApertureRatio, validateEyeApertureObservation, type EyeApertureObservation } from "./eyeAperturePrototype";
import { measurableExample } from "./eyeApertureSemanticReview";

export type PixelPoint = { x: number; y: number };
export function projectSection(a: PixelPoint, b: PixelPoint, u: PixelPoint, l: PixelPoint) {
  if (![a, b, u, l].every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  const dx = b.x - a.x, dy = b.y - a.y, width = Math.hypot(dx, dy);
  if (!Number.isFinite(width) || width === 0 || dx === 0) return null;
  const e = { x: dx / width, y: dy / width }, s = dx > 0 ? 1 : -1;
  const n = { x: -s * e.y, y: s * e.x };
  const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const offset = (p: PixelPoint) => (p.x - m.x) * n.x + (p.y - m.y) * n.y;
  const along = (p: PixelPoint) => ((p.x - a.x) * e.x + (p.y - a.y) * e.y) / width;
  const dU = offset(u), dL = offset(l), separation = dL - dU;
  return { width, e, n, m, dU, dL, separation, ratio: separation / width,
    normalProjection: (l.x - u.x) * n.x + (l.y - u.y) * n.y,
    unsignedSum: Math.abs(dU) + Math.abs(dL), euclidean: Math.hypot(l.x - u.x, l.y - u.y),
    upperAt: along(u), lowerAt: along(l), straddlesStrictly: dU < 0 && dL > 0 };
}

export function syntheticOffsets(dU: number, dL: number, upperAt = .5, lowerAt = .5): EyeApertureObservation {
  const v = measurableExample();
  // Specified directly in pixels; other eye stays the existing valid fixture.
  v.left.upperLid = { x: (40 + 40 * upperAt) / 200, y: (40 + dU) / 100 };
  v.left.lowerLid = { x: (40 + 40 * lowerAt) / 200, y: (40 + dL) / 100 };
  return v;
}
export function inspectLeft(v: EyeApertureObservation) {
  const px = (p: { x: number | null; y: number | null }): PixelPoint => {
    if (p.x === null || p.y === null) throw new Error("synthetic_complete_points_required");
    return { x: p.x * v.cropWidthPx, y: p.y * v.cropHeightPx };
  };
  return projectSection(px(v.left.outerCorner), px(v.left.innerCorner), px(v.left.upperLid), px(v.left.lowerLid));
}
export const signCases = [
  { id: "straddling", dU: -2, dL: 3, expectedValid: true, expectedH: 5, expectedAbsSum: 5 },
  { id: "both-positive", dU: 1, dL: 6, expectedValid: false, expectedH: 5, expectedAbsSum: 7 },
  { id: "both-negative", dU: -6, dL: -1, expectedValid: false, expectedH: 5, expectedAbsSum: 7 },
  { id: "upper-on-chord", dU: 0, dL: 5, expectedValid: false, expectedH: 5, expectedAbsSum: 5 },
  { id: "inverted", dU: 3, dL: -2, expectedValid: false, expectedH: -5, expectedAbsSum: 5 },
  { id: "coincident", dU: 2, dL: 2, expectedValid: false, expectedH: 0, expectedAbsSum: 4 },
] as const;
export function caseResults() {
  return signCases.map(c => {
    const value = syntheticOffsets(c.dU, c.dL), validation = validateEyeApertureObservation(value);
    return { evidenceKind: "synthetic_contract_test", ...c, math: inspectLeft(value),
      currentValidator: validation.ok, currentErrors: validation.errors,
      currentDerivedLeft: deriveEyeApertureRatio(value).left,
      acceptedCurrentRatio: validation.ok ? deriveEyeApertureRatio(validation.value).left : null };
  });
}

export const currentFormula = {
  version: "eye_aperture_landmarks_v1", source: "test/audit/eyeAperturePrototype.ts",
  corners: "Viewer-left: outer.x < inner.x; viewer-right: outer.x > inner.x. A=outer, B=inner. Inner-left.x < inner-right.x. No anatomical-side remapping.",
  pixels: "(xNormalized * cropWidthPx, yNormalized * cropHeightPx), NOT W-1/H-1; image y increases downward",
  chord: "D=B-A; W=hypot(D.x,D.y); e=D/W; M=(A+B)/2",
  normal: "s=D.x>=0?1:-1; n=s*(-D.y,D.x)/W. Validated corner order excludes D.x=0, hence n.y>0. No output-dependent flipping.",
  offsets: "Current dot(P-A,n); review dot(P-M,n) is equal because dot(M-A,n)=0",
  aperture: "H=dL-dU; ratio=H/W; finite H>0 required. NOT abs(dU)+abs(dL).",
  straddling: "dU<0 && dL>0; equality at either endpoint is rejected; no epsilon",
  longitudinal: "t(P)=dot(P-A,D)/W^2; abs(tU-.5)<=.2; abs(tL-.5)<=.2; abs(tU-tL)<=.1 (implemented as rejection with >)",
  precision: "JavaScript Number operations; no numerical tolerance beyond the explicit .2/.1 longitudinal allowances. Decimal floating rounding can affect exact boundary comparisons.",
  exposure: "Rejected straddle returns null before aperture division. Derived helper is not a replacement for structural/semantic validation.",
  finiteRange: "Coordinates finite [0,1]; dimensions positive safe integers and match request; chord positive finite; complete observed points; confidence (0,1].",
};
export const measurementDomain = {
  prompt: "same central position along each eye's corner-to-corner chord",
  currentMeaning: "Central region, not explicitly exact midpoint intersection; runtime permits t in [.3,.7] and different positions by up to .1. Iris-centered measurement is not specified.",
  distinctions: ["arithmetic computability", "same-section definition", "actual visible eyelid placement", "empirical provider accuracy"],
  syntheticCoverage: "Only first two are testable by these fixtures; no anatomy, accuracy or historical coordinate claim.",
  identities: [
    "dL-dU = dot(L-U,n) for all finite points on a nondegenerate chord",
    "Euclidean(L-U)^2 = (dL-dU)^2 + W^2*(tL-tU)^2",
    "If tL=tU and H>0, Euclidean distance=H; straddling alone does not ensure this",
    "abs(dU)+abs(dL)=H for dU<=0<=dL; strict straddling sufficient but not necessary (zero endpoint)",
    "Same-side positive H is possible; abs sum then overstates H unless a zero endpoint",
  ],
  predicateRemoval: "Removing straddling alone does not break the current signed formula, provided H>0/finite, valid width and other guards remain. It does NOT resolve existing longitudinal mismatch or actual boundary accuracy. No deletion implemented.",
  taxonomy: { mathematicalNecessity: false, requiredByCurrentSignedFormula: false,
    currentAdditionalDomainRestriction: true, universalBiologicalNecessityEstablished: false },
};
export const contractDecision = {
  decision: "SEPARATE_STRADDLING_FROM_GAP_VALIDITY",
  rationale: "Measure central normal-section gap independently of its offset from the corner baseline. Positive ordered separation does not mathematically require baseline intersection. Narrowing the scientific target to straddling-only is not necessary for this gap definition.",
  implementationStatus: "draft_only_v1_unchanged_inactive",
  limitations: "This is a measurement-definition decision, not anatomical proof or evidence that provider accuracy improves. Same-side output alone is neither proof of error nor proof of true boundary placement.",
  previousLive: "Exact rejected points/state remain unknown. Saved live errors were state/order errors, not invalid_chord_or_lid_geometry. No historical result reclassified or salvaged.",
  nextBoundary: "Separately authorized audit-only v2 midpoint-section contract implementation and synthetic tests; no provider wiring or activation.",
};
export const nextContractSpec = {
  version: "eye_aperture_midpoint_section_v2_DRAFT", status: "artifact_spec_only_not_implemented",
  measurement: "Visible upper-to-lower eyelid gap along the image-plane corner-chord midpoint normal, divided by corner-chord pixel length",
  corners: currentFormula.corners,
  coordinates: currentFormula.pixels,
  orientation: "A=outer; B=inner; W>0; D.x!=0 under unchanged viewer corner ordering; e=D/W; n=sign(D.x)*(-e.y,e.x), fixed positive image-y. M=(A+B)/2.",
  section: "Exactly S={M+d*n | d real}; U and L are the unique visible upper/lower eyelid intersections with S. Not independently chosen central points, iris centers, or widest-opening locations.",
  representation: {
    scope: "Next-version measurement encoding only; pose/visibility/confidence semantics and bilateral availability are retained. No current schema edited.",
    corners: "Keep normalized outerCorner/innerCorner {x,y} and crop dimensions",
    upperLid: "Next-version upperLidOffsetPx: signed finite pixel distance from M along fixed n, or null",
    lowerLid: "Next-version lowerLidOffsetPx: signed finite pixel distance from M along fixed n, or null",
    reason: "Native section coordinates enforce tU=tL=.5 by construction without an arbitrary alignment tolerance. The provider must observe intersections on S directly, not project independent off-section landmarks.",
    reconstruction: "U=M+upperLidOffsetPx*n; L=M+lowerLidOffsetPx*n defines the encoded points; not correction of old v1 x/y output. No v1-to-v2 conversion or historical salvage.",
    units: "Offsets are pixels, NOT normalized openness or fractions of eye width. Uniform resize scales offsets and W equally; ratio invariant.",
  },
  formula: "H=lowerLidOffsetPx-upperLidOffsetPx; R=H/W. Finite positive H and R. Mean only when both eyes measurable.",
  straddling: "Diagnostic baseline relation only: straddling / upper_on_chord / lower_on_chord / both_positive / both_negative. Never flips normal, sorts lids, takes abs(H), or gates a positive valid gap.",
  measurable: "Supported pose, actually visible uniquely locatable corners and section intersections, no blink/downcast ambiguity/occlusion, complete finite values, positive confidence, ordered corners, in-crop reconstructed points and finite positive H/R. Numeric checks cannot independently prove actual boundary placement.",
  unavailable: "Unlocatable/ambiguous intersection, occlusion, blink, unsupported pose, or uncertainty: use existing unknown/occluded/blink state; no inferred points or defaults. No valid gap is reported.",
  abstention: "For each unavailable eye: corner point objects {x:null,y:null}; upperLidOffsetPx:null; lowerLidOffsetPx:null; confidence:0; non-observed visibility. Unsupported pose requires both eyes unavailable. One available eye does not synthesize the other or binocular mean.",
  invalid: "Malformed, out-of-crop/nonfinite coordinates, contradictory state, nonpositive/degenerate width, invalid viewer ordering, nonpositive separation, or nonfinite ratio. Reject; do not repair, swap, clamp, or downgrade invalid observed output.",
  predicateDraft: [
    "Validate distinct v2 version and shape, dimensions equality and coordinate finite/range",
    "Retain v1 pose/visibility/confidence semantics and corner checks/order; no corner-order refactor bundled",
    "Observed requires supported pose, complete corners and offsets, confidence>0",
    "D.x obeys existing side ordering; W finite>0; construct fixed n and midpoint M",
    "Decode native section U,L; require both in [0,cropWidthPx] x [0,cropHeightPx] and finite",
    "Require H finite>0 and R finite>0; never require dU<0<dL",
    "No free longitudinal coordinates or alignment tolerance: section is fixed in representation",
    "Record baseline relation separately; both-eye mean only if both measured",
  ],
  acceptanceDelta: "Not a superset: includes correctly observed same-side/zero-endpoint positive midpoint gaps excluded by v1; excludes v1's off-midpoint or mismatched longitudinal observations as representations of this different quantity. Inverted/coincident points still invalid. Compare meanings, not old DTO byte acceptance.",
  promptDraft: "Audit-only midpoint-section eye aperture, v2 draft. Use viewer-left/right eyes and visible outer/inner corners in independently normalized crop x/y coordinates, origin top-left. Convert corners to pixels with the supplied width/height. The section is the line perpendicular to the corner chord through its exact midpoint. Fix the normal toward positive image-y. Locate the actual visible upper and lower eyelid intersections on that section and report each signed pixel offset from the midpoint along that fixed normal. Both offsets may have the same sign or one may be zero; upper-to-lower separation must be positive. Do not choose independent central points, iris centers or maximum opening, project off-section landmarks, infer points from width or desired categories, swap labels or force straddling. If intersections or corners are hidden, blinking, ambiguous, unsupported, or uncertain, abstain using the retained visibility rules: both corner x/y components null, both offsets null, confidence zero for that eye. Preserve measured asymmetry; do not guess the other eye.",
  numericalPolicy: "No new geometric tolerance. Native midpoint-section encoding removes alignment comparison. Finite/range/positive comparisons use supplied numeric values; no epsilon, snapping or correction. Empirical precision assessment remains future work.",
  thresholds: "No use of subjective-openness .34/.68 thresholds for this dimensionless aperture ratio",
  compatibility: "No production activation, no change to v1 prompt/schema/validator/builder; new version cannot reinterpret old rejected DTOs. Accuracy/repeatability remain unmeasured.",
};
