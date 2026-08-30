import { describe, expect, it } from "vitest";
import { buildSkinPlan } from "../src/skinPlan";
import { isGeneratedFaceStructurallyValid, packFrontViewToAtlas } from "../src/skinPack";
import { measureAtlasCraft } from "../src/skinPost";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis, makeFrontBackView, makeIdentityGeometry, makeSyntheticAtlas } from "./helpers";

function frontFaceBytes(atlas: NonNullable<ReturnType<typeof packFrontViewToAtlas>>["atlas"]): number[] {
  const face = CLASSIC_LAYOUT.head.base.front;
  const bytes: number[] = [];
  for (let y = 0; y < face.h; y++) {
    for (let x = 0; x < face.w; x++) {
      const offset = ((face.y + y) * atlas.width + face.x + x) * 4;
      bytes.push(...atlas.rgba.subarray(offset, offset + 4));
    }
  }
  return bytes;
}

function authoredFaceSheet() {
  const sheet = makeFrontBackView();
  // The helper's detected front head is exactly 120x140. Paint an authored
  // 8x8 face with connected shade bands and a distinctive cyan eye cluster.
  for (let py = 0; py < 8; py++) {
    const y0 = 40 + Math.floor((py * 140) / 8);
    const y1 = 40 + Math.floor(((py + 1) * 140) / 8);
    for (let px = 0; px < 8; px++) {
      const x0 = 196 + Math.floor((px * 120) / 8);
      const x1 = 196 + Math.floor(((px + 1) * 120) / 8);
      const color =
        (py === 4 && (px === 2 || px === 5))
          ? [18, 178, 204]
          : py < 2
            ? [48 + px * 3, 33 + px * 2, 27]
            : [214 + (px % 3) * 6, 165 + (py % 3) * 7, 142 + ((px + py) % 2) * 8];
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sheet.rgba.set([color[0], color[1], color[2], 255], (y * sheet.width + x) * 4);
        }
      }
    }
  }
  return sheet;
}

describe("identity-first architecture", () => {
  it("builds bounded role-based face, hair, palette and outfit plans", () => {
    const plan = buildSkinPlan(makeAnalysis());
    expect(plan.facePixelPlan.coordinateSpace).toBe("head.base.front");
    expect(plan.facePixelPlan.pixels.length).toBeGreaterThan(8);
    expect(plan.facePixelPlan.pixels.every((pixel) => pixel.x >= 0 && pixel.x < 8 && pixel.y >= 0 && pixel.y < 8)).toBe(true);
    expect(plan.facePixelPlan.pixels.every((pixel) => !/^#/.test(pixel.role))).toBe(true);
    expect(plan.hairPlan.template).toBe("short_cap");
    expect(plan.hairPlan.continuousFaces).toEqual(expect.arrayContaining(["head.top", "head.left", "head.right", "head.back"]));
    expect(plan.palettePlan.ramps.every((ramp) => ramp.maxLocalColors === 6)).toBe(true);
    expect(plan.outfitPlan.inventionPolicy).toBe("extend_existing_materials_only");
  });

  it.each([
    ["jaw", "straight", "medium_bob"],
    ["waist", "straight", "long_curtain"],
    ["shoulder", "curly", "curly_volume"],
    ["shoulder", "coily", "coily_volume"],
  ] as const)("selects the %s/%s hair mask family", (length, texture, template) => {
    const base = makeAnalysis();
    const plan = buildSkinPlan(makeAnalysis({
      renderHints: { ...base.renderHints, overallHairLength: length, hairTexture: texture },
    }));
    expect(plan.hairPlan.template).toBe(template);
    if (length === "waist") expect(plan.hairPlan.continuousFaces).toContain("body.back");
  });

  it("preserves a structurally valid image-generated face byte-for-byte through later passes", () => {
    const sheet = authoredFaceSheet();
    const packed = packFrontViewToAtlas(sheet, undefined, 2, { faceMode: "preserve_generated" });
    expect(packed).not.toBeNull();
    expect(isGeneratedFaceStructurallyValid(packed!.atlas)).toBe(true);
    const face = CLASSIC_LAYOUT.head.base.front;
    const eyeOffset = ((face.y + 4) * packed!.atlas.width + face.x + 2) * 4;
    expect(Array.from(packed!.atlas.rgba.subarray(eyeOffset, eyeOffset + 3))).toEqual([18, 178, 204]);
  });

  it("uses procedural recovery only when the generated face is structurally invalid", () => {
    const source = makeFrontBackView();
    const recovered = packFrontViewToAtlas(source, undefined, 2, { faceMode: "preserve_generated" });
    const deterministic = packFrontViewToAtlas(source);
    expect(recovered).not.toBeNull();
    expect(frontFaceBytes(recovered!.atlas)).toEqual(frontFaceBytes(deterministic!.atlas));
  });

  it("actually applies the FacePixelPlan on the deterministic production pack path", () => {
    const source = makeFrontBackView();
    const base = makeAnalysis();
    const plan = buildSkinPlan(makeAnalysis({
      renderHints: {
        ...base.renderHints,
        faceShape: "long",
        eyeSpacing: "wide",
        eyeSize: "large",
        mouthShape: "small",
        bangsLength: "eye",
      },
    }));
    const withoutPlan = packFrontViewToAtlas(source, undefined, 2, { faceMode: "deterministic_plan" });
    const withPlan = packFrontViewToAtlas(source, undefined, 2, {
      faceMode: "deterministic_plan",
      facePixelPlan: plan.facePixelPlan,
      hairPlan: plan.hairPlan,
    });
    expect(withPlan?.preservedGeneratedFace).toBe(false);
    expect(frontFaceBytes(withPlan!.atlas)).not.toEqual(frontFaceBytes(withoutPlan!.atlas));
  });

  it("renders normalized glasses geometry on the head outer layer", () => {
    const source = makeFrontBackView();
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      identityGeometry: makeIdentityGeometry(),
      renderHints: { ...base.renderHints, glasses: "round" },
    });
    const plan = buildSkinPlan(analysis);
    expect(plan.facePixelPlan.layout.glassesMask.length).toBeGreaterThan(0);
    const packed = packFrontViewToAtlas(source, undefined, 2, {
      faceMode: "deterministic_plan",
      facePixelPlan: plan.facePixelPlan,
      hairPlan: plan.hairPlan,
    });
    expect(packed).not.toBeNull();
    const overlay = CLASSIC_LAYOUT.head.overlay.front;
    for (const point of plan.facePixelPlan.glassesPlan.framePixels.filter((pixel) => pixel.face === "front")) {
      const alpha = packed!.atlas.rgba[((overlay.y + point.y) * packed!.atlas.width + overlay.x + point.x) * 4 + 3];
      expect(alpha).toBe(255);
    }
    for (const point of plan.facePixelPlan.glassesPlan.lensOpenings) {
      const alpha = packed!.atlas.rgba[((overlay.y + point.y) * packed!.atlas.width + overlay.x + point.x) * 4 + 3];
      expect(alpha).toBe(0);
    }
  });

  it("reports noise, palette, entropy, edge and part-aware overlay metrics", () => {
    const metrics = measureAtlasCraft(makeSyntheticAtlas(31));
    expect(metrics.isolatedNoiseRatio).toBeGreaterThanOrEqual(0);
    expect(metrics.maxLocalPaletteSize).toBeGreaterThan(0);
    expect(metrics.connectedClusterCoherence).toBeGreaterThan(0);
    expect(metrics.colorEntropy).toBeGreaterThan(0);
    expect(metrics.edgeFrequency).toBeGreaterThan(0);
    expect(metrics.overlayCoverageByPart.head).toBeGreaterThan(0);
  });
});
