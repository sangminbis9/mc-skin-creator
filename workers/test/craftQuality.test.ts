import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildProceduralFallbackAtlas } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { measureAtlasCraft, validateAtlasCraft } from "../src/skinPost";
import { DEFAULT_FACE_STYLE, packFrontViewToAtlas } from "../src/skinPack";
import {
  buildSkinViewMontage,
  renderSkinViews,
} from "../src/skinRender";
import { REFERENCE_SKIN_BASE64 } from "./fixtures/referenceSkin";
import { makeFrontView } from "./helpers";
import {
  ALL_PARTS,
  ATLAS_SIZE,
  CLASSIC_LAYOUT,
  getBoxUvSeams,
} from "../src/uvLayout";

function opaquePixelsIn(
  atlas: { rgba: Uint8Array },
  rect: { x: number; y: number; w: number; h: number },
): number {
  let count = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (atlas.rgba[(y * ATLAS_SIZE + x) * 4 + 3] !== 0) count++;
    }
  }
  return count;
}

function channelAt(
  atlas: { rgba: Uint8Array },
  rect: { x: number; y: number },
  x: number,
  y: number,
  channel: 0 | 1 | 2 | 3,
): number {
  return atlas.rgba[((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4 + channel];
}

describe("handcrafted atlas quality metrics", () => {
  it("keeps the rich procedural reference style in the handcrafted skin quality range", async () => {
    const reference = await decodePng(
      Uint8Array.from(atob(REFERENCE_SKIN_BASE64), (character) =>
        character.charCodeAt(0),
      ),
    );
    const richStyle = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      hairColor: "#6f4c45",
      bangs: "curtain",
      bangsLength: "eye",
      bangsDensity: "balanced",
      fringeEdge: "wispy",
      fringeOpening: "center",
      hairTexture: "wavy",
      hairVolume: "full",
      hairBackShape: "long",
      hairPart: "right",
      sideHairLength: "shoulder",
      sideHairShape: "face_framing",
      hairAccessory: "flower",
      hairAccessoryScale: "large",
      hairAccessorySide: "left",
      hairAccessoryColor: "pink",
      faceShape: "oval",
      eyeShape: "almond",
      eyeSize: "large",
      irisLightness: "dark",
      eyeSpacing: "average",
      eyeTilt: "level",
      eyebrowShape: "soft",
      eyebrowThickness: "thin",
      noseShape: "small",
      mouthShape: "full",
      mouthOpening: "closed",
      lipFullness: "full",
      lipColor: "berry",
      jawShape: "pointed",
      topType: "sweater",
      sleeveLength: "long",
      garmentTexture: "knit",
      outerLayer: "heavy",
      outerGarment: "cardigan",
      neckAccessory: "bow",
      bottomType: "skirt",
      bottomPattern: "plaid",
      bottomAccent: "ribbon",
      legwear: "leg_warmers",
      legwearAsymmetry: "left",
      thighAccessory: "bow",
      thighAccessorySide: "right",
      shoeStyle: "dress_shoes",
    };
    const procedural = buildProceduralFallbackAtlas(
      {
        skinTone: "#efd0c7",
        hairColor: "#6f4c45",
        eyeColor: "#4a3728",
        topColor: "#bea0a8",
        topAccentColor: "#f4eee7",
        bottomColor: "#d4c0b3",
        shoesColor: "#e8dfd1",
      },
      richStyle,
    )!;
    const referenceMetrics = measureAtlasCraft(reference);
    const proceduralMetrics = measureAtlasCraft(procedural);
    expect(referenceMetrics.opaqueOverlayPixels).toBe(269);
    expect(referenceMetrics.overlayPixelsByPart.head).toBe(103);
    expect(referenceMetrics.overlayPixelsByPart.body).toBe(63);
    expect(proceduralMetrics.opaqueOverlayPixels).toBeLessThanOrEqual(995);
    expect(proceduralMetrics.overlayColorCount).toBeGreaterThan(
      referenceMetrics.overlayColorCount,
    );
    expect(proceduralMetrics.shadedOverlayFaces).toBeGreaterThanOrEqual(
      referenceMetrics.shadedOverlayFaces,
    );
    // The target-like large almond eyes and full lips deliberately use four
    // extra overlay pixels for readable iris/lid and lip clusters.
    expect(proceduralMetrics.overlayPixelsByPart.head).toBeLessThanOrEqual(150);
    const referenceHead = CLASSIC_LAYOUT.head.overlay;
    const proceduralHead = CLASSIC_LAYOUT.head.overlay;
    expect(opaquePixelsIn(reference, referenceHead.top)).toBe(9);
    expect(opaquePixelsIn(reference, referenceHead.front)).toBe(29);
    expect(opaquePixelsIn(reference, referenceHead.right)).toBe(20);
    expect(opaquePixelsIn(reference, referenceHead.left)).toBe(18);
    expect(opaquePixelsIn(reference, referenceHead.back)).toBe(24);
    expect(opaquePixelsIn(procedural, proceduralHead.top)).toBeLessThanOrEqual(
      30,
    );
    expect(
      opaquePixelsIn(procedural, proceduralHead.front),
    ).toBeLessThanOrEqual(36);
    expect(
      opaquePixelsIn(procedural, proceduralHead.right),
    ).toBeLessThanOrEqual(30);
    expect(
      opaquePixelsIn(procedural, proceduralHead.left),
    ).toBeLessThanOrEqual(30);
    expect(opaquePixelsIn(procedural, proceduralHead.back)).toBeLessThanOrEqual(
      28,
    );
    // A large side flower stays a physical one-sided cluster. It retains a
    // bright centre on the owning profile while leaving the centre-right
    // fringe and opposite crown hair-coloured instead of forming a horizontal
    // pink band across the forehead.
    expect(
      channelAt(procedural, proceduralHead.front, 1, 2, 0),
    ).toBeGreaterThan(220);
    expect(
      channelAt(procedural, proceduralHead.front, 4, 1, 0),
    ).toBeLessThan(170);
    expect(
      channelAt(procedural, proceduralHead.right, 4, 4, 0),
    ).toBeGreaterThan(220);
    expect(
      channelAt(procedural, proceduralHead.top, 5, 3, 0),
    ).toBeLessThan(170);
    const proceduralBody = CLASSIC_LAYOUT.body;
    expect(
      opaquePixelsIn(procedural, proceduralBody.overlay.back),
    ).toBeLessThanOrEqual(55);
    expect(channelAt(procedural, proceduralBody.overlay.back, 4, 2, 3)).toBe(
      0,
    );
    expect(channelAt(procedural, proceduralBody.overlay.back, 3, 7, 3)).toBe(
      255,
    );
    // The continuous rear-hair mass belongs on the base layer. Its central
    // brown value must replace the pink cardigan beneath, while the sparse
    // outer pixels above provide only strand highlights and volume.
    expect(
      channelAt(procedural, proceduralBody.base.back, 4, 4, 0),
    ).toBeLessThan(125);
    expect(
      channelAt(procedural, proceduralBody.base.back, 4, 4, 0),
    ).toBeGreaterThan(
      channelAt(procedural, proceduralBody.base.back, 4, 4, 1) + 15,
    );
    // The shoulder stays broad, but the rear mass must start tapering by the
    // third torso row. Leaving both edges hair-coloured through row seven made
    // long hair read as a rigid rectangular cape from back and side views.
    expect(
      channelAt(procedural, proceduralBody.base.back, 0, 0, 0),
    ).toBeLessThan(125);
    expect(
      channelAt(procedural, proceduralBody.base.back, 0, 4, 0),
    ).toBeGreaterThan(
      channelAt(procedural, proceduralBody.base.back, 4, 4, 0) + 10,
    );
    expect(
      channelAt(procedural, proceduralBody.base.back, 7, 6, 0),
    ).toBeGreaterThan(
      channelAt(procedural, proceduralBody.base.back, 4, 6, 0) + 10,
    );
    // The final seam pass adds only the perimeter of the hidden underside;
    // keep enough room for that connected hem without allowing solid faces.
    expect(proceduralMetrics.overlayPixelsByPart.body).toBeLessThanOrEqual(295);
    expect(proceduralMetrics.overlayPixelsByPart.rightArm).toBeLessThanOrEqual(
      80,
    );
    expect(proceduralMetrics.overlayPixelsByPart.leftArm).toBeLessThanOrEqual(
      80,
    );
    expect(proceduralMetrics.overlayPixelsByPart.rightLeg).toBeLessThanOrEqual(
      120,
    );
    expect(proceduralMetrics.overlayPixelsByPart.leftLeg).toBeLessThanOrEqual(
      100,
    );
    expect(proceduralMetrics.solidOverlayFaces).toBe(0);
    expect(proceduralMetrics.overlayVerticalSeamMismatches).toBe(0);
    expect(proceduralMetrics.overlayVerticalSeamColorDistance).toBe(0);
    expect(
      proceduralMetrics.overlayHorizontalSeamMismatches,
    ).toBeLessThanOrEqual(3);
    expect(proceduralMetrics.overlayHorizontalSeamMismatchesByPart.body).toBe(
      0,
    );
    expect(
      proceduralMetrics.overlayHorizontalSeamMismatchesByPart.rightArm,
    ).toBe(0);
    expect(
      proceduralMetrics.overlayHorizontalSeamMismatchesByPart.leftArm,
    ).toBe(0);
    expect(
      proceduralMetrics.overlayHorizontalSeamMismatchesByPart.rightLeg,
    ).toBe(0);
    expect(
      proceduralMetrics.overlayHorizontalSeamMismatchesByPart.leftLeg,
    ).toBe(0);
    expect(
      proceduralMetrics.overlayHorizontalSeamColorDistance,
    ).toBeLessThanOrEqual(12);
    expect(
      proceduralMetrics.baseHorizontalSeamColorDistance,
    ).toBeLessThanOrEqual(200);

    const artifactDir = process.env.CRAFT_ARTIFACT_DIR?.trim();
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
      await Promise.all([
        writeFile(
          join(artifactDir, "handcrafted-reference-atlas.png"),
          await encodePng(reference),
        ),
        writeFile(
          join(artifactDir, "handcrafted-reference-six-view.png"),
          await encodePng(buildSkinViewMontage(renderSkinViews(reference))),
        ),
        writeFile(
          join(artifactDir, "reference-style-atlas.png"),
          await encodePng(procedural),
        ),
        writeFile(
          join(artifactDir, "reference-style-six-view.png"),
          await encodePng(buildSkinViewMontage(renderSkinViews(procedural))),
        ),
      ]);
    }

    const compactMale = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      hairColor: "#171719",
      bangs: "straight",
      bangsLength: "brow",
      bangsDensity: "dense",
      fringeEdge: "blunt",
      fringeOpening: "center",
      hairTexture: "straight",
      hairVolume: "normal",
      hairSilhouette: "rounded",
      hairBackShape: "tapered",
      sideHairLength: "short",
      sideHairShape: "ear_hugging",
      earExposure: "partial",
      topType: "sweater",
      sleeveLength: "long",
      garmentTexture: "knit",
      outerLayer: "heavy",
      outerGarment: "none",
      bottomType: "pants",
      shoeStyle: "sneakers",
    })!.atlas;
    const compactMetrics = measureAtlasCraft(compactMale);
    const decoratedStyle = {
      hairstyle: "long",
      sideHairLength: "shoulder",
      hairAccessory: "flower",
      outerLayer: "heavy",
      outerGarment: "cardigan",
      neckAccessory: "bow",
      bottomPattern: "plaid",
      bottomAccent: "ribbon",
      legwear: "leg_warmers",
      thighAccessory: "bow",
    };
    expect(validateAtlasCraft(reference, decoratedStyle).ok).toBe(true);
    expect(validateAtlasCraft(procedural, decoratedStyle).ok).toBe(true);
    expect(
      validateAtlasCraft(compactMale, {
        eyeSpacing: "average",
        eyeTilt: "level",
        glasses: "none",
        mouthShape: "small",
        bangs: "straight",
        fringeOpening: "center",
        hairstyle: "short",
        sideHairLength: "short",
        outerLayer: "heavy",
        garmentTexture: "knit",
      }).ok,
    ).toBe(true);
    expect(compactMetrics.opaqueOverlayPixels).toBeLessThanOrEqual(
      referenceMetrics.opaqueOverlayPixels * 2 + 100,
    );
    expect(compactMetrics.overlayPixelsByPart.head).toBeLessThanOrEqual(150);
    expect(compactMetrics.overlayPixelsByPart.body).toBeLessThanOrEqual(160);
    expect(compactMetrics.overlayPixelsByPart.rightArm).toBeLessThanOrEqual(75);
    expect(compactMetrics.overlayPixelsByPart.leftArm).toBeLessThanOrEqual(75);
    expect(compactMetrics.overlayPixelsByPart.rightLeg).toBeLessThanOrEqual(
      110,
    );
    expect(compactMetrics.overlayPixelsByPart.leftLeg).toBeLessThanOrEqual(110);
    expect(compactMetrics.solidOverlayFaces).toBe(0);
    expect(compactMetrics.overlayVerticalSeamMismatches).toBe(0);
    expect(compactMetrics.overlayVerticalSeamColorDistance).toBe(0);
    expect(compactMetrics.overlayHorizontalSeamMismatches).toBe(0);
    expect(
      compactMetrics.overlayHorizontalSeamColorDistance,
    ).toBeLessThanOrEqual(3);
  });

  it("rejects hair that covers both irises and a one-sided profile collapse", () => {
    const style = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short",
      bangs: "straight" as const,
      bangsLength: "brow" as const,
      fringeOpening: "center" as const,
      sideHairLength: "short" as const,
      sideHairShape: "ear_hugging" as const,
      outerLayer: "heavy" as const,
      garmentTexture: "knit" as const,
    };
    const source = packFrontViewToAtlas(makeFrontView(), style)!.atlas;
    expect(validateAtlasCraft(source, style).ok).toBe(true);

    const hiddenEyes = { ...source, rgba: new Uint8Array(source.rgba) };
    const faceOverlay = CLASSIC_LAYOUT.head.overlay.front;
    const hairSource = (faceOverlay.y * ATLAS_SIZE + faceOverlay.x) * 4;
    for (const x of [2, 5]) {
      const target = ((faceOverlay.y + 4) * ATLAS_SIZE + faceOverlay.x + x) * 4;
      hiddenEyes.rgba.set(
        hiddenEyes.rgba.slice(hairSource, hairSource + 4),
        target,
      );
      hiddenEyes.rgba[target + 3] = 255;
    }
    expect(
      validateAtlasCraft(hiddenEyes, style).problems.join(" / "),
    ).toContain("readable eye");

    const missingSide = { ...source, rgba: new Uint8Array(source.rgba) };
    const leftSide = CLASSIC_LAYOUT.head.overlay.left;
    for (let y = 0; y < leftSide.h; y++) {
      for (let x = 0; x < leftSide.w; x++) {
        const offset = ((leftSide.y + y) * ATLAS_SIZE + leftSide.x + x) * 4;
        missingSide.rgba.set([0, 0, 0, 0], offset);
      }
    }
    expect(
      validateAtlasCraft(missingSide, style).problems.join(" / "),
    ).toContain("side hair is disconnected");
  });

  it("rejects a single broken side-hair edge and disconnected top/bottom UV faces", () => {
    const style = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "short" as const,
      bangs: "straight" as const,
      bangsLength: "brow" as const,
      fringeOpening: "center" as const,
      sideHairLength: "short" as const,
      sideHairShape: "ear_hugging" as const,
      outerLayer: "heavy" as const,
      garmentTexture: "knit" as const,
    };
    const source = packFrontViewToAtlas(makeFrontView(), style)!.atlas;
    expect(validateAtlasCraft(source, style).ok).toBe(true);

    const brokenHairEdge = {
      ...source,
      rgba: new Uint8Array(source.rgba),
    };
    const headSeam = getBoxUvSeams(CLASSIC_LAYOUT.head.overlay).vertical[0];
    const opaqueIndex = headSeam.primary.findIndex(({ x, y }) => {
      const offset = (y * ATLAS_SIZE + x) * 4;
      return brokenHairEdge.rgba[offset + 3] === 255;
    });
    expect(opaqueIndex).toBeGreaterThanOrEqual(0);
    const adjacent = headSeam.adjacent[opaqueIndex];
    brokenHairEdge.rgba[(adjacent.y * ATLAS_SIZE + adjacent.x) * 4 + 3] = 0;
    expect(
      validateAtlasCraft(brokenHairEdge, style).problems.join(" / "),
    ).toContain("head side-hair seams are not continuous");

    const brokenHairCrown = {
      ...source,
      rgba: new Uint8Array(source.rgba),
    };
    const headHorizontal = getBoxUvSeams(
      CLASSIC_LAYOUT.head.overlay,
    ).horizontal;
    let clearedHeadEdges = 0;
    for (const seam of headHorizontal) {
      for (let index = 0; index < seam.primary.length; index++) {
        const primary = seam.primary[index];
        const adjacent = seam.adjacent[index];
        const primaryOffset = (primary.y * ATLAS_SIZE + primary.x) * 4;
        const adjacentOffset = (adjacent.y * ATLAS_SIZE + adjacent.x) * 4;
        if (
          brokenHairCrown.rgba[primaryOffset + 3] === 0 ||
          brokenHairCrown.rgba[adjacentOffset + 3] === 0
        ) {
          continue;
        }
        brokenHairCrown.rgba[adjacentOffset + 3] = 0;
        clearedHeadEdges++;
        if (clearedHeadEdges >= 16) break;
      }
      if (clearedHeadEdges >= 16) break;
    }
    expect(clearedHeadEdges).toBeGreaterThan(12);
    expect(
      validateAtlasCraft(brokenHairCrown, style).problems.join(" / "),
    ).toContain("head crown and side hair are disconnected");

    const missingHorizontalFaces = {
      ...source,
      rgba: new Uint8Array(source.rgba),
    };
    for (const part of ALL_PARTS) {
      for (const rect of [
        CLASSIC_LAYOUT[part].overlay.top,
        CLASSIC_LAYOUT[part].overlay.bottom,
      ]) {
        for (let y = 0; y < rect.h; y++) {
          for (let x = 0; x < rect.w; x++) {
            const offset =
              ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
            missingHorizontalFaces.rgba[offset + 3] = 0;
          }
        }
      }
      for (const rect of [
        CLASSIC_LAYOUT[part].overlay.front,
        CLASSIC_LAYOUT[part].overlay.back,
        CLASSIC_LAYOUT[part].overlay.right,
        CLASSIC_LAYOUT[part].overlay.left,
      ]) {
        for (const y of [0, rect.h - 1]) {
          for (let x = 0; x < rect.w; x++) {
            const offset =
              ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
            missingHorizontalFaces.rgba.set([32, 32, 32, 255], offset);
          }
        }
      }
    }
    expect(
      validateAtlasCraft(missingHorizontalFaces, style).problems.join(" / "),
    ).toContain("outer-layer horizontal seams disconnected");

    const clashingBaseFaces = {
      ...source,
      rgba: new Uint8Array(source.rgba),
    };
    for (const part of ALL_PARTS) {
      for (const rect of [
        CLASSIC_LAYOUT[part].base.top,
        CLASSIC_LAYOUT[part].base.bottom,
      ]) {
        for (let y = 0; y < rect.h; y++) {
          for (let x = 0; x < rect.w; x++) {
            const offset =
              ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
            clashingBaseFaces.rgba.set([0, 255, 0, 255], offset);
          }
        }
      }
    }
    expect(
      validateAtlasCraft(clashingBaseFaces, style).problems.join(" / "),
    ).toContain("base-layer horizontal seam colours diverge");

    const clashingBaseSides = {
      ...source,
      rgba: new Uint8Array(source.rgba),
    };
    for (const part of ALL_PARTS) {
      for (const [rect, color] of [
        [CLASSIC_LAYOUT[part].base.front, [0, 255, 0, 255]],
        [CLASSIC_LAYOUT[part].base.back, [0, 255, 0, 255]],
        [CLASSIC_LAYOUT[part].base.right, [255, 0, 255, 255]],
        [CLASSIC_LAYOUT[part].base.left, [255, 0, 255, 255]],
      ] as const) {
        for (let y = 0; y < rect.h; y++) {
          for (let x = 0; x < rect.w; x++) {
            const offset =
              ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
            clashingBaseSides.rgba.set(color, offset);
          }
        }
      }
    }
    expect(
      validateAtlasCraft(clashingBaseSides, style).problems.join(" / "),
    ).toContain("base-layer vertical seam colours diverge");
  });

  it("accepts intentional eye-corner curtain overlap but still rejects a covered iris", () => {
    const style = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long" as const,
      bangs: "curtain" as const,
      bangsLength: "eye" as const,
      hairPart: "left" as const,
      hairTexture: "wavy" as const,
      hairVolume: "full" as const,
      hairBackShape: "long" as const,
      sideHairLength: "shoulder" as const,
      sideHairShape: "face_framing" as const,
      eyeSpacing: "average" as const,
      glasses: "none",
      outerLayer: "heavy" as const,
      outerGarment: "cardigan" as const,
    };
    const source = packFrontViewToAtlas(makeFrontView(), style)!.atlas;
    const faceOverlay = CLASSIC_LAYOUT.head.overlay.front;
    const outerCorner =
      ((faceOverlay.y + 4) * ATLAS_SIZE + faceOverlay.x + 6) * 4;
    const iris =
      ((faceOverlay.y + 4) * ATLAS_SIZE + faceOverlay.x + 5) * 4;

    expect(source.rgba[outerCorner + 3]).toBe(255);
    expect(source.rgba[iris + 3]).toBe(0);
    expect(validateAtlasCraft(source, style).ok).toBe(true);

    const hiddenIris = { ...source, rgba: new Uint8Array(source.rgba) };
    const hairSource = (faceOverlay.y * ATLAS_SIZE + faceOverlay.x) * 4;
    hiddenIris.rgba.set(
      hiddenIris.rgba.slice(hairSource, hairSource + 4),
      iris,
    );
    hiddenIris.rgba[iris + 3] = 255;
    expect(
      validateAtlasCraft(hiddenIris, style).problems.join(" / "),
    ).toContain("readable eye");
  });

  it("rejects shoulder hair that stops at the head instead of crossing the torso and arms", () => {
    const style = {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long" as const,
      bangs: "curtain" as const,
      hairTexture: "wavy" as const,
      hairVolume: "full" as const,
      hairBackShape: "long" as const,
      sideHairLength: "shoulder" as const,
      sideHairShape: "face_framing" as const,
      outerLayer: "heavy" as const,
      outerGarment: "cardigan" as const,
    };
    const source = packFrontViewToAtlas(makeFrontView(), style)!.atlas;
    expect(validateAtlasCraft(source, style).ok).toBe(true);

    const disconnected = { ...source, rgba: new Uint8Array(source.rgba) };
    const repaint = (rect: { x: number; y: number }, x: number, y: number) => {
      const offset = ((rect.y + y) * ATLAS_SIZE + rect.x + x) * 4;
      disconnected.rgba.set([54, 116, 204, 255], offset);
    };
    const torso = CLASSIC_LAYOUT.body.overlay;
    for (let y = 0; y < 8; y++) {
      if (y < 7) {
        repaint(torso.front, 0, y);
        repaint(torso.front, torso.front.w - 1, y);
      }
      repaint(torso.right, 0, y);
      repaint(torso.left, torso.left.w - 1, y);
    }
    for (const [arm, side] of [
      [CLASSIC_LAYOUT.rightArm.overlay, CLASSIC_LAYOUT.rightArm.overlay.right],
      [CLASSIC_LAYOUT.leftArm.overlay, CLASSIC_LAYOUT.leftArm.overlay.left],
    ] as const) {
      for (let y = 0; y < 6; y++) {
        repaint(arm.front, 0, y);
        repaint(arm.front, arm.front.w - 1, y);
        repaint(side, 0, y);
        if (y < 4) repaint(side, 1, y);
      }
    }

    expect(
      validateAtlasCraft(disconnected, style).problems.join(" / "),
    ).toContain("shoulder hair is not colour-connected");
  });

  const styleMatrix = [
    {
      name: "minimal buzz-cut casual",
      maxOverlayPixels: 420,
      style: {
        hairstyle: "buzz",
        hairVolume: "flat",
        bangs: "none",
        sideHairLength: "none",
        topType: "tshirt",
        sleeveLength: "short",
        outerLayer: "none",
        bottomType: "shorts",
        shoeStyle: "sandals",
      },
    },
    {
      name: "short rounded knit portrait",
      maxOverlayPixels: 644,
      style: {
        hairstyle: "short",
        hairVolume: "normal",
        hairSilhouette: "rounded",
        bangs: "straight",
        bangsLength: "brow",
        sideHairLength: "short",
        sideHairShape: "ear_hugging",
        topType: "sweater",
        sleeveLength: "long",
        outerLayer: "heavy",
        bottomType: "pants",
        shoeStyle: "sneakers",
      },
    },
    {
      name: "medium layered jacket",
      maxOverlayPixels: 994,
      style: {
        hairstyle: "medium",
        hairVolume: "normal",
        hairSilhouette: "swept",
        bangs: "side",
        sideHairLength: "jaw",
        topType: "jacket",
        sleeveLength: "long",
        outerLayer: "heavy",
        outerGarment: "open_jacket",
        bottomType: "jeans",
        bottomAccent: "side_stripe",
        shoeStyle: "boots",
      },
    },
    {
      name: "coily hoodie",
      maxOverlayPixels: 820,
      style: {
        hairstyle: "afro",
        hairTexture: "coily",
        hairVolume: "full",
        hairSilhouette: "rounded",
        bangs: "none",
        sideHairLength: "cheek",
        topType: "hoodie",
        sleeveLength: "long",
        outerLayer: "heavy",
        bottomType: "pants",
        shoeStyle: "sneakers",
      },
    },
    {
      name: "long decorated cardigan",
      maxOverlayPixels: 1_024,
      style: {
        hairstyle: "long",
        hairTexture: "wavy",
        hairVolume: "full",
        hairSilhouette: "rounded",
        hairBackShape: "long",
        bangs: "curtain",
        sideHairLength: "shoulder",
        hairAccessory: "flower",
        topType: "sweater",
        sleeveLength: "long",
        outerLayer: "heavy",
        outerGarment: "cardigan",
        neckAccessory: "bow",
        bottomType: "skirt",
        bottomPattern: "plaid",
        legwear: "leg_warmers",
        legwearAsymmetry: "left",
        shoeStyle: "dress_shoes",
      },
    },
  ] as const;

  it.each(styleMatrix)(
    "keeps $name outer-layer clusters below solid-shell density",
    ({ style, maxOverlayPixels }) => {
      const atlas = packFrontViewToAtlas(makeFrontView(), {
        ...DEFAULT_FACE_STYLE,
        ...style,
      })!.atlas;
      const metrics = measureAtlasCraft(atlas);
      expect(metrics.opaqueOverlayPixels).toBeLessThanOrEqual(maxOverlayPixels);
      expect(metrics.overlayPixelsByPart.head).toBeLessThanOrEqual(260);
      expect(metrics.overlayPixelsByPart.body).toBeLessThanOrEqual(295);
      expect(metrics.overlayPixelsByPart.rightArm).toBeLessThanOrEqual(140);
      expect(metrics.overlayPixelsByPart.leftArm).toBeLessThanOrEqual(140);
      expect(metrics.overlayPixelsByPart.rightLeg).toBeLessThanOrEqual(200);
      expect(metrics.overlayPixelsByPart.leftLeg).toBeLessThanOrEqual(200);
      expect(metrics.shadedOverlayFaces).toBeGreaterThanOrEqual(8);
      expect(metrics.solidOverlayFaces).toBe(0);
      expect(metrics.overlayVerticalSeamMismatches).toBe(0);
      expect(metrics.overlayVerticalSeamColorDistance).toBe(0);
      expect(metrics.overlayHorizontalSeamMismatches).toBeLessThanOrEqual(80);
      expect(metrics.overlayHorizontalSeamColorDistance).toBeLessThanOrEqual(
        80,
      );
      expect(metrics.baseVerticalSeamColorDistance).toBeLessThanOrEqual(200);
      expect(metrics.baseHorizontalSeamColorDistance).toBeLessThanOrEqual(200);
    },
  );
});
