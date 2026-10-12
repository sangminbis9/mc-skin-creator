// Frozen pre-index implementation (2026-10-11); test oracle only. Never imported by production.
/** Ownership-aware design validation. Never guesses hair by RGB similarity. */
import { CLASSIC_LAYOUT, getBoxUvSeams, type BodyPart, type BoxUV } from "../../src/uvLayout";
import { REFERENCE_OUTER_COVERAGE, type ReferenceStylePlan } from "../../src/referenceStyleTemplates";

export interface StyledSurfaceCell {
  part: BodyPart;
  face: keyof BoxUV;
  layer: "base" | "overlay";
  x: number;
  y: number;
  owner: "hair" | "garment" | "accessory" | "face" | "covering";
  /** A renderer may emit this only for a source-supported connected drape. */
  drapeGroup?: string;
}
export interface ReferenceConstraintResult {
  ok: boolean;
  violations: string[];
  outerCoverage: Record<BodyPart, number>;
  baseHairCells: number;
  outerHairCells: number;
}

export function validatePairwiseReferenceSurfaces(cells: readonly StyledSurfaceCell[], plan: ReferenceStylePlan): ReferenceConstraintResult {
  const violations = new Set<string>();
  const unique = new Map<string, StyledSurfaceCell>();
  const shoulderColumns = new Map<string, Set<number>>();
  for (const c of cells) {
    const r = CLASSIC_LAYOUT[c.part][c.layer][c.face];
    if (!Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.y < 0 || c.x >= r.w || c.y >= r.h) {
      violations.add("surface_coordinate_invalid"); continue;
    }
    const key = `${c.part}:${c.layer}:${c.face}:${c.x}:${c.y}`;
    const previous = unique.get(key);
    if (previous && previous.owner !== c.owner) violations.add("ownership_conflict");
    unique.set(key, c);
    const shoulder = ["body", "leftArm", "rightArm"].includes(c.part) && c.layer === "overlay" && (c.face === "top" || c.y < 2);
    if (shoulder && c.owner === "hair") {
      if (!plan.drape.eligible || !c.drapeGroup || c.face === "top") violations.add("hair_in_outer_upper_shoulder_zone");
      const columnKey = `${c.part}:${c.face}`;
      const columns = shoulderColumns.get(columnKey) ?? new Set<number>();
      columns.add(c.x); shoulderColumns.set(columnKey, columns);
      if (columns.size > plan.drape.maxShoulderColumns) violations.add("hair_drape_too_wide");
    }
  }
  const coverage = {} as Record<BodyPart, number>;
  // A label is not proof of continuity. Follow only same-group owned hair,
  // including physical UV seam partners, from the actual bottom head lock.
  const namedHair = [...unique.values()].filter(c => c.owner === "hair" && c.drapeGroup);
  const cellKey = (c: StyledSurfaceCell) => `${c.part}:${c.layer}:${c.face}:${c.x}:${c.y}`;
  const neighbors = new Map(namedHair.map(c => [cellKey(c), new Set<string>()]));
  const connect = (a: StyledSurfaceCell, b: StyledSurfaceCell) => {
    if (a.drapeGroup !== b.drapeGroup) return;
    neighbors.get(cellKey(a))!.add(cellKey(b)); neighbors.get(cellKey(b))!.add(cellKey(a));
  };
  for (const [i, a] of namedHair.entries()) for (const b of namedHair.slice(i + 1)) {
    const localAdjacent = a.part === b.part && a.face === b.face && (
      (a.layer === b.layer && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1)
      || (a.layer !== b.layer && a.x === b.x && a.y === b.y));
    const headBody = (h: StyledSurfaceCell, t: StyledSurfaceCell) => h.part === "head" && h.y === 7
      && (h.face === "front" && [0, 7].includes(h.x) || h.face === "back" && h.drapeGroup === "rear_curtain" && h.x >= 1 && h.x <= 6)
      && t.part === "body" && t.face === h.face && t.x === h.x && t.y === 0;
    const bodyArm = (t: StyledSurfaceCell, arm: StyledSurfaceCell) => t.part === "body" && t.face === "front" && arm.face === "front" && t.y === arm.y
      && ((t.x === 0 && arm.part === "rightArm" && arm.x === 3) || (t.x === 7 && arm.part === "leftArm" && arm.x === 0));
    if (localAdjacent || headBody(a, b) || headBody(b, a) || bodyArm(a, b) || bodyArm(b, a)) connect(a, b);
  }
  for (const part of Object.keys(CLASSIC_LAYOUT) as BodyPart[]) for (const layer of ["base", "overlay"] as const) {
    // A physical seam can connect only named hair in this part/layer. Avoid
    // constructing every cuboid's seam arrays when it has no graph vertices.
    // Keep request-local positions and all existing connectivity predicates.
    const partHair = namedHair.filter(c => c.part === part && c.layer === layer);
    if (partHair.length === 0) continue;
    const box = CLASSIC_LAYOUT[part][layer], seams = getBoxUvSeams(box);
    const positions = new Map(partHair.map(c => {
      const r = box[c.face]; return [`${r.x + c.x}:${r.y + c.y}`, c] as const;
    }));
    for (const seam of [...seams.vertical, ...seams.horizontal]) seam.primary.forEach((p, i) => {
      const q = seam.adjacent[i], a = positions.get(`${p.x}:${p.y}`), b = positions.get(`${q.x}:${q.y}`);
      if (a && b) connect(a, b);
    });
  }
  const connected = new Set<string>();
  const queue = namedHair.filter(c => c.part === "head" && c.layer === "base" && c.y === 7
    && (c.face === "front" && [0, 7].includes(c.x) || c.face === "back" && c.drapeGroup === "rear_curtain" && c.x >= 1 && c.x <= 6)).map(cellKey);
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i]; if (connected.has(k)) continue; connected.add(k);
    for (const neighbor of neighbors.get(k) ?? []) if (!connected.has(neighbor)) queue.push(neighbor);
  }
  for (const c of unique.values()) if (c.owner === "hair" && c.part !== "head") {
    const eligible = c.drapeGroup === "rear_curtain" ? plan.drape.rearCompletion === "source_supported" && c.part === "body" && c.face === "back" && c.layer === "base" : plan.drape.eligible;
    if (!eligible || !c.drapeGroup || !connected.has(cellKey(c))) violations.add("hair_drape_disconnected");
  }
  for (const part of Object.keys(CLASSIC_LAYOUT) as BodyPart[]) {
    const area = Object.values(CLASSIC_LAYOUT[part].overlay).reduce((n, r) => n + r.w * r.h, 0);
    const outer = [...unique.values()].filter(c => c.part === part && c.layer === "overlay").length;
    coverage[part] = outer / area;
    if (coverage[part] > REFERENCE_OUTER_COVERAGE[part]) violations.add(`outer_coverage:${part}`);
  }
  const hairCells = [...unique.values()].filter(c => c.owner === "hair");
  const baseHairCells = hairCells.filter(c => c.layer === "base").length;
  const outerHairCells = hairCells.length - baseHairCells;
  if (outerHairCells > baseHairCells) violations.add("hair_not_inner_first");
  return { ok: violations.size === 0, violations: [...violations].sort(), outerCoverage: coverage, baseHairCells, outerHairCells };
}
