/** Ownership-aware design validation. Never guesses hair by RGB similarity. */
import { CLASSIC_LAYOUT, getBoxUvSeams, type BodyPart, type BoxUV } from "./uvLayout";
import { REFERENCE_OUTER_COVERAGE, type ReferenceStylePlan } from "./referenceStyleTemplates";

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

// Fixed classic-UV tuple indices, not request data. Each face fits a 16x16
// coordinate slot; even a positive-neighbor lookup stays within that slot.
const partIndex: Readonly<Record<BodyPart, number>> = { head: 0, body: 1, rightArm: 2, leftArm: 3, rightLeg: 4, leftLeg: 5 };
const faceIndex: Readonly<Record<keyof BoxUV, number>> = { top: 0, bottom: 1, right: 2, front: 3, left: 4, back: 5 };
const positionKey = (part: BodyPart, layer: StyledSurfaceCell["layer"], face: keyof BoxUV, x: number, y: number) =>
  (((partIndex[part] * 2 + (layer === "overlay" ? 1 : 0)) * 6 + faceIndex[face]) * 16 + y) * 16 + x;
const cellKey = (c: StyledSurfaceCell) => positionKey(c.part, c.layer, c.face, c.x, c.y);

export function validateReferenceStyleSurfaces(cells: readonly StyledSurfaceCell[], plan: ReferenceStylePlan): ReferenceConstraintResult {
  const violations = new Set<string>();
  const unique = new Map<number, StyledSurfaceCell>();
  const shoulderColumns = new Map<string, Set<number>>();
  for (const c of cells) {
    const r = CLASSIC_LAYOUT[c.part][c.layer][c.face];
    if (!Number.isInteger(c.x) || !Number.isInteger(c.y) || c.x < 0 || c.y < 0 || c.x >= r.w || c.y >= r.h) {
      violations.add("surface_coordinate_invalid"); continue;
    }
    const key = cellKey(c);
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
  const neighbors = new Map(namedHair.map(c => [cellKey(c), new Set<number>()]));
  const connect = (a: StyledSurfaceCell, b: StyledSurfaceCell) => {
    if (a.drapeGroup !== b.drapeGroup) return;
    neighbors.get(cellKey(a))!.add(cellKey(b)); neighbors.get(cellKey(b))!.add(cellKey(a));
  };
  // These edges have fixed coordinate offsets. Look them up instead of
  // comparing every pair (and allocating a sliced array per vertex). This
  // index is request-local; labels still cannot manufacture connectivity.
  const byPosition = new Map(namedHair.map(c => [cellKey(c), c]));
  const connectAt = (a: StyledSurfaceCell, part: BodyPart, layer: StyledSurfaceCell["layer"], face: keyof BoxUV, x: number, y: number) => {
    const b = byPosition.get(positionKey(part, layer, face, x, y));
    if (b) connect(a, b);
  };
  for (const a of namedHair) {
    // Edges are undirected; each same-layer adjacency need only be visited
    // in its positive direction. Cross-layer adjacency retains both owners.
    connectAt(a, a.part, a.layer, a.face, a.x + 1, a.y);
    connectAt(a, a.part, a.layer, a.face, a.x, a.y + 1);
    if (a.layer === "base") connectAt(a, a.part, "overlay", a.face, a.x, a.y);
    for (const layer of ["base", "overlay"] as const) {
      if (a.part === "head" && a.y === 7 && (a.face === "front" && [0, 7].includes(a.x)
        || a.face === "back" && a.drapeGroup === "rear_curtain" && a.x >= 1 && a.x <= 6))
        connectAt(a, "body", layer, a.face, a.x, 0);
      if (a.part === "body" && a.face === "front") {
        if (a.x === 0) connectAt(a, "rightArm", layer, "front", 3, a.y);
        if (a.x === 7) connectAt(a, "leftArm", layer, "front", 0, a.y);
      }
    }
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
  const connected = new Set<number>();
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
  const outerCounts: Record<BodyPart, number> = { head: 0, body: 0, rightArm: 0, leftArm: 0, rightLeg: 0, leftLeg: 0 };
  let baseHairCells = 0, outerHairCells = 0;
  for (const c of unique.values()) {
    if (c.layer === "overlay") outerCounts[c.part]++;
    if (c.owner === "hair") {
      if (c.layer === "base") baseHairCells++; else outerHairCells++;
    }
  }
  for (const part of Object.keys(CLASSIC_LAYOUT) as BodyPart[]) {
    const area = Object.values(CLASSIC_LAYOUT[part].overlay).reduce((n, r) => n + r.w * r.h, 0);
    coverage[part] = outerCounts[part] / area;
    if (coverage[part] > REFERENCE_OUTER_COVERAGE[part]) violations.add(`outer_coverage:${part}`);
  }
  if (outerHairCells > baseHairCells) violations.add("hair_not_inner_first");
  return { ok: violations.size === 0, violations: [...violations].sort(), outerCoverage: coverage, baseHairCells, outerHairCells };
}
