import type { RawImage } from "./png";
import type { OutfitPlan, OutfitPatternPlan, OutfitSleevePlan } from "./outfitIdentity";
import { ATLAS_SIZE, CLASSIC_LAYOUT, type BoxUV, type Rect } from "./uvLayout";

type Rgb = [number, number, number];
type VerticalFace = "front" | "right" | "left" | "back";

function rgb(hex: string, fallback: Rgb): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  return match
    ? [Number.parseInt(match[1].slice(0, 2), 16), Number.parseInt(match[1].slice(2, 4), 16), Number.parseInt(match[1].slice(4, 6), 16)]
    : fallback;
}

function shade(value: Rgb, factor: number): Rgb {
  return value.map((channel) => Math.max(0, Math.min(255, Math.round(channel * factor)))) as Rgb;
}

function blend(first: Rgb, second: Rgb, amount: number): Rgb {
  return first.map((channel, index) => Math.round(channel * (1 - amount) + second[index] * amount)) as Rgb;
}

function offset(atlas: RawImage, rect: Rect, x: number, y: number): number {
  return ((rect.y + y) * atlas.width + rect.x + x) * 4;
}

function put(atlas: RawImage, rect: Rect, x: number, y: number, color: Rgb, alpha = 255): void {
  if (x < 0 || y < 0 || x >= rect.w || y >= rect.h) return;
  atlas.rgba.set([color[0], color[1], color[2], alpha], offset(atlas, rect, x, y));
}

function clearRect(atlas: RawImage, rect: Rect): void {
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) atlas.rgba.fill(0, offset(atlas, rect, x, y), offset(atlas, rect, x, y) + 4);
}

function fill(atlas: RawImage, rect: Rect, color: Rgb): void {
  for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, y, color);
}

const FACE_SHADE: Record<keyof BoxUV, number> = {
  front: 1,
  right: 0.86,
  left: 0.92,
  back: 0.78,
  top: 1.08,
  bottom: 0.68,
};

function clearBodyOverlays(atlas: RawImage): void {
  for (const part of ["body", "rightArm", "leftArm", "rightLeg", "leftLeg"] as const) {
    for (const rect of Object.values(CLASSIC_LAYOUT[part].overlay)) clearRect(atlas, rect);
  }
}

function fillBox(atlas: RawImage, box: BoxUV, color: Rgb): void {
  for (const face of Object.keys(box) as Array<keyof BoxUV>) fill(atlas, box[face], shade(color, FACE_SHADE[face]));
}

function drawPattern(
  atlas: RawImage,
  rect: Rect,
  pattern: OutfitPatternPlan,
  maxRows: number,
  face: VerticalFace,
  floralStartRow = 3,
): void {
  if (pattern.kind === "none") return;
  if (pattern.placement === "front" && face !== "front") return;
  const accent = rgb(pattern.color, [230, 226, 216]);
  const faceColor = shade(accent, FACE_SHADE[face]);
  if (pattern.kind === "color_panel" && pattern.construction === "stepped_gradient" && pattern.gradientColors && pattern.gradientColors.length >= 2) {
    const palette = pattern.gradientColors.map(c => shade(rgb(c, accent), FACE_SHADE[face]));
    const rows = Math.min(rect.h, maxRows);
    // Compact, ordered color planes: no noise, checker cells or extra shell.
    // When direction/positions were not observed, vertical list-order placement
    // is explicitly a design default, not a recovered photographic measurement.
    for (let y = 1; y < rows; y++) for (let x = 0; x < rect.w; x++) {
      const across = face === "right" ? 0 : face === "left" ? 1
        : face === "back" ? 1 - x / Math.max(1, rect.w - 1) : x / Math.max(1, rect.w - 1);
      const t = pattern.gradientDirection === "horizontal" ? across : (y - 1) / Math.max(1, rows - 2);
      const step = Math.round(t * (palette.length - 1) * 2) / 2;
      const low = Math.floor(step), high = Math.min(palette.length - 1, low + 1);
      put(atlas, rect, x, y, blend(palette[low], palette[high], step - low));
    }
  } else if (pattern.kind === "horizontal_stripe") {
    const bands = pattern.stripeColors?.length ? pattern.stripeColors.map(c => shade(rgb(c, accent), FACE_SHADE[face])) : [faceColor];
    for (let y = 2, band = 0; y < Math.min(rect.h, maxRows); y += pattern.frequency, band++)
      for (let x = 0; x < rect.w; x++) put(atlas, rect, x, y, bands[band % bands.length]);
  } else if (pattern.kind === "vertical_stripe") {
    for (let x = 1; x < rect.w; x += pattern.frequency) for (let y = 1; y < Math.min(rect.h, maxRows); y++) put(atlas, rect, x, y, faceColor);
  } else if (pattern.kind === "checker_block") {
    if (pattern.construction === "pixel_blocks" && pattern.blockColors && pattern.blockColors.length >= 2) {
      const palette = pattern.blockColors.map(c => shade(rgb(c, accent), FACE_SHADE[face]));
      // Connected two-pixel cloth blocks, rather than noisy singleton dots.
      // Exact photographic placement is unobserved; this deterministic grammar
      // preserves the observed palette without making a duplicate outer shell.
      for (let y = 1; y < Math.min(rect.h, maxRows); y++) for (let x = 0; x < rect.w; x++)
        put(atlas, rect, x, y, palette[(Math.floor(x / 2) + Math.floor((y - 1) / 2)) % palette.length]);
    } else if (pattern.construction === "crossed_bands") {
      const bands = pattern.crossedBandColors?.length
        ? pattern.crossedBandColors.map(c => shade(rgb(c, accent), FACE_SHADE[face])) : [faceColor];
      // Continue horizontal bands around the UV sides and cross them with a
      // quieter vertical thread. Both axes remain connected at 8px scale.
      for (let y = 1; y < Math.min(rect.h, maxRows); y++) for (let x = 0; x < rect.w; x++) {
        const band = y % 3 === 2, thread = x % 4 === 1;
        const bandColor = bands[Math.floor(y / 3) % bands.length];
        if (band) put(atlas, rect, x, y, thread ? shade(bandColor, 0.78) : bandColor);
        else if (thread) {
          const i = offset(atlas, rect, x, y);
          put(atlas, rect, x, y, blend([atlas.rgba[i], atlas.rgba[i + 1], atlas.rgba[i + 2]], bandColor, 0.35));
        }
      }
    } else {
      for (let y = 1; y < Math.min(rect.h, maxRows); y += 2) for (let x = y % 4 === 1 ? 0 : 2; x < rect.w; x += 4) {
        put(atlas, rect, x, y, faceColor);
        put(atlas, rect, Math.min(rect.w - 1, x + 1), y, shade(faceColor, 0.86));
      }
    }
  } else if (pattern.kind === "center_graphic" && face === "front") {
    const cx = pattern.anchor === "left" ? 1 : pattern.anchor === "right" ? rect.w - 3 : Math.floor(rect.w / 2) - 1;
    if (pattern.graphicShape === "cross") {
      // A compact connected symbol, source-colored ink on the base chest only.
      // No reference bitmap or unobserved ornament/outer-shell duplication.
      for (let y = 3; y < Math.min(maxRows, 9); y++) for (let x = cx; x <= cx + 1; x++)
        put(atlas, rect, x, y, shade(faceColor, 0.82));
      if (maxRows > 5) for (let x = cx - 1; x <= cx + 2; x++) put(atlas, rect, x, 5, shade(faceColor, 0.82));
      return;
    }
    const y = Math.min(maxRows - 2, 4);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 1]] as const) put(atlas, rect, cx + dx, y + dy, dy === 0 ? faceColor : shade(faceColor, 0.82));
  } else if (pattern.kind === "irregular_group" && face === "front") {
    if (pattern.motif === "floral") {
      for (const [dx, dy] of [[0, 0], [-1, 1], [0, 1], [1, 1], [0, 2]] as const) {
        const x = Math.floor(rect.w / 2) + dx, y = floralStartRow + dy;
        if (y < maxRows) put(atlas, rect, x, y, shade(faceColor, dy === 1 && dx === 0 ? 0.72 : 1));
      }
      return;
    }
    for (const [x, y] of [[2, 3], [3, 3], [3, 4], [4, 4], [5, 4], [4, 5]] as const) if (y < maxRows) put(atlas, rect, x, y, (x + y) % 2 === 0 ? faceColor : shade(faceColor, 0.8));
  }
}

function drawNeckline(atlas: RawImage, plan: OutfitPlan, skin: Rgb): void {
  const front = CLASSIC_LAYOUT.body.base.front;
  const accent = rgb(plan.upper.accentColor, [236, 231, 220]);
  const centerLeft = 3;
  const centerRight = 4;
  const kind = plan.upper.neckline.kind;
  const inner = plan.upper.neckline.innerVisible ? accent : skin;
  if (kind === "high_neck") {
    put(atlas, front, centerLeft, 0, accent);
    put(atlas, front, centerRight, 0, shade(accent, 0.9));
    return;
  }
  const topWidth = Math.max(2, Math.min(6, plan.upper.neckline.width));
  const left = Math.floor((front.w - topWidth) / 2);
  for (let x = left; x < left + topWidth; x++) put(atlas, front, x, 0, inner);
  if (kind === "v_neck") {
    for (let y = 1; y < Math.min(front.h, plan.upper.neckline.depth); y++) {
      put(atlas, front, centerLeft, y, inner);
      if (y < 2) put(atlas, front, centerRight, y, shade(inner, 0.94));
    }
  } else if (["open_collar", "layered", "hood_opening"].includes(kind)) {
    for (let y = 1; y < Math.min(front.h, plan.upper.neckline.depth); y++) {
      put(atlas, front, centerLeft, y, inner);
      put(atlas, front, centerRight, y, shade(inner, 0.92));
    }
  } else {
    put(atlas, front, centerLeft, 1, inner);
    put(atlas, front, centerRight, 1, shade(inner, 0.94));
  }
}

function drawTorso(atlas: RawImage, plan: OutfitPlan, skin: Rgb): void {
  const box = CLASSIC_LAYOUT.body.base;
  const base = rgb(plan.upper.baseColor, [82, 106, 140]);
  fillBox(atlas, box, base);
  const lower = rgb(plan.lower.baseColor, [55, 67, 88]);
  if (plan.lower.garmentType === "dress_continuation" || plan.lower.garmentType === "skirt") {
    for (const face of ["front", "right", "left", "back"] as const) {
      const rect = box[face];
      for (let y = plan.lower.waistRow; y < rect.h; y++) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, y, shade(lower, FACE_SHADE[face]));
    }
  } else {
    for (const face of ["front", "right", "left", "back"] as const) {
      const rect = box[face];
      const hemY = Math.max(0, Math.min(rect.h - 1, plan.lower.waistRow));
      for (let x = 0; x < rect.w; x++) put(atlas, rect, x, hemY, shade(base, FACE_SHADE[face] * 0.82));
    }
  }
  const front = box.front;
  const accent = rgb(plan.upper.accentColor, [236, 231, 220]);
  for (const block of plan.upper.colorBlocks) {
    const c = rgb(block.color, accent);
    if (block.region === "front_center") {
      const panelEnd = plan.formalSuit?.jacketOpening === "buttoned"
        ? Math.min(plan.lower.waistRow, plan.formalSuit.shirtOpening) : plan.lower.waistRow;
      for (let y = 1; y < Math.min(panelEnd, front.h); y++) for (let x = 2; x <= 5; x++) {
        if (plan.formalSuit?.frontDrape === "tapered" && (y >= 8 || y >= 5 && (x === 2 || x === 5))) continue;
        put(atlas, front, x, y, x === 5 ? shade(c, 0.92) : c);
      }
    } else if (block.region === "front_left") {
      for (let y = 1; y < plan.lower.waistRow; y++) for (let x = 0; x < 4; x++) put(atlas, front, x, y, c);
    } else if (block.region === "front_right") {
      for (let y = 1; y < plan.lower.waistRow; y++) for (let x = 4; x < 8; x++) put(atlas, front, x, y, shade(c, 0.94));
    } else if (block.region === "vertical_opening") {
      for (let y = 1; y < plan.lower.waistRow; y++) {
        if (plan.formalSuit?.frontDrape === "tapered" && y >= 8) continue;
        put(atlas, front, 3, y, c);
        put(atlas, front, 4, y, shade(c, 0.9));
      }
    } else if (block.region === "horizontal_band") {
      const y = Math.min(front.h - 2, Math.max(3, Math.floor(plan.lower.waistRow / 2)));
      for (let x = 0; x < front.w; x++) put(atlas, front, x, y, c);
    } else if (block.region === "shoulders") {
      for (const x of [0, 1, 6, 7]) put(atlas, front, x, 0, c);
    }
  }
  if (!plan.upper.pattern.surfaceParts || plan.upper.pattern.surfaceParts.includes("body"))
    for (const face of ["front", "right", "left", "back"] as const) drawPattern(atlas, box[face], plan.upper.pattern,
      plan.upper.pattern.construction === "stepped_gradient" && plan.upper.hem
        ? Math.min(plan.lower.waistRow, plan.upper.hem.endRow - 1) : plan.lower.waistRow, face);
  // Chest ink is composed after its cloth ground, only on the torso front.
  // Reuse the existing bounded glyph; do not turn a motif into sleeve texture.
  if (plan.upper.pattern.frontGraphic && (!plan.upper.pattern.surfaceParts || plan.upper.pattern.surfaceParts.includes("body"))) drawPattern(atlas, front, {
    ...plan.upper.pattern, ...plan.upper.pattern.frontGraphic, kind: "center_graphic", placement: "front",
  }, plan.lower.waistRow, "front");
  drawNeckline(atlas, plan, skin);
  if (plan.upper.hem) {
    const end = plan.upper.hem.endRow;
    for (const face of ["front", "right", "left", "back"] as const) {
      const rect = box[face];
      for (let y = end; y < rect.h; y++) for (let x = 0; x < rect.w; x++)
        put(atlas, rect, x, y, shade(y < plan.lower.waistRow ? skin : lower, FACE_SHADE[face]));
      for (let x = 0; x < rect.w; x++) put(atlas, rect, x, end - 1, shade(base, FACE_SHADE[face] * 0.82));
    }
    fill(atlas, box.bottom, shade(lower, FACE_SHADE.bottom));
  }
}

function drawSleeve(atlas: RawImage, box: BoxUV, sleeve: OutfitSleevePlan, pattern: OutfitPatternPlan, skin: Rgb, part: "rightArm" | "leftArm"): void {
  const cloth = rgb(sleeve.color, [82, 106, 140]);
  fillBox(atlas, box, skin);
  for (const face of ["front", "right", "left", "back"] as const) {
    const rect = box[face];
    for (let y = 0; y < Math.min(rect.h, sleeve.terminationRow); y++) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, y, shade(cloth, FACE_SHADE[face]));
    if (pattern.surfaceParts ? pattern.surfaceParts.includes(part) : pattern.placement === "front_and_sleeves" || pattern.placement === "wrap") {
      // Keep the existing flower inside actual cloth, above the physical hem.
      // Short sleeves clip the glyph, not the skin or shoulder seam; long
      // sleeves retain its original position. Never infer a longer sleeve.
      const floral = pattern.kind === "irregular_group" && pattern.motif === "floral";
      const clothEnd = Math.min(rect.h, sleeve.terminationRow) -
        (sleeve.terminationRow > 0 && sleeve.terminationRow < rect.h ? 1 : 0);
      drawPattern(atlas, rect, pattern, floral || pattern.construction === "stepped_gradient" ? clothEnd : sleeve.terminationRow, face,
        floral ? Math.max(1, Math.min(3, clothEnd - 3)) : 3);
    }
    if (sleeve.terminationRow > 0 && sleeve.terminationRow < rect.h) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, sleeve.terminationRow - 1, shade(sleeve.cuff ? rgb(sleeve.cuff.color, cloth) : cloth, FACE_SHADE[face] * 0.76));
  }
  fill(atlas, box.top, shade(cloth, FACE_SHADE.top));
  fill(atlas, box.bottom, shade(skin, FACE_SHADE.bottom));
}

/** The raised cue occupies the same material interval as the base cloth.
 * Neither a thigh-high label nor a decorative cuff can override a skirt/shoe.
 */
function legwearRows(plan: OutfitPlan, height: number): { start: number; end: number } {
  const garmentEnd = Math.min(height, plan.lower.garmentRows);
  const end = Math.max(garmentEnd, height - plan.lower.shoeRows);
  const start = plan.lower.legwear.kind === "socks" ? Math.max(garmentEnd, end - 3)
    : plan.lower.legwear.kind === "leg_warmers" ? Math.max(garmentEnd, end - 5) : garmentEnd;
  return { start, end };
}

function drawLower(atlas: RawImage, plan: OutfitPlan, skin: Rgb): void {
  const garment = rgb(plan.lower.baseColor, [55, 67, 88]);
  const shoes = rgb(plan.lower.shoeColor, [52, 48, 50]);
  for (const part of ["rightLeg", "leftLeg"] as const) {
    const box = CLASSIC_LAYOUT[part].base;
    fillBox(atlas, box, garment);
    for (const face of ["front", "right", "left", "back"] as const) {
      const rect = box[face];
      const garmentEnd = Math.min(rect.h, plan.lower.garmentRows);
      const shoeStart = Math.max(garmentEnd, rect.h - plan.lower.shoeRows);
      for (let y = garmentEnd; y < shoeStart; y++) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, y, shade(skin, FACE_SHADE[face]));
      const viewerSide = part === "rightLeg" ? "left" : "right";
      const legwearApplies = plan.lower.legwear.kind !== "none" && (plan.lower.legwear.asymmetry === "both" || plan.lower.legwear.asymmetry === viewerSide || plan.lower.legwear.asymmetry === "none");
      if (legwearApplies) {
        const legwear = rgb(plan.lower.legwear.color, [70, 68, 72]);
        const { start: legwearStart } = legwearRows(plan, rect.h);
        for (let y = legwearStart; y < shoeStart; y++) for (let x = 0; x < rect.w; x++) {
          const stripe = plan.lower.legwear.pattern === "diagonal_stripe" &&
            (part === "rightLeg" ? (x + y) % 3 === 0 : (x - y + 48) % 3 === 0);
          // The source-supported striped tights have visible skin-toned gaps;
          // keep them within the legwear region, never across shorts or shoes.
          const material = stripe ? blend(legwear, skin, 0.72) : legwear;
          put(atlas, rect, x, y, shade(material, FACE_SHADE[face] * (y === legwearStart ? 1.08 : 1)));
        }
      }
      for (let y = shoeStart; y < rect.h; y++) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, y, shade(shoes, FACE_SHADE[face] * (y === rect.h - 1 ? 0.72 : 1)));
      if (!plan.lower.pattern.surfaceParts || plan.lower.pattern.surfaceParts.includes(part)) drawPattern(atlas, rect, plan.lower.pattern, garmentEnd, face);
    }
    fill(atlas, box.top, shade(garment, FACE_SHADE.top));
    fill(atlas, box.bottom, shade(shoes, FACE_SHADE.bottom));
    if (plan.lower.kneeDistressing?.parts.includes(part)) {
      // Six interior cells, no UV seam/outer shell or opposite-leg inference.
      // Washed threads use the denim's own desaturated ramp. Skin is only
      // used when explicitly observed through the tear, never from "ripped".
      const threads = blend(garment, [220, 220, 210], 0.55);
      const gap = plan.lower.kneeDistressing.exposedSkin ? skin : shade(garment, 0.70);
      for (const x of [1, 2]) for (const y of [5, 6, 7])
        put(atlas, box.front, x, y, y === 6 ? gap : threads);
    }
  }
}

function drawOuter(atlas: RawImage, plan: OutfitPlan): void {
  const body = CLASSIC_LAYOUT.body.overlay;
  const garment = rgb(plan.upper.baseColor, [82, 106, 140]);
  const accent = rgb(plan.upper.accentColor, [236, 231, 220]);
  const lower = rgb(plan.lower.baseColor, [55, 67, 88]);
  const has = (region: OutfitPlan["outerLayer"]["regions"][number]) => plan.outerLayer.regions.includes(region);
  if (has("collar")) {
    const collar = rgb(plan.upper.collarColor ?? plan.upper.accentColor, accent);
    for (const [x, y] of [[1, 0], [2, 0], [2, 1], [5, 0], [6, 0], [5, 1]] as const) put(atlas, body.front, x, y, x < 4 ? collar : shade(collar, 0.88));
  }
  if (has("lapels")) {
    for (let y = 0; y < Math.min(8, plan.lower.waistRow); y++) {
      if (plan.formalSuit?.frontDrape === "tapered") {
        const x = plan.formalSuit.lapelStyle === "peak" && y === 1 ? 0
          : plan.formalSuit.lapelStyle === "shawl" && y === 4 ? 2
          : y < 5 ? 1 : y < 7 ? 2 : 3;
        put(atlas, body.front, x, y, shade(garment, 1.06));
        put(atlas, body.front, 7 - x, y, shade(garment, 0.86));
        continue;
      }
      const spread = plan.formalSuit?.lapelStyle === "peak" ? Math.min(2, Math.floor((y + 2) / 3))
        : plan.formalSuit?.lapelStyle === "shawl" ? Math.min(1, Math.floor(y / 4))
        : Math.min(2, Math.floor(y / 3));
      put(atlas, body.front, Math.max(0, 2 - spread), y, y < 2 ? blend(garment, accent, 0.32) : shade(garment, 1.06));
      put(atlas, body.front, Math.min(7, 5 + spread), y, shade(garment, 0.78));
    }
    for (const [rect, x] of [[body.right, body.right.w - 1], [body.left, 0]] as const) for (let y = 1; y < Math.min(rect.h, plan.lower.waistRow); y++) put(atlas, rect, x, y, shade(garment, 0.82));
    for (const x of [0, body.back.w - 1]) for (const y of [1, Math.min(body.back.h - 1, plan.lower.waistRow - 1)]) put(atlas, body.back, x, y, shade(garment, 0.78));
  }
  if (has("hood_rim")) {
    for (let x = 1; x < body.front.w - 1; x++) put(atlas, body.front, x, 0, x === 3 || x === 4 ? accent : shade(garment, 1.06));
    for (const rect of [body.right, body.left, body.back]) for (const x of [0, rect.w - 1]) put(atlas, rect, x, 0, shade(garment, 0.82));
  }
  if (has("cuffs")) {
    for (const [part, sleeve] of [["rightArm", plan.upper.rightSleeve], ["leftArm", plan.upper.leftSleeve]] as const) {
      if (sleeve.terminationRow <= 0) continue;
      const arm = CLASSIC_LAYOUT[part].overlay;
      const cuffY = Math.min(arm.front.h - 1, sleeve.terminationRow - 1);
      const cuff = sleeve.cuff ? rgb(sleeve.cuff.color, garment) : garment;
      // Preserve the physical cuff fold's light/shadow after removing an
      // unrelated lower-body pattern. No extra occupied pixels or new motif.
      for (const face of ["front", "back"] as const) for (let x = 0; x < arm[face].w; x++) {
        const fold = x > 0 && x < arm[face].w - 1 ? 1.08 : 0.84;
        put(atlas, arm[face], x, cuffY, shade(cuff, FACE_SHADE[face] * fold));
      }
      for (const face of ["right", "left"] as const) for (const x of [0, arm[face].w - 1]) put(atlas, arm[face], x, cuffY, shade(cuff, FACE_SHADE[face] * 0.84));
      for (let x = 0; x < arm.top.w; x++) put(atlas, arm.top, x, 0, shade(garment, FACE_SHADE.top * 0.84));
    }
  }
  if (has("hem")) for (const face of ["front", "right", "left", "back"] as const) for (let x = 0; x < body[face].w; x += 2) {
    if (plan.upper.hem) {
      put(atlas, body[face], x, plan.upper.hem.endRow - 1, shade(garment, FACE_SHADE[face] * 0.86));
      continue;
    }
    put(atlas, body[face], x, body[face].h - 1, shade(garment, FACE_SHADE[face] * 0.76));
    if (plan.lower.waistRow < body[face].h - 1) put(atlas, body[face], Math.min(body[face].w - 1, x + 1), plan.lower.waistRow, shade(garment, FACE_SHADE[face] * 0.86));
  }
  if (has("lapels") && has("hem") && plan.lower.waistRow < body.front.h - 1) {
    put(atlas, body.front, 2, plan.lower.waistRow, shade(garment, 0.72));
    put(atlas, body.front, 3, body.front.h - 1, shade(garment, 0.68));
  }
  if (has("skirt_pleats")) {
    put(atlas, body.front, 3, body.front.h - 1, shade(lower, 0.62));
    put(atlas, body.front, 1, body.front.h - 3, shade(lower, 0.62));
    put(atlas, body.front, 2, body.front.h - 3, shade(lower, 1.08));
    for (const part of ["rightLeg", "leftLeg"] as const) for (const face of ["front", "back"] as const) {
      const rect = CLASSIC_LAYOUT[part].overlay[face];
      for (let y = 0; y < Math.min(rect.h, plan.lower.garmentRows); y++) for (const x of [1, 3]) if (y === 0 || (x + y) % 2 === 0 || y === plan.lower.garmentRows - 1) put(atlas, rect, x, y, shade(lower, FACE_SHADE[face] * (x === 1 ? 1.08 : 0.78)));
    }
  }
  if (has("pocket")) for (const [x, y] of [[1, 6], [2, 6], [1, 7], [2, 7]] as const) put(atlas, body.front, x, y, y === 6 ? shade(garment, 1.1) : shade(garment, 0.78));
  if (has("legwear") && plan.lower.legwear.kind !== "none") {
    const legwear = rgb(plan.lower.legwear.color, accent);
    for (const part of ["rightLeg", "leftLeg"] as const) {
      const viewerSide = part === "rightLeg" ? "left" : "right";
      if (!(plan.lower.legwear.asymmetry === "both" || plan.lower.legwear.asymmetry === viewerSide || plan.lower.legwear.asymmetry === "none")) continue;
      const leg = CLASSIC_LAYOUT[part].overlay;
      const { start, end } = legwearRows(plan, leg.front.h);
      if (start >= end) continue;
      if (plan.lower.legwear.kind !== "leg_warmers" && !plan.lower.legwear.pattern) {
        // Plain socks need a quiet connected cuff/rib, not alternating blocks
        // which invent a checker print. Keep the continuous cloth on the base.
        for (const face of ["front", "right", "left", "back"] as const) {
          const rect = leg[face];
          for (let x = 0; x < rect.w; x++) put(atlas, rect, x, start, shade(legwear, FACE_SHADE[face] * 1.04));
          const x = face === "right" ? 0 : face === "left" ? rect.w - 1 : 1;
          for (let y = start + 1; y < end; y++) put(atlas, rect, x, y, shade(legwear, FACE_SHADE[face] * 0.94));
        }
        continue;
      }
      for (const face of ["front", "right", "left", "back"] as const) for (let y = start; y < end; y++) {
        const x = y % 2 === 0 ? 0 : leg[face].w - 1;
        put(atlas, leg[face], x, y, shade(legwear, FACE_SHADE[face] * (y === start ? 1.08 : 0.88)));
      }
      if (plan.lower.legwear.kind === "thigh_highs" || plan.lower.legwear.kind === "leg_warmers" || plan.lower.legwear.kind === "socks") {
        for (const y of [start, start + 1, start + 4].filter(y => y < end)) for (const x of [1, 2]) put(atlas, leg.front, x, y, shade(legwear, x === 1 ? 1.04 : 0.88));
      }
    }
  }
  if (has("lower_accent")) {
    if (plan.lower.accent === "side_stripe") for (const part of ["rightLeg", "leftLeg"] as const) for (const face of ["front", "right", "left", "back"] as const) {
      const rect = CLASSIC_LAYOUT[part].overlay[face];
      for (let y = 1; y < rect.h - plan.lower.shoeRows; y++) put(atlas, rect, part === "rightLeg" ? 0 : rect.w - 1, y, shade(accent, FACE_SHADE[face]));
    } else if (plan.lower.accent === "cuffs") for (const part of ["rightLeg", "leftLeg"] as const) for (const face of ["front", "right", "left", "back"] as const) {
      const rect = CLASSIC_LAYOUT[part].overlay[face];
      for (let x = 0; x < rect.w; x++) put(atlas, rect, x, Math.max(0, plan.lower.garmentRows - 1), shade(accent, FACE_SHADE[face] * 0.82));
    }
  }
  if (has("pattern_depth") && plan.lower.pattern.kind !== "none") {
    for (const part of ["rightLeg", "leftLeg"] as const) {
      const leg = CLASSIC_LAYOUT[part].overlay;
      for (const face of ["front", "right", "left", "back"] as const) {
        const rect = leg[face];
        const patternColor = rgb(plan.lower.baseColor, lower);
        for (let y = 0; y < Math.min(rect.h, plan.lower.garmentRows); y += 2) {
          const x = (y / 2 + (part === "rightLeg" ? 1 : 0)) % rect.w;
          put(atlas, rect, x, y, shade(patternColor, FACE_SHADE[face] * (y % 4 === 0 ? 0.64 : 0.82)));
          put(atlas, rect, Math.min(rect.w - 1, x + 1), y, shade(patternColor, FACE_SHADE[face] * 1.08));
        }
      }
    }
  }
  if (has("lower_fold")) {
    for (const part of ["rightLeg", "leftLeg"] as const) {
      const leg = CLASSIC_LAYOUT[part].overlay;
      put(atlas, leg.front, 1, Math.min(4, leg.front.h - plan.lower.shoeRows - 1), shade(lower, 0.72));
      put(atlas, leg.front, 1, Math.max(0, leg.front.h - plan.lower.shoeRows - 1), shade(lower, 0.62));
      put(atlas, leg.back, 2, Math.min(5, leg.back.h - plan.lower.shoeRows - 1), shade(lower, 0.64));
    }
  }
  if (has("graphic_depth") && (plan.upper.pattern.kind === "center_graphic" || plan.upper.pattern.frontGraphic)) {
    const graphic = plan.upper.pattern.frontGraphic;
    const anchor = graphic?.anchor ?? plan.upper.pattern.anchor;
    const ink = rgb(graphic?.color ?? plan.upper.pattern.color, accent);
    const x = anchor === "left" ? 1 : anchor === "right" ? 6 : 3;
    for (const [dx, dy] of [[0, 3], [1, 3], [0, 4]] as const) put(atlas, body.front, x + dx, dy, dx === 0 && dy === 3 ? ink : shade(ink, 0.78));
  }
  if (has("shoe_depth")) for (const part of ["rightLeg", "leftLeg"] as const) {
    const overlay = CLASSIC_LAYOUT[part].overlay;
    const rect = overlay.front;
    const shoe = rgb(plan.lower.shoeColor, [52, 48, 50]);
    put(atlas, rect, part === "rightLeg" ? 0 : rect.w - 1, rect.h - 1, shade(shoe, 0.76));
    for (const x of [1, 2]) put(atlas, rect, x, rect.h - 3, shade(shoe, x === 1 ? 1.08 : 0.82));
    put(atlas, overlay.right, overlay.right.w - 1, overlay.right.h - 1, shade(shoe, 0.68));
  }
  for (const accessory of plan.accessories) {
    const c = rgb(accessory.color, accent);
    if (accessory.kind === "bag_strap") {
      for (let y = 0; y < body.front.h; y++) put(atlas, body.front, Math.min(7, 1 + Math.floor(y / 2)), y, y % 3 === 0 ? shade(c, 0.74) : c);
      for (let y = 0; y < body.right.h; y++) put(atlas, body.right, body.right.w - 1, y, shade(c, 0.82));
      for (let y = 0; y < body.back.h; y++) put(atlas, body.back, Math.max(0, body.back.w - 1 - Math.floor(y / 2)), y, shade(c, 0.74));
    } else if (accessory.kind === "tie") {
      if (plan.formalSuit?.construction === "connected_tie_tapered_front") {
        // A connected knot and blade, not two diagonal disconnected strokes.
        const end = plan.formalSuit.jacketOpening === "buttoned" ? Math.max(2, Math.min(7, plan.formalSuit.shirtOpening)) : 7;
        for (let y = 1; y < end; y++) for (const x of [3, 4])
          put(atlas, body.front, x, y, shade(c, x === 3 ? 1 : 0.88));
        if (plan.formalSuit.tieAccent || plan.formalSuit.tiePattern === "striped") {
          // A thin source stripe covers only part of a full atlas pixel. Keep
          // the observed accent hue, but do not turn it into a shirt-colored
          // hole severing the two-pixel-wide knot/blade.
          const stripe = plan.formalSuit.tieAccent ? blend(c, rgb(plan.formalSuit.tieAccent, c), 0.28) : blend(c, [255, 255, 255], 0.14);
          for (const [x, y] of [[3, 2], [4, 3]]) if (y < end) put(atlas, body.front, x, y, stripe);
        }
        continue;
      }
      for (let y = 1; y < 7; y++) put(atlas, body.front, y < 3 ? 3 : 4, y, y % 2 === 0 ? c : shade(c, 0.78));
      if (plan.formalSuit?.tieAccent) put(atlas, body.front, 4, 3, rgb(plan.formalSuit.tieAccent, c));
      else if (plan.formalSuit?.tiePattern === "striped") {
        // Unresolved stripe hue uses only a tonal step of the tie material,
        // not invented white/colored ink. No new occupied cells or silhouette.
        const tonalStripe = blend(c, [255, 255, 255], 0.14);
        put(atlas, body.front, 3, 2, tonalStripe);
        put(atlas, body.front, 4, 5, tonalStripe);
      }
    } else if (accessory.kind === "bow") {
      const broad = /\bbroad\b/.test(accessory.evidence);
      const pixels: Array<readonly [number, number]> = [[2, 1], [3, 1], [5, 1], [2, 2], [3, 2], [4, 2], [5, 2], [3, 3], [4, 3]];
      if (broad) pixels.push([3, 4], [3, 5], [3, 6]);
      for (const [x, y] of pixels) put(atlas, body.front, x, y, x === 2 ? shade(c, 1.08) : x === 3 && y <= 2 ? shade(c, 0.72) : shade(c, 0.9));
    } else if (accessory.kind === "scarf") {
      for (const [x, y] of [[2, 0], [3, 0], [4, 0], [5, 0], [3, 1], [4, 1], [3, 2]] as const) put(atlas, body.front, x, y, x === 2 ? shade(c, 1.08) : x === 3 ? shade(c, 0.72) : x < 4 ? c : shade(c, 0.84));
    } else if (accessory.kind === "necklace") {
      for (const [x, y] of [[2, 1], [5, 1], [3, 2], [4, 2], [3, 3], [3, 4], [4, 4]] as const) put(atlas, body.front, x, y, y === 4 ? shade(c, 1.08) : c);
    } else if (accessory.kind === "suspenders") {
      for (let y = 1; y < 10; y++) for (const x of [2, 5]) put(atlas, body.front, x, y, shade(c, x === 2 ? 1 : 0.84));
    } else if (accessory.kind === "belt") {
      const y = Math.min(body.front.h - 1, Math.max(0, plan.lower.waistRow - 1));
      for (const face of ["front", "right", "left", "back"] as const) for (let x = 0; x < body[face].w; x++) put(atlas, body[face], x, y, shade(c, FACE_SHADE[face] * 0.72));
    } else if (accessory.kind === "hood_string") {
      for (const [x, y] of [[3, 1], [4, 1], [3, 2], [4, 3]] as const) put(atlas, body.front, x, y, c);
    } else if (accessory.kind === "wrist_cuff") {
      // One finite wrap at the wrist, leaving the last two hand rows bare.
      // This is accessory topology, independent of the observed sleeve cut.
      for (const part of ["rightArm", "leftArm"] as const) {
        const arm = CLASSIC_LAYOUT[part].overlay;
        for (const face of ["front", "back", "right", "left"] as const)
          for (let x = 0; x < arm[face].w; x++)
            put(atlas, arm[face], x, arm[face].h - 3, shade(c, FACE_SHADE[face]));
      }
    } else if (accessory.kind === "thigh_accessory") {
      const part = accessory.side === "right" ? "leftLeg" : "rightLeg";
      const front = CLASSIC_LAYOUT[part].overlay.front;
      const anchor = accessory.side === "right" ? 3 : 0;
      for (const [dx, dy] of [[0, 2], [accessory.side === "right" ? -1 : 1, 2], [0, 3]] as const) put(atlas, front, anchor + dx, dy, dy === 2 ? c : shade(c, 0.82));
    }
  }
}

/** Apply the analysis-derived body contract. Head UV coordinates are never touched. */
export function applyOutfitPlan(atlas: RawImage, plan: OutfitPlan, skinColor: string): void {
  if (atlas.width !== ATLAS_SIZE || atlas.height !== ATLAS_SIZE) return;
  const skin = rgb(skinColor, [211, 158, 128]);
  clearBodyOverlays(atlas);
  drawTorso(atlas, plan, skin);
  drawSleeve(atlas, CLASSIC_LAYOUT.rightArm.base, plan.upper.rightSleeve, plan.upper.pattern, skin, "rightArm");
  drawSleeve(atlas, CLASSIC_LAYOUT.leftArm.base, plan.upper.leftSleeve, plan.upper.pattern, skin, "leftArm");
  drawLower(atlas, plan, skin);
  drawOuter(atlas, plan);
}
