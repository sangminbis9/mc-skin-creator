/** Source-preserving reference composition. No RGB-based ownership inference.
 * Body construction is rebuilt from the garment plan, so generic hair paint
 * cannot leak onto shoulders. Hair then adds only an explicitly authorized drape.
 */
import type { RawImage } from "./png";
import type { SkinPlan } from "./skinPlan";
import type { FaceStyle } from "./skinPack";
import type { OutfitPlan } from "./outfitIdentity";
import { applyOutfitPlan } from "./outfitRenderer";
import { applyReferenceFaceFinish, referencePresentedFaceContract } from "./referenceFaceFinish";
import { applyReferenceHeadProportion, buildReferenceHeadProportion, type ReferenceHeadProportion } from "./referenceHeadProportion";
import { applyReferenceGarmentFinish } from "./referenceGarmentFinish";
import { referenceHairMaterial, referenceLooseHairMaterial } from "./referenceMaterialDetail";
import { facialHairBaseFootprint } from "./facialHairFootprint";
import { buildReferencePairedHair, buildReferencePairedDrapePlan, type ReferencePairedHair } from "./referencePairedHair";
import { buildReferenceLooseHair, type ReferenceLooseHair } from "./referenceLooseHair";
import { buildReferenceScarfFinish, type ReferenceScarfFinish } from "./referenceScarfFinish";
import { buildReferenceShortFringe, type ReferenceShortFringe } from "./referenceShortFringe";
import { retainLayeredCrownAccent } from "./referenceLayeredCrown";
import { hasReferenceHairVolume, referenceHairVolumeGroups, referenceHairVolumeColor } from "./referenceHairVolume";
import { HAIR_STYLE_TEMPLATES, OUTFIT_STYLE_TEMPLATES, REFERENCE_OUTER_COVERAGE, type GarmentAccent, type ReferenceStylePlan } from "./referenceStyleTemplates";
import { validateReferenceStyleSurfaces, type StyledSurfaceCell } from "./referenceStyleConstraints";
import { CLASSIC_LAYOUT, getBoxUvSeams, type BodyPart, type BoxUV } from "./uvLayout";

type Rgb = [number, number, number];
type Cell = StyledSurfaceCell & { color: Rgb };
const parts = Object.keys(CLASSIC_LAYOUT) as BodyPart[];
const faces = Object.keys(CLASSIC_LAYOUT.head.base) as (keyof BoxUV)[];
function rgb(hex: string | undefined, fallback: Rgb): Rgb {
  return hex && /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16)) as Rgb : fallback;
}
function shade(c: Rgb, factor: number): Rgb { return c.map(v => Math.max(0, Math.min(255, Math.round(v * factor)))) as Rgb; }
function at(c: Pick<StyledSurfaceCell, "part" | "layer" | "face" | "x" | "y">): number {
  const r = CLASSIC_LAYOUT[c.part][c.layer][c.face]; return ((r.y + c.y) * 64 + r.x + c.x) * 4;
}
function key(c: StyledSurfaceCell): string { return `${c.part}:${c.layer}:${c.face}:${c.x}:${c.y}`; }
function clone(image: RawImage): RawImage { return { ...image, rgba: image.rgba.slice() }; }
function area(part: BodyPart): number { return faces.reduce((n, f) => { const r = CLASSIC_LAYOUT[part].overlay[f]; return n + r.w * r.h; }, 0); }
function surfaceCells(image: RawImage, part: BodyPart, layer: "base" | "overlay", owner: StyledSurfaceCell["owner"]): Cell[] {
  const cells: Cell[] = [];
  for (const face of faces) {
    const r = CLASSIC_LAYOUT[part][layer][face];
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
      const c = { part, face, layer, x, y, owner }; const i = at(c);
      if (image.rgba[i + 3]) cells.push({ ...c, color: [...image.rgba.slice(i, i + 3)] as Rgb });
    }
  }
  return cells;
}

/** Physical UV corners join three faces. Build transitive seam units before
 * selection; repairing pairs after budgeting would create new occupied cells.
 */
function buildSeamUnits(part: BodyPart): Cell[][] {
  const parent = new Map<string, string>(), positions = new Map<string, Cell>();
  const root = (k: string): string => {
    let r = k; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  const local = (x: number, y: number): Cell => {
    for (const face of faces) {
      const r = CLASSIC_LAYOUT[part].overlay[face];
      if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return { part, layer: "overlay", face, x: x - r.x, y: y - r.y, owner: "garment", color: [0, 0, 0] };
    }
    throw new Error("reference_seam_outside_uv");
  };
  const seams = getBoxUvSeams(CLASSIC_LAYOUT[part].overlay);
  for (const seam of [...seams.vertical, ...seams.horizontal]) seam.primary.forEach((p, i) => {
    const a = local(p.x, p.y), b = local(seam.adjacent[i].x, seam.adjacent[i].y);
    positions.set(key(a), a); positions.set(key(b), b); parent.set(root(key(a)), root(key(b)));
  });
  const units = new Map<string, Cell[]>();
  for (const c of positions.values()) { const r = root(key(c)); const unit = units.get(r) ?? []; unit.push(c); units.set(r, unit); }
  return [...units.values()];
}

// These six graphs depend only on CLASSIC_LAYOUT, never on a photo, plan,
// palette or candidate. Freeze every nested value: closeSeams copies cells
// before adding source material. No request-owned state survives a render.
const fixedSeamUnits = Object.freeze(Object.fromEntries(parts.map(part => [part,
  Object.freeze(buildSeamUnits(part).map(unit => Object.freeze(unit.map(cell => {
    Object.freeze(cell.color); return Object.freeze(cell);
  })))),
]))) as Readonly<Record<BodyPart, readonly (readonly Readonly<Cell>[])[]>>;
function seamUnits(part: BodyPart): readonly (readonly Readonly<Cell>[])[] {
  return fixedSeamUnits[part];
}

const facePriority = (c: Cell) => ["front", "right", "left", "back", "top", "bottom"].indexOf(c.face);
const cellPriority = (a: Cell, b: Cell) => facePriority(a) - facePriority(b) || a.y - b.y || a.x - b.x;

/** Head accents need source-owned support on every adjacent face. An explicit
 * eye/window/accessory boundary cannot be filled just to close a seam. Garment
 * construction, by contrast, may wrap its own structural cue onto the cuboid.
 */
function closeSeams(cells: Cell[], part: BodyPart, support?: Map<string, Cell>): Cell[] {
  const selected = new Map(cells.map(c => [key(c), c]));
  for (const unit of seamUnits(part)) {
    const authored = unit.map(c => selected.get(key(c))).filter((c): c is Cell => !!c).sort(cellPriority);
    if (!authored.length) continue;
    if (support && unit.some(c => !support.has(key(c)))) {
      unit.forEach(c => selected.delete(key(c))); continue;
    }
    const source = authored[0];
    for (const c of unit) selected.set(key(c), { ...(support?.get(key(c)) ?? source), ...c, owner: source.owner, color: source.color });
  }
  return [...selected.values()].sort(cellPriority);
}

/** Select whole short edge runs together with their seam partners. */
function accentRuns(cells: Cell[], part: BodyPart): Cell[][] {
  const parent = new Map(cells.map(c => [key(c), key(c)]));
  const root = (k: string): string => { let r = k; while (parent.get(r) !== r) r = parent.get(r)!; return r; };
  const join = (a: string, b: string) => parent.set(root(a), root(b));
  const runs = new Map<string, Cell[]>();
  for (const c of cells) {
    const id = `${c.face}:${c.face === "front" ? c.y : c.x}`;
    const run = runs.get(id) ?? []; run.push(c); runs.set(id, run);
  }
  for (const run of runs.values()) for (const c of run.slice(1)) join(key(run[0]), key(c));
  for (const unit of seamUnits(part)) {
    const members = unit.filter(c => parent.has(key(c)));
    for (const c of members.slice(1)) join(key(members[0]), key(c));
  }
  const groups = new Map<string, Cell[]>();
  for (const c of cells) { const r = root(key(c)); const group = groups.get(r) ?? []; group.push(c); groups.set(r, group); }
  return [...groups.values()].sort((a, b) => cellPriority(a[0], b[0]));
}

export interface ReferenceCompositionDiagnostic {
  /** Final authored projection; other face diagnostics describe its foundation. */
  headProportion?: ReferenceHeadProportion;
  version: "reference_composition_v1";
  surfaces: StyledSurfaceCell[];
  /** Executable paint contract, not a photograph or provider response. */
  surfacePixels: Array<StyledSurfaceCell & { color: Rgb }>;
  facePixels: Array<{ x: number; y: number; color: Rgb }>;
  constraints: ReturnType<typeof validateReferenceStyleSurfaces>;
  bodyGroups: Array<{ id: string; placement: "outer_structure" | "base_anchor"; cells: number; sourceCells: number; coveredByAccessoryCells: number }>;
  garmentFoldCells: number;
  hairAccentCells: number;
  coveringAccentCells: number;
  drapeCells: number;
  pairedHair: ReferencePairedHair;
  looseHair: ReferenceLooseHair;
  scarfFinish: ReferenceScarfFinish;
  shortFringe: ReferenceShortFringe;
  faceChangedCells: number;
  faceFinish: ReturnType<typeof applyReferenceFaceFinish>;
  identityGeometryUnchanged: true;
}
export interface ReferenceCompositionResult { atlas: RawImage; diagnostic: ReferenceCompositionDiagnostic; }

/** Atomic structural groups are routed before painting. If a group cannot fit
 * the outer budget its full connected cue goes on the base, not random pruning.
 */
function garmentComposition(atlas: RawImage, plan: OutfitPlan, skin: string, design: ReferenceStylePlan, ownership: Map<string, Cell>, scarf: ReferenceScarfFinish) {
  const groups: ReferenceCompositionDiagnostic["bodyGroups"] = [];
  const placedGroups: Array<{ record: ReferenceCompositionDiagnostic["bodyGroups"][number]; cells: Cell[] }> = [];
  const basePlan = { ...plan, outerLayer: { ...plan.outerLayer, regions: [] }, accessories: [] };
  applyOutfitPlan(atlas, basePlan, skin);
  const garmentFoldCells = applyReferenceGarmentFinish(atlas, basePlan, !!design.materialDetailPolicy).length;
  for (const part of parts.filter(p => p !== "head")) for (const c of surfaceCells(atlas, part, "base", "garment")) ownership.set(key(c), c);
  // Reserve the source-supported tail before structural groups. The original
  // seven-cell neck cue still takes its usual selective outer/base route.
  for (const p of scarf.paints) {
    const c: Cell = { ...p, layer: "base", owner: "accessory" };
    atlas.rgba.set([...c.color, 255], at(c)); ownership.set(key(c), c);
  }
  const groupsToRender: Array<{ id: string; plan: OutfitPlan; owner: "garment" | "accessory" }> = [
    ...plan.accessories.map(accessory => ({ id: `accessory:${accessory.kind}`, owner: "accessory" as const, plan: { ...basePlan, accessories: [accessory], outerLayer: { ...basePlan.outerLayer, regions: accessory.kind === "large_pocket" ? ["pocket" as const] : [] } } })),
    ...plan.outerLayer.regions.filter(region => region !== "pattern_depth" && region !== "graphic_depth")
      .map(region => ({ id: `structure:${region}`, owner: "garment" as const, plan: { ...basePlan, outerLayer: { ...basePlan.outerLayer, regions: [region] } } })),
  ];
  const regionAccent: Record<string, GarmentAccent> = { collar: "collar", lapels: "collar", cuffs: "cuff", hem: "hem", hood_rim: "hood_rim", skirt_pleats: "pleat", pocket: "pocket" };
  const preferred = design.outfit.family === "preserve_existing" ? [] : OUTFIT_STYLE_TEMPLATES[design.outfit.family].accents as readonly GarmentAccent[];
  const priority = (group: typeof groupsToRender[number]) => {
    if (group.owner === "accessory") return -1;
    const index = preferred.indexOf(regionAccent[group.id.split(":")[1]]);
    return index < 0 ? 100 : index;
  };
  groupsToRender.sort((a, b) => priority(a) - priority(b));
  for (const group of groupsToRender) {
    const scratch = clone(atlas); applyOutfitPlan(scratch, group.plan, skin);
    const cells = parts.filter(p => p !== "head").flatMap(p => surfaceCells(scratch, p, "overlay", group.owner));
    // A cuff fold is not a shoulder cap. Keep sleeve termination and connected
    // vertical cuff surfaces; its top-plane sketch remains part of the base.
    const candidates = cells.filter(c => !(group.id === "structure:cuffs" && (c.face === "top" || c.y === 0)));
    const sourceCells = parts.filter(p => p !== "head").flatMap(part => closeSeams(candidates.filter(c => c.part === part), part));
    // Accessories reserve visible coordinates on both possible layers. A
    // collar/hem may sit behind a scarf/bow, never overwrite it. Remove a whole
    // physical seam unit when any partner is reserved, rather than making a
    // seam hole or disguising partial structure as complete source retention.
    const reserved = new Set([...ownership.values()].filter(c => c.owner === "accessory").map(c => `${c.part}:${c.face}:${c.x}:${c.y}`));
    const covered = new Set<string>();
    if (group.owner === "garment") {
      for (const c of sourceCells) if (reserved.has(`${c.part}:${c.face}:${c.x}:${c.y}`)) covered.add(key(c));
      for (const part of parts.filter(p => p !== "head")) for (const unit of seamUnits(part)) {
        if (unit.some(c => covered.has(key(c)))) unit.forEach(c => covered.add(key(c)));
      }
    }
    const outerCells = sourceCells.filter(c => !covered.has(key(c)));
    const fits = parts.filter(p => p !== "head").every(part => {
      const occupied = new Set([...ownership.values()].filter(c => c.part === part && c.layer === "overlay").map(key));
      outerCells.filter(c => c.part === part).forEach(c => occupied.add(key(c)));
      return occupied.size / area(part) <= REFERENCE_OUTER_COVERAGE[part];
    });
    if (!fits) {
      const positions = new Set(outerCells.map(c => `${c.part}:${c.face}:${c.x}:${c.y}`));
      for (const previous of placedGroups.filter(g => g.record.placement === "outer_structure")) {
        const visible = previous.cells.filter(c => ownership.get(key(c)) === c);
        if (!visible.some(c => positions.has(`${c.part}:${c.face}:${c.x}:${c.y}`))) continue;
        // Routing a later source cue to base must not hide it behind an older
        // opaque construction. Move that entire surviving seam-closed group
        // to base first; then the later source cue retains its paint order.
        const demoted: Cell[] = [];
        for (const c of visible) {
          atlas.rgba.fill(0, at(c), at(c) + 4); ownership.delete(key(c));
          const base = { ...c, layer: "base" as const };
          atlas.rgba.set([...base.color, 255], at(base)); ownership.set(key(base), base); demoted.push(base);
        }
        previous.cells = demoted; previous.record.placement = "base_anchor";
      }
    }
    const placedCells: Cell[] = [];
    for (const c of outerCells) {
      const placed = { ...c, layer: fits ? "overlay" as const : "base" as const };
      atlas.rgba.set([...placed.color, 255], at(placed)); ownership.set(key(placed), placed);
      placedCells.push(placed);
    }
    const record: ReferenceCompositionDiagnostic["bodyGroups"][number] = { id: group.id, placement: fits ? "outer_structure" : "base_anchor", cells: outerCells.length, sourceCells: sourceCells.length, coveredByAccessoryCells: sourceCells.length - outerCells.length };
    groups.push(record); placedGroups.push({ record, cells: placedCells });
  }
  if (design.outfit.family === "black_floral_streetwear" && plan.upper.pattern.kind === "irregular_group" && plan.upper.pattern.surfaceParts === undefined) {
    // This family is eligible only from observed floral evidence. Paint an
    // authored five-cell flower, not photographic noise or a new outer shell.
    const ink = rgb(plan.upper.pattern.color, rgb(plan.upper.accentColor, [180, 90, 93]));
    const targets: BodyPart[] = /\bsleeves?\b/i.test(plan.observedConstruction) ? ["rightArm", "leftArm"] : ["body"];
    for (const part of targets) {
      const width = CLASSIC_LAYOUT[part].base.front.w;
      for (const [dx, dy] of [[0, 0], [-1, 1], [0, 1], [1, 1], [0, 2]] as const) {
        const x = Math.floor(width / 2) + dx, y = 3 + dy;
        const end = part === "rightArm" ? plan.upper.rightSleeve.terminationRow : part === "leftArm" ? plan.upper.leftSleeve.terminationRow : plan.lower.waistRow;
        if (y >= end || x < 0 || x >= width) continue;
        if ([...ownership.values()].some(c => c.part === part && c.face === "front" && c.x === x && c.y === y && c.owner === "accessory")) continue;
        const c: Cell = { part, face: "front", layer: "base", x, y, owner: "garment", color: shade(ink, dy === 1 && dx === 0 ? 0.72 : 1) };
        atlas.rgba.set([...c.color, 255], at(c)); ownership.set(key(c), c);
      }
    }
  }
  return { groups, garmentFoldCells };
}

function hairAccentAllowed(c: Cell, design: ReferenceStylePlan, plan: SkinPlan, style: FaceStyle): boolean {
  if (!retainLayeredCrownAccent(c.face, c.x, c.y, plan, design, style)) return false;
  const family = design.hair.family;
  // A continuous long-hair crown rim becomes a second cuboid even when its
  // total coverage is small. Round only the *raised* categorical crown;
  // preserve the source-owned inner mass, length, drape and all measured masks.
  // Top seam partners are supplied by closeSeams, not independently painted
  // corners that would reconnect the complete front rim.
  const hair = plan.hairPlan;
  const categoricalLooseCrown = ["medium_layered", "long_straight_with_bangs", "long_wavy_with_bangs", "long_pastel_straight"].includes(family)
    && ["medium", "long"].includes(hair.lengthClass) && !hair.surfaceOnly
    && hair.headMask.source === "semantic_template" && hair.structure.source === "semantic_analysis"
    && ["rounded", "tousled", "swept"].includes(style.hairSilhouette ?? "")
    && !plan.headIdentityPlan.ownership?.covering && !plan.headIdentityPlan.ownership?.tiedMass
    && !plan.facePixelPlan.layout.geometryUsage.hairline
    && !plan.headIdentityPlan.ownership?.cells.some(p => p.provenance === "validated_derived");
  if (categoricalLooseCrown) {
    if (c.face === "top") return false;
    if (c.y === 0) {
      if (c.face !== "front" || c.x === 0 || c.x === 7) return false;
      const rootColumns = hair.part === "center" ? [3, 4] : hair.part === "left" ? [2] : hair.part === "right" ? [5] : [];
      // Long semantic masks do not carry the short-fringe window annotation.
      // Use the independently observed opening, never infer one from part alone.
      return !style.fringeOpening || style.fringeOpening === "none" || !rootColumns.includes(c.x);
    }
  }
  // Short templates need bounded tufts, not the entire front rim plus every
  // temple/crown edge. That connected shell exceeds the accent budget and is
  // dropped as a whole, erasing dimensional short-hair differentiation.
  // These are design cells on source-owned material only; closeSeams still
  // requires each physical partner and never occupies an eye/accessory window.
  if (family === "short_shaggy_masculine" || family === "short_soft_feminine") {
    // An explicitly opened categorical short fringe may separate its raised
    // crown runs at the observed root. Keep the inner foundation intact: part
    // position alone is not evidence of exposed scalp. UV closure copies only
    // the retained runs to their supported top partners, not across this gap.
    if (c.face === "front" && c.y === 0 && hair.part !== "none"
      && hair.lengthClass === "short" && !hair.surfaceOnly
      && hair.headMask.source === "semantic_template"
      && hair.structure.source === "semantic_analysis"
      && hair.headMask.semanticSilhouette?.fringeOpening
      && !plan.facePixelPlan.layout.geometryUsage.hairline
      && !plan.headIdentityPlan.ownership?.cells.some(p => p.provenance === "validated_derived")) {
      const rootColumns = hair.part === "center" ? [3, 4] : hair.part === "left" ? [2] : [5];
      if (rootColumns.includes(c.x)) return false;
    }
    if (c.face === "front") return family === "short_shaggy_masculine"
      ? c.y === 0 && [1, 2, 5, 6].includes(c.x) || c.y === 1 && [1, 6].includes(c.x)
      : c.y === 0 && c.x >= 2 && c.x <= 5;
    // A small temple accent is separate from the crown and stops before jaw.
    if (c.face === "left" || c.face === "right") return c.x === (c.face === "right" ? 7 : 0) && c.y >= 2 && c.y <= 3;
    return false; // Only required UV seam partners may occupy the top perimeter.
  }
  const accents: readonly string[] = family === "preserve_existing" ? ["fringe", "side_lock", "crown_edge", "temple"] : HAIR_STYLE_TEMPLATES[family].accents;
  if (c.face === "front") return (accents.includes("fringe") && c.y <= 3 && c.x >= 1 && c.x <= 6)
    || ((accents.includes("side_lock") || accents.includes("temple") || accents.includes("braid_front") || accents.includes("tied_section")) && (c.x === 0 || c.x === 7));
  if (c.face === "top") return accents.includes("crown_edge") && (c.x === 0 || c.x === 7) && (c.y === 0 || c.y === 7);
  if (c.face === "back") return accents.includes("side_lock") && (c.x === 0 || c.x === 7) && c.y >= 2;
  return c.face !== "bottom" && ((accents.includes("crown_edge") && c.y === 0 && c.x >= 1 && c.x <= 6)
    || ((accents.includes("side_lock") || accents.includes("temple") || accents.includes("tied_section")) && c.x === (c.face === "right" ? 7 : 0) && c.y >= 2));
}

/** Source-owned material finishing, never a new mask or eye/hair measurement.
 * Near-black coily material needs a small neutral reflection: multiplication
 * alone cannot separate a zero-valued curl from a zero-valued foundation.
 * The two-cell arcs are deterministic connected texture, not random speckle.
 */
export function referenceBaseHairColor(color: Rgb, c: Pick<Cell, "x" | "y" | "face">, plan: SkinPlan, design: ReferenceStylePlan, style?: FaceStyle): Rgb {
  if (design.hairPalettePolicy === "continuous_material" && design.hair.family !== "preserve_existing"
    && style?.hairColor && /^#[0-9a-f]{6}$/i.test(style.hairColor) && !plan.hairPlan.surfaceOnly) {
    // One source material ramp on every owned head face. The old atlas's
    // independently shaded dark side/nape band must not become a second color.
    const material = rgb(style.hairColor, color);
    if (design.materialDetailPolicy) {
      const color = referenceHairMaterial(material, c.face, c.x, c.y, style, false, design.materialDetailPolicy);
      return hasReferenceHairVolume(plan, design, style) ? referenceHairVolumeColor(color, material, c, style) : color;
    }
    const band = c.face === "top" ? 1 : 1 - Math.min(c.y, 6) * 0.015;
    const strand = (c.x + Math.floor(c.y / 3)) % 4 === 1 ? 1.08 : 1;
    return shade(material, band * strand);
  }
  if (design.hair.family === "preserve_existing") {
    const texture = plan.hairPlan.structure.grammar;
    const categoricalCurls = texture === "curl_lobes" && plan.hairPlan.headMask.semanticSilhouette?.profileOpening === "curly_ringlets";
    if (!(texture === "coily_clusters" || categoricalCurls) || plan.hairPlan.surfaceOnly) return [...color];
    const arc = (c.x % 3 === 0 && c.y % 3 <= 1) || (c.x % 3 === 1 && c.y % 3 === 0);
    if (!arc) return [...color];
    const dark = Math.max(...color) <= 48;
    return color.map(v => Math.min(255, Math.round(v * 1.1) + (dark ? categoricalCurls ? 12 : 8 : 0))) as Rgb;
  }
  const grammar = HAIR_STYLE_TEMPLATES[design.hair.family].strandGrammar;
  const highlight = grammar === "braid" ? (c.x + c.y) % 3 === 0
    : grammar === "wave" ? (c.x + Math.floor(c.y / 2)) % 4 === 0
    : grammar === "paired_locks" ? (c.x === 0 || c.x === 7) && c.y % 3 === 0
    : grammar === "staggered" ? (c.x + c.y * 2) % 5 === 0
    : grammar === "layered" ? c.y % 4 === 2 && c.x % 3 === 0
    : c.x % 4 === 1 && c.y >= 2;
  return highlight ? shade(color, grammar === "soft" ? 1.06 : 1.12) : [...color];
}

/** Separately executable presentation stage. Legacy source construction and
 * its diagnostics are retained; the final eye/outline contract is explicit. */
export function composeReferenceStyleAtlas(baseline: RawImage, plan: SkinPlan, design: ReferenceStylePlan, style: FaceStyle): ReferenceCompositionResult {
  const result = composeReferenceStyleFoundation(baseline, plan, design, style);
  if (design.headProportionPolicy) {
    const projection = deriveCompositionHeadProportion(result, plan, design, style);
    applyReferenceHeadProportion(result.atlas, projection);
    result.diagnostic.headProportion = projection;
  }
  return result;
}

export function deriveCompositionHeadProportion(foundation: ReferenceCompositionResult, plan: SkinPlan, design: ReferenceStylePlan, style: FaceStyle) {
  const materials = plan.headIdentityPlan.ownership?.cells.filter(c => c.layer === "base" && c.face === "front" && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner)) ?? [];
  const displayed = referencePresentedFaceContract(plan.facePixelPlan, design, style,
    [...facialHairBaseFootprint(style), ...materials, ...buildReferencePairedDrapePlan(plan, design, style).junctions]);
  const finish = foundation.diagnostic.faceFinish;
  const extra = [...finish.eyePresentation.cells, ...finish.eyeAccentCells].map(p => ({ x: p.x, y: p.y + finish.eyeRowOffset,
    role: "iris" as const, cluster: p.x < 4 ? "left_eye" as const : "right_eye" as const }));
  return buildReferenceHeadProportion(plan, design, style, foundation.atlas, { ...displayed, pixels: [...displayed.pixels, ...extra] },
    foundation.diagnostic.surfaces.filter(c => c.part === "head" && c.layer === "base" && c.owner === "hair"));
}

function composeReferenceStyleFoundation(baseline: RawImage, plan: SkinPlan, design: ReferenceStylePlan, style: FaceStyle): ReferenceCompositionResult {
  if (baseline.width !== 64 || baseline.height !== 64 || baseline.rgba.length !== 16384) throw new Error("reference_composition_atlas_invalid");
  const head = plan.headIdentityPlan.ownership;
  if (!head || head.execution !== "resolved") throw new Error("reference_composition_head_ownership_unresolved");
  const atlas = clone(baseline), ownership = new Map<string, Cell>();
  const skin = rgb(style.skinTone, [211, 158, 128]), hair = rgb(style.hairColor, [57, 42, 33]);
  const scarfFinish = buildReferenceScarfFinish(plan, style.skinTone ?? "#d39e80");
  const garment = garmentComposition(atlas, plan.outfitPlan, style.skinTone ?? "#d39e80", design, ownership, scarfFinish);
  const bodyGroups = garment.groups;
  const protectedFace = new Set(plan.facePixelPlan.pixels.filter(p => ["left_eye", "right_eye", "glasses", "mouth"].includes(p.cluster) || p.role === "brow").map(p => `${p.x}:${p.y}`));
  const baseHair: Cell[] = [], accents: Cell[] = [], sourceOuterHair = new Map<string, Cell>();
  const coveringBase = new Set(head.cells.filter(c => c.layer === "base" && c.owner === "covering").map(c => `${c.face}:${c.x}:${c.y}`));
  const coveringAccents: Cell[] = [], sourceOuterCovering = new Map<string, Cell>();
  const pairedHair = buildReferencePairedHair(plan, design);
  const shortFringe = buildReferenceShortFringe(plan, design, style);
  const coilyAccentKeys = new Set(plan.hairPlan.structure.grammar === "coily_clusters"
    ? plan.hairPlan.structure.groups.filter(g => g.kind === "coily_cluster").flatMap(g => g.points.filter(p => p.layer === "outer").map(p => `${p.face}:${p.x}:${p.y}`)) : []);
  const categoricalCurls = plan.hairPlan.headMask.semanticSilhouette?.profileOpening === "curly_ringlets";
  const curlAccentKeys = new Set(categoricalCurls
    ? plan.hairPlan.structure.groups.filter(g => g.kind === "curl_lobe").flatMap(g => g.points.filter(p => p.layer === "outer").map(p => `${p.face}:${p.x}:${p.y}`)) : []);
  // Finish foundations before promoting a covering pattern from its outer
  // layer. Interleaved input cells must not reset its executable base color.
  const headCells = [...head.cells].sort((a, b) => Number(a.layer === "outer") - Number(b.layer === "outer"));
  for (const c of headCells) {
    const layer = c.layer === "outer" ? "overlay" as const : "base" as const;
    const pos = { part: "head" as const, face: c.face, layer, x: c.x, y: c.y };
    const offset = at(pos);
    if (layer === "overlay" && (c.owner === "clear" || c.owner === "hair_outer" || c.owner === "covering")) atlas.rgba.fill(0, offset, offset + 4);
    if (c.owner === "hair_base") {
      if (c.face === "front" && protectedFace.has(`${c.x}:${c.y}`)) continue;
      if (shortFringe.windows.some(p => p.face === c.face && p.x === c.x && p.y === c.y)) {
        const cell: Cell = { ...pos, owner: "face", color: [...skin] };
        atlas.rgba.set([...cell.color, 255], offset); ownership.set(key(cell), cell); continue;
      }
      if (pairedHair.nape.some(p => p.face === c.face && p.x === c.x && p.y === c.y)) {
        const cell: Cell = { ...pos, owner: "face", color: shade(skin, 0.78) };
        atlas.rgba.set([...cell.color, 255], offset); ownership.set(key(cell), cell); continue;
      }
      const color = [...baseline.rgba.slice(offset, offset + 3)] as Rgb;
      const cell: Cell = { ...pos, owner: "hair", color }; baseHair.push(cell); ownership.set(key(cell), cell);
    } else if (c.owner === "hair_outer") {
      if (c.face === "front" && protectedFace.has(`${c.x}:${c.y}`)) continue;
      const cell: Cell = { ...pos, owner: "hair", color: shade(hair, c.face === "back" ? 0.84 : 1) };
      if (design.materialDetailPolicy && design.hair.family !== "preserve_existing" && !plan.hairPlan.surfaceOnly)
        cell.color = referenceHairMaterial(hair, c.face, c.x, c.y, style, true, design.materialDetailPolicy);
      sourceOuterHair.set(key(cell), cell);
      // Two attached crown rises, separated by a lower centre/outer corner,
      // read as rounded curls rather than a straight inflated helmet rim.
      // Keep actual clipped lobe footprints and intermittent front ringlets.
      // These are template accent positions on source-owned material only.
      const curlAccent = curlAccentKeys.has(`${c.face}:${c.x}:${c.y}`) ||
        c.face === "front" && (c.y === 0 && [1, 2, 5, 6].includes(c.x) || c.y >= 2 && c.y % 2 === 0 && (c.x === 0 || c.x === 7));
      if (categoricalCurls ? curlAccent : hairAccentAllowed(cell, design, plan, style) || coilyAccentKeys.has(`${c.face}:${c.x}:${c.y}`)) accents.push(cell);
    } else if (c.owner === "covering") {
      const cell: Cell = { ...pos, owner: "covering", color: [...baseline.rgba.slice(offset, offset + 3)] as Rgb };
      if (layer === "base") ownership.set(key(cell), cell);
      else if (baseline.rgba[offset + 3] && coveringBase.has(`${c.face}:${c.x}:${c.y}`)) {
        // Retain the actual scarf pattern on its source-owned foundation. A
        // source covering is not permission for a full inflated outer shell.
        const foundation: Cell = { ...cell, layer: "base" };
        atlas.rgba.set([...cell.color, 255], at(foundation)); ownership.set(key(foundation), foundation);
        sourceOuterCovering.set(key(cell), cell);
        const border = [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => !coveringBase.has(`${c.face}:${c.x + dx}:${c.y + dy}`));
        if (border) coveringAccents.push(cell);
      }
    } else if (c.owner === "face" && layer === "base" && ["semantic-fringe-window", "semantic-fringe-length-window"].includes(c.sourceGroupId)) {
      const cell: Cell = { ...pos, owner: "face", color: [...skin] };
      atlas.rgba.set([...cell.color, 255], offset); ownership.set(key(cell), cell);
    } else if (c.owner !== "clear" && layer === "overlay" && baseline.rgba[offset + 3]) {
      const cell: Cell = { ...pos, owner: "accessory", color: [...baseline.rgba.slice(offset, offset + 3)] as Rgb };
      ownership.set(key(cell), cell);
    }
  }
  // Whole seam-connected edge groups add a fitted rim. A group that cannot fit remains
  // fully represented on the base; no pixelwise budget pruning or cue deletion.
  let coveringAccentCells = 0;
  for (const group of accentRuns(closeSeams(coveringAccents, "head", sourceOuterCovering), "head")) {
    const occupied = [...ownership.values()].filter(c => c.part === "head" && c.layer === "overlay").length;
    if (occupied + group.length > Math.floor(area("head") * REFERENCE_OUTER_COVERAGE.head)) continue;
    for (const c of group) { atlas.rgba.set([...c.color, 255], at(c)); ownership.set(key(c), c); }
    coveringAccentCells += group.length;
  }
  // Keep legacy silhouette accents attached to existing source hair. Crown
  // relief below uses separate whole bundles, within the same fixed budget.
  const ratio = design.hair.family === "preserve_existing" ? 0.3 : HAIR_STYLE_TEMPLATES[design.hair.family].outerHairRatio;
  const occupiedHeadOuter = [...ownership.values()].filter(c => c.part === "head" && c.layer === "overlay").length;
  const maxAccents = Math.max(0, Math.min(Math.floor(baseHair.length * ratio / (1 - ratio)), Math.floor(area("head") * REFERENCE_OUTER_COVERAGE.head) - occupiedHeadOuter));
  const baseKeys = new Set(baseHair.map(c => `${c.face}:${c.x}:${c.y}`));
  for (const p of pairedHair.accents) {
    const cell: Cell = { ...p, part: "head", layer: "overlay", owner: "hair", color: shade(hair, 0.84) };
    sourceOuterHair.set(key(cell), cell); accents.push(cell);
  }
  const support = new Map([...sourceOuterHair].filter(([, c]) => baseKeys.has(`${c.face}:${c.x}:${c.y}`)));
  const supportedAccents = closeSeams(accents.filter(c => support.has(key(c))), "head", support);
  // A silhouette accent is a short connected run on a source-owned edge.
  // Emit entire runs where possible; never scatter random crown speckles.
  let hairAccentCells = 0;
  for (const run of accentRuns(supportedAccents, "head")) {
    if (hairAccentCells + run.length > maxAccents) continue;
    for (const c of run) { atlas.rgba.set([...c.color, 255], at(c)); ownership.set(key(c), c); }
    hairAccentCells += run.length;
  }
  if (hasReferenceHairVolume(plan, design, style)) {
    const outer = new Map(head.cells.filter(c => c.layer === "outer").map(c => [`${c.face}:${c.x}:${c.y}`, c]));
    for (const group of referenceHairVolumeGroups(style)) {
      // Only ordinary hair/clear outer space above actual owned base hair.
      // Never overwrite a source accessory or a semantic/validated opening.
      if (!group.every(p => {
        const k = `${p.face}:${p.x}:${p.y}`, c = outer.get(k);
        return baseKeys.has(k) && c && ["clear", "hair_outer"].includes(c.owner)
          && !/window/.test(c.sourceGroupId);
      })) continue;
      const cells: Cell[] = group.map(p => ({ ...p, part: "head", layer: "overlay", owner: "hair",
        color: referenceHairVolumeColor(referenceHairMaterial(hair, p.face, p.x, p.y, style, true, design.materialDetailPolicy), hair, p, style, true) }));
      const added = cells.filter(c => !ownership.has(key(c))).length;
      if (hairAccentCells + added > maxAccents) continue;
      for (const c of cells) { atlas.rgba.set([...c.color, 255], at(c)); ownership.set(key(c), c); }
      hairAccentCells += added;
    }
  }
  // Strand finishing follows the owned foundation, including an explicitly
  // authored semantic paired completion; it never overwrites an eye window.
  for (const c of baseHair) {
    c.color = referenceBaseHairColor(c.color, c, plan, design, style);
    atlas.rgba.set(c.color, at(c));
  }
  let drapeCells = 0;
  const pairedDrapePlan = buildReferencePairedDrapePlan(plan, design, style);
  const pairedDrape = pairedDrapePlan.points;
  for (const p of pairedDrapePlan.junctions) {
    const c: Cell = { ...p, part: "head", layer: "base", owner: "hair", color: [...hair] };
    atlas.rgba.set([...c.color, 255], at(c)); baseHair.push(c); ownership.set(key(c), c);
  }
  const looseHair = buildReferenceLooseHair(plan, design, style);
  if (pairedDrape.length) {
    for (const [headX, name] of [[0, "left_lock"], [7, "right_lock"]] as const) {
      const points = pairedDrape.filter(c => c.drapeGroup === name);
      if (!points.length) continue;
      const origin = baseHair.find(c => c.face === "front" && c.x === headX && c.y === 7);
      if (!origin) continue;
      origin.drapeGroup = name; ownership.set(key(origin), origin);
      for (const { x, y } of points) {
        const c: Cell = { part: "body", face: "front", layer: "base", x, y, owner: "hair", drapeGroup: name, color: shade(hair, design.hair.family === "twin_braids" && y % 2 ? 1.16 : 1) };
        atlas.rgba.set([...c.color, 255], at(c)); ownership.set(key(c), c); drapeCells++;
      }
    }
  }
  for (const root of looseHair.roots) {
    const origin = baseHair.find(c => c.face === root.face && c.x === root.x && c.y === root.y);
    if (!origin) throw new Error("reference_composition_loose_hair_root_missing");
    origin.drapeGroup = root.drapeGroup;
  }
  for (const p of looseHair.points) {
    const c: Cell = { part: "body", face: p.face, layer: "base", x: p.x, y: p.y, drapeGroup: p.drapeGroup, owner: "hair", color: referenceLooseHairMaterial(hair, p, style, design.hair.family !== "preserve_existing" && (design.materialDetailPolicy ?? false)) };
    atlas.rgba.set([...c.color, 255], at(c)); ownership.set(key(c), c); drapeCells++;
  }
  // Use the same authored footprint as the production painter, not an entire
  // lower-face rectangle that also suppresses mouth and complexion finishing.
  const protectedBeard = facialHairBaseFootprint(style);
  const protectedMaterial = head.cells.filter(c => c.layer === "base" && c.face === "front" && ["hair_base", "covering", "tied_hair", "other_p5"].includes(c.owner));
  const face = applyReferenceFaceFinish(atlas, plan.facePixelPlan, design, {
    skinMid: skin, skinShade: shade(skin, 0.78), lip: [Math.max(0, skin[0] - 18), Math.max(0, skin[1] - 45), Math.max(0, skin[2] - 45)],
    eye: style.eyeColor && /^#[0-9a-f]{6}$/i.test(style.eyeColor) ? rgb(style.eyeColor, [0, 0, 0]) : undefined,
  }, [...protectedBeard, ...protectedMaterial, ...pairedDrapePlan.junctions], style, baseline);
  const surfaces = [...ownership.values()].map(({ color: _color, ...c }) => { void _color; return c; });
  const constraints = validateReferenceStyleSurfaces(surfaces, design);
  if (!constraints.ok) throw new Error(`reference_composition_constraints:${constraints.violations.join(",")}`);
  const surfacePixels = [...ownership.values()].map(c => ({ ...c, color: [...c.color] as Rgb }));
  const front = CLASSIC_LAYOUT.head.base.front;
  const facePixels = face.changedCells.map(p => ({ ...p, color: [...atlas.rgba.slice(((front.y + p.y) * 64 + front.x + p.x) * 4, ((front.y + p.y) * 64 + front.x + p.x) * 4 + 3)] as Rgb }));
  return { atlas, diagnostic: { version: "reference_composition_v1", surfaces, surfacePixels, facePixels, constraints, bodyGroups, garmentFoldCells: garment.garmentFoldCells, hairAccentCells, coveringAccentCells, drapeCells, pairedHair, looseHair, scarfFinish, shortFringe, faceChangedCells: face.changedCells.length, faceFinish: face, identityGeometryUnchanged: true } };
}
