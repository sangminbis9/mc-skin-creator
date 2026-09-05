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
): void {
  if (pattern.kind === "none") return;
  if (pattern.placement === "front" && face !== "front") return;
  const accent = rgb(pattern.color, [230, 226, 216]);
  const faceColor = shade(accent, FACE_SHADE[face]);
  if (pattern.kind === "horizontal_stripe") {
    for (let y = 2; y < Math.min(rect.h, maxRows); y += pattern.frequency) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, y, faceColor);
  } else if (pattern.kind === "vertical_stripe") {
    for (let x = 1; x < rect.w; x += pattern.frequency) for (let y = 1; y < Math.min(rect.h, maxRows); y++) put(atlas, rect, x, y, faceColor);
  } else if (pattern.kind === "checker_block") {
    for (let y = 1; y < Math.min(rect.h, maxRows); y += 2) for (let x = y % 4 === 1 ? 0 : 2; x < rect.w; x += 4) {
      put(atlas, rect, x, y, faceColor);
      put(atlas, rect, Math.min(rect.w - 1, x + 1), y, shade(faceColor, 0.86));
    }
  } else if (pattern.kind === "center_graphic" && face === "front") {
    const cx = pattern.anchor === "left" ? 1 : pattern.anchor === "right" ? rect.w - 3 : Math.floor(rect.w / 2) - 1;
    const y = Math.min(maxRows - 2, 4);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1], [-1, 1]] as const) put(atlas, rect, cx + dx, y + dy, dy === 0 ? faceColor : shade(faceColor, 0.82));
  } else if (pattern.kind === "irregular_group" && face === "front") {
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
      for (let y = 1; y < Math.min(plan.lower.waistRow, front.h); y++) for (let x = 2; x <= 5; x++) put(atlas, front, x, y, x === 5 ? shade(c, 0.92) : c);
    } else if (block.region === "front_left") {
      for (let y = 1; y < plan.lower.waistRow; y++) for (let x = 0; x < 4; x++) put(atlas, front, x, y, c);
    } else if (block.region === "front_right") {
      for (let y = 1; y < plan.lower.waistRow; y++) for (let x = 4; x < 8; x++) put(atlas, front, x, y, shade(c, 0.94));
    } else if (block.region === "vertical_opening") {
      for (let y = 1; y < plan.lower.waistRow; y++) {
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
  for (const face of ["front", "right", "left", "back"] as const) drawPattern(atlas, box[face], plan.upper.pattern, plan.lower.waistRow, face);
  drawNeckline(atlas, plan, skin);
}

function drawSleeve(atlas: RawImage, box: BoxUV, sleeve: OutfitSleevePlan, pattern: OutfitPatternPlan, skin: Rgb): void {
  const cloth = rgb(sleeve.color, [82, 106, 140]);
  fillBox(atlas, box, skin);
  for (const face of ["front", "right", "left", "back"] as const) {
    const rect = box[face];
    for (let y = 0; y < Math.min(rect.h, sleeve.terminationRow); y++) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, y, shade(cloth, FACE_SHADE[face]));
    if (pattern.placement === "front_and_sleeves" || pattern.placement === "wrap") drawPattern(atlas, rect, pattern, sleeve.terminationRow, face);
    if (sleeve.terminationRow > 0 && sleeve.terminationRow < rect.h) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, sleeve.terminationRow - 1, shade(cloth, FACE_SHADE[face] * 0.76));
  }
  fill(atlas, box.top, shade(cloth, FACE_SHADE.top));
  fill(atlas, box.bottom, shade(skin, FACE_SHADE.bottom));
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
        const legwearStart = plan.lower.legwear.kind === "socks" ? Math.max(garmentEnd, shoeStart - 3) : plan.lower.legwear.kind === "leg_warmers" ? Math.max(garmentEnd, shoeStart - 5) : garmentEnd;
        for (let y = legwearStart; y < shoeStart; y++) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, y, shade(legwear, FACE_SHADE[face] * (y === legwearStart ? 1.08 : 1)));
      }
      for (let y = shoeStart; y < rect.h; y++) for (let x = 0; x < rect.w; x++) put(atlas, rect, x, y, shade(shoes, FACE_SHADE[face] * (y === rect.h - 1 ? 0.72 : 1)));
      drawPattern(atlas, rect, plan.lower.pattern, garmentEnd, face);
    }
    fill(atlas, box.top, shade(garment, FACE_SHADE.top));
    fill(atlas, box.bottom, shade(shoes, FACE_SHADE.bottom));
  }
}

function drawOuter(atlas: RawImage, plan: OutfitPlan): void {
  const body = CLASSIC_LAYOUT.body.overlay;
  const garment = rgb(plan.upper.baseColor, [82, 106, 140]);
  const accent = rgb(plan.upper.accentColor, [236, 231, 220]);
  const lower = rgb(plan.lower.baseColor, [55, 67, 88]);
  const has = (region: OutfitPlan["outerLayer"]["regions"][number]) => plan.outerLayer.regions.includes(region);
  if (has("collar")) for (const [x, y] of [[1, 0], [2, 0], [2, 1], [5, 0], [6, 0], [5, 1]] as const) put(atlas, body.front, x, y, x < 4 ? accent : shade(accent, 0.88));
  if (has("lapels")) {
    for (let y = 0; y < Math.min(8, plan.lower.waistRow); y++) {
      const spread = Math.min(2, Math.floor(y / 3));
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
      for (const face of ["front", "back"] as const) for (let x = 0; x < arm[face].w; x++) put(atlas, arm[face], x, cuffY, shade(garment, FACE_SHADE[face] * 0.84));
      for (const face of ["right", "left"] as const) for (const x of [0, arm[face].w - 1]) put(atlas, arm[face], x, cuffY, shade(garment, FACE_SHADE[face] * 0.84));
      for (let x = 0; x < arm.top.w; x++) put(atlas, arm.top, x, 0, shade(garment, FACE_SHADE.top * 0.84));
    }
  }
  if (has("hem")) for (const face of ["front", "right", "left", "back"] as const) for (let x = 0; x < body[face].w; x += 2) {
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
  if (has("legwear")) {
    const legwear = rgb(plan.lower.legwear.color, accent);
    for (const part of ["rightLeg", "leftLeg"] as const) {
      const viewerSide = part === "rightLeg" ? "left" : "right";
      if (!(plan.lower.legwear.asymmetry === "both" || plan.lower.legwear.asymmetry === viewerSide || plan.lower.legwear.asymmetry === "none")) continue;
      const leg = CLASSIC_LAYOUT[part].overlay;
      const start = plan.lower.legwear.kind === "socks" ? 7 : plan.lower.legwear.kind === "leg_warmers" ? 4 : plan.lower.legwear.kind === "thigh_highs" ? 0 : 3;
      for (const face of ["front", "right", "left", "back"] as const) for (let y = start; y < Math.min(9, leg[face].h); y++) {
        const x = y % 2 === 0 ? 0 : leg[face].w - 1;
        put(atlas, leg[face], x, y, shade(legwear, FACE_SHADE[face] * (y === start ? 1.08 : 0.88)));
      }
      if (plan.lower.legwear.kind === "thigh_highs" || plan.lower.legwear.kind === "leg_warmers" || plan.lower.legwear.kind === "socks") {
        for (const y of [start, Math.min(leg.front.h - 1, start + 1), Math.min(leg.front.h - 1, start + 4)]) for (const x of [1, 2]) put(atlas, leg.front, x, y, shade(legwear, x === 1 ? 1.04 : 0.88));
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
  if (has("graphic_depth") && plan.upper.pattern.kind === "center_graphic") {
    const x = plan.upper.pattern.anchor === "left" ? 1 : plan.upper.pattern.anchor === "right" ? 6 : 3;
    for (const [dx, dy] of [[0, 3], [1, 3], [0, 4]] as const) put(atlas, body.front, x + dx, dy, dx === 0 && dy === 3 ? accent : shade(accent, 0.78));
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
      for (let y = 1; y < 7; y++) put(atlas, body.front, y < 3 ? 3 : 4, y, y % 2 === 0 ? c : shade(c, 0.78));
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
  drawSleeve(atlas, CLASSIC_LAYOUT.rightArm.base, plan.upper.rightSleeve, plan.upper.pattern, skin);
  drawSleeve(atlas, CLASSIC_LAYOUT.leftArm.base, plan.upper.leftSleeve, plan.upper.pattern, skin);
  drawLower(atlas, plan, skin);
  drawOuter(atlas, plan);
}
