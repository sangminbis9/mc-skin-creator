/** Bounded head-only plan resolution. No atlas/color guessing or provider calls. */
import type { PhotoAnalysis } from "./analysis";
import type { FacePixelPlan, HairPlan } from "./identityPlans";
import type { HairStructureRole } from "./headStructure";
import { CLASSIC_LAYOUT, getBoxUvSeams, type BoxUV } from "./uvLayout";

export type HeadOwner = "face" | "hair_base" | "hair_outer" | "glasses" | "covering" | "tied_hair" | "other_p5" | "clear";
export interface HeadOwnedCell {
  face: keyof BoxUV; layer: "base" | "outer"; x: number; y: number;
  owner: HeadOwner; sourceGroupId: string; provenance: "observed" | "validated_derived" | "inferred";
  role?: HairStructureRole; continuityGroupId?: string;
  /** Existing clipped buzz texture has no separate major depth to resolve. */
  retain?: boolean;
}
export interface TiedMassGeometry {
  position: "high_back" | "mid_back" | "low_back";
  horizontalBias: "left" | "center" | "right";
  verticalProminence: 0 | 1 | 2;
  massWidth: 2 | 4 | 6;
  attachmentWidth: 2;
  attachmentRegion: "crown_back";
  outerDepth: 1;
  source: "observed";
  groupId: "tied-mass";
  attachmentGroupId: "tied-attachment";
}
export interface HeadOwnershipPlan {
  execution: "resolved" | "preserve_existing_grammar";
  hairFamily: HairPlan["template"];
  covering: boolean;
  tiedMass: null | TiedMassGeometry;
  cells: HeadOwnedCell[];
  continuities: Array<{ id: string; cells: string[]; sourceGroupIds: string[] }>;
}
export const headCellKey = (p: Pick<HeadOwnedCell, "layer" | "face" | "x" | "y">) => `${p.layer}:${p.face}:${p.x},${p.y}`;

/** Only hair-owned evidence can affect this taxonomy (never bag/blazer adjectives). */
export function observedTiedHair(analysis: PhotoAnalysis): boolean {
  const text = [analysis.observed.hair, ...analysis.canonicalIdentity.features.filter(f => f.category === "hair").map(f => f.feature)].join("; ");
  return !/\b(?:no|without)\s+(?:a\s+)?(?:(?:high|low|tight|loose)\s+)?(?:bun|topknot|top[- ]knot)\b/i.test(text) && /\b(?:bun|topknot|top[- ]knot|tied[- ]up hair|hair (?:tied|pulled) (?:up|back))\b/i.test(text);
}

/** Quantize only already-observed tied-hair evidence into the 8px head grid. */
export function quantizeTiedMassGeometry(analysis: PhotoAnalysis): TiedMassGeometry {
  const text = [analysis.observed.hair, ...analysis.canonicalIdentity.features.filter(f => f.category === "hair").map(f => f.feature)].join("; ");
  const position: TiedMassGeometry["position"] = /\b(?:low|lower|nape)\b[^.;]{0,24}\b(?:bun|topknot|top[- ]knot)\b|\b(?:bun|topknot|top[- ]knot)\b[^.;]{0,24}\b(?:low|lower|nape)\b/i.test(text)
    ? "low_back"
    : /\b(?:high|upper|top)\b[^.;]{0,24}\b(?:bun|topknot|top[- ]knot)\b|\b(?:bun|topknot|top[- ]knot)\b[^.;]{0,24}\b(?:high|upper|top)\b/i.test(text)
      ? "high_back"
      : "mid_back";
  const horizontalBias: TiedMassGeometry["horizontalBias"] = /\b(?:left|left[- ]biased|viewer(?:'s)? left)\b[^.;]{0,28}\b(?:bun|topknot|top[- ]knot)\b|\b(?:bun|topknot|top[- ]knot)\b[^.;]{0,28}\b(?:left|left[- ]biased|viewer(?:'s)? left)\b/i.test(text)
    ? "left"
    : /\b(?:right|right[- ]biased|viewer(?:'s)? right)\b[^.;]{0,28}\b(?:bun|topknot|top[- ]knot)\b|\b(?:bun|topknot|top[- ]knot)\b[^.;]{0,28}\b(?:right|right[- ]biased|viewer(?:'s)? right)\b/i.test(text)
      ? "right"
      : "center";
  const massWidth: TiedMassGeometry["massWidth"] = /\b(?:large|wide|full|voluminous)\b[^.;]{0,24}\b(?:bun|topknot|top[- ]knot)\b|\b(?:bun|topknot|top[- ]knot)\b[^.;]{0,24}\b(?:large|wide|full|voluminous)\b/i.test(text)
    ? 6
    : /\b(?:small|smaller|tiny|compact)\b[^.;]{0,24}\b(?:bun|topknot|top[- ]knot)\b|\b(?:bun|topknot|top[- ]knot)\b[^.;]{0,24}\b(?:small|smaller|tiny|compact)\b/i.test(text)
      ? 2
      : 4;
  return {
    position,
    horizontalBias,
    verticalProminence: position === "high_back" ? 2 : position === "mid_back" ? 1 : 0,
    massWidth,
    attachmentWidth: 2,
    attachmentRegion: "crown_back",
    outerDepth: 1,
    source: "observed",
    groupId: "tied-mass",
    attachmentGroupId: "tied-attachment",
  };
}

function tiedXs(width: number, bias: TiedMassGeometry["horizontalBias"]): number[] {
  const centered = Math.floor((8 - width) / 2);
  const start = bias === "left" ? Math.max(0, centered - 1) : bias === "right" ? Math.min(8 - width, centered + 1) : centered;
  return Array.from({ length: width }, (_, i) => start + i);
}

export function resolveHeadOwnership(analysis: PhotoAnalysis, hair: HairPlan, facePlan: FacePixelPlan): HeadOwnershipPlan {
  const headEvidence = [analysis.observed.hair, analysis.observed.accessories, ...analysis.canonicalIdentity.features.filter(f => f.category === "hair" || f.category === "accessory").map(f => f.feature)].join("; ");
  const observedCovering = headEvidence.split(/[.;]/).some(clause => /\b(?:hijab|headscarf|head scarf)\b/i.test(clause) && !/\b(?:no|without|not wearing)\s+(?:a\s+)?(?:hijab|headscarf|head scarf)\b/i.test(clause));
  const covering = analysis.fallbackFeatures.hat === "headscarf" || Boolean(analysis.identityGeometry?.headSilhouette.covering) || observedCovering;
  const tied = !covering && observedTiedHair(analysis);
  const tiedGeometry = tied ? quantizeTiedMassGeometry(analysis) : null;
  const provenance = hair.structure.source === "identity_geometry" ? "validated_derived" : "observed";
  const cells = new Map<string, HeadOwnedCell>();
  const put = (p: HeadOwnedCell) => { cells.set(headCellKey(p), p); };
  const faces = Object.keys(CLASSIC_LAYOUT.head.base) as Array<keyof BoxUV>;
  // Explicit transparent ownership prevents generic completion from adding a
  // second family. A selective mask, not the enclosing cube, supplies depth.
  for (const face of faces) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    put({ face, layer: "outer", x, y, owner: "clear", sourceGroupId: "unclaimed-depth", provenance: "inferred" });
  }
  if (hair.lengthClass !== "none") {
    for (const [face, points] of Object.entries(hair.headMask.faces)) for (const p of points) {
      const f = face as keyof BoxUV;
      const material = covering ? "covering" : "hair_base";
      put({ ...p, face: f, layer: "base", owner: material, sourceGroupId: `foundation-${face}`, provenance: covering ? "observed" : provenance, role: "shadow" });
      // Semantic masks contain a full top foundation, not a full outer cap.
      const topInterior = f === "top" && p.x > 0 && p.x < 7 && p.y > 0 && p.y < 7;
      const backInterior = !covering && f === "back" && p.x > 1 && p.x < 6 && p.y > 0 && p.y < 7;
      const tiedCrown = tied && (f === "top" || f === "back" || p.y === 0 || p.y > 3 || (f === "front" && p.x > 1 && p.x < 6));
      if (!topInterior && !backInterior && !tiedCrown && analysis.fallbackFeatures.hairstyle !== "buzz") put({ ...p, face: f, layer: "outer", owner: covering ? "covering" : "hair_outer", sourceGroupId: `silhouette-${face}`, provenance: covering ? "observed" : provenance, role: p.y % 3 === 0 ? "light" : "mid" });
    }
    if (!covering) for (const g of hair.structure.groups) for (const p of g.points) {
      if (tied && p.layer === "outer") continue;
      if (analysis.fallbackFeatures.hairstyle === "buzz" && p.layer === "outer") continue;
      put({ ...p, owner: p.layer === "base" ? "hair_base" : "hair_outer", sourceGroupId: g.id, provenance });
    }
    if (!covering) for (const p of hair.structure.partChannel.points) put({ ...p, owner: "hair_base", sourceGroupId: "part-channel", provenance });
  }
  if (tiedGeometry) {
    const massXs = tiedXs(tiedGeometry.massWidth, tiedGeometry.horizontalBias);
    const attachmentXs = tiedXs(tiedGeometry.attachmentWidth, tiedGeometry.horizontalBias);
    const mirrored = (xs: number[]) => xs.map(x => 7 - x);
    const paint = (face: keyof BoxUV, xs: number[], y: number, group: "tied-mass" | "tied-attachment", role: HairStructureRole) => {
      for (const x of xs) put({ face, x, y, layer: "outer", owner: "tied_hair", sourceGroupId: group, provenance: "observed", role });
    };
    const attachBase = (face: keyof BoxUV, xs: number[], y: number) => {
      for (const x of xs) put({ face, x, y, layer: "base", owner: "hair_base", sourceGroupId: tiedGeometry.attachmentGroupId, provenance: "observed", role: "shadow" });
    };

    if (tiedGeometry.position === "high_back") {
      // Rear/top mass + narrow crown neck + seam-matched front rim. The rim is
      // the bounded silhouette proxy needed for a horizontal top face to read
      // in a level front projection; it is not a full crown shell.
      for (let y = 0; y <= 3; y++) paint("top", massXs, y, "tied-mass", y === 3 ? "shadow" : "mid");
      for (let y = 4; y <= 6; y++) {
        paint("top", attachmentXs, y, "tied-attachment", "shadow");
        attachBase("top", attachmentXs, y);
      }
      paint("top", attachmentXs, 7, "tied-mass", "mid");
      paint("front", attachmentXs, 0, "tied-mass", "mid");
      paint("front", attachmentXs, 1, "tied-attachment", "shadow");
      attachBase("front", attachmentXs, 1);
      paint("back", mirrored(massXs), 0, "tied-mass", "mid");
      paint("back", mirrored(attachmentXs), 1, "tied-attachment", "shadow");
      attachBase("back", mirrored(attachmentXs), 1);
    } else if (tiedGeometry.position === "mid_back") {
      for (let y = 0; y <= 2; y++) paint("top", massXs, y, "tied-mass", y === 2 ? "shadow" : "mid");
      paint("top", attachmentXs, 3, "tied-attachment", "shadow");
      attachBase("top", attachmentXs, 3);
      paint("back", mirrored(massXs), 0, "tied-mass", "light");
      paint("back", mirrored(attachmentXs), 1, "tied-attachment", "shadow");
      attachBase("back", mirrored(attachmentXs), 1);
    } else {
      paint("top", attachmentXs, 0, "tied-attachment", "shadow");
      attachBase("top", attachmentXs, 0);
      paint("back", mirrored(attachmentXs), 0, "tied-attachment", "shadow");
      attachBase("back", mirrored(attachmentXs), 0);
      for (let y = 1; y <= 3; y++) paint("back", mirrored(massXs), y, "tied-mass", y === 1 ? "light" : "mid");
    }
  }
  // Face-window ownership is local. Do not globally elevate every P5 phrase.
  for (const p of facePlan.pixels.filter(p => p.cluster !== "fringe")) {
    put({ face: "front", layer: "base", x: p.x, y: p.y, owner: "face", sourceGroupId: p.cluster, provenance: "observed" });
    if (p.cluster !== "complexion") put({ face: "front", layer: "outer", x: p.x, y: p.y, owner: "clear", sourceGroupId: "face-window", provenance: "observed" });
  }
  if (facePlan.glassesPlan.topology === "none") {
    // The semantic face path and measured layout may use different eye rows.
    // Keep the existing production readability window as well as measured
    // landmarks; this is an ownership reservation, not a later clearing pass.
    const xs = analysis.renderHints.eyeSpacing === "wide" ? [0, 1, 6, 7] : analysis.renderHints.eyeSpacing === "close" ? [1, 2, 4, 5] : [1, 2, 5, 6];
    for (const x of xs) for (const y of analysis.renderHints.eyeTilt === "level" ? [4] : [3, 4, 5]) put({ face: "front", layer: "outer", x, y, owner: "clear", sourceGroupId: "face-window", provenance: "observed" });
  }
  if (facePlan.glassesPlan.topology !== "none") {
    const frame = facePlan.glassesPlan.framePixels.filter(p => p.face === "front");
    const minY = Math.min(...frame.map(p => p.y)), maxY = Math.max(...frame.map(p => p.y));
    // Reserve the actual frame's window before resolving hair. Keep its
    // existing topology and side arms; remove unrelated generic lens fill.
    for (let y = minY; y <= maxY; y++) for (let x = 1; x < 7; x++) put({ face: "front", layer: "outer", x, y, owner: facePlan.glassesPlan.topology === "oversized" ? "glasses" : "clear", sourceGroupId: "glasses-window", provenance: "observed", retain: facePlan.glassesPlan.topology === "oversized" });
    for (const p of [...facePlan.glassesPlan.framePixels, ...facePlan.glassesPlan.sideArms]) put({ ...p, layer: "outer", owner: "glasses", sourceGroupId: "glasses-frame", provenance: "observed", role: undefined });
    for (const p of facePlan.glassesPlan.lensOpenings) put({ ...p, face: "front", layer: "outer", owner: analysis.fallbackFeatures.glasses === "sunglasses" ? "glasses" : "clear", sourceGroupId: "glasses-lens", provenance: "observed" });
  }
  // Existing jewelry grammar keeps its own small attachment region. Other
  // accessory evidence elsewhere on the body cannot claim any head cells.
  if (analysis.fallbackFeatures.earrings) for (const [frontX, side, sideX] of [[0, "right", 7], [7, "left", 0]] as const) for (let y = 5; y < 8; y++) {
    for (const p of [{ face: "front" as const, x: frontX }, { face: side, x: sideX }]) put({ ...p, y, layer: "outer", owner: "other_p5", sourceGroupId: "ear-accessory", provenance: "observed" });
  }
  if (analysis.renderHints.hairAccessory !== "none") {
    const side = analysis.renderHints.hairAccessorySide;
    for (const p of cells.values()) if (p.layer === "outer") {
      const selectedX = side === "right" ? p.x >= 4 : side === "center" ? p.x >= 2 && p.x <= 5 : p.x < 4;
      const region = (p.face === "front" && selectedX && p.y <= 3) || (p.face === "top" && selectedX) || ((p.face === (side === "right" ? "left" : "right")) && p.y <= 5) || (p.face === "back" && selectedX && p.y <= 4);
      if (region && p.owner !== "glasses" && p.sourceGroupId !== "face-window") put({ ...p, owner: "other_p5", sourceGroupId: "head-accessory-region", provenance: "observed", retain: true });
    }
  }
  // Compute connected seam equivalence classes ONCE in plan space. Corners
  // belong to three surfaces; union-find avoids repeated atlas repair loops.
  const parent = new Map<string, string>();
  const root = (key: string): string => { const p = parent.get(key); return !p || p === key ? key : root(p); };
  const local = (x: number, y: number): HeadOwnedCell => {
    for (const face of faces) { const r = CLASSIC_LAYOUT.head.overlay[face]; if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return cells.get(`outer:${face}:${x - r.x},${y - r.y}`)!; }
    throw new Error("Head seam outside cuboid");
  };
  const seams = getBoxUvSeams(CLASSIC_LAYOUT.head.overlay);
  for (const seam of [...seams.vertical, ...seams.horizontal]) seam.primary.forEach((p, i) => {
    const a = headCellKey(local(p.x, p.y)), q = seam.adjacent[i], b = headCellKey(local(q.x, q.y));
    parent.set(root(a), root(b));
  });
  const classes = new Map<string, string[]>();
  for (const key of cells.keys()) if (parent.has(key) || [...parent.values()].includes(key)) { const r = root(key); classes.set(r, [...(classes.get(r) ?? []), key]); }
  const continuities: HeadOwnershipPlan["continuities"] = [];
  for (const keys of classes.values()) {
    const members = keys.map(key => cells.get(key)!);
    const masses = members.filter(p => ["hair_outer", "covering", "tied_hair"].includes(p.owner));
    if (!masses.length) continue;
    // Explicit transparent face/lens windows and jewelry are boundaries, not
    // missing hair. Never erase them to force a validator result.
    if (members.some(p => p.owner === "glasses" || p.owner === "other_p5" || (p.owner === "clear" && p.provenance === "observed"))) continue;
    const winner = masses.find(p => p.owner === "tied_hair") ?? masses.find(p => p.owner === "covering") ?? masses[0];
    const id = `head-continuity-${continuities.length + 1}`;
    continuities.push({ id, cells: keys, sourceGroupIds: [...new Set(masses.map(p => p.sourceGroupId))] });
    for (const p of members) put({ ...winner, face: p.face, x: p.x, y: p.y, continuityGroupId: id, sourceGroupId: p.owner === "clear" ? winner.sourceGroupId : p.sourceGroupId });
  }
  if (analysis.fallbackFeatures.hairstyle === "buzz" && !covering && !tied) for (const p of cells.values()) p.retain = true;
  // Existing complex ornament/loc and unmeasured curl grammars remain intact;
  // they are not converted into the wavy/tied completion introduced here.
  const observedOrnament = /\b(?:flower|ribbon|bow|clip|headband)\b[^.;]{0,35}\bhair\b|\bhair\b[^.;]{0,35}\b(?:flower|ribbon|bow|clip|headband)\b/i.test(headEvidence);
  const preserve = !tied && !covering && (observedOrnament || analysis.renderHints.hairAccessory !== "none" || hair.structure.grammar === "lock_groups" || (hair.template === "short_cap" && hair.structure.grammar === "straight_bands" && facePlan.glassesPlan.topology === "none") || (hair.structure.source === "semantic_analysis" && ["curl_lobes", "coily_clusters"].includes(hair.structure.grammar)));
  return { execution: preserve ? "preserve_existing_grammar" : "resolved", hairFamily: hair.template, covering, tiedMass: tiedGeometry, cells: [...cells.values()], continuities };
}
