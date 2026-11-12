import type { SkinFeatures } from "./skinFeatures";

type Color = [number, number, number];

function distance(a: Color, b: Color): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function brightness([r, g, b]: Color): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function average(colors: Color[]): Color {
  const sum: Color = [0, 0, 0];
  for (const [r, g, b] of colors) {
    sum[0] += r;
    sum[1] += g;
    sum[2] += b;
  }
  return sum.map(value => Math.round(value / colors.length)) as Color;
}

function dominant(colors: Color[]): Color | undefined {
  const groups = new Map<string, Color[]>();
  let largest: Color[] = [];
  for (const color of colors) {
    const key = color.map(value => Math.floor(value / 24)).join(":");
    const group = groups.get(key) ?? [];
    group.push(color);
    groups.set(key, group);
    if (group.length > largest.length) largest = group;
  }
  return largest.length >= 3 ? average(largest) : undefined;
}

function hex(color: Color): string {
  return "#" + color.map(value => value.toString(16).padStart(2, "0")).join("");
}

/** Estimates a palette from a small portrait. Shape and accessories stay at editable defaults. */
export function estimatePhotoColors(image: ImageData): Partial<SkinFeatures> {
  const { width, height, data } = image;
  function region(left: number, top: number, right: number, bottom: number): Color[] {
    const colors: Color[] = [];
    for (let y = Math.max(0, Math.floor(top)); y < Math.min(height, Math.ceil(bottom)); y++) {
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(width, Math.ceil(right)); x++) {
        const offset = (y * width + x) * 4;
        if (data[offset + 3] >= 128) colors.push([data[offset], data[offset + 1], data[offset + 2]]);
      }
    }
    return colors;
  }

  const background = [
    dominant(region(0, 0, width * .11, height * .11)),
    dominant(region(width * .89, 0, width, height * .11)),
  ].filter((color): color is Color => color !== undefined);
  const isForeground = (color: Color) => background.every(sample => distance(color, sample) > 24);
  const couldBeSkin = ([r, g, b]: Color) => r >= 36 && r - g >= 5 && g >= b - 2 && r - b >= 12 && r - b <= 110;
  const faceWidth = Math.min(width * .28, height * .23);
  const faceHeight = Math.min(height * .17, width * .28);
  if (faceWidth < 2 || faceHeight < 2) return {};

  let face: { x: number; y: number; score: number; skin: Color } | undefined;
  for (let y = height * .09; y < height * .56; y += faceHeight * .45) {
    for (const x of [width * .5, width * .36, width * .64]) {
      const colors = region(x - faceWidth / 2, y - faceHeight / 2, x + faceWidth / 2, y + faceHeight / 2);
      const skinColors = colors.filter(color => couldBeSkin(color) && isForeground(color));
      const skin = dominant(skinColors);
      if (!skin) continue;
      const warmth = .62 + .38 * Math.min(1, (skin[0] - skin[2]) / 55);
      const score = (skinColors.length / Math.max(1, colors.length)) * (1 - y / height * .6)
        * (1 - Math.abs(x - width / 2) / width) * warmth;
      if (score < .17 || (face && score <= face.score)) continue;
      face = { x, y, score, skin };
    }
  }

  const x = face?.x ?? width * .5;
  const y = face?.y ?? height * .25;
  const hair = face && dominant(region(x - faceWidth * .85, y - faceHeight, x + faceWidth * .85, y + faceHeight * .25)
    .filter(color => isForeground(color) && brightness(color) + 14 < brightness(face.skin) && distance(color, face.skin) > 30));
  const clothing = dominant(region(x - faceWidth * .65, y + faceHeight, x + faceWidth * .65, y + faceHeight * 2.8)
    .filter(color => (!face || distance(color, face.skin) > 29) && (!hair || distance(color, hair) > 26)));
  return {
    ...(face ? { skinTone: hex(face.skin) } : {}),
    ...(hair ? { hairColor: hex(hair) } : {}),
    ...(clothing ? { topColor: hex(clothing) } : {}),
  };
}
