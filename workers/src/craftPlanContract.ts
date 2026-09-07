import type { HairPlan, HeadIdentityPlan } from "./identityPlans";
import type { OutfitAccessoryPlan, OutfitPlan } from "./outfitIdentity";
import { applyOutfitPlan } from "./outfitRenderer";
import type { RawImage } from "./png";
import { ATLAS_SIZE, CLASSIC_LAYOUT, type BodyPart, type BoxUV, type Rect } from "./uvLayout";

export interface AtlasCraftPlanContext {
  hairPlan?: HairPlan;
  headIdentityPlan?: HeadIdentityPlan;
  outfitPlan?: OutfitPlan;
}

export interface PlannedOuterGroupMeasurement {
  id: string;
  scope: "head" | "outfit";
  expectedPixels: number;
  presentPixels: number;
  expectedFaces: number;
  presentFaces: number;
  expectedColorRoles: number;
  actualColors: number;
  missingPixels: number;
  status: "satisfied" | "missing" | "unshaded";
}

export interface PlannedOuterContractMeasurement {
  status: "satisfied" | "violated" | "not_applicable";
  groups: PlannedOuterGroupMeasurement[];
  expectedGroups: number;
  satisfiedGroups: number;
  expectedConnectedFaces: number;
  actualConnectedFaces: number;
  expectedShadedGroups: number;
  actualShadedGroups: number;
  expectedPixels: number;
  presentPixels: number;
  violations: string[];
}

type Cell = { part: BodyPart; face: keyof BoxUV; x: number; y: number };

function indexFor(cell: Cell): number {
  const rect = CLASSIC_LAYOUT[cell.part].overlay[cell.face];
  return ((rect.y + cell.y) * ATLAS_SIZE + rect.x + cell.x) * 4;
}

function colorKey(atlas: RawImage, cell: Cell): string | null {
  const at = indexFor(cell);
  if (atlas.rgba[at + 3] === 0) return null;
  return `${atlas.rgba[at]}:${atlas.rgba[at + 1]}:${atlas.rgba[at + 2]}`;
}

function uniqueCells(cells: Cell[]): Cell[] {
  return [...new Map(cells.map((cell) => [`${cell.part}:${cell.face}:${cell.x},${cell.y}`, cell])).values()];
}

function measureGroup(
  atlas: RawImage,
  id: string,
  scope: PlannedOuterGroupMeasurement["scope"],
  cells: Cell[],
  expectedColorRoles: number,
  requireEveryExpectedFace: boolean,
): PlannedOuterGroupMeasurement | null {
  const expected = uniqueCells(cells);
  if (expected.length === 0) return null;
  const present = expected.filter((cell) => colorKey(atlas, cell) !== null);
  const colors = expected.map((cell) => colorKey(atlas, cell)).filter((value): value is string => value !== null);
  const presentPixels = present.length;
  const missingPixels = expected.length - presentPixels;
  const actualColors = new Set(colors).size;
  const expectedFaces = new Set(expected.map((cell) => `${cell.part}:${cell.face}`));
  const presentFaces = new Set(present.map((cell) => `${cell.part}:${cell.face}`));
  const missing = requireEveryExpectedFace
    ? [...expectedFaces].some((face) => !presentFaces.has(face))
    : presentPixels === 0;
  const unshaded = !missing && expectedColorRoles >= 2 && actualColors < 2;
  return {
    id,
    scope,
    expectedPixels: expected.length,
    presentPixels,
    expectedFaces: expectedFaces.size,
    presentFaces: presentFaces.size,
    expectedColorRoles,
    actualColors,
    missingPixels,
    status: missing ? "missing" : unshaded ? "unshaded" : "satisfied",
  };
}

function cellsIn(rect: Rect, part: BodyPart, face: keyof BoxUV, atlas: RawImage): Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
    const at = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
    if (atlas.rgba[at + 3] !== 0) cells.push({ part, face, x, y });
  }
  return cells;
}

function bodyOuterCells(atlas: RawImage): Cell[] {
  const cells: Cell[] = [];
  for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
    for (const face of Object.keys(CLASSIC_LAYOUT[part].overlay) as Array<keyof BoxUV>) {
      cells.push(...cellsIn(CLASSIC_LAYOUT[part].overlay[face], part, face, atlas));
    }
  }
  return cells;
}

function emptyAtlas(): RawImage {
  return { width: ATLAS_SIZE, height: ATLAS_SIZE, rgba: new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4) };
}

function isolatedOutfitPlan(
  plan: OutfitPlan,
  regions: OutfitPlan["outerLayer"]["regions"],
  accessories: OutfitAccessoryPlan[],
): OutfitPlan {
  return {
    ...plan,
    outerLayer: { ...plan.outerLayer, regions },
    accessories,
  };
}

function measureOutfitGroups(atlas: RawImage, plan: OutfitPlan): PlannedOuterGroupMeasurement[] {
  const groups: PlannedOuterGroupMeasurement[] = [];
  for (const region of plan.outerLayer.regions) {
    const expected = emptyAtlas();
    applyOutfitPlan(expected, isolatedOutfitPlan(plan, [region], []), "#808080");
    const cells = bodyOuterCells(expected);
    const colors = new Set(cells.map((cell) => colorKey(expected, cell)).filter(Boolean)).size;
    const measurement = measureGroup(atlas, `outfit:${region}`, "outfit", cells, colors, true);
    if (measurement) groups.push(measurement);
  }
  for (const [index, accessory] of plan.accessories.entries()) {
    const expected = emptyAtlas();
    applyOutfitPlan(expected, isolatedOutfitPlan(plan, [], [accessory]), "#808080");
    const cells = bodyOuterCells(expected);
    const colors = new Set(cells.map((cell) => colorKey(expected, cell)).filter(Boolean)).size;
    const measurement = measureGroup(atlas, `outfit:accessory:${accessory.kind}:${index}`, "outfit", cells, colors, true);
    if (measurement) groups.push(measurement);
  }
  return groups;
}

function measureHeadGroups(
  atlas: RawImage,
  hairPlan: HairPlan | undefined,
  plan: HeadIdentityPlan,
): PlannedOuterGroupMeasurement[] {
  const ownership = plan.ownership;
  if (ownership?.execution === "resolved") {
    const expected = ownership.cells.filter((cell) => cell.layer === "outer" && cell.owner !== "clear");
    const byGroup = new Map<string, typeof expected>();
    for (const cell of expected) byGroup.set(cell.sourceGroupId, [...(byGroup.get(cell.sourceGroupId) ?? []), cell]);
    return [...byGroup].flatMap(([id, cells]) => {
      const roles = new Set(cells.map((cell) => cell.role).filter(Boolean)).size;
      const measured = measureGroup(
        atlas,
        `head:${id}`,
        "head",
        cells.map((cell) => ({ part: "head", face: cell.face, x: cell.x, y: cell.y })),
        roles,
        true,
      );
      return measured ? [measured] : [];
    });
  }

  if (!hairPlan || hairPlan.lengthClass === "none") return [];
  const groups: PlannedOuterGroupMeasurement[] = [];
  for (const face of ["front", "top", "left", "right", "back"] as const) {
    const planned = hairPlan.headMask.faces[face];
    if (planned.length === 0) continue;
    const cells = planned.map((point) => ({
      part: "head" as const,
      face,
      x: point.x,
      y: point.y,
    }));
    const measured = measureGroup(atlas, `head:semantic-${face}`, "head", cells, planned.length >= 4 ? 2 : 1, false);
    if (measured) groups.push(measured);
  }
  return groups;
}

/**
 * Validate only outer-layer richness explicitly promised by the normalized
 * identity plans. Global face-count floors cannot distinguish a simple shirt
 * from a missing lapel, bun, frame, cuff or other source-derived structure.
 */
export function measurePlannedOuterContract(
  atlas: RawImage,
  hairPlan: HairPlan | undefined,
  context?: AtlasCraftPlanContext,
): PlannedOuterContractMeasurement {
  if (!context?.headIdentityPlan && !context?.outfitPlan) {
    return { status: "not_applicable", groups: [], expectedGroups: 0, satisfiedGroups: 0, expectedConnectedFaces: 0, actualConnectedFaces: 0, expectedShadedGroups: 0, actualShadedGroups: 0, expectedPixels: 0, presentPixels: 0, violations: [] };
  }
  const groups = [
    ...(context.headIdentityPlan ? measureHeadGroups(atlas, hairPlan ?? context.hairPlan, context.headIdentityPlan) : []),
    ...(context.outfitPlan ? measureOutfitGroups(atlas, context.outfitPlan) : []),
  ];
  const violations = groups.flatMap((group) => group.status === "missing"
    ? [`planned outer group missing (${group.id}: ${group.presentPixels}/${group.expectedPixels})`]
    : group.status === "unshaded"
      ? [`planned outer group lacks shading (${group.id}: ${group.actualColors}/${group.expectedColorRoles})`]
      : []);
  const ownershipCells = context.headIdentityPlan?.ownership?.execution === "resolved"
    ? context.headIdentityPlan.ownership.cells.filter((cell) => cell.layer === "outer" && cell.owner === "clear" && !cell.retain)
    : [];
  const occupiedReservedCells = ownershipCells.filter((cell) => colorKey(atlas, { part: "head", face: cell.face, x: cell.x, y: cell.y }) !== null).length;
  if (occupiedReservedCells > 0) violations.push(`planned outer ownership violated (${occupiedReservedCells} reserved cells occupied)`);
  const shaded = groups.filter((group) => group.expectedColorRoles >= 2);
  return {
    status: violations.length === 0 ? "satisfied" : "violated",
    groups,
    expectedGroups: groups.length,
    satisfiedGroups: groups.filter((group) => group.status === "satisfied").length,
    expectedConnectedFaces: groups.reduce((sum, group) => sum + group.expectedFaces, 0),
    actualConnectedFaces: groups.reduce((sum, group) => sum + group.presentFaces, 0),
    expectedShadedGroups: shaded.length,
    actualShadedGroups: shaded.filter((group) => group.status === "satisfied").length,
    expectedPixels: groups.reduce((sum, group) => sum + group.expectedPixels, 0),
    presentPixels: groups.reduce((sum, group) => sum + group.presentPixels, 0),
    violations,
  };
}
