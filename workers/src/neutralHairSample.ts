import type { PhotoAnalysis } from "./analysis";
import { base64ToBytes, decodeImage, type RawImage } from "./png";

const neutralSwatches = { gray: "#777783", silver: "#a9a9af", platinum: "#e0dbd3", white: "#eae7e1" } as const;

export function observedNeutralHairColor(a: PhotoAnalysis): string | undefined {
  const detail = a.appearanceDetail;
  if (!detail || !a.visibleRegions.hair || ["beanie", "ear_beanie"].includes(detail.beanie)) return;
  if (detail.neutralHairSample) return detail.neutralHairSample;
  const tone = detail.hairNeutral;
  return tone !== "unknown" && tone !== "not_neutral" ? neutralSwatches[tone] : undefined;
}

function percentile(sorted: number[], p: number): number { return sorted[Math.floor((sorted.length - 1) * p)]; }

/** Only corroborate a neutral main material when a localized crown has a
 * textured, predominantly neutral cluster separated from its background. */
export function sampleNeutralCrown(img: RawImage, region: NonNullable<PhotoAnalysis["sourceSelection"]["portraitRegion"]>): string | undefined {
  const { headBox: head, faceBox: face, confidence } = region;
  if (!head || !face || confidence < .75) return;
  const w = head.right - head.left, h = head.bottom - head.top;
  if (w * img.width < 24 || h * img.height < 30 || face.top < head.top || face.top > head.top + h * .59) return;
  const top = head.top + h * .10, bottom = Math.min(head.top + h * .39, Math.max(face.top + h * .035, head.top + h * .25));
  const scan = (start: number, end: number, columns: number) => {
    const px: Array<{ l: number; spread: number; r: number; g: number; b: number }> = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < columns; x++) {
      const ix = Math.round((start + (end - start) * (x + .5) / columns) * img.width);
      const iy = Math.round((top + (bottom - top) * (y + .5) / 8) * img.height);
      if (ix < 0 || ix >= img.width || iy < 0 || iy >= img.height) continue;
      const i = (iy * img.width + ix) * 4;
      if (img.rgba[i + 3] < 250) continue;
      const [r,g,b] = img.rgba.subarray(i, i + 3);
      const l = .213 * r + .715 * g + .072 * b;
      px.push({ l, spread: Math.max(r,g,b) - Math.min(r,g,b), r,g,b });
    }
    return px.sort((a,b) => a.l-b.l);
  };
  const crest = scan(head.left + w * .22, head.right - w * .22, 12);
  if (crest.length < 64) return;
  const levels = crest.map(p => p.l), mid = percentile(levels, .48);
  if (mid < 63 || percentile(levels, .83) - percentile(levels, .23) < 13) return;
  const nearlyNeutral = crest.filter(p => p.spread <= (p.l >= 150 ? 25 : 15));
  if (nearlyNeutral.length / crest.length < .70) return;
  const surround = [...scan(head.left - w * .20, head.left - w * .07, 3), ...scan(head.right + w * .07, head.right + w * .20, 3)].map(p => p.l).sort((a,b) => a-b);
  // A computation on the background alone must not recolor dark hair.
  if (surround.length >= 24 && Math.abs(mid - percentile(surround, .5)) < 13) return;
  const useful = nearlyNeutral.filter(p => Math.abs(p.l - mid) <= 23);
  if (useful.length < 24) return;
  const channel = (ch: "r" | "g" | "b") => percentile(useful.map(p => p[ch]).sort((a,b) => a-b), .50);
  const bump = mid >= 145 ? 8 : 4;
  return `#${(["r", "g", "b"] as const).map(ch => Math.min(237, Math.round(mid + (channel(ch) - mid) * .55 + bump)).toString(16).padStart(2,"0")).join("")}`;
}

export async function corroborateNeutralHair(a: PhotoAnalysis, image: string): Promise<PhotoAnalysis> {
  const detail = a.appearanceDetail, region = a.sourceSelection.portraitRegion;
  if (!detail || !region || !a.visibleRegions.hair || a.fallbackFeatures.hat !== "none"
    || !["short", "medium"].includes(a.fallbackFeatures.hairstyle)
    || !["unknown", "none"].includes(detail.beanie)
    || /\b(?:pink|red|orange|blue|green|purple|lavender) (?:dyed )?hair\b/i.test(a.observed.hair)) return a;
  const encoded = /^data:image\/(?:jpeg|png);base64,(.+)$/i.exec(image)?.[1];
  if (!encoded) return a;
  try {
    const found = sampleNeutralCrown(await decodeImage(base64ToBytes(encoded)), region);
    return found ? { ...a, appearanceDetail: { ...detail, neutralHairSample: found } } : a;
  } catch { return a; }
}
