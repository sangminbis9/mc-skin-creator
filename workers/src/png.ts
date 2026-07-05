/**
 * 최소 이미지 코덱.
 * PNG: 자체 구현 (Workers 런타임의 CompressionStream/DecompressionStream("deflate")).
 *   지원 범위: 8-bit, colorType 0(gray)/2(RGB)/3(palette)/6(RGBA), non-interlaced.
 * JPEG: jpeg-js (순수 JS) — FLUX 출력이 base64 JPEG(JFIF)로 확인돼 필요하다.
 */

import { decode as decodeJpegRaw } from "jpeg-js";

export interface RawImage {
  width: number;
  height: number;
  /** RGBA, width * height * 4 */
  rgba: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class PngError extends Error {}

async function pipeThrough(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const blob = new Blob([bytes]);
  const out = new Response(blob.stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function decodePng(bytes: Uint8Array): Promise<RawImage> {
  if (bytes.length < 8 + 25 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new PngError("PNG 시그니처가 아닙니다");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts: Uint8Array[] = [];
  let palette: Uint8Array | null = null;
  let paletteAlpha: Uint8Array | null = null;

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const dataStart = offset + 8;
    if (dataStart + length > bytes.length) {
      throw new PngError("PNG 청크가 잘렸습니다");
    }
    const data = bytes.subarray(dataStart, dataStart + length);
    if (type === "IHDR") {
      width = view.getUint32(dataStart);
      height = view.getUint32(dataStart + 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = data.slice();
    } else if (type === "tRNS") {
      paletteAlpha = data.slice();
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4; // +4 = CRC
  }

  if (width <= 0 || height <= 0) {
    throw new PngError("PNG 크기가 올바르지 않습니다");
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new PngError(`지원하지 않는 PNG (bitDepth=${bitDepth}, interlace=${interlace})`);
  }
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (!channels) {
    throw new PngError(`지원하지 않는 colorType=${colorType}`);
  }

  const idat = concat(idatParts);
  const raw = await pipeThrough(idat, new DecompressionStream("deflate"));

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) {
    throw new PngError("PNG 데이터가 부족합니다");
  }

  // 스캔라인 unfilter
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowIn = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const rowOut = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    unfilterRow(filter, rowIn, rowOut, prev, channels);
  }

  // RGBA 변환
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 6) {
      rgba[d] = pixels[s];
      rgba[d + 1] = pixels[s + 1];
      rgba[d + 2] = pixels[s + 2];
      rgba[d + 3] = pixels[s + 3];
    } else if (colorType === 2) {
      rgba[d] = pixels[s];
      rgba[d + 1] = pixels[s + 1];
      rgba[d + 2] = pixels[s + 2];
      rgba[d + 3] = 255;
    } else if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s];
      rgba[d + 3] = 255;
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s];
      rgba[d + 3] = pixels[s + 1];
    } else {
      // palette
      const p = pixels[s] * 3;
      if (!palette || p + 2 >= palette.length) {
        throw new PngError("팔레트 인덱스가 범위를 벗어났습니다");
      }
      rgba[d] = palette[p];
      rgba[d + 1] = palette[p + 1];
      rgba[d + 2] = palette[p + 2];
      rgba[d + 3] = paletteAlpha?.[pixels[s]] ?? 255;
    }
  }

  return { width, height, rgba };
}

function unfilterRow(
  filter: number,
  rowIn: Uint8Array,
  rowOut: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
): void {
  const n = rowIn.length;
  for (let x = 0; x < n; x++) {
    const rawByte = rowIn[x];
    const left = x >= bpp ? rowOut[x - bpp] : 0;
    const up = prev ? prev[x] : 0;
    const upLeft = prev && x >= bpp ? prev[x - bpp] : 0;
    let value: number;
    switch (filter) {
      case 0:
        value = rawByte;
        break;
      case 1:
        value = rawByte + left;
        break;
      case 2:
        value = rawByte + up;
        break;
      case 3:
        value = rawByte + ((left + up) >> 1);
        break;
      case 4:
        value = rawByte + paeth(left, up, upLeft);
        break;
      default:
        throw new PngError(`지원하지 않는 필터=${filter}`);
    }
    rowOut[x] = value & 0xff;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** PNG/JPEG 자동 판별 디코더 — 이미지 생성 모델 출력용 */
export async function decodeImage(bytes: Uint8Array): Promise<RawImage> {
  if (PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    return decodePng(bytes);
  }
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const jpeg = decodeJpegRaw(bytes, {
      useTArray: true,
      maxMemoryUsageInMB: 64,
    });
    return {
      width: jpeg.width,
      height: jpeg.height,
      rgba: new Uint8Array(jpeg.data.buffer, jpeg.data.byteOffset, jpeg.data.length),
    };
  }
  throw new PngError("PNG/JPEG가 아닌 이미지입니다");
}

export async function encodePng(image: RawImage): Promise<Uint8Array> {
  const { width, height, rgba } = image;
  if (rgba.length !== width * height * 4) {
    throw new PngError("RGBA 버퍼 크기가 맞지 않습니다");
  }
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = await pipeThrough(raw, new CompressionStream("deflate"));

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  // compression/filter/interlace = 0

  return concat([
    new Uint8Array(PNG_SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * PNG/JPEG data URL에서 픽셀 크기를 읽는다 (디코딩 없이 헤더만).
 * 알 수 없는 포맷이면 null.
 */
export function sniffImageSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  // PNG
  if (bytes.length > 24 && PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: SOF 마커에서 크기 추출
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let pos = 2;
    while (pos + 9 < bytes.length) {
      if (bytes[pos] !== 0xff) {
        pos++;
        continue;
      }
      const marker = bytes[pos + 1];
      // SOF0-SOF15 (DHT/DAC/RST 제외)
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return {
          height: (bytes[pos + 5] << 8) | bytes[pos + 6],
          width: (bytes[pos + 7] << 8) | bytes[pos + 8],
        };
      }
      const length = (bytes[pos + 2] << 8) | bytes[pos + 3];
      pos += 2 + length;
    }
  }
  return null;
}
