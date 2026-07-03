/**
 * 인물 특징(SkinFeatures) → 마인크래프트 64x64 스킨 절차 생성기.
 *
 * AI vision 모델이 뽑은 특징 JSON을 받아 셰이딩·노이즈가 들어간
 * 픽셀 아트 스킨을 결정적으로(같은 입력 → 같은 출력) 그린다.
 */

import { ATLAS_SIZE, CLASSIC_LAYOUT, type BoxUV, type Rect } from "./skinAtlas";
import type { SkinFeatures } from "./skinFeatures";

// ---------- 색상 유틸 ----------

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${((clamp(r) << 16) | (clamp(g) << 8) | clamp(b))
    .toString(16)
    .padStart(6, "0")}`;
}

/** factor > 1 밝게, < 1 어둡게 */
export function shadeHex(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(r * factor, g * factor, b * factor);
}

function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return rgbToHex(
    ar + (br - ar) * t,
    ag + (bg - ag) * t,
    ab + (bb - ab) * t,
  );
}

function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// ---------- 시드 난수 (결정적 노이즈) ----------

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 페인터 ----------

/** 면별 기본 셰이딩 (마인크래프트 라이팅 느낌) */
const FACE_SHADE: Record<keyof BoxUV, number> = {
  top: 1.06,
  bottom: 0.62,
  right: 0.86,
  left: 0.86,
  front: 1.0,
  back: 0.92,
};

class AtlasPainter {
  private ctx: CanvasRenderingContext2D;
  private rand: () => number;

  constructor(canvas: HTMLCanvasElement, seed: number) {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("2D context unavailable");
    }
    this.ctx = ctx;
    this.rand = mulberry32(seed);
    ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  }

  /** 절대 atlas 좌표에 픽셀 하나 */
  px(x: number, y: number, hex: string, jitter = 0): void {
    let color = hex;
    if (jitter > 0) {
      const f = 1 + (this.rand() * 2 - 1) * jitter;
      color = shadeHex(hex, f);
    }
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, 1, 1);
  }

  erase(rect: Rect): void {
    this.ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
  }

  /** 면 채우기: 면별 셰이딩 + 지터 + 세로 그라데이션 */
  fillFace(
    rect: Rect,
    face: keyof BoxUV,
    hex: string,
    options: { jitter?: number; vGradient?: number } = {},
  ): void {
    const { jitter = 0.045, vGradient = 0 } = options;
    const base = shadeHex(hex, FACE_SHADE[face]);
    for (let y = 0; y < rect.h; y++) {
      const rowColor = vGradient
        ? shadeHex(base, 1 - y * vGradient)
        : base;
      for (let x = 0; x < rect.w; x++) {
        this.px(rect.x + x, rect.y + y, rowColor, jitter);
      }
    }
  }

  /** 면 위의 부분 사각형 (면 로컬 좌표) */
  fillOnFace(
    rect: Rect,
    face: keyof BoxUV,
    lx: number,
    ly: number,
    w: number,
    h: number,
    hex: string,
    jitter = 0.04,
  ): void {
    const base = shadeHex(hex, FACE_SHADE[face]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ax = rect.x + lx + x;
        const ay = rect.y + ly + y;
        if (
          ax >= rect.x &&
          ax < rect.x + rect.w &&
          ay >= rect.y &&
          ay < rect.y + rect.h
        ) {
          this.px(ax, ay, base, jitter);
        }
      }
    }
  }

  /** 면 로컬 좌표에 픽셀 하나 (면 셰이딩 적용) */
  pxOnFace(
    rect: Rect,
    face: keyof BoxUV,
    lx: number,
    ly: number,
    hex: string,
    jitter = 0,
  ): void {
    if (lx < 0 || ly < 0 || lx >= rect.w || ly >= rect.h) {
      return;
    }
    this.px(rect.x + lx, rect.y + ly, shadeHex(hex, FACE_SHADE[face]), jitter);
  }

  random(): number {
    return this.rand();
  }
}

// ---------- 부위별 그리기 ----------

const L = CLASSIC_LAYOUT;

function drawHeadBase(p: AtlasPainter, f: SkinFeatures): void {
  const uv = L.head.base;
  (Object.keys(uv) as (keyof BoxUV)[]).forEach((face) => {
    p.fillFace(uv[face], face, f.skinTone, { jitter: 0.03 });
  });
}

function drawFace(p: AtlasPainter, f: SkinFeatures): void {
  const front = L.head.base.front;
  const browColor = shadeHex(f.hairColor, 0.8);
  const skinShadow = shadeHex(f.skinTone, 0.82);
  const mouthColor = mixHex(shadeHex(f.skinTone, 0.62), "#a04a3c", 0.5);

  // 눈썹 (row 2)
  const brow = (lx: number) => p.pxOnFace(front, "front", lx, 2, browColor);
  if (f.eyebrowThickness === "thick") {
    [0, 1, 2, 5, 6, 7].forEach(brow);
  } else if (f.eyebrowThickness === "thin") {
    [1, 2, 5, 6].forEach((lx) =>
      p.pxOnFace(front, "front", lx, 2, mixHex(browColor, f.skinTone, 0.35)),
    );
  } else {
    [1, 2, 5, 6].forEach(brow);
  }

  // 눈 (rows 3-4): 흰자 + 눈동자 2x2
  const white = "#f5f5f0";
  for (const [wx, ix] of [
    [1, 2],
    [6, 5],
  ] as const) {
    p.pxOnFace(front, "front", wx, 3, white);
    p.pxOnFace(front, "front", wx, 4, shadeHex(white, 0.92));
    p.pxOnFace(front, "front", ix, 3, f.eyeColor);
    p.pxOnFace(front, "front", ix, 4, shadeHex(f.eyeColor, 0.75));
  }

  // 코 (row 5)
  p.pxOnFace(front, "front", 3, 5, skinShadow);
  p.pxOnFace(front, "front", 4, 5, skinShadow);

  // 입 (row 6)
  if (f.expression === "smile") {
    p.pxOnFace(front, "front", 3, 6, mouthColor);
    p.pxOnFace(front, "front", 4, 6, mouthColor);
    p.pxOnFace(front, "front", 2, 6, shadeHex(mouthColor, 1.15));
    p.pxOnFace(front, "front", 5, 6, shadeHex(mouthColor, 1.15));
    // 볼터치
    const blush = mixHex(f.skinTone, "#ff8a80", 0.35);
    p.pxOnFace(front, "front", 0, 5, blush);
    p.pxOnFace(front, "front", 7, 5, blush);
  } else if (f.expression === "serious") {
    p.pxOnFace(front, "front", 2, 6, shadeHex(mouthColor, 0.8));
    p.pxOnFace(front, "front", 3, 6, shadeHex(mouthColor, 0.8));
    p.pxOnFace(front, "front", 4, 6, shadeHex(mouthColor, 0.8));
    p.pxOnFace(front, "front", 5, 6, shadeHex(mouthColor, 0.8));
  } else {
    p.pxOnFace(front, "front", 3, 6, mouthColor);
    p.pxOnFace(front, "front", 4, 6, mouthColor);
  }
}

function drawFacialHair(p: AtlasPainter, f: SkinFeatures): void {
  if (f.facialHair === "none") {
    return;
  }
  const front = L.head.base.front;
  const right = L.head.base.right;
  const left = L.head.base.left;
  const color =
    f.facialHair === "stubble"
      ? mixHex(f.skinTone, f.hairColor, 0.4)
      : shadeHex(f.hairColor, 0.9);

  if (f.facialHair === "mustache" || f.facialHair === "beard") {
    // 콧수염: 입 위 (row 5 양쪽 + row 6 바깥)
    p.pxOnFace(front, "front", 2, 5, color);
    p.pxOnFace(front, "front", 5, 5, color);
  }
  if (f.facialHair === "goatee") {
    p.fillOnFace(front, "front", 3, 7, 2, 1, color);
  }
  if (f.facialHair === "beard" || f.facialHair === "stubble") {
    // 턱수염: 턱 전체 (row 7) + 볼 라인
    p.fillOnFace(front, "front", 0, 7, 8, 1, color, 0.08);
    p.pxOnFace(front, "front", 0, 6, color, 0.08);
    p.pxOnFace(front, "front", 1, 7, color, 0.08);
    p.pxOnFace(front, "front", 7, 6, color, 0.08);
    // 옆면 턱 라인
    p.fillOnFace(right, "right", 0, 7, 8, 1, color, 0.08);
    p.fillOnFace(left, "left", 0, 7, 8, 1, color, 0.08);
  }
}

function drawHair(p: AtlasPainter, f: SkinFeatures): void {
  if (f.hairstyle === "bald") {
    return;
  }
  const base = L.head.base;
  const over = L.head.overlay;
  const hair = f.hairColor;
  const jitter = f.hairstyle === "curly" || f.hairstyle === "afro" ? 0.12 : 0.06;
  const hatOn = f.hat !== "none";

  // 공통: 정수리 (모자가 있으면 모자가 덮음)
  if (!hatOn) {
    p.fillFace(base.top, "top", hair, { jitter });
  }

  // 스타일별 길이 (front 앞머리 rows / side rows / back rows)
  const style = f.hairstyle;
  const bangsRows = style === "buzz" ? 1 : 2;
  const sideRows =
    style === "buzz"
      ? 1
      : style === "short"
        ? 3
        : style === "medium" || style === "curly"
          ? 5
          : style === "bun" || style === "ponytail"
            ? 2
            : style === "afro"
              ? 3
              : 8; // long, twintails
  const backRows =
    style === "buzz"
      ? 2
      : style === "short"
        ? 4
        : style === "medium" || style === "curly"
          ? 6
          : style === "bun" || style === "ponytail"
            ? 3
            : style === "afro"
              ? 4
              : 8; // long, twintails

  // 앞머리 (모자를 써도 살짝 보이게 1줄은 유지)
  const frontRows = hatOn ? 1 : bangsRows;
  for (let y = 0; y < frontRows; y++) {
    for (let x = 0; x < 8; x++) {
      // 두 번째 줄은 들쭉날쭉하게
      if (y === 0 || p.random() > 0.35) {
        p.pxOnFace(base.front, "front", x, y, hair, jitter);
      }
    }
  }

  // 옆머리: 얼굴 쪽 가장자리는 남기고 채움
  p.fillOnFace(base.right, "right", 0, 0, 8, Math.min(sideRows, 8), hair, jitter);
  p.fillOnFace(base.left, "left", 0, 0, 8, Math.min(sideRows, 8), hair, jitter);
  // 뒷머리
  p.fillOnFace(base.back, "back", 0, 0, 8, Math.min(backRows, 8), hair, jitter);

  // 긴 머리는 얼굴 옆 라인까지 (front 양끝 세로줄)
  if (style === "long" || style === "twintails") {
    for (let y = 0; y < 6; y++) {
      p.pxOnFace(base.front, "front", 0, y, hair, jitter);
      p.pxOnFace(base.front, "front", 7, y, hair, jitter);
    }
  }

  // ---- 오버레이(볼륨) ----
  if (!hatOn) {
    p.fillFace(over.top, "top", hair, { jitter });
    // 이마 위 볼륨
    p.fillOnFace(over.front, "front", 0, 0, 8, 1, hair, jitter);
    p.fillOnFace(over.right, "right", 0, 0, 8, 1, hair, jitter);
    p.fillOnFace(over.left, "left", 0, 0, 8, 1, hair, jitter);
    p.fillOnFace(over.back, "back", 0, 0, 8, 1, hair, jitter);
  }

  if (style === "afro" || style === "curly") {
    const rows = style === "afro" ? 4 : 2;
    p.fillOnFace(over.front, "front", 0, 0, 8, rows, hair, 0.14);
    p.fillOnFace(over.right, "right", 0, 0, 8, rows + 1, hair, 0.14);
    p.fillOnFace(over.left, "left", 0, 0, 8, rows + 1, hair, 0.14);
    p.fillOnFace(over.back, "back", 0, 0, 8, rows + 1, hair, 0.14);
  }

  if (style === "long") {
    // 어깨까지 내려오는 뒷머리 (몸통 뒤 오버레이)
    const bodyBackOver = L.body.overlay.back;
    p.fillOnFace(bodyBackOver, "back", 0, 0, 8, 4, hair, jitter);
    p.fillOnFace(bodyBackOver, "back", 1, 4, 6, 1, hair, jitter);
    // 옆머리 볼륨
    p.fillOnFace(over.right, "right", 0, 0, 8, 6, hair, jitter);
    p.fillOnFace(over.left, "left", 0, 0, 8, 6, hair, jitter);
  }

  if (style === "ponytail") {
    // 뒤로 묶은 꼬리 (머리 뒤 오버레이 중앙 + 몸통 뒤)
    p.fillOnFace(over.back, "back", 2, 1, 4, 7, hair, jitter);
    p.fillOnFace(L.body.overlay.back, "back", 3, 0, 2, 4, hair, jitter);
  }

  if (style === "bun") {
    // 똥머리: 머리 뒤 오버레이 위쪽 뭉치
    p.fillOnFace(over.back, "back", 2, 0, 4, 3, hair, jitter);
    p.fillOnFace(over.top, "top", 2, 5, 4, 3, hair, jitter);
  }

  if (style === "twintails") {
    // 양갈래: 좌우 오버레이 아래로 길게
    p.fillOnFace(over.right, "right", 5, 0, 3, 8, hair, jitter);
    p.fillOnFace(over.left, "left", 0, 0, 3, 8, hair, jitter);
    // 몸통 옆까지
    p.fillOnFace(L.body.overlay.right, "right", 0, 0, 4, 4, hair, jitter);
    p.fillOnFace(L.body.overlay.left, "left", 0, 0, 4, 4, hair, jitter);
  }
}

function drawGlasses(p: AtlasPainter, f: SkinFeatures): void {
  if (f.glasses === "none") {
    return;
  }
  const front = L.head.overlay.front;
  const rim = f.glassesColor;
  const isSun = f.glasses === "sunglasses";
  const lens = isSun ? shadeHex(rim, 0.55) : null;

  // 렌즈 테두리 (눈 rows 3-4 주변)
  for (const x0 of [0, 5]) {
    if (f.glasses === "round") {
      // 둥근 테: 모서리 생략
      p.pxOnFace(front, "front", x0 + 1, 2, rim);
      p.pxOnFace(front, "front", x0, 3, rim);
      p.pxOnFace(front, "front", x0 + 2, 3, rim);
      p.pxOnFace(front, "front", x0 + 1, 5, rim);
    } else {
      p.fillOnFace(front, "front", x0, 2, 3, 1, rim, 0);
      p.pxOnFace(front, "front", x0, 3, rim);
      p.pxOnFace(front, "front", x0 + 2, 3, rim);
      p.fillOnFace(front, "front", x0, 5, 3, 1, rim, 0);
      p.pxOnFace(front, "front", x0, 4, rim);
      p.pxOnFace(front, "front", x0 + 2, 4, rim);
    }
    if (lens) {
      p.pxOnFace(front, "front", x0 + 1, 3, lens);
      p.pxOnFace(front, "front", x0 + 1, 4, lens);
    }
  }
  // 브릿지
  p.pxOnFace(front, "front", 3, 3, rim);
  p.pxOnFace(front, "front", 4, 3, rim);
  // 안경 다리 (옆면)
  p.pxOnFace(L.head.overlay.right, "right", 7, 3, rim);
  p.pxOnFace(L.head.overlay.right, "right", 6, 3, rim);
  p.pxOnFace(L.head.overlay.left, "left", 0, 3, rim);
  p.pxOnFace(L.head.overlay.left, "left", 1, 3, rim);
}

function drawHat(p: AtlasPainter, f: SkinFeatures): void {
  if (f.hat === "none") {
    return;
  }
  const over = L.head.overlay;
  const color = f.hatColor;
  const dark = shadeHex(color, 0.8);

  p.fillFace(over.top, "top", color, { jitter: 0.04 });

  if (f.hat === "cap") {
    p.fillOnFace(over.front, "front", 0, 0, 8, 2, color, 0.04);
    // 챙: 앞면 3번째 줄을 어둡게
    p.fillOnFace(over.front, "front", 0, 2, 8, 1, dark, 0);
    p.fillOnFace(over.right, "right", 0, 0, 8, 2, color, 0.04);
    p.fillOnFace(over.left, "left", 0, 0, 8, 2, color, 0.04);
    p.fillOnFace(over.back, "back", 0, 0, 8, 2, color, 0.04);
    // 정면 로고 픽셀
    p.pxOnFace(over.front, "front", 3, 1, f.topAccentColor);
    p.pxOnFace(over.front, "front", 4, 1, f.topAccentColor);
  } else if (f.hat === "beanie") {
    p.fillOnFace(over.front, "front", 0, 0, 8, 3, color, 0.05);
    p.fillOnFace(over.right, "right", 0, 0, 8, 3, color, 0.05);
    p.fillOnFace(over.left, "left", 0, 0, 8, 3, color, 0.05);
    p.fillOnFace(over.back, "back", 0, 0, 8, 3, color, 0.05);
    // 접힌 밑단
    p.fillOnFace(over.front, "front", 0, 2, 8, 1, dark, 0);
    p.fillOnFace(over.right, "right", 0, 2, 8, 1, dark, 0);
    p.fillOnFace(over.left, "left", 0, 2, 8, 1, dark, 0);
    p.fillOnFace(over.back, "back", 0, 2, 8, 1, dark, 0);
  } else {
    // hood: 옆/뒤 전체 + 이마
    p.fillOnFace(over.front, "front", 0, 0, 8, 2, color, 0.05);
    p.fillOnFace(over.right, "right", 0, 0, 8, 8, color, 0.05);
    p.fillOnFace(over.left, "left", 0, 0, 8, 8, color, 0.05);
    p.fillOnFace(over.back, "back", 0, 0, 8, 8, color, 0.05);
  }
}

function drawEarrings(p: AtlasPainter, f: SkinFeatures): void {
  if (!f.earrings) {
    return;
  }
  const gold = "#ffd34d";
  p.pxOnFace(L.head.base.right, "right", 2, 5, gold);
  p.pxOnFace(L.head.base.left, "left", 5, 5, gold);
}

function drawBody(p: AtlasPainter, f: SkinFeatures): void {
  const uv = L.body.base;
  const top = f.topColor;
  const accent = f.topAccentColor;
  const dark = shadeHex(top, 0.78);

  (Object.keys(uv) as (keyof BoxUV)[]).forEach((face) => {
    p.fillFace(uv[face], face, top, { jitter: 0.05, vGradient: 0.008 });
  });

  const front = uv.front;

  switch (f.topType) {
    case "shirt": {
      // 카라 + 단추
      p.pxOnFace(front, "front", 2, 0, accent);
      p.pxOnFace(front, "front", 5, 0, accent);
      p.pxOnFace(front, "front", 3, 0, shadeHex(f.skinTone, 0.95));
      p.pxOnFace(front, "front", 4, 0, shadeHex(f.skinTone, 0.95));
      for (const y of [2, 5, 8]) {
        p.pxOnFace(front, "front", 4, y, dark);
      }
      break;
    }
    case "hoodie": {
      // 끈 + 주머니 + 뒤 후드 뭉치
      p.pxOnFace(front, "front", 2, 1, accent);
      p.pxOnFace(front, "front", 5, 1, accent);
      p.pxOnFace(front, "front", 2, 2, accent);
      p.pxOnFace(front, "front", 5, 2, accent);
      p.fillOnFace(front, "front", 1, 8, 6, 3, dark, 0.04);
      p.fillOnFace(uv.back, "back", 1, 0, 6, 3, dark, 0.05);
      break;
    }
    case "jacket": {
      // 안에 받쳐 입은 이너 + 지퍼 라인
      p.fillOnFace(front, "front", 3, 0, 2, 12, accent, 0.04);
      for (let y = 0; y < 12; y++) {
        p.pxOnFace(front, "front", 4, y, shadeHex(accent, 0.8));
      }
      p.pxOnFace(front, "front", 2, 0, dark);
      p.pxOnFace(front, "front", 5, 0, dark);
      p.pxOnFace(front, "front", 2, 1, dark);
      p.pxOnFace(front, "front", 5, 1, dark);
      break;
    }
    case "sweater": {
      // 골지 무늬
      for (let y = 1; y < 12; y += 3) {
        p.fillOnFace(front, "front", 0, y, 8, 1, shadeHex(top, 0.92), 0.03);
        p.fillOnFace(uv.back, "back", 0, y, 8, 1, shadeHex(top, 0.92), 0.03);
      }
      p.fillOnFace(front, "front", 2, 0, 4, 1, dark, 0);
      break;
    }
    case "tank": {
      // 어깨끈만 남기고 위쪽은 피부
      p.fillOnFace(front, "front", 0, 0, 8, 2, f.skinTone, 0.03);
      p.fillOnFace(uv.back, "back", 0, 0, 8, 2, f.skinTone, 0.03);
      p.fillOnFace(front, "front", 1, 0, 2, 2, top, 0.04);
      p.fillOnFace(front, "front", 5, 0, 2, 2, top, 0.04);
      p.fillOnFace(uv.back, "back", 1, 0, 2, 2, top, 0.04);
      p.fillOnFace(uv.back, "back", 5, 0, 2, 2, top, 0.04);
      break;
    }
    case "dress": {
      // 허리 라인
      p.fillOnFace(front, "front", 0, 7, 8, 1, dark, 0);
      break;
    }
    default: {
      // tshirt: 목선
      p.pxOnFace(front, "front", 3, 0, shadeHex(top, 0.85));
      p.pxOnFace(front, "front", 4, 0, shadeHex(top, 0.85));
      // 가슴 프린트 포인트
      p.fillOnFace(front, "front", 3, 3, 2, 2, accent, 0.05);
      break;
    }
  }
}

function drawArm(
  p: AtlasPainter,
  f: SkinFeatures,
  part: "rightArm" | "leftArm",
): void {
  const uv = L[part].base;
  const sleeveRows =
    f.topType === "tank"
      ? 0
      : f.sleeveLength === "long" ||
          f.topType === "hoodie" ||
          f.topType === "jacket" ||
          f.topType === "sweater"
        ? 10
        : 5;

  (Object.keys(uv) as (keyof BoxUV)[]).forEach((face) => {
    const rect = uv[face];
    if (face === "top") {
      p.fillFace(rect, face, sleeveRows > 0 ? f.topColor : f.skinTone, {
        jitter: 0.04,
      });
      return;
    }
    if (face === "bottom") {
      p.fillFace(rect, face, f.skinTone, { jitter: 0.03 });
      return;
    }
    // 소매 + 피부
    for (let y = 0; y < rect.h; y++) {
      const isSleeve = y < sleeveRows;
      const color = isSleeve ? f.topColor : f.skinTone;
      for (let x = 0; x < rect.w; x++) {
        p.px(
          rect.x + x,
          rect.y + y,
          shadeHex(color, FACE_SHADE[face] * (1 - y * 0.006)),
          isSleeve ? 0.05 : 0.03,
        );
      }
    }
    // 소매 끝단
    if (sleeveRows > 0 && sleeveRows < rect.h) {
      for (let x = 0; x < rect.w; x++) {
        p.px(
          rect.x + x,
          rect.y + sleeveRows - 1,
          shadeHex(f.topColor, FACE_SHADE[face] * 0.85),
        );
      }
    }
  });
}

function drawLeg(
  p: AtlasPainter,
  f: SkinFeatures,
  part: "rightLeg" | "leftLeg",
): void {
  const uv = L[part].base;
  const isDress = f.topType === "dress";
  const skirtColor = isDress ? f.topColor : f.bottomColor;
  const shoeRows = 2;

  const pantsRows =
    f.bottomType === "shorts"
      ? 6
      : f.bottomType === "skirt"
        ? 4
        : 12; // pants, jeans는 신발까지 덮고 신발이 위에 그려짐

  (Object.keys(uv) as (keyof BoxUV)[]).forEach((face) => {
    const rect = uv[face];
    if (face === "top") {
      p.fillFace(rect, face, f.bottomType === "skirt" ? skirtColor : f.bottomColor, {
        jitter: 0.04,
      });
      return;
    }
    if (face === "bottom") {
      // 신발 밑창
      p.fillFace(rect, face, shadeHex(f.shoesColor, 0.8), { jitter: 0.03 });
      return;
    }
    for (let y = 0; y < rect.h; y++) {
      let color: string;
      let jitter = 0.04;
      if (y >= rect.h - shoeRows) {
        color = f.shoesColor;
      } else if (y < pantsRows) {
        color = f.bottomType === "skirt" ? skirtColor : f.bottomColor;
        if (f.bottomType === "jeans") {
          jitter = 0.07;
        }
      } else {
        color = f.skinTone;
        jitter = 0.03;
      }
      for (let x = 0; x < rect.w; x++) {
        p.px(
          rect.x + x,
          rect.y + y,
          shadeHex(color, FACE_SHADE[face] * (1 - y * 0.004)),
          jitter,
        );
      }
    }
    // 청바지 밑단 스티치
    if (f.bottomType === "jeans" && pantsRows >= rect.h - shoeRows) {
      for (let x = 0; x < rect.w; x++) {
        p.px(
          rect.x + x,
          rect.y + rect.h - shoeRows - 1,
          shadeHex(f.bottomColor, FACE_SHADE[face] * 1.18),
        );
      }
    }
    // 신발 윗선
    for (let x = 0; x < rect.w; x++) {
      p.px(
        rect.x + x,
        rect.y + rect.h - shoeRows,
        shadeHex(f.shoesColor, FACE_SHADE[face] * 1.05),
      );
    }
  });

  // 치마/원피스: 다리 오버레이 위쪽에 퍼지는 플레어
  if (f.bottomType === "skirt" || isDress) {
    const over = L[part].overlay;
    const flare = shadeHex(skirtColor, 0.94);
    (["front", "back", "right", "left"] as const).forEach((face) => {
      p.fillOnFace(over[face], face, 0, 0, 4, isDress ? 5 : 4, flare, 0.05);
    });
  }
}

// ---------- 진입점 ----------

/**
 * 특징 → 64x64 스킨 캔버스 생성.
 * 같은 features 입력이면 항상 같은 결과가 나온다.
 */
export function generateSkinFromFeatures(
  features: SkinFeatures,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;

  const seed = hashString(JSON.stringify(features));
  const p = new AtlasPainter(canvas, seed);

  drawHeadBase(p, features);
  drawHair(p, features);
  drawFace(p, features);
  drawFacialHair(p, features);
  drawEarrings(p, features);
  drawBody(p, features);
  drawArm(p, features, "rightArm");
  drawArm(p, features, "leftArm");
  drawLeg(p, features, "rightLeg");
  drawLeg(p, features, "leftLeg");
  drawGlasses(p, features);
  drawHat(p, features);

  return canvas;
}

/** 밝은 색 위 텍스트 대비용 (공유 카드 등에서 사용) */
export function isLightColor(hex: string): boolean {
  return luminance(hex) > 0.6;
}
