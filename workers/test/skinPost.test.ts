import { describe, expect, it } from "vitest";
import type { RawImage } from "../src/png";
import {
  applyUvMask,
  downscaleToAtlas,
  validateAtlas,
  validateFinalAtlas,
} from "../src/skinPost";
import { ATLAS_SIZE, HEAD_FRONT, buildZoneMap } from "../src/uvLayout";
import { makeSyntheticAtlas, upscale } from "./helpers";

const ZONES = buildZoneMap();

describe("downscaleToAtlas", () => {
  it("512x512 → 64x64 셀 중앙값 축소 (nearest 확대의 역변환)", () => {
    const original = makeSyntheticAtlas();
    const big = upscale(original, 8);
    const down = downscaleToAtlas(big);
    expect(down.width).toBe(64);
    expect(down.rgba).toEqual(original.rgba);
  });

  it("셀 안의 소수 이상치는 중앙값이 흡수한다", () => {
    const original = makeSyntheticAtlas();
    const big = upscale(original, 8);
    // 각 셀의 1픽셀만 오염
    for (let cy = 0; cy < 64; cy++) {
      for (let cx = 0; cx < 64; cx++) {
        const d = (cy * 8 * 512 + cx * 8) * 4;
        big.rgba.set([255, 0, 255, 255], d);
      }
    }
    expect(downscaleToAtlas(big).rgba).toEqual(original.rgba);
  });

  it("64 미만 입력은 거부한다", () => {
    const tiny: RawImage = { width: 32, height: 32, rgba: new Uint8Array(32 * 32 * 4) };
    expect(() => downscaleToAtlas(tiny)).toThrow();
  });
});

describe("applyUvMask + validateFinalAtlas", () => {
  it("UV 밖 완전 투명, base 완전 불투명, overlay 이진 alpha", () => {
    const atlas = makeSyntheticAtlas();
    // overlay alpha를 일부러 중간값으로 오염
    for (let i = 0; i < ATLAS_SIZE * ATLAS_SIZE; i++) {
      if (ZONES[i] === "overlay") {
        atlas.rgba[i * 4 + 3] = i % 2 === 0 ? 60 : 200;
      }
    }
    applyUvMask(atlas);
    for (let i = 0; i < ATLAS_SIZE * ATLAS_SIZE; i++) {
      const a = atlas.rgba[i * 4 + 3];
      if (ZONES[i] === "outside") expect(a).toBe(0);
      else if (ZONES[i] === "base") expect(a).toBe(255);
      else expect(a === 0 || a === 255).toBe(true);
    }
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("validateFinalAtlas는 규칙 위반을 잡는다", () => {
    const atlas = applyUvMask(makeSyntheticAtlas());
    // base 픽셀 하나를 투명하게 오염
    const baseIndex = ZONES.indexOf("base");
    atlas.rgba[baseIndex * 4 + 3] = 0;
    expect(validateFinalAtlas(atlas).ok).toBe(false);
  });

  it("64x64가 아니면 실패한다", () => {
    const bad: RawImage = { width: 32, height: 32, rgba: new Uint8Array(32 * 32 * 4) };
    expect(validateFinalAtlas(bad).ok).toBe(false);
    expect(() => applyUvMask(bad)).toThrow();
  });
});

describe("validateAtlas (마스크 전 휴리스틱)", () => {
  it("정상 합성 atlas는 통과한다", () => {
    expect(validateAtlas(makeSyntheticAtlas()).ok).toBe(true);
  });

  it("얼굴 면이 단색이면 실패한다", () => {
    const atlas = makeSyntheticAtlas();
    for (let y = HEAD_FRONT.y; y < HEAD_FRONT.y + HEAD_FRONT.h; y++) {
      for (let x = HEAD_FRONT.x; x < HEAD_FRONT.x + HEAD_FRONT.w; x++) {
        atlas.rgba.set([200, 170, 140, 255], (y * ATLAS_SIZE + x) * 4);
      }
    }
    const verdict = validateAtlas(atlas);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join()).toContain("얼굴");
  });

  it("전체가 단색이면 실패한다", () => {
    const flat: RawImage = {
      width: 64,
      height: 64,
      rgba: new Uint8Array(64 * 64 * 4).fill(120),
    };
    expect(validateAtlas(flat).ok).toBe(false);
  });

  it("UV 밖에 디테일이 가득하면(일반 캐릭터 렌더) 실패한다", () => {
    const atlas = makeSyntheticAtlas();
    let n = 7;
    for (let i = 0; i < ATLAS_SIZE * ATLAS_SIZE; i++) {
      if (ZONES[i] === "outside") {
        n = (n * 1103515245 + 12345) & 0x7fffffff;
        atlas.rgba.set(
          [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 255],
          i * 4,
        );
      }
    }
    const verdict = validateAtlas(atlas);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join()).toContain("atlas");
  });
});
