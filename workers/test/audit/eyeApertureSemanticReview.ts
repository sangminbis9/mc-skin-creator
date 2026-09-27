/** Offline specification examples, not reconstructions of discarded live responses. */
import { deriveEyeApertureRatio, EYE_APERTURE_CONTRACT_VERSION, validateEyeApertureObservation,
  type EyeApertureObservation } from "./eyeAperturePrototype";
import { apertureShapeErrors } from "./eyeAperturePilotContract";

export function measurableExample(): EyeApertureObservation {
  // Pixel specification: 200x100; left corners (40,40)/(80,40), lids (60,35)/(60,45).
  // Right corners (160,40)/(120,40), lids (140,34)/(140,46). Ratios .25/.30.
  return { version: EYE_APERTURE_CONTRACT_VERSION, cropWidthPx: 200, cropHeightPx: 100, pose: "frontal",
    left: { visibility: "observed", outerCorner: { x: .2, y: .4 }, innerCorner: { x: .4, y: .4 },
      upperLid: { x: .3, y: .35 }, lowerLid: { x: .3, y: .45 }, confidence: .9 },
    right: { visibility: "observed", outerCorner: { x: .8, y: .4 }, innerCorner: { x: .6, y: .4 },
      upperLid: { x: .7, y: .34 }, lowerLid: { x: .7, y: .46 }, confidence: .8 } };
}
export function abstainingEye(visibility: "unknown" | "blink" | "occluded" = "unknown"): EyeApertureObservation["left"] {
  return { visibility, outerCorner: { x: null, y: null }, innerCorner: { x: null, y: null },
    upperLid: { x: null, y: null }, lowerLid: { x: null, y: null }, confidence: 0 };
}
export function tiltedExample(): EyeApertureObservation {
  const value = measurableExample(); value.pose = "mild_tilt";
  // Rigid 10-degree image-plane rotation preserves lengths and perpendicular apertures.
  const angle = Math.PI / 18, cs = Math.cos(angle), sn = Math.sin(angle);
  for (const side of ["left", "right"] as const) {
    for (const key of ["outerCorner", "innerCorner", "upperLid", "lowerLid"] as const) {
      const p = value[side][key], x = p.x! * 200 - 100, y = p.y! * 100 - 40;
      p.x = (100 + x * cs - y * sn) / 200; p.y = (40 + x * sn + y * cs) / 100;
    }
  }
  return value;
}
type Example = { id: string; category: string; basis: string; raw: unknown;
  expectedShape: boolean; expectedSemantic: boolean; expectedMeasurableEyes: string[] };
export function semanticExamples(): Example[] {
  const samples: Example[] = [];
  const add = (id: string, category: string, basis: string, edit: (v: EyeApertureObservation) => unknown,
    expectedShape: boolean, expectedSemantic: boolean, expectedMeasurableEyes: string[] = []) => {
    samples.push({ id, category, basis, raw: edit(measurableExample()), expectedShape, expectedSemantic, expectedMeasurableEyes });
  };
  add("both-observed", "A", "Visible corners and ordered central lids, positive numeric confidence; schema exact fields", v => v, true, true, ["left", "right"]);
  add("mild-tilt", "A", "Prompt permits mild_tilt; rigid image rotation cannot change aperture ratio", () => tiltedExample(), true, true, ["left", "right"]);
  for (const visibility of ["unknown", "blink", "occluded"] as const) {
    add(`both-${visibility}`, "B", "Prompt abstention with all coordinate components null and confidence zero; object shape from schema", v => {
      v.left = abstainingEye(visibility); v.right = abstainingEye(visibility); return v;
    }, true, true);
  }
  add("unsupported-abstention", "B", "Unsupported image pose: do not guess either eye", v => {
    v.pose = "unsupported"; v.left = abstainingEye(); v.right = abstainingEye(); return v;
  }, true, true);
  for (const side of ["left", "right"] as const) {
    add(`only-${side}-measured`, "C", "Affected-eye abstention, other eye remains measured; both-eye mean unavailable", v => {
      v[side === "left" ? "right" : "left"] = abstainingEye(); return v;
    }, true, true, [side]);
  }
  add("observed-null-component", "D", "Observed eye requires actual complete boundary points", v => { v.left.upperLid.x = null; return v; }, true, false);
  add("observed-all-null", "D", "Claiming observed without any landmarks is contradictory", v => { v.left = { ...abstainingEye(), visibility: "observed", confidence: .9 }; return v; }, true, false);
  add("unknown-with-coordinates", "E", "Prompt explicitly forbids invented points for unknown", v => { v.left.visibility = "unknown"; v.left.confidence = 0; return v; }, true, false);
  add("unknown-with-confidence", "E", "Abstention confidence must be zero", v => { v.left = { ...abstainingEye(), confidence: .9 }; return v; }, true, false);
  add("unsupported-with-observed", "F", "Image-level unsupported pose cannot claim observed eyes", v => { v.pose = "unsupported"; return v; }, true, false);
  add("unsupported-observed-null", "F", "Null points alone do not make observed+unsupported a truthful state", v => {
    v.pose = "unsupported"; v.left = { ...abstainingEye(), visibility: "observed" }; v.right = abstainingEye(); return v;
  }, true, false);
  add("confidence-one", "G", "Schema inclusive maximum 1 for observed confidence", v => { v.left.confidence = 1; return v; }, true, true, ["left", "right"]);
  add("confidence-small-positive", "G", "No additional positive confidence cutoff in contract", v => { v.left.confidence = .0001; return v; }, true, true, ["left", "right"]);
  add("observed-zero-confidence", "G", "Observed evidence must express nonzero confidence; zero is abstention convention", v => { v.left.confidence = 0; return v; }, true, false);
  add("confidence-negative", "G", "Schema minimum 0", v => { v.left.confidence = -.01; return v; }, false, false);
  add("confidence-above-one", "G", "Schema maximum 1", v => { v.left.confidence = 1.01; return v; }, false, false);
  add("confidence-string", "H", "No string-to-number coercion", v => ({ ...v, left: { ...v.left, confidence: "0.9" } }), false, false);
  add("wrong-visibility", "H", "Exact schema enum, no alias", v => ({ ...v, left: { ...v.left, visibility: "visible" } }), false, false);
  add("untrimmed-visibility", "H", "No value trimming or enum case conversion", v => ({ ...v, left: { ...v.left, visibility: "observed " } }), false, false);
  add("wrong-pose", "H", "Only schema pose literals", v => ({ ...v, pose: "tilted" }), false, false);
  add("whole-point-null", "H", "Point itself is a required object; only its x/y components are nullable", v => ({ ...v, left: { ...v.left, upperLid: null } }), false, false);
  add("missing-point", "H", "Missing differs from explicit x/y null", v => {
    const left: Partial<EyeApertureObservation["left"]> = { ...v.left }; delete left.upperLid; return { ...v, left };
  }, false, false);
  add("undefined-coordinate", "H", "undefined is not JSON null", v => ({ ...v, left: { ...v.left, upperLid: { x: undefined, y: .35 } } }), false, false);
  add("nan-coordinate", "H", "Coordinates must be finite before JSON; no coercion", v => { v.left.upperLid.x = NaN; return v; }, false, false);
  add("infinite-confidence", "H", "Numeric confidence must be finite", v => { v.left.confidence = Infinity; return v; }, false, false);
  add("coordinate-out-of-range", "H", "Schema coordinate interval [0,1]", v => { v.left.upperLid.x = -1; return v; }, false, false);
  add("eyes-swapped", "ORDER", "Viewer-left/right field mapping is fixed", v => { [v.left, v.right] = [v.right, v.left]; return v; }, true, false);
  add("left-corners-swapped", "ORDER", "Left outer is lateral, left inner is medial", v => { [v.left.outerCorner, v.left.innerCorner] = [v.left.innerCorner, v.left.outerCorner]; return v; }, true, false);
  add("left-lids-swapped", "ORDER", "Positive image-y and central chord normal distinguish lower from upper", v => { [v.left.upperLid, v.left.lowerLid] = [v.left.lowerLid, v.left.upperLid]; return v; }, true, false);
  add("unknown-reversed-corners", "ORDER", "Contradictory abstention may emit multiple dependent diagnostics, not multiple independent defects", v => {
    [v.left, v.right] = [v.right, v.left]; v.left.visibility = "unknown"; v.right.visibility = "unknown";
    v.left.confidence = 0; v.right.confidence = 0; return v;
  }, true, false);
  add("null-x-corner", "ORDER", "Nullable x defers corner comparison but cannot support observed measurement", v => { v.left.innerCorner.x = null; return v; }, true, false);
  add("null-y-reversed-corner", "ORDER", "Shape admits nullable y; corner x comparison precedes complete-landmark gate", v => {
    [v.left.outerCorner, v.left.innerCorner] = [v.left.innerCorner, v.left.outerCorner]; v.left.innerCorner.y = null; return v;
  }, true, false);
  add("shape-before-semantic", "ORDER", "Invalid enum fails structural gate before semantic corner checks", v => {
    [v.left.outerCorner, v.left.innerCorner] = [v.left.innerCorner, v.left.outerCorner];
    return { ...v, left: { ...v.left, visibility: "Observed" } };
  }, false, false);
  return samples;
}
export function evaluateExample(example: Example) {
  const shapeErrors = apertureShapeErrors(example.raw), result = validateEyeApertureObservation(example.raw, { widthPx: 200, heightPx: 100 });
  const ratios = result.ok ? deriveEyeApertureRatio(result.value) : null;
  const measured = ratios ? ["left", "right"].filter(side => ratios[side as "left" | "right"] !== null) : [];
  return { id: example.id, category: example.category, expectationBasis: example.basis,
    expected: { shapeValid: example.expectedShape, semanticContractValid: example.expectedSemantic, measurableEyes: example.expectedMeasurableEyes },
    actual: { shapeValid: shapeErrors.length === 0, semanticContractValid: result.ok,
      measurementAvailable: measured.length > 0, binocularMeasurementAvailable: ratios?.mean !== null && ratios !== null,
      measurableEyes: measured, ratios, shapeErrors, validationErrors: result.errors },
    agrees: (shapeErrors.length === 0) === example.expectedShape && result.ok === example.expectedSemantic
      && JSON.stringify(measured) === JSON.stringify(example.expectedMeasurableEyes) };
}

export function chordPlacementProbe() {
  const value = measurableExample();
  // Central ordered lids still have positive separation, but both lie below corner chord.
  value.left.upperLid.y = .41; value.left.lowerLid.y = .45;
  return { syntheticOnly: true, notAReconstruction: true,
    question: "Must the central eyelid pair straddle the corner chord, or is positive ordered perpendicular separation sufficient?",
    schemaValid: apertureShapeErrors(value).length === 0,
    promptRequiresStraddlingExplicitly: false,
    upperLidPx: 41, lowerLidPx: 45, cornerChordYPx: 40,
    actual: validateEyeApertureObservation(value, { widthPx: 200, heightPx: 100 }),
    expectedFromPromptAlone: "UNRESOLVED_CONTRACT_DECISION",
    correctionApplied: false };
}
