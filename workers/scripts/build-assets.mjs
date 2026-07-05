/**
 * Worker 자산 생성 스크립트 (Node 전용, 의존성 없음).
 *
 * 1) src/assets/uvGuide.ts — 마인크래프트 64x64 classic UV 배치 가이드를
 *    부위별 색으로 그린 뒤 nearest-neighbor 7x(448x448)로 확대해 base64로 내장.
 * 2) (선택) 스타일 참고 스킨 64x64 PNG 경로를 인자로 주면 448x448로 확대한
 *    PNG와 base64 파일을 만들어 KV 업로드 명령을 안내한다.
 *    참고 스킨은 사용 권리가 확인될 때까지 저장소에 커밋하지 않는다.
 *
 * 사용법:
 *   node scripts/build-assets.mjs [style-ref-64.png] [출력디렉터리]
 */

import { deflateSync, inflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ATLAS = 64;
const SCALE = 7; // 64 * 7 = 448 (FLUX 입력 제한 512 미만)

// ---------- UV 레이아웃 (workers/src/uvLayout.ts와 동일 좌표) ----------

function boxUV(u, v, w, h, d) {
  return {
    top: { x: u + d, y: v, w, h: d },
    bottom: { x: u + d + w, y: v, w, h: d },
    right: { x: u, y: v + d, w: d, h },
    front: { x: u + d, y: v + d, w, h },
    left: { x: u + d + w, y: v + d, w: d, h },
    back: { x: u + d + w + d, y: v + d, w, h },
  };
}

const LAYOUT = {
  head: { base: boxUV(0, 0, 8, 8, 8), overlay: boxUV(32, 0, 8, 8, 8) },
  body: { base: boxUV(16, 16, 8, 12, 4), overlay: boxUV(16, 32, 8, 12, 4) },
  rightArm: { base: boxUV(40, 16, 4, 12, 4), overlay: boxUV(40, 32, 4, 12, 4) },
  leftArm: { base: boxUV(32, 48, 4, 12, 4), overlay: boxUV(48, 48, 4, 12, 4) },
  rightLeg: { base: boxUV(0, 16, 4, 12, 4), overlay: boxUV(0, 32, 4, 12, 4) },
  leftLeg: { base: boxUV(16, 48, 4, 12, 4), overlay: boxUV(0, 48, 4, 12, 4) },
};

/** 부위별 기준색 [r, g, b] */
const PART_COLORS = {
  head: [214, 72, 72],
  body: [70, 160, 84],
  rightArm: [70, 110, 205],
  leftArm: [70, 185, 205],
  rightLeg: [220, 140, 60],
  leftLeg: [150, 90, 200],
};

/** 면별 밝기 변화로 top/bottom/front/back을 구분 */
const FACE_SHADE = {
  top: 1.25,
  bottom: 0.55,
  front: 1.0,
  right: 0.8,
  left: 0.8,
  back: 0.65,
};

// ---------- 최소 PNG 인코더/디코더 ----------

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256).map((_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 8-bit RGB/RGBA/palette non-interlaced PNG → RGBA */
function decodePng(bytes) {
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  let palette = null;
  let trns = null;
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString("ascii", off + 4, off + 8);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = bytes.readUInt32BE(off + 8);
      height = bytes.readUInt32BE(off + 12);
      if (data[8] !== 8 || data[12] !== 0) {
        throw new Error("8-bit non-interlaced PNG만 지원");
      }
      colorType = data[9];
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") trns = Buffer.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const ul = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value;
      if (filter === 0) value = v;
      else if (filter === 1) value = v + left;
      else if (filter === 2) value = v + up;
      else if (filter === 3) value = v + ((left + up) >> 1);
      else if (filter === 4) value = v + paeth(left, up, ul);
      else throw new Error(`filter=${filter} 미지원`);
      pixels[y * stride + x] = value & 0xff;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 6) pixels.copy(rgba, d, s, s + 4);
    else if (colorType === 2) {
      pixels.copy(rgba, d, s, s + 3);
      rgba[d + 3] = 255;
    } else if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s];
      rgba[d + 3] = 255;
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s];
      rgba[d + 3] = pixels[s + 1];
    } else {
      const p = pixels[s] * 3;
      rgba[d] = palette[p];
      rgba[d + 1] = palette[p + 1];
      rgba[d + 2] = palette[p + 2];
      rgba[d + 3] = trns?.[pixels[s]] ?? 255;
    }
  }
  return { width, height, rgba };
}

function upscaleNearest(rgba, width, height, scale) {
  const out = Buffer.alloc(width * scale * height * scale * 4);
  for (let y = 0; y < height * scale; y++) {
    for (let x = 0; x < width * scale; x++) {
      const s = ((y / scale | 0) * width + (x / scale | 0)) * 4;
      rgba.copy(out, (y * width * scale + x) * 4, s, s + 4);
    }
  }
  return out;
}

// ---------- UV 가이드 그리기 ----------

function drawUvGuide() {
  const rgba = Buffer.alloc(ATLAS * ATLAS * 4);
  // 배경: 어두운 회색 불투명 (모델이 "빈 영역"으로 인식하게)
  for (let i = 0; i < ATLAS * ATLAS; i++) {
    rgba[i * 4] = 24;
    rgba[i * 4 + 1] = 24;
    rgba[i * 4 + 2] = 28;
    rgba[i * 4 + 3] = 255;
  }
  const fillFace = (rect, [r, g, b], shade, isOverlay) => {
    for (let y = rect.y; y < rect.y + rect.h; y++) {
      for (let x = rect.x; x < rect.x + rect.w; x++) {
        const border =
          y === rect.y || y === rect.y + rect.h - 1 || x === rect.x || x === rect.x + rect.w - 1;
        // overlay는 옅게, 면 테두리는 어둡게 — 영역 경계를 시각적으로 강조
        let f = shade * (isOverlay ? 0.6 : 1);
        if (border) f *= 0.45;
        const d = (y * ATLAS + x) * 4;
        rgba[d] = Math.min(255, r * f + (isOverlay ? 70 : 0));
        rgba[d + 1] = Math.min(255, g * f + (isOverlay ? 70 : 0));
        rgba[d + 2] = Math.min(255, b * f + (isOverlay ? 70 : 0));
        rgba[d + 3] = 255;
      }
    }
  };
  for (const [part, layout] of Object.entries(LAYOUT)) {
    for (const [face, rect] of Object.entries(layout.base)) {
      fillFace(rect, PART_COLORS[part], FACE_SHADE[face], false);
    }
    for (const [face, rect] of Object.entries(layout.overlay)) {
      fillFace(rect, PART_COLORS[part], FACE_SHADE[face], true);
    }
  }
  return rgba;
}

// ---------- 실행 ----------

const guide64 = drawUvGuide();
const guide448 = upscaleNearest(guide64, ATLAS, ATLAS, SCALE);
const guidePng = encodePng(ATLAS * SCALE, ATLAS * SCALE, guide448);
const assetsDir = join(HERE, "..", "src", "assets");
mkdirSync(assetsDir, { recursive: true });
writeFileSync(
  join(assetsDir, "uvGuide.ts"),
  `/**
 * 마인크래프트 64x64 classic UV 배치 가이드 (448x448 PNG, nearest 7x).
 * scripts/build-assets.mjs가 생성한다 — 직접 수정하지 말 것.
 */

export const UV_GUIDE_PNG_B64 =
  "${guidePng.toString("base64")}";
`,
);
console.log(`uvGuide.ts 생성 완료 (${guidePng.length} bytes PNG)`);

const styleRefPath = process.argv[2];
if (styleRefPath) {
  const outDir = resolve(process.argv[3] ?? HERE);
  const src = decodePng(readFileSync(styleRefPath));
  if (src.width !== 64 || src.height !== 64) {
    throw new Error(`스타일 참고 스킨은 64x64여야 합니다 (${src.width}x${src.height})`);
  }
  const big = upscaleNearest(src.rgba, 64, 64, SCALE);
  const png = encodePng(448, 448, big);
  const pngPath = join(outDir, "style-ref-448.png");
  const b64Path = join(outDir, "style-ref-448.b64");
  writeFileSync(pngPath, png);
  writeFileSync(b64Path, png.toString("base64"));
  console.log(`스타일 참고 이미지 변환 완료: ${pngPath}`);
  console.log("KV 업로드 (workers 디렉터리에서):");
  console.log(
    `  wrangler kv key put --binding MCSKIN_KV --remote "asset:style-ref-448" --path "${b64Path}"`,
  );
}
