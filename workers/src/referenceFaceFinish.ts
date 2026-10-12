/** Reference face compositor. Source measurements stay immutable; authored
 * presentation may omit mouths and translate the complete eye pair. */
import type { FacePixelPlan } from "./identityPlans";
import type { RawImage } from "./png";
import type { FaceStyle } from "./skinPack";
import { FACE_STYLE_TEMPLATES, type ReferenceStylePlan } from "./referenceStyleTemplates";
import { CLASSIC_LAYOUT } from "./uvLayout";

export interface ReferenceFacePalette {
  skinMid: readonly [number, number, number];
  skinShade: readonly [number, number, number];
  lip: readonly [number, number, number];
  /** Existing source palette only; absence does not invent an eye color. */
  eye?: readonly [number, number, number];
}
export interface ReferenceFaceFinishResult {
  mouthPresentation: "retain_source" | "omit_neutral" | "omit_style";
  eyeRowOffset: number;
  hairSpaceCells: Array<{ x: number; y: number }>;
  changedCells: Array<{ x: number; y: number }>;
  /** Authored complexion foundation; no new measured/observed feature. */
  skinWindowCells: Array<{ x: number; y: number }>;
  preservedEyeCells: number;
  expressionException: boolean;
  eyeAccentCells: Array<{ x: number; y: number }>;
  blushCells: Array<{ x: number; y: number }>;
  irisPigmentCells: Array<{ x: number; y: number; color: number[] }>;
  irisGlintCells: Array<{ x: number; y: number; color: number[] }>;
  eyePresentation: ReferenceEyePresentation;
}

export type ReferenceEyePresentation =
  | { kind: "retain_source"; cells: [] }
  | { kind: "paired_upper_catch" | "paired_upper_catch_unmeasured_brow" | "paired_lower_pigment"; cells: Array<{ x: number; y: number; color: number[] }> };

type MouthStyle = Pick<FaceStyle, "expression" | "mouthShape" | "mouthOpening" | "lipFullness" | "lipColor">;

/** Authored presentation only. Missing context and salient/protected source
 * mouths retain the source contract. Historical V1 replay keeps its two-cell
 * finish. Neither source identity nor canonical mouth measurements are edited.
 */
export function referenceMouthPresentation(
  pixels: FacePixelPlan, design: ReferenceStylePlan, sourceStyle: MouthStyle | undefined,
  protectedCells: readonly { x: number; y: number }[],
): ReferenceFaceFinishResult["mouthPresentation"] {
  if (design.faceLayoutPolicy === "mouthless_lower_eyes") return "omit_style";
  const mouth = pixels.pixels.filter(p => p.cluster === "mouth"), contract = pixels.renderContract.mouth;
  if (design.version !== "reference_style_v2" || FACE_STYLE_TEMPLATES[design.face.family].mouthCells !== 0
    || !sourceStyle || sourceStyle.expression !== "neutral" || sourceStyle.mouthShape !== "small"
    || sourceStyle.mouthOpening !== "closed" || !["thin", "average"].includes(sourceStyle.lipFullness ?? "")
    || sourceStyle.lipColor !== "natural" || !contract || contract.protected || contract.teethReadable
    || contract.preserveAsymmetry || contract.opening !== "closed" || contract.minimumPerceptualWidth > 3
    || pixels.layout.mouthWidth > 3 || pixels.protectedGeometry.includes("mouth")
    || pixels.layout.mouthExpressionTopology !== "neutral" || pixels.layout.mouthOpening !== "closed"
    || pixels.layout.mouthCornerOffsets.some(n => n !== 0) || mouth.length === 0 || mouth.length > 3
    || mouth.some(p => p.role !== "lip" || p.y <= pixels.layout.hairlineDepthByColumn[p.x]
      || protectedCells.some(c => c.x === p.x && c.y === p.y)
      || pixels.pixels.some(c => c.cluster !== "mouth" && c.cluster !== "complexion" && c.x === p.x && c.y === p.y))) return "retain_source";
  return "omit_neutral";
}

/** A separate, source-derived presentation contract. The original plan and
 * all its landmarks remain intact. The identity validator checks the explicitly
 * presented eyes/glasses; historical styles retain their mouth contract.
 */
export function referencePresentedFaceContract(
  pixels: FacePixelPlan, design: ReferenceStylePlan, sourceStyle: MouthStyle,
  protectedCells: readonly { x: number; y: number }[],
): FacePixelPlan {
  if (design.faceLayoutPolicy === "mouthless_lower_eyes") {
    const dy = referenceEyeRowOffset(pixels, design, protectedCells);
    return { ...pixels, pixels: pixels.pixels.filter(p => p.cluster !== "mouth").map(p =>
      (p.cluster === "left_eye" || p.cluster === "right_eye") && p.role !== "brow" ? { ...p, y: p.y + dy } : p),
      renderContract: { ...pixels.renderContract, mouth: undefined } };
  }
  return referenceMouthPresentation(pixels, design, sourceStyle, protectedCells) === "omit_neutral"
    ? { ...pixels, renderContract: { ...pixels.renderContract, mouth: undefined } } : pixels;
}

/** Translate the pair as a unit, never its shape/spacing/asymmetry. Source
 * materials and eyewear win over the authored lower-row preference. */
export function referenceEyeRowOffset(pixels: FacePixelPlan, design: ReferenceStylePlan,
  protectedCells: readonly { x: number; y: number }[]): number {
  if (design.faceLayoutPolicy !== "mouthless_lower_eyes" || pixels.glassesPlan.topology !== "none") return 0;
  const eyes = pixels.pixels.filter(p => (p.cluster === "left_eye" || p.cluster === "right_eye") && p.role !== "brow");
  const iris = eyes.filter(p => p.role === "iris");
  if (!iris.length || Math.min(...iris.map(p => p.y)) >= 5 || eyes.some(p => p.y >= 6)) return 0;
  if (eyes.some(p => protectedCells.some(q => q.x === p.x && (q.y === p.y || q.y === p.y + 1)))) return 0;
  return 1;
}

/** A two-row iris is not a two-row black lash. Give its existing lower row
 * source-colored pigment, leaving the upper contour, sclera, coordinates and
 * asymmetric footprints unchanged. This is authored shading, not new evidence.
 * Protected source materials always win, including an explicit role collision.
 */
export function referenceIrisPigmentCells(
  pixels: FacePixelPlan, style: ReferenceStylePlan, eye: readonly number[] | undefined,
  protectedCells: readonly { x: number; y: number }[],
  skin?: readonly number[],
): ReferenceFaceFinishResult["irisPigmentCells"] {
  if (!eye || eye.length !== 3 || eye.some(v => !Number.isFinite(v) || v < 0 || v > 255)) return [];
  const protectedKeys = new Set(protectedCells.map(p => `${p.x}:${p.y}`));
  for (const p of pixels.pixels) if (!["left_eye", "right_eye", "complexion"].includes(p.cluster) || !["iris", "skin_mid", "skin_light", "skin_shadow"].includes(p.role)) protectedKeys.add(`${p.x}:${p.y}`);
  const iris = pixels.pixels.filter(p => ["left_eye", "right_eye"].includes(p.cluster) && p.role === "iris");
  // A paired one-cell iris has no lower row to carry its source pigment.
  // Leaving only the legacy contour ink makes it merge with nearby dark hair.
  // Use the existing eye palette itself (not a white glint or invented sclera)
  // on those exact cells. Asymmetric/closed/eyewear/protected grammar stays put.
  const eyes = (["left_eye", "right_eye"] as const).map(cluster => pixels.pixels.filter(p => p.cluster === cluster && p.role !== "brow"));
  const singletonPair = style.version === "reference_style_v2" && pixels.layout.eyeTopology === "readable_iris"
    && pixels.glassesPlan.topology === "none"
    && eyes.every(points => points.length === 1 && points[0].role === "iris" && !protectedKeys.has(`${points[0].x}:${points[0].y}`))
    && eyes[0][0].x < eyes[1][0].x && eyes[0][0].y === eyes[1][0].y;
  if (singletonPair) return eyes.map(([p]) => ({ x: p.x, y: p.y, color: [...eye] }));
  const highlight = eye.map(v => Math.min(255, Math.round(v * FACE_STYLE_TEMPLATES[style.face.family].irisPigment)));
  // A pigment highlight must not cross into the complexion's palette identity.
  // Keep source eye pigment when the candidate is nearer skin than the eye;
  // no demographic thresholds, new color, landmark changes or darkening hack.
  const distance = (a: readonly number[], b: readonly number[]) => a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0);
  const validSkin = skin?.length === 3 && skin.every(v => Number.isFinite(v) && v >= 0 && v <= 255);
  const pigment = validSkin && distance(highlight, skin) <= distance(highlight, eye) ? [...eye] : highlight;
  return iris.filter(p => !protectedKeys.has(`${p.x}:${p.y}`)
    && iris.some(q => q.cluster === p.cluster && q.x === p.x && q.y === p.y - 1))
    .map(p => ({ x: p.x, y: p.y, color: [...pigment] }));
}

function mix(a: readonly number[], b: readonly number[], amount: number): number[] {
  return a.map((v, i) => Math.round(v * (1 - amount) + b[i] * amount));
}

/** Authored eye-led presentation for a categorical medium eye compressed to
 * one column/one row by the face window. It does not amend source measurements,
 * source-plan landmarks or canonical openness. Measured/protected eyes opt out.
 * The explicit lower-pigment policy expands presentation, not observed geometry.
 * Derive visibility from the immutable source atlas, never a candidate that
 * may have already pruned outer hair. Both cells must be safe or neither paints.
 */
export function referenceEyePresentation(
  pixels: FacePixelPlan, style: ReferenceStylePlan, eye: readonly number[] | undefined,
  protectedCells: readonly { x: number; y: number; owner?: string }[], sourceAtlas?: RawImage,
): ReferenceEyePresentation {
  const retain: ReferenceEyePresentation = { kind: "retain_source", cells: [] };
  const l = pixels.layout, contract = pixels.renderContract.eyes;
  const openness = l.measurementTrace?.eyeOpenness, footprint = l.measurementTrace?.eyeFootprint;
  if (style.version !== "reference_style_v2" || !sourceAtlas || sourceAtlas.width !== 64 || sourceAtlas.height !== 64
    || sourceAtlas.rgba.length !== 64 * 64 * 4 || !eye || eye.length !== 3
    || eye.some(v => !Number.isFinite(v) || v < 0 || v > 255)
    || l.geometryUsage.eyes || pixels.protectedGeometry.includes("eye_layout") || !contract || contract.protected || contract.preserveAsymmetry || contract.openness !== "readable"
    || l.eyeOpenness !== "readable" || l.eyeTopology !== "readable_iris" || l.eyeFootprintTopology !== "medium"
    || openness?.value !== "normal" || footprint?.value !== "medium"
    || openness.selected !== "categorical_grammar" || footprint.selected !== "categorical_grammar"
    || pixels.glassesPlan.topology !== "none") return retain;
  const eyes = (["left_eye", "right_eye"] as const).map(cluster => pixels.pixels.filter(p => p.cluster === cluster && p.role !== "brow"));
  if (!eyes.every(e => e.length === 1 && e[0].role === "iris")
    || eyes[0][0].y !== eyes[1][0].y || eyes[0][0].x >= eyes[1][0].x) return retain;
  const cells = eyes.map(([p]) => ({ x: p.x, y: p.y - 1 }));
  // Unknown subtle fallback brows are not measured identity. Only the exact
  // paired default cells immediately above singleton eyes may yield to the
  // authored eye-led finish. Never edit the source plan or general brow grammar.
  const browCues = [l.measurementTrace?.browEyeDistance, l.measurementTrace?.browSlope];
  const browSalience = [...l.salience.primary, ...l.salience.secondary, ...l.salience.tertiary]
    .filter(c => c.axis === "brow_position" || c.axis === "brow_strength");
  const brows = pixels.pixels.filter(p => p.role === "brow");
  const fallbackBrowPair = !l.geometryUsage.brows && l.browThickness === "subtle"
    && browCues.every(c => c?.value === "unknown" && c.provenance === "unknown" && c.confidence === 0 && c.selected === "legacy_fallback")
    && browSalience.length === 2 && browSalience.every(c => c.score === 0)
    && brows.length === 2 && cells.every((p, i) => brows.some(q => q.x === p.x && q.y === p.y && q.cluster === eyes[i][0].cluster));
  const blocked = new Set(protectedCells.map(p => `${p.x}:${p.y}`));
  const visible = (p: { x: number; y: number }) => {
    const base = CLASSIC_LAYOUT.head.base.front, outer = CLASSIC_LAYOUT.head.overlay.front;
    return sourceAtlas.rgba[((base.y + p.y) * 64 + base.x + p.x) * 4 + 3] === 255
      && sourceAtlas.rgba[((outer.y + p.y) * 64 + outer.x + p.x) * 4 + 3] === 0;
  };
  if (!eyes.every(([p]) => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 1 && p.x <= 6 && p.y >= 3 && p.y <= 6
    && !blocked.has(`${p.x}:${p.y}`) && visible(p)
    && !pixels.pixels.some(q => q.cluster !== "complexion" && (q.cluster !== p.cluster || q.role !== "iris") && q.x === p.x && q.y === p.y))) return retain;
  const upperSafe = cells.every(p => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 1 && p.x <= 6 && p.y >= 2 && p.y <= 5
      && p.y > l.hairlineDepthByColumn[p.x] && !blocked.has(`${p.x}:${p.y}`) && visible(p)
      && !pixels.pixels.some(q => q.cluster !== "complexion" && !(fallbackBrowPair && q.role === "brow") && q.x === p.x && q.y === p.y));
  const color = mix(eye, [248, 246, 240], FACE_STYLE_TEMPLATES[style.face.family].irisGlint);
  if (upperSafe) return { kind: fallbackBrowPair ? "paired_upper_catch_unmeasured_brow" : "paired_upper_catch", cells: cells.map(p => ({ ...p, color: [...color] })) };
  // A hat/fringe can own the complete upper boundary of an otherwise valid
  // categorical singleton pair. Never erase that material to force a catch.
  // Use the original row for the catch and the immediately lower free skin
  // cell for source pigment. This is a two-tone design, NOT observed geometry.
  // Both sides must have real protected upper material and a clear lower cell;
  // brow-only, unilateral, measured, mouth/other-landmark and outer collisions
  // retain the original output. Historical designs lack this explicit policy.
  const lower = eyes.map(([p]) => ({ x: p.x, y: p.y + 1 }));
  if (style.eyeBoundaryPolicy !== "paired_lower_pigment"
    || !eyes.every(([p]) => p.y > l.hairlineDepthByColumn[p.x])
    || !cells.every(p => p.y <= l.hairlineDepthByColumn[p.x]
      && protectedCells.some(c => c.x === p.x && c.y === p.y && (c.owner === "hair_base" || c.owner === "covering")))
    || !lower.every(p => p.y <= 5 && p.y < l.mouthRow && p.y > l.hairlineDepthByColumn[p.x]
      && !blocked.has(`${p.x}:${p.y}`) && visible(p)
      && !pixels.pixels.some(q => q.cluster !== "complexion" && q.x === p.x && q.y === p.y))) return retain;
  return { kind: "paired_lower_pigment", cells: eyes.flatMap(([p], i) => [
    { x: p.x, y: p.y, color: [...color] }, { ...lower[i], color: [...eye] },
  ]) };
}

/** Curated narrow two-row eye grammar: light catch above source-colored iris.
 * These are shader highlights on existing iris cells, not measured sclera or
 * new eye geometry. Only a complete pair of one-column/two-row eyes with no
 * planned sclera can use it; singleton, wide, tilted/asymmetric or protected
 * eyes retain their source grammar. Never create a half-pair around eyewear.
 */
export function referenceIrisGlintCells(
  pixels: FacePixelPlan, style: ReferenceStylePlan, eye: readonly number[] | undefined,
  protectedCells: readonly { x: number; y: number }[],
): ReferenceFaceFinishResult["irisGlintCells"] {
  if (!eye || eye.length !== 3 || eye.some(v => !Number.isFinite(v) || v < 0 || v > 255)) return [];
  const eyes = (["left_eye", "right_eye"] as const).map(cluster => pixels.pixels.filter(p => p.cluster === cluster && p.role !== "brow"));
  const top = eyes.map(points => [...points].sort((a, b) => a.y - b.y)[0]);
  if (!eyes.every((points, i) => points.length === 2 && points.every(p => p.role === "iris" && p.x === top[i].x)
    && points.some(p => p.y === top[i].y + 1)) || top[0].y !== top[1].y || top[0].x >= top[1].x) return [];
  const blocked = new Set(protectedCells.map(p => `${p.x}:${p.y}`));
  for (const p of pixels.pixels) if (!["left_eye", "right_eye", "complexion"].includes(p.cluster)
    || !["iris", "skin_mid", "skin_light", "skin_shadow"].includes(p.role)) blocked.add(`${p.x}:${p.y}`);
  if (eyes.some(points => points.some(p => blocked.has(`${p.x}:${p.y}`)))) return [];
  const color = mix(eye, [248, 246, 240], FACE_STYLE_TEMPLATES[style.face.family].irisGlint);
  return top.map(p => ({ x: p.x, y: p.y, color: [...color] }));
}

/** The template controls the resulting contrast, not a fraction of an already
 * faint lip ramp. Preserve the palette's hue direction; never invent geometry.
 * A 12–18% RGB-distance budget gives a visible but restrained two-cell mouth.
 */
function lipFinish(palette: ReferenceFacePalette, contrast: number, background: readonly number[]): number[] {
  const distance = background.reduce((sum, v, i) => sum + Math.abs(v - palette.lip[i]), 0);
  return mix(background, palette.lip, distance ? Math.min(1, 255 * contrast / distance) : 0);
}

/** Must receive source facial-hair/accessory protection from the caller.
 * This is authored presentation, not canonicalization or geometry normalization.
 * Source-atlas context enables the separately guarded categorical upper catch;
 * absent context retains the previous source footprint.
 */
export function applyReferenceFaceFinish(
  atlas: RawImage, pixels: FacePixelPlan, style: ReferenceStylePlan,
  palette: ReferenceFacePalette, protectedCells: readonly { x: number; y: number; owner?: string }[],
  sourceStyle?: MouthStyle,
  sourceAtlas?: RawImage,
): ReferenceFaceFinishResult {
  if (atlas.width !== 64 || atlas.height !== 64 || atlas.rgba.length !== 64 * 64 * 4) throw new Error("reference_face_atlas_invalid");
  if ([palette.skinMid, palette.skinShade, palette.lip, ...(palette.eye ? [palette.eye] : [])].some(rgb => rgb.length !== 3 || rgb.some(v => !Number.isFinite(v) || v < 0 || v > 255))) throw new Error("reference_face_palette_invalid");
  if (pixels.pixels.some(p => !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0 || p.x >= 8 || p.y >= 8)) throw new Error("reference_face_coordinate_invalid");
  const design = FACE_STYLE_TEMPLATES[style.face.family];
  const mouthPresentation = referenceMouthPresentation(pixels, style, sourceStyle, protectedCells);
  // Retained source mouths and legacy V1 keep their previous readable budget.
  const mouthCells = mouthPresentation === "omit_style" ? 0 : mouthPresentation === "omit_neutral" ? design.mouthCells : Math.max(2, design.mouthCells);
  // A retained mouth must satisfy its source width, even without a P5 flag.
  // Keep existing cells; never expand geometry or weaken the render contract.
  // Explicit neutral omission remains an independent presentation decision.
  const preserveMouthWidth = mouthPresentation === "retain_source"
    && (pixels.renderContract.mouth?.minimumPerceptualWidth ?? 0) > mouthCells;
  const front = CLASSIC_LAYOUT.head.base.front;
  const protectedKeys = new Set(protectedCells.map(p => `${p.x}:${p.y}`));
  // Eye/brow/fringe/glasses protection applies to general face finishing. Only
  // the separately derived iris pigment/glint plans can recolor an iris; a
  // collision with a source material can never license that exception.
  const protectedClusters = new Set(["left_eye", "right_eye", "fringe", "glasses"]);
  for (const p of pixels.pixels) if (protectedClusters.has(p.cluster) || p.role === "brow") protectedKeys.add(`${p.x}:${p.y}`);
  const original = atlas.rgba.slice();
  const skinWindowCells: ReferenceFaceFinishResult["skinWindowCells"] = [];
  const eyeAccentCells: ReferenceFaceFinishResult["eyeAccentCells"] = [], blushCells: ReferenceFaceFinishResult["blushCells"] = [];
  const paint = (x: number, y: number, color: readonly number[]) => {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 8 || y >= 8) throw new Error("reference_face_coordinate_invalid");
    if (protectedKeys.has(`${x}:${y}`)) return;
    const at = ((front.y + y) * 64 + front.x + x) * 4;
    // No alpha changes, no new pixels outside a legal base face.
    atlas.rgba.set(color.slice(0, 3), at);
  };
  // The old painter also shaded skin cells absent from FacePixelPlan. Finishing
  // only explicit complexion instructions left a literal central nose column
  // and cheek patches behind. Rebuild the available *skin window*, not the
  // measured features or material masks. No RGB guesswork: source hairline,
  // landmark roles and caller-owned beard/covering cells define eligibility.
  const landmarks = new Set(pixels.pixels.filter(p => p.cluster !== "complexion" && p.cluster !== "nose").map(p => `${p.x}:${p.y}`));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    if (y <= pixels.layout.hairlineDepthByColumn[x] || protectedKeys.has(`${x}:${y}`) || landmarks.has(`${x}:${y}`)) continue;
    // Connected, low-contrast cheek/jaw planes; no central nose highlight,
    // arbitrary speckles or changes to the source skin-color category.
    const amount = y === 7 ? design.complexionContrast : x === 0 || x === 7 ? design.complexionContrast * 0.5 : 0;
    paint(x, y, mix(palette.skinMid, palette.skinShade, amount));
    skinWindowCells.push({ x, y });
  }
  const nose = pixels.pixels.filter(p => p.cluster === "nose")
    .sort((a, b) => Math.abs(a.x - 3.5) - Math.abs(b.x - 3.5) || a.y - b.y || a.x - b.x);
  for (const [i, p] of nose.entries()) paint(p.x, p.y, i < design.noseCells ? mix(palette.skinMid, palette.skinShade, 0.08) : palette.skinMid);
  // Authored accents are template design, not new eye measurements. Keep the
  // exact iris/sclera/brow geometry and allow only a paired, available skin-window
  // accent. Never make a lone lash/blush speck by overwriting hair or a lens.
  const occupiedLandmarks = new Set(pixels.pixels.filter(p => p.cluster !== "complexion").map(p => `${p.x}:${p.y}`));
  const available = (p: { x: number; y: number }) => p.x >= 1 && p.x <= 6 && p.y >= 2 && p.y <= 6
    && p.y > pixels.layout.hairlineDepthByColumn[p.x] && !protectedKeys.has(`${p.x}:${p.y}`) && !occupiedLandmarks.has(`${p.x}:${p.y}`);
  const eyes = (["left_eye", "right_eye"] as const).map(cluster => pixels.pixels.filter(p => p.cluster === cluster && p.role === "iris"));
  if (eyes.every(points => points.length > 0)) {
    const upper = design.eyeFinish === "upper_lash" || design.eyeFinish === "upper_rim";
    const anchors = eyes.map(points => {
      const p = [...points].sort((a, b) => upper ? a.y - b.y || a.x - b.x : b.y - a.y || a.x - b.x)[0];
      return { x: p.x, y: p.y + (upper ? -1 : 1), source: p };
    });
    if (design.eyeFinish !== "clean" && anchors.every(available)) {
      for (const p of anchors) {
        const i = ((front.y + p.source.y) * 64 + front.x + p.source.x) * 4;
        const ink = upper ? [...original.slice(i, i + 3)] : design.eyeFinish === "bright" ? [255, 255, 255] : palette.skinShade;
        paint(p.x, p.y, mix(palette.skinMid, ink, upper ? 0.16 : design.eyeFinish === "bright" ? 0.08 : 0.04));
        eyeAccentCells.push({ x: p.x, y: p.y });
      }
    }
    const cheeks = eyes.map((points, index) => ({
      x: index === 0 ? Math.min(...points.map(p => p.x)) - 1 : Math.max(...points.map(p => p.x)) + 1,
      y: Math.max(...points.map(p => p.y)) + 1,
    }));
    if (design.blush && cheeks.every(p => available(p) && p.y < pixels.layout.mouthRow)) {
      for (const p of cheeks) { paint(p.x, p.y, mix(palette.skinMid, palette.lip, 0.1)); blushCells.push(p); }
    }
  }
  const mouth = pixels.pixels.filter(p => p.cluster === "mouth");
  // Preserve source teeth/opening/expression topology; a style budget is not
  // permission to turn an observed smile into a closed mouth.
  const expressionException = mouth.some(p => p.role === "teeth" || p.role === "mouth_shadow")
    || pixels.layout.mouthCornerOffsets.some(offset => offset !== 0)
    || pixels.renderContract.mouth?.preserveAsymmetry === true;
  const sortedMouth = mouth.filter(p => !protectedKeys.has(`${p.x}:${p.y}`)).sort((a, b) => Math.abs(a.x - pixels.layout.mouthCenterX) - Math.abs(b.x - pixels.layout.mouthCenterX) || a.y - b.y || a.x - b.x);
  const excludedBackground = new Set(pixels.pixels.filter(p => p.cluster !== "complexion").map(p => `${p.x}:${p.y}`));
  for (const k of protectedKeys) excludedBackground.add(k);
  const localBackground = (x: number, y: number): number[] => {
    const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
      .filter(p => p.x >= 0 && p.x < 8 && p.y >= 3 && p.y < 8 && !excludedBackground.has(`${p.x}:${p.y}`));
    if (!neighbors.length) return [...palette.skinMid];
    return [0, 1, 2].map(channel => neighbors.reduce((sum, p) => sum + atlas.rgba[((front.y + p.y) * 64 + front.x + p.x) * 4 + channel], 0) / neighbors.length);
  };
  for (const [i, p] of sortedMouth.entries()) {
    if (mouthPresentation === "omit_style") { paint(p.x, p.y, palette.skinMid); continue; }
    if (expressionException && p.role !== "lip") continue;
    paint(p.x, p.y, expressionException || preserveMouthWidth || i < mouthCells ? lipFinish(palette, design.lipContrast, localBackground(p.x, p.y)) : palette.skinMid);
  }
  const irisPigmentCells = referenceIrisPigmentCells(pixels, style, palette.eye, protectedCells, palette.skinMid);
  const irisGlintCells = referenceIrisGlintCells(pixels, style, palette.eye, protectedCells);
  const eyePresentation = referenceEyePresentation(pixels, style, palette.eye, protectedCells, sourceAtlas);
  for (const p of [...irisPigmentCells, ...irisGlintCells]) {
    const at = ((front.y + p.y) * 64 + front.x + p.x) * 4;
    atlas.rgba.set(p.color, at);
  }
  for (const p of eyePresentation.cells) {
    if (eyePresentation.kind === "paired_upper_catch_unmeasured_brow" || eyePresentation.kind === "paired_lower_pigment") {
      // This exact pair has its own independently reconstructed contract.
      // Generic face paint remains unable to overwrite any brow or landmark.
      atlas.rgba.set(p.color, ((front.y + p.y) * 64 + front.x + p.x) * 4);
    } else paint(p.x, p.y, p.color);
  }
  const eyeRowOffset = referenceEyeRowOffset(pixels, style, protectedCells);
  if (eyeRowOffset) {
    const moving = pixels.pixels.filter(p => (p.cluster === "left_eye" || p.cluster === "right_eye") && p.role !== "brow");
    const cells = [...new Map([...moving, ...eyePresentation.cells, ...eyeAccentCells]
      .map(p => [`${p.x}:${p.y}`, p])).values()];
    const beforeMove = atlas.rgba.slice();
    for (const p of cells) atlas.rgba.set(palette.skinMid, ((front.y + p.y) * 64 + front.x + p.x) * 4);
    for (const p of cells) {
      const i = ((front.y + p.y) * 64 + front.x + p.x) * 4;
      if (p.y + 1 <= 7 && !protectedCells.some(q => q.x === p.x && q.y === p.y + 1))
        atlas.rgba.set(beforeMove.slice(i, i + 3), i + 256);
    }
  }
  const hairSpaceCells: ReferenceFaceFinishResult["hairSpaceCells"] = [];
  if (eyeRowOffset && sourceAtlas && !pixels.layout.geometryUsage.hairline) {
    // Spend the freed row on existing fringe columns only. Never bridge the
    // observed part/opening, cover eyebrows, or add hair to a bald/covered head.
    const movedEyes = pixels.pixels.filter(p => (p.cluster === "left_eye" || p.cluster === "right_eye") && p.role !== "brow");
    for (let x = 1; x <= 6; x++) {
      const opening = pixels.layout.fringeOpening;
      if ((opening === "center" && (x === 3 || x === 4)) || (opening === "left" && x === 2) || (opening === "right" && x === 5)) continue;
      const roots = protectedCells.filter(p => p.x === x && p.owner === "hair_base");
      const y = Math.max(-1, ...roots.map(p => p.y)) + 1;
      if (y < 2 || y > 4 || protectedCells.some(p => p.x === x && p.y === y)
        || pixels.pixels.some(p => p.role === "brow" && p.x === x && p.y === y)
        || movedEyes.some(p => p.x === x && p.y + eyeRowOffset <= y)) continue;
      const i = ((front.y + y) * 64 + front.x + x) * 4;
      atlas.rgba.set(sourceAtlas.rgba.slice(i - 256, i - 253), i);
      hairSpaceCells.push({ x, y });
    }
  }
  const changedCells: ReferenceFaceFinishResult["changedCells"] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const at = ((front.y + y) * 64 + front.x + x) * 4;
    if ([0, 1, 2].some(c => atlas.rgba[at + c] !== original[at + c])) changedCells.push({ x, y });
  }
  return { mouthPresentation, eyeRowOffset, hairSpaceCells, changedCells, skinWindowCells, preservedEyeCells: pixels.pixels.filter(p => (p.cluster === "left_eye" || p.cluster === "right_eye") && ![...irisPigmentCells, ...irisGlintCells].some(c => c.x === p.x && c.y === p.y)).length, expressionException, eyeAccentCells, blushCells, irisPigmentCells, irisGlintCells, eyePresentation };
}
