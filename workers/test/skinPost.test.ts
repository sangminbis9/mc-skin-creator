import { describe, expect, it } from "vitest";
import type { RawImage } from "../src/png";
import {
  applyUvMask,
  downscaleToAtlas,
  restoreGeneratedOverlayAlpha,
  validateAtlas,
  validateAtlasCraft,
  validateFinalAtlas,
} from "../src/skinPost";
import {
  ATLAS_SIZE,
  CLASSIC_LAYOUT,
  HEAD_FRONT,
  buildZoneMap,
} from "../src/uvLayout";
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
    const tiny: RawImage = {
      width: 32,
      height: 32,
      rgba: new Uint8Array(32 * 32 * 4),
    };
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
    const bad: RawImage = {
      width: 32,
      height: 32,
      rgba: new Uint8Array(32 * 32 * 4),
    };
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

describe("restoreGeneratedOverlayAlpha", () => {
  it("turns generated background-colored overlay pixels transparent", () => {
    const atlas = makeSyntheticAtlas();
    for (let pixel = 0; pixel < ATLAS_SIZE * ATLAS_SIZE; pixel++) {
      if (ZONES[pixel] === "outside") {
        atlas.rgba.set([24, 24, 28, 255], pixel * 4);
      }
    }
    const overlay = CLASSIC_LAYOUT.head.overlay.front;
    for (let y = 0; y < overlay.h; y++) {
      for (let x = 0; x < overlay.w; x++) {
        atlas.rgba[((overlay.y + y) * ATLAS_SIZE + overlay.x + x) * 4 + 3] = 0;
      }
    }
    const backgroundPixel = (overlay.y * ATLAS_SIZE + overlay.x) * 4;
    const darkHairPixel = (overlay.y * ATLAS_SIZE + overlay.x + 1) * 4;
    atlas.rgba.set([24, 24, 28, 255], backgroundPixel);
    atlas.rgba.set([18, 18, 20, 255], darkHairPixel);

    restoreGeneratedOverlayAlpha(atlas);

    expect(atlas.rgba[backgroundPixel + 3]).toBe(0);
    expect(atlas.rgba[darkHairPixel + 3]).toBe(255);
  });

  it("removes an opaque base-layer copy while keeping distinct overlay detail", () => {
    const atlas = makeSyntheticAtlas();
    const base = CLASSIC_LAYOUT.body.base.front;
    const overlay = CLASSIC_LAYOUT.body.overlay.front;
    for (let y = 0; y < overlay.h; y++) {
      for (let x = 0; x < overlay.w; x++) {
        const source = ((base.y + y) * ATLAS_SIZE + base.x + x) * 4;
        const target = ((overlay.y + y) * ATLAS_SIZE + overlay.x + x) * 4;
        atlas.rgba.set(atlas.rgba.slice(source, source + 4), target);
        atlas.rgba[target + 3] = 255;
      }
    }
    const accent = ((overlay.y + 5) * ATLAS_SIZE + overlay.x + 3) * 4;
    atlas.rgba.set([238, 72, 118, 255], accent);

    restoreGeneratedOverlayAlpha(atlas);

    const duplicate = ((overlay.y + 1) * ATLAS_SIZE + overlay.x + 1) * 4;
    expect(atlas.rgba[duplicate + 3]).toBe(0);
    expect(atlas.rgba[accent + 3]).toBe(255);
  });

  it("keeps solid head top and back faces for legitimate hair volume", () => {
    const atlas = makeSyntheticAtlas();
    for (const faceName of ["top", "back"] as const) {
      const base = CLASSIC_LAYOUT.head.base[faceName];
      const overlay = CLASSIC_LAYOUT.head.overlay[faceName];
      for (let y = 0; y < overlay.h; y++) {
        for (let x = 0; x < overlay.w; x++) {
          const source = ((base.y + y) * ATLAS_SIZE + base.x + x) * 4;
          const target = ((overlay.y + y) * ATLAS_SIZE + overlay.x + x) * 4;
          atlas.rgba.set(atlas.rgba.slice(source, source + 4), target);
          atlas.rgba[target + 3] = 255;
        }
      }
    }

    restoreGeneratedOverlayAlpha(atlas);

    for (const faceName of ["top", "back"] as const) {
      const overlay = CLASSIC_LAYOUT.head.overlay[faceName];
      for (let y = overlay.y; y < overlay.y + overlay.h; y++) {
        for (let x = overlay.x; x < overlay.x + overlay.w; x++) {
          expect(atlas.rgba[(y * ATLAS_SIZE + x) * 4 + 3]).toBe(255);
        }
      }
    }
  });

  it("preserves an already sparse authored overlay", () => {
    const atlas = makeSyntheticAtlas();
    const base = CLASSIC_LAYOUT.head.base.front;
    const overlay = CLASSIC_LAYOUT.head.overlay.front;
    for (let y = 0; y < overlay.h; y++) {
      for (let x = 0; x < overlay.w; x++) {
        const target = ((overlay.y + y) * ATLAS_SIZE + overlay.x + x) * 4;
        atlas.rgba[target + 3] = 0;
      }
    }
    for (let x = 2; x <= 5; x++) {
      const source = ((base.y + 1) * ATLAS_SIZE + base.x + x) * 4;
      const target = ((overlay.y + 1) * ATLAS_SIZE + overlay.x + x) * 4;
      atlas.rgba.set(atlas.rgba.slice(source, source + 4), target);
      atlas.rgba[target + 3] = 255;
    }

    restoreGeneratedOverlayAlpha(atlas);

    for (let x = 2; x <= 5; x++) {
      expect(
        atlas.rgba[((overlay.y + 1) * ATLAS_SIZE + overlay.x + x) * 4 + 3],
      ).toBe(255);
    }
  });
});

describe("validateAtlasCraft", () => {
  it("rejects a valid template that has no authored outer-layer detail", () => {
    const atlas = applyUvMask(makeSyntheticAtlas());
    for (let i = 0; i < ATLAS_SIZE * ATLAS_SIZE; i++) {
      if (ZONES[i] === "overlay") {
        atlas.rgba.set([0, 0, 0, 0], i * 4);
      }
    }

    expect(validateFinalAtlas(atlas).ok).toBe(true);
    const verdict = validateAtlasCraft(atlas, {
      hairstyle: "long",
      sideHairLength: "shoulder",
      hairAccessory: "flower",
      outerGarment: "cardigan",
      legwear: "leg_warmers",
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" / ")).toContain("outer-layer");
  });
});
