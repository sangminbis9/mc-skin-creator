import { encode as encodeJpeg } from "jpeg-js";
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  decodeImage,
  decodePng,
  encodePng,
  sniffImageSize,
} from "../src/png";
import { makeSyntheticAtlas } from "./helpers";

describe("png codec", () => {
  it("encode → decode 왕복에서 픽셀이 보존된다", async () => {
    const original = makeSyntheticAtlas();
    const bytes = await encodePng(original);
    const decoded = await decodePng(bytes);
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(64);
    expect(decoded.rgba).toEqual(original.rgba);
  });

  it("PNG가 아닌 입력은 거부한다", async () => {
    await expect(decodePng(new Uint8Array(100))).rejects.toThrow();
  });

  it("decodeImage가 JPEG(FLUX 실제 출력 포맷)를 디코딩한다", async () => {
    const original = makeSyntheticAtlas();
    const jpeg = encodeJpeg(
      { width: 64, height: 64, data: original.rgba },
      95,
    );
    const decoded = await decodeImage(new Uint8Array(jpeg.data));
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(64);
    // 손실 압축이므로 픽셀 근사만 확인
    let diff = 0;
    for (let i = 0; i < decoded.rgba.length; i += 4) {
      diff += Math.abs(decoded.rgba[i] - original.rgba[i]);
    }
    expect(diff / (64 * 64)).toBeLessThan(40);
  });

  it("decodeImage가 PNG도 그대로 처리한다", async () => {
    const bytes = await encodePng(makeSyntheticAtlas());
    const decoded = await decodeImage(bytes);
    expect(decoded.width).toBe(64);
  });

  it("base64 왕복이 무손실이다", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("sniffImageSize가 PNG 크기를 읽는다", async () => {
    const bytes = await encodePng(makeSyntheticAtlas());
    expect(sniffImageSize(bytes)).toEqual({ width: 64, height: 64 });
  });

  it("sniffImageSize가 JPEG SOF에서 크기를 읽는다", () => {
    // 최소 JPEG 헤더: SOI + SOF0(높이 300, 너비 448)
    const jpeg = new Uint8Array([
      0xff, 0xd8, // SOI
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x01, 0x2c, 0x01, 0xc0, 0x03, 0x00, // SOF0
    ]);
    expect(sniffImageSize(jpeg)).toEqual({ width: 448, height: 300 });
  });

  it("알 수 없는 포맷은 null", () => {
    expect(sniffImageSize(new Uint8Array([1, 2, 3, 4, 5, 6]))).toBeNull();
  });
});
