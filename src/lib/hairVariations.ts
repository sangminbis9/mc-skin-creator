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
    label: "부드러운 결",
    description: "원래 명암을 부드럽게 정돈해요.",
  },
  {
    id: "defined",
    label: "또렷한 결",
    description: "머릿결의 명암을 조금 더 살려요.",
  },
  {
    id: "silky",
    label: "은은한 윤기",
    description: "정수리와 옆머리에 작은 하이라이트를 더해요.",
  },
  {
    id: "matte",
    label: "차분한 질감",
    description: "반짝임을 줄이고 자연스러운 음영을 남겨요.",
  },
  {
    id: "volume",
    label: "가벼운 볼륨",
    description: "기존 머리 영역 안에서 바깥 레이어를 보강해요.",
  },
  {
    id: "tidy",
    label: "옆머리 정돈",
    description: "안쪽 머리가 받쳐주는 옆머리 볼륨만 줄여요.",
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
        // Eyes, fringe boundary, earrings, neck and silhouette edges are not rewritten.
        if (
          n.face === "bottom" ||
          (n.face === "front" && n.y >= 2) ||
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
  const reason =
    blocked ??
    (mask.size < 28 ? "머리 영역이 불확실해 원본을 유지해요." : undefined);
  return {
    nodes,
    mask: reason ? new Set<number>() : mask,
    color,
    skin,
    reason,
  };
}

export function varyOriginalHair(
  source: Uint8ClampedArray,
  finish: HairFinish,
  analysis: ReturnType<typeof analyzeHair>,
) {
  const result = new Uint8ClampedArray(source);
  const { mask, nodes, color } = analysis;
  for (const n of nodes) {
    if (!mask.has(n.i) || n.edge) continue; // Preserve every UV seam exactly.
    const c = rgb(source, n.i);
    // Broad directional bands, not random pixel noise.
    const strand = Math.cos(
      (n.x + (n.face === "top" ? n.y * 0.45 : n.y * 0.18)) * 1.6,
    );
    for (let channel = 0; channel < 3; channel++) {
      const v = c[channel],
        anchor = color[channel];
      const next =
        finish === "soft"
          ? v * 0.68 + anchor * 0.32 + strand * 2
          : finish === "defined"
            ? anchor + (v - anchor) * 1.25 + strand * 9
            : finish === "silky"
              ? v + Math.max(0, strand) * 17
              : finish === "matte"
                ? v * 0.78 + anchor * 0.22 - 4
                : finish === "volume"
                  ? v + Math.max(0, strand) * 7
                  : v * 0.9 + anchor * 0.1;
      result[n.i + channel] = Math.max(0, Math.min(255, Math.round(next)));
    }
    if (n.layer !== "base" || n.face === "front" || n.face === "bottom")
      continue;
    const overlay = L.head.overlay[n.face];
    const oi = at(overlay.x + n.x, overlay.y + n.y);
    const supported = [n.i - 4, n.i + 4, n.i - 256, n.i + 256].every((i) =>
      mask.has(i),
    );
    if (finish === "volume" && supported && source[oi + 3] === 0) {
      result.set([result[n.i], result[n.i + 1], result[n.i + 2], 255], oi);
    }
    if (
      finish === "tidy" &&
      (n.face === "left" || n.face === "right") &&
      n.y >= 2 &&
      supported &&
      mask.has(oi) &&
      source[oi + 256 + 3] === 0
    ) {
      result.fill(0, oi, oi + 4);
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
