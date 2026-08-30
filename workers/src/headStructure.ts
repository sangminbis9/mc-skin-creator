import type { PhotoAnalysis } from "./analysis";
import type { FaceLayoutPlan } from "./identityQuantization";
import type { HeadMaskFace, HeadMaskPlan } from "./identityPlans";

export type HairTextureGrammar = "straight_bands" | "wavy_bands" | "curl_lobes" | "coily_clusters" | "lock_groups";
export type HairStructureKind = "foundation" | "fringe" | "temple" | "side_lock" | "strand_band" | "curl_lobe" | "coily_cluster" | "lock_group" | "crown_flow";
export type HairDirection = "down" | "down_left" | "down_right" | "outward_left" | "outward_right" | "compact";
export type HairStructureRole = "shadow" | "mid" | "light" | "tip" | "part_light" | "part_shadow";

export interface HairStructurePoint {
  face: HeadMaskFace;
  layer: "base" | "outer";
  x: number;
  y: number;
  role: HairStructureRole;
}

export interface HairStructureGroup {
  id: string;
  kind: HairStructureKind;
  direction: HairDirection;
  identityImportance: 1 | 2 | 3 | 4 | 5;
  points: HairStructurePoint[];
}

export interface HairStructurePlan {
  source: "identity_geometry" | "semantic_analysis";
  grammar: HairTextureGrammar;
  fringe: {
    groupIds: string[];
    openingColumns: number[];
    irregularity: "none" | "measured_step" | "wispy_endpoints";
  };
  temples: { leftGroupId: string | null; rightGroupId: string | null };
  sideLocks: { leftGroupIds: string[]; rightGroupIds: string[] };
  textureGroupIds: string[];
  partChannel: {
    column: number | null;
    direction: "none" | "center" | "left" | "right";
    points: HairStructurePoint[];
  };
  groups: HairStructureGroup[];
  requiredGroupIds: string[];
}

export type GlassesTopology = "none" | "round_thin" | "round_heavy" | "rectangular_thin" | "rectangular_heavy" | "oversized";
export type GlassesPixelRole = "rim_shadow" | "rim_mid" | "rim_light" | "bridge";

export interface GlassesStructurePixel {
  face: "front" | "left" | "right";
  x: number;
  y: number;
  role: GlassesPixelRole;
}

export interface GlassesStructurePlan {
  topology: GlassesTopology;
  framePixels: GlassesStructurePixel[];
  lensOpenings: Array<{ x: number; y: number }>;
  sideArms: GlassesStructurePixel[];
  minimumReadablePixels: number;
  preserveThinness: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function hairIdentityImportance(analysis: PhotoAnalysis): 1 | 2 | 3 | 4 | 5 {
  const priority = analysis.canonicalIdentity.features
    .filter((feature) => feature.category === "hair" || feature.category === "silhouette")
    .reduce((maximum, feature) => Math.max(maximum, feature.priority), 1);
  return clamp(priority, 1, 5) as 1 | 2 | 3 | 4 | 5;
}

function textureGrammar(analysis: PhotoAnalysis): HairTextureGrammar {
  const text = `${analysis.observed.hair} ${analysis.identityPrompt} ${analysis.canonicalIdentity.overallImpression} ${analysis.canonicalIdentity.mustPreserve.join(" ")}`.toLowerCase();
  if (/dread|\blocs?\b|lock group/.test(text)) return "lock_groups";
  if (analysis.renderHints.hairTexture === "coily") return "coily_clusters";
  if (analysis.renderHints.hairTexture === "curly") return "curl_lobes";
  if (analysis.renderHints.hairTexture === "wavy") return "wavy_bands";
  return "straight_bands";
}

function geometryPhase(analysis: PhotoAnalysis): number {
  const geometry = analysis.identityGeometry;
  if (!geometry) {
    const part = analysis.renderHints.hairPart === "left" ? 1 : analysis.renderHints.hairPart === "right" ? 2 : 0;
    return (part + analysis.renderHints.hairVolume.length + analysis.renderHints.fringeEdge.length) % 5;
  }
  const silhouette = geometry.headSilhouette;
  const values = [
    silhouette.sideVolumeLeft,
    silhouette.sideVolumeRight,
    silhouette.hairEndpointLeftY,
    silhouette.hairEndpointRightY,
    silhouette.foreheadExposure,
    geometry.hairline.asymmetry,
  ];
  return Math.abs(Math.round(values.reduce((sum, value, index) => sum + value * (index + 3) * 17, 0))) % 7;
}

function pointKey(point: Pick<HairStructurePoint, "face" | "layer" | "x" | "y">): string {
  return `${point.layer}:${point.face}:${point.x},${point.y}`;
}

function uniquePoints(points: HairStructurePoint[]): HairStructurePoint[] {
  const seen = new Set<string>();
  return points.filter((point) => {
    if (point.x < 0 || point.x > 7 || point.y < 0 || point.y > 7) return false;
    const key = pointKey(point);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function largestConnectedComponent(points: HairStructurePoint[]): HairStructurePoint[] {
  const remaining = new Map(points.map((point) => [pointKey(point), point]));
  const components: HairStructurePoint[][] = [];
  while (remaining.size > 0) {
    const seed = remaining.values().next().value as HairStructurePoint;
    const queue = [seed];
    const component: HairStructurePoint[] = [];
    remaining.delete(pointKey(seed));
    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const key = `${current.layer}:${current.face}:${current.x + dx},${current.y + dy}`;
        const neighbor = remaining.get(key);
        if (!neighbor) continue;
        remaining.delete(key);
        queue.push(neighbor);
      }
    }
    components.push(component);
  }
  return components.sort((first, second) => second.length - first.length)[0] ?? [];
}

function runGroups(columns: number[]): number[][] {
  const sorted = [...new Set(columns)].sort((a, b) => a - b);
  const groups: number[][] = [];
  for (const column of sorted) {
    const last = groups.at(-1);
    if (!last || column > last.at(-1)! + 1) groups.push([column]);
    else last.push(column);
  }
  return groups;
}

function maskSet(headMask: HeadMaskPlan, face: HeadMaskFace): Set<string> {
  return new Set(headMask.faces[face].map((point) => `${point.x},${point.y}`));
}

function clippedPath(
  headMask: HeadMaskPlan,
  face: HeadMaskFace,
  coordinates: Array<[number, number]>,
  role: HairStructureRole,
): HairStructurePoint[] {
  const allowed = maskSet(headMask, face);
  return uniquePoints(coordinates
    // Physical UV seam cells remain owned by HeadMaskPlan/seam reconciliation.
    // Identity texture groups occupy the interior so a highlight cannot split
    // one connected outer shell into differently coloured cube edges.
    .filter(([x, y]) => x > 0 && x < 7 && y > 0 && y < 7 && allowed.has(`${x},${y}`))
    .map(([x, y]) => ({ face, layer: "outer" as const, x, y, role })));
}

/** Convert measured geometry into connected low-resolution visual groups. */
export function buildHairStructurePlan(
  analysis: PhotoAnalysis,
  layout: FaceLayoutPlan,
  headMask: HeadMaskPlan,
): HairStructurePlan {
  const grammar = textureGrammar(analysis);
  const phase = geometryPhase(analysis);
  const importance = hairIdentityImportance(analysis);
  const groups: HairStructureGroup[] = [];
  const addGroup = (group: Omit<HairStructureGroup, "identityImportance" | "points"> & { points: HairStructurePoint[] }) => {
    const points = largestConnectedComponent(uniquePoints(group.points));
    if (points.length < 2) return null;
    groups.push({ ...group, identityImportance: importance, points });
    return group.id;
  };

  const partColumn = headMask.partColumn ?? (analysis.renderHints.hairPart === "center" ? 3 : analysis.renderHints.hairPart === "left" ? 2 : analysis.renderHints.hairPart === "right" ? 5 : null);
  const openingColumns = analysis.renderHints.fringeOpening === "center"
    ? [3, 4]
    : analysis.renderHints.fringeOpening === "left"
      ? [2]
      : analysis.renderHints.fringeOpening === "right"
        ? [5]
        : partColumn === null ? [] : [partColumn];
  const fringeColumns = Array.from({ length: 8 }, (_, x) => x)
    .filter((x) => layout.hairlineDepthByColumn[x] > 0 && !openingColumns.includes(x));
  const fringeGroupIds = runGroups(fringeColumns).flatMap((columns, index) => {
    const points = columns.flatMap((x) => Array.from({ length: layout.hairlineDepthByColumn[x] }, (_, y) => ({
      face: "front" as const,
      layer: "base" as const,
      x,
      y,
      role: y === layout.hairlineDepthByColumn[x] - 1 ? "tip" as const : x < 4 ? "mid" as const : "shadow" as const,
    })));
    const id = addGroup({ id: `fringe-${index + 1}`, kind: "fringe", direction: columns.every((x) => x < 4) ? "down_right" : "down_left", points });
    return id ? [id] : [];
  });

  const templeIds: Array<string | null> = [0, 7].map((x, index) => {
    const endpoint = index === 0 ? headMask.endpointRows.left : headMask.endpointRows.right;
    const maximumY = Math.min(6, Math.max(2, endpoint));
    const points = Array.from({ length: maximumY }, (_, offset) => ({
      face: "front" as const,
      layer: "base" as const,
      x,
      y: offset + 1,
      role: offset === maximumY - 1 ? "tip" as const : "shadow" as const,
    }));
    return addGroup({ id: index === 0 ? "temple-left" : "temple-right", kind: "temple", direction: "down", points });
  });

  const sideLockIds = { left: [] as string[], right: [] as string[] };
  for (const [side, face, endpoint, outerX] of [
    ["left", "left", headMask.endpointRows.left, 0],
    ["right", "right", headMask.endpointRows.right, 7],
  ] as const) {
    if (analysis.renderHints.sideHairLength === "none" || analysis.renderHints.sideHairLength === "short") continue;
    const coordinates: Array<[number, number]> = [];
    for (let y = 1; y <= endpoint; y++) coordinates.push([outerX, y]);
    const id = addGroup({
      id: `side-lock-${side}`,
      kind: "side_lock",
      direction: side === "left" ? "outward_left" : "outward_right",
      points: clippedPath(headMask, face, coordinates, "tip"),
    });
    if (id) sideLockIds[side].push(id);
  }

  const partPoints: HairStructurePoint[] = [];
  if (partColumn !== null) {
    for (let y = 1; y <= 5; y++) {
      const drift = analysis.renderHints.hairPart === "left" ? Math.floor(y / 3) : analysis.renderHints.hairPart === "right" ? -Math.floor(y / 3) : 0;
      partPoints.push({ face: "top", layer: "base", x: clamp(partColumn + drift, 0, 7), y, role: y % 2 === 0 ? "part_light" : "part_shadow" });
    }
  }

  const textureGroupIds: string[] = [];
  const textureFaces: HeadMaskFace[] = ["left", "right", "back", "top"];
  for (const face of textureFaces) {
    const rows = headMask.faces[face];
    if (rows.length === 0) continue;
    const minimumY = Math.min(...rows.map((point) => point.y));
    const maximumY = Math.max(...rows.map((point) => point.y));
    const seeds = face === "back" || face === "top" ? [1 + (phase % 2), 4 + ((phase + 1) % 2)] : [face === "left" ? phase % 3 : 7 - (phase % 3)];
    seeds.forEach((seed, index) => {
      let coordinates: Array<[number, number]> = [];
      let kind: HairStructureKind = "strand_band";
      let direction: HairDirection = "down";
      if (grammar === "straight_bands" || grammar === "lock_groups") {
        kind = grammar === "lock_groups" ? "lock_group" : "strand_band";
        direction = index % 2 === 0 ? "down_left" : "down_right";
        for (let y = minimumY; y <= maximumY; y++) {
          const drift = grammar === "lock_groups" && y >= minimumY + 3 ? (index % 2 === 0 ? -1 : 1) : 0;
          coordinates.push([clamp(seed + drift, 0, 7), y]);
        }
      } else if (grammar === "wavy_bands") {
        direction = index % 2 === 0 ? "down_right" : "down_left";
        for (let y = minimumY; y <= maximumY; y++) coordinates.push([clamp(seed + ((Math.floor((y + phase) / 2) + index) % 2), 0, 7), y]);
      } else {
        kind = grammar === "curl_lobes" ? "curl_lobe" : "coily_cluster";
        direction = "compact";
        const stride = grammar === "curl_lobes" ? 3 : 2;
        for (let y = minimumY + (index % 2); y <= maximumY; y += stride) {
          const x = clamp(seed + ((y + phase) % 2), 0, 6);
          coordinates.push([x, y], [x + 1, y], [x, Math.min(7, y + 1)]);
          if (grammar === "coily_clusters") coordinates.push([x + 1, Math.min(7, y + 1)]);
        }
      }
      const role: HairStructureRole = index % 2 === 0 ? "light" : "shadow";
      const id = addGroup({ id: `${grammar}-${face}-${index + 1}`, kind, direction, points: clippedPath(headMask, face, coordinates, role) });
      if (id) textureGroupIds.push(id);
    });
  }

  const crownIds: string[] = [];
  for (const [index, startX] of [1 + (phase % 2), 6 - (phase % 2)].entries()) {
    const coordinates: Array<[number, number]> = [];
    for (let y = 0; y < 8; y++) {
      const x = clamp(startX + (index === 0 ? Math.floor(y / 4) : -Math.floor(y / 4)), 0, 7);
      coordinates.push([x, y]);
    }
    const id = addGroup({
      id: `crown-flow-${index + 1}`,
      kind: "crown_flow",
      direction: index === 0 ? "down_right" : "down_left",
      points: clippedPath(headMask, "top", coordinates, index === 0 ? "light" : "shadow"),
    });
    if (id) crownIds.push(id);
  }

  const requiredGroupIds = [...fringeGroupIds, ...textureGroupIds, ...sideLockIds.left, ...sideLockIds.right]
    .filter((id) => groups.find((group) => group.id === id)!.identityImportance >= 4 || id.startsWith("fringe"));
  return {
    source: headMask.source === "identity_geometry" ? "identity_geometry" : "semantic_analysis",
    grammar,
    fringe: {
      groupIds: fringeGroupIds,
      openingColumns,
      irregularity: analysis.renderHints.fringeEdge === "wispy" ? "wispy_endpoints" : new Set(layout.hairlineDepthByColumn).size > 1 ? "measured_step" : "none",
    },
    temples: { leftGroupId: templeIds[0], rightGroupId: templeIds[1] },
    sideLocks: { leftGroupIds: sideLockIds.left, rightGroupIds: sideLockIds.right },
    textureGroupIds: [...textureGroupIds, ...crownIds],
    partChannel: {
      column: partColumn,
      direction: analysis.renderHints.hairPart,
      points: uniquePoints(partPoints),
    },
    groups,
    requiredGroupIds,
  };
}

function putGlassesPixel(
  pixels: GlassesStructurePixel[],
  face: GlassesStructurePixel["face"],
  x: number,
  y: number,
  role: GlassesPixelRole,
): void {
  if (x < 0 || x > 7 || y < 0 || y > 7) return;
  const existing = pixels.findIndex((pixel) => pixel.face === face && pixel.x === x && pixel.y === y);
  if (existing >= 0) pixels[existing] = { face, x, y, role };
  else pixels.push({ face, x, y, role });
}

/** Build a topology whose pixel footprint, not only its label, changes. */
export function buildGlassesStructurePlan(analysis: PhotoAnalysis, layout: FaceLayoutPlan): GlassesStructurePlan {
  const glasses = analysis.fallbackFeatures.glasses;
  const explicitNoGlasses = /\b(?:no|without|not wearing)\s+(?:any\s+)?(?:eye)?glasses\b/.test(
    `${analysis.observed.accessories} ${analysis.negativePrompt}`.toLowerCase(),
  );
  if (glasses === "none" || explicitNoGlasses || layout.glassesMask.length === 0) {
    return { topology: "none", framePixels: [], lensOpenings: [], sideArms: [], minimumReadablePixels: 0, preserveThinness: false };
  }
  const accessoryText = analysis.observed.accessories.toLowerCase();
  const canonicalGlassesText = analysis.canonicalIdentity.features
    .filter((feature) => /\b(?:glasses|frames?|rims?|eyewear)\b/i.test(`${feature.feature} ${feature.evidence}`))
    .map((feature) => `${feature.feature} ${feature.evidence}`)
    .join(" ")
    .toLowerCase();
  // Keep classification accessory-specific. Whole identity prompts commonly
  // contain "round face" or "thick eyebrows" near glasses and must not turn
  // a thin rectangular frame into a round/heavy one.
  const glassesText = `${accessoryText} ${canonicalGlassesText}`.toLowerCase();
  const nearGlasses = (adjective: string) => new RegExp(
    `\\b(?:${adjective})\\b[^.!?;,]{0,28}\\b(?:glasses|frames?|rims?|eyewear)\\b|\\b(?:glasses|frames?|rims?|eyewear)\\b[^.!?;,]{0,28}\\b(?:${adjective})\\b`,
  ).test(glassesText);
  const round = glasses === "round" || nearGlasses("round|circular|coke[-\\s]+bottle");
  const heavyFrame = nearGlasses("thick|heavy|bold|coke[-\\s]+bottle");
  const thin = nearGlasses("thin|wire|fine|delicate|narrow") && !heavyFrame;
  const oversized = nearGlasses("oversized|very[-\\s]+large|coke[-\\s]+bottle");
  const topology: GlassesTopology = oversized ? "oversized" : round ? thin ? "round_thin" : "round_heavy" : thin ? "rectangular_thin" : "rectangular_heavy";
  const framePixels: GlassesStructurePixel[] = [];
  const sideArms: GlassesStructurePixel[] = [];
  const lensOpenings: Array<{ x: number; y: number }> = [];
  // Keep the complete lens rims one cell inside the front-face UV seams.
  // Side arms carry the topology around the cube without repainting seams
  // after the final face landmark pass.
  const centers = [clamp(Math.round(mean(layout.leftEyeXs)), 2, 2), clamp(Math.round(mean(layout.rightEyeXs)), 5, 5)];
  const centerY = clamp(Math.round((layout.leftEyeRow + layout.rightEyeRow) / 2), 3, 5);
  for (const [index, centerX] of centers.entries()) {
    lensOpenings.push({ x: centerX, y: centerY });
    const outerRole: GlassesPixelRole = index === 0 ? "rim_light" : "rim_shadow";
    if (topology === "round_thin") {
      putGlassesPixel(framePixels, "front", centerX - 1, centerY, outerRole);
      putGlassesPixel(framePixels, "front", centerX, centerY - 1, "rim_mid");
      putGlassesPixel(framePixels, "front", centerX + 1, centerY, "rim_shadow");
      putGlassesPixel(framePixels, "front", centerX, centerY + 1, "rim_mid");
    } else if (topology === "round_heavy" || topology === "oversized") {
      const radiusY = topology === "oversized" ? 2 : 1;
      putGlassesPixel(framePixels, "front", centerX - 1, centerY, outerRole);
      putGlassesPixel(framePixels, "front", centerX + 1, centerY, "rim_shadow");
      putGlassesPixel(framePixels, "front", centerX, centerY - radiusY, "rim_light");
      putGlassesPixel(framePixels, "front", centerX, centerY + radiusY, "rim_shadow");
      putGlassesPixel(framePixels, "front", centerX - 1, centerY - 1, "rim_mid");
      putGlassesPixel(framePixels, "front", centerX + 1, centerY + 1, "rim_mid");
    } else if (topology === "rectangular_thin") {
      for (let x = centerX - 1; x <= centerX + 1; x++) {
        putGlassesPixel(framePixels, "front", x, centerY - 1, x === centerX - 1 ? outerRole : "rim_mid");
      }
      const outerColumn = index === 0 ? centerX - 1 : centerX + 1;
      putGlassesPixel(framePixels, "front", outerColumn, centerY, outerRole);
      putGlassesPixel(framePixels, "front", centerX, centerY + 1, index === 0 ? "rim_mid" : "rim_shadow");
    } else {
      for (let x = centerX - 1; x <= centerX + 1; x++) putGlassesPixel(framePixels, "front", x, centerY - 1, x === centerX - 1 ? outerRole : "rim_mid");
      putGlassesPixel(framePixels, "front", centerX - 1, centerY, outerRole);
      putGlassesPixel(framePixels, "front", centerX + 1, centerY, "rim_shadow");
      putGlassesPixel(framePixels, "front", centerX - 1, centerY + 1, "rim_mid");
      putGlassesPixel(framePixels, "front", centerX + 1, centerY + 1, "rim_shadow");
      if (topology === "rectangular_heavy") putGlassesPixel(framePixels, "front", centerX, centerY + 1, "rim_mid");
    }
  }
  // Fine wire bridges sit on the upper rim, leaving the center face opening
  // readable through close-fitting hair or a head covering. Heavy frames use
  // the eye row so their materially thicker topology remains distinct.
  const bridgeY = thin ? centerY - 1 : centerY;
  for (let x = centers[0] + 1; x < centers[1]; x++) putGlassesPixel(framePixels, "front", x, bridgeY, "bridge");
  for (const [face, xs] of [["left", [2, 3]], ["right", [4, 5]]] as const) {
    for (const x of xs) putGlassesPixel(sideArms, face, x, centerY, x === xs[0] ? "rim_mid" : "rim_shadow");
  }
  return {
    topology,
    framePixels,
    lensOpenings,
    sideArms,
    minimumReadablePixels: Math.ceil(framePixels.length * 0.75),
    preserveThinness: thin,
  };
}
