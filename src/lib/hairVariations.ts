import {
  CLASSIC_LAYOUT as L,
  getBoxUvSeams,
  type BoxUV,
} from "../../shared/skinLayout";

export interface VariationHints {
  hairColor?: string;
  skinTone?: string;
  hat?: string;
  hairstyle?: string;
}
export const HAIR_FINISHES = [
  {
    id: "soft",
    label: "앞머리 가볍게",
    description:
      "앞머리 끝의 겉 레이어를 덜어, 원래 길이를 유지하며 가볍게 내려요.",
  },
  {
    id: "defined",
    label: "앞머리 볼륨",
    description:
      "가르마와 이마를 유지하면서 앞머리의 겉 레이어를 도톰하게 채워요.",
  },
  {
    id: "silky",
    label: "옆머리 볼륨",
    description:
      "양옆 윗부분은 풍성하게, 아래쪽은 원래 머리선을 따라 둥글게 정리해요.",
  },
  {
    id: "matte",
    label: "전체 가볍게",
    description:
      "앞머리 끝과 양옆의 겉 레이어를 함께 줄여 가벼운 실루엣을 만들어요.",
  },
  {
    id: "volume",
    label: "전체 볼륨",
    description: "앞머리·양옆·정수리의 겉 레이어를 연결해 전체 볼륨을 살려요.",
  },
  {
    id: "tidy",
    label: "옆머리 밀착",
    description:
      "앞머리는 두고 양옆 아래쪽 부피를 줄여, 두상에 붙는 느낌으로 정리해요.",
  },
] as const;
export type HairFinish = (typeof HAIR_FINISHES)[number]["id"];
type Color = [number, number, number];
type Node = {
  i: number;
  x: number;
  y: number;
  face: keyof BoxUV;
  layer: "base" | "overlay";
  edge: boolean;
};
const at = (x: number, y: number) => (y * 64 + x) * 4;
const rgb = (data: Uint8ClampedArray, i: number): Color => [
  data[i],
  data[i + 1],
  data[i + 2],
];
const distance = (a: Color, b: Color) =>
  Math.hypot(...a.map((c, i) => c - b[i]));
const median = (colors: Color[]): Color =>
  [0, 1, 2].map(
    (c) =>
      colors.map((v) => v[c]).sort((a, b) => a - b)[
        Math.floor(colors.length / 2)
      ] ?? 0,
  ) as Color;
const parse = (hex?: string): Color | null =>
  hex && /^#[\da-f]{6}$/i.test(hex)
    ? ([1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Color)
    : null;

/** Conservative color+connectivity mask. Never claims to re-analyse the source photo. */
export function analyzeHair(
  source: Uint8ClampedArray,
  hints: VariationHints = {},
) {
  const nodes: Node[] = [];
  const neighbors = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    if (!neighbors.has(b)) neighbors.set(b, new Set());
    neighbors.get(a)!.add(b);
    neighbors.get(b)!.add(a);
  };
  for (const layer of ["base", "overlay"] as const) {
    for (const face of Object.keys(L.head[layer]) as (keyof BoxUV)[]) {
      const r = L.head[layer][face];
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++) {
          const i = at(r.x + x, r.y + y);
          nodes.push({
            i,
            x,
            y,
            face,
            layer,
            edge: x === 0 || x === 7 || y === 0 || y === 7,
          });
          if (x < 7) link(i, i + 4);
          if (y < 7) link(i, i + 256);
          if (layer === "overlay")
            link(i, at(L.head.base[face].x + x, L.head.base[face].y + y));
        }
    }
    const seams = getBoxUvSeams(L.head[layer]);
    for (const seam of [...seams.vertical, ...seams.horizontal])
      seam.primary.forEach((p, k) =>
        link(at(p.x, p.y), at(seam.adjacent[k].x, seam.adjacent[k].y)),
      );
  }
  const face = L.head.base.front;
  const skin =
    parse(hints.skinTone) ??
    median(
      [
        [1, 4],
        [6, 4],
        [1, 5],
        [6, 5],
      ].map(([x, y]) => rgb(source, at(face.x + x, face.y + y))),
    );
  const crown = nodes.filter(
    (n) =>
      n.layer === "base" &&
      n.face === "top" &&
      !n.edge &&
      source[n.i + 3] === 255,
  );
  const color =
    parse(hints.hairColor) ?? median(crown.map((n) => rgb(source, n.i)));
  const contrast = distance(color, skin);
  const blocked =
    hints.hat && hints.hat !== "none"
      ? "모자 영역을 보호하기 위해 원본 머리를 유지해요."
      : hints.hairstyle === "bald" || contrast < 42
        ? "머리와 피부를 확실히 구분하기 어려워 원본을 유지해요."
        : undefined;
  const eligible = new Set(
    nodes
      .filter((n) => {
        // The top three front rows can contain fringe; never enter the eye row.
        if (
          n.face === "bottom" ||
          (n.face === "front" && n.y >= 3) ||
          source[n.i + 3] !== 255
        )
          return false;
        const c = rgb(source, n.i),
          d = distance(c, color);
        return (
          d < Math.min(100, Math.max(38, contrast * 0.48)) &&
          d + 22 < distance(c, skin)
        );
      })
      .map((n) => n.i),
  );
  const mask = new Set<number>();
  const queue = crown.filter((n) => eligible.has(n.i)).map((n) => n.i);
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k];
    if (mask.has(i)) continue;
    mask.add(i);
    for (const next of neighbors.get(i) ?? [])
      if (eligible.has(next) && !mask.has(next)) queue.push(next);
  }
  // Front fringe must be connected vertically to the crown, not just touch
  // sideburns/glasses laterally. This also keeps original parting gaps open.
  for (const layer of [L.head.base, L.head.overlay]) {
    for (let x = 0; x < 8; x++) {
      let connected = true;
      for (let y = 0; y < 3; y++) {
        const i = at(layer.front.x + x, layer.front.y + y);
        const bi = at(L.head.base.front.x + x, L.head.base.front.y + y);
        connected &&= mask.has(i) || mask.has(bi);
        if (!connected) mask.delete(i);
      }
    }
  }
  const reason =
    blocked ??
    (hints.hairstyle === "buzz"
      ? "아주 짧은 머리는 원래 두상과 길이를 유지해요."
      : undefined) ??
    (mask.size < 28 ? "머리 영역이 불확실해 원본을 유지해요." : undefined);
  return {
    nodes,
    mask: reason ? new Set<number>() : mask,
    color,
    skin,
    reason,
  };
}

/** Shape the outer shell only. The complete base head remains byte-for-byte intact. */
export function varyOriginalHair(
  source: Uint8ClampedArray,
  finish: HairFinish,
  analysis: ReturnType<typeof analyzeHair>,
) {
  const result = new Uint8ClampedArray(source);
  if (analysis.reason) return result;
  const { mask, nodes } = analysis;
  const front =
    finish === "soft" || finish === "matte"
      ? -1
      : finish === "defined" || finish === "volume"
        ? 1
        : 0;
  const side =
    finish === "tidy" || finish === "matte"
      ? -1
      : finish === "silky" || finish === "volume"
        ? 1
        : 0;
  const plans = new Map<
    number,
    { node: Node; base: number; filled: boolean; mode: number }
  >();
  const depth = (face: keyof BoxUV, x: number) => {
    const r = L.head.base[face];
    let d = 0;
    while (d < (face === "front" ? 3 : 8) && mask.has(at(r.x + x, r.y + d)))
      d++;
    return d;
  };
  // A continuous transparent groove flanked by raised hair is an authored
  // parting, even when the base under it is also hair. Never fill that groove.
  const grooves = new Set<number>();
  for (const face of ["front", "top"] as const) {
    const r = L.head.overlay[face];
    const grooveCandidates = new Set<number>();
    for (let y = 0; y < (face === "front" ? 3 : 8); y++) {
      for (let x = 1; x < 7; x++) {
        const start = x;
        while (x < 7 && source[at(r.x + x, r.y + y) + 3] === 0) x++;
        if (
          x > start &&
          x - start <= 2 &&
          mask.has(at(r.x + start - 1, r.y + y)) &&
          mask.has(at(r.x + x, r.y + y))
        ) {
          for (let u = start; u < x; u++)
            grooveCandidates.add(at(r.x + u, r.y + y));
        }
      }
    }
    for (let x = 1; x < 7; x++) {
      const run: number[] = [];
      for (let y = 0; y < (face === "front" ? 3 : 8); y++) {
        const i = at(r.x + x, r.y + y);
        if (grooveCandidates.has(i)) run.push(i);
        else {
          if (run.length >= 2) run.forEach((j) => grooves.add(j));
          run.length = 0;
        }
      }
      if (run.length >= 2) run.forEach((j) => grooves.add(j));
    }
  }
  for (const node of nodes) {
    if (node.layer !== "overlay" || node.face === "bottom") continue;
    const { i, face, x, y } = node;
    const b = L.head.base[face],
      bi = at(b.x + x, b.y + y);
    // No new coverage over skin; never erase overlay-only long locks/accessories.
    if (
      !mask.has(bi) ||
      (source[i + 3] !== 0 && !mask.has(i)) ||
      grooves.has(i)
    )
      continue;
    let mode = 0,
      filled = source[i + 3] !== 0;
    if (face === "front") {
      mode = front;
      if (mode) filled = y < Math.max(0, depth(face, x) - (mode < 0 ? 1 : 0));
    } else if (face === "left" || face === "right") {
      mode = side;
      const d = depth(face, x);
      // Keep the long-hair endpoints unchanged; shaping is confined to the scalp.
      if (y >= 6) continue;
      if (mode)
        filled =
          y <
          (mode < 0
            ? Math.max(1, Math.ceil(Math.min(d, 6) * 0.3))
            : Math.max(1, Math.min(d, 6) - (x < 2 || x > 5 ? 1 : 0)));
    } else if (face === "top") {
      const frontBand = y >= (x >= 2 && x <= 5 ? 5 : 6);
      const sideBand = x <= 1 || x >= 6;
      mode =
        frontBand && front
          ? front
          : sideBand && side
            ? side
            : finish === "volume"
              ? 1
              : 0;
      if (mode) filled = mode > 0;
    } else {
      // Carry the side profile one column around the rear corner.
      mode = (x === 0 || x === 7) && y < 6 ? side : 0;
      if (mode)
        filled =
          y < (mode < 0 ? 2 : Math.max(1, Math.min(depth(face, x), 6) - 1));
    }
    // A slimming choice may remove volume, never add it to an already flat area.
    if (mode < 0) filled &&= source[i + 3] !== 0;
    plans.set(i, { node, base: bi, filled, mode });
  }
  const paint = (i: number, filled: boolean) => {
    const plan = plans.get(i)!;
    if (!filled) {
      result.fill(0, i, i + 4);
      return;
    }
    const n = plan.node;
    const c = rgb(source, source[i + 3] ? i : plan.base);
    // Broad relief lighting follows the authored strands rather than adding noise.
    const lift = n.face === "top" ? 14 : n.y === 0 ? 10 : 4;
    result.set([...c.map((v) => Math.min(255, v + lift)), 255], i);
  };
  for (const [i, p] of plans) if (p.mode) paint(i, p.filled);

  // Solve seam-connected corner groups together. Pair-by-pair edits can undo
  // earlier edges at a three-face corner and produce floating shell fragments.
  const links = new Map<number, Set<number>>();
  const seams = getBoxUvSeams(L.head.overlay);
  for (const seam of [...seams.vertical, ...seams.horizontal])
    seam.primary.forEach((a, k) => {
      const i = at(a.x, a.y),
        b = seam.adjacent[k],
        j = at(b.x, b.y);
      if (!links.has(i)) links.set(i, new Set());
      if (!links.has(j)) links.set(j, new Set());
      links.get(i)!.add(j);
      links.get(j)!.add(i);
    });
  const visited = new Set<number>();
  for (const start of links.keys()) {
    if (visited.has(start)) continue;
    const group = [start];
    for (let k = 0; k < group.length; k++) {
      const i = group[k];
      visited.add(i);
      for (const j of links.get(i) ?? []) if (!group.includes(j)) group.push(j);
    }
    if (!group.some((i) => plans.get(i)?.mode)) continue;
    if (!group.every((i) => plans.has(i))) {
      // A protected face wins over a proposed change on its neighbour.
      for (const i of group) result.set(source.subarray(i, i + 4), i);
      continue;
    }
    const changed = group.map((i) => plans.get(i)!).filter((p) => p.mode);
    const filled =
      changed[0].mode > 0
        ? changed.some((p) => p.filled)
        : changed.every((p) => p.filled) &&
          group.every((i) => source[i + 3] !== 0);
    for (const i of group) paint(i, filled);
    if (filled) {
      const c = median(group.map((i) => rgb(result, i)));
      for (const i of group) result.set([...c, 255], i);
    }
  }
  return result;
}

/** Preserve unambiguous long-hair strands on torso overlays while changing clothes. */
export function preserveDrapedHair(
  target: Uint8ClampedArray,
  original: Uint8ClampedArray,
  analysis: ReturnType<typeof analyzeHair>,
) {
  if (analysis.reason) return;
  const back = L.head.base.back;
  if (![2, 3, 4, 5].some((x) => analysis.mask.has(at(back.x + x, back.y + 6))))
    return;
  for (const part of ["body", "rightArm", "leftArm"] as const)
    for (const face of ["front", "back", "left", "right"] as const) {
      const r = L[part].overlay[face],
        b = L[part].base[face];
      const queue: [number, number][] = Array.from({ length: r.w }, (_, x) => [
        x,
        0,
      ]);
      const visited = new Set<number>();
      for (let k = 0; k < queue.length; k++) {
        const [x, y] = queue[k];
        if (x < 0 || y < 0 || x >= r.w || y >= r.h) continue;
        const i = at(r.x + x, r.y + y);
        if (visited.has(i)) continue;
        visited.add(i);
        if (
          original[i + 3] !== 255 ||
          distance(rgb(original, i), analysis.color) > 35 ||
          distance(rgb(original, at(b.x + x, b.y + y)), analysis.color) < 48
        )
          continue;
        target.set(original.subarray(i, i + 4), i);
        queue.push([x - 1, y], [x + 1, y], [x, y + 1]);
      }
    }
}
