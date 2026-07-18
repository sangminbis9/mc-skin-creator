import { describe, expect, it } from "vitest";
import { decodePng } from "../src/png";
import { measureAtlasCraft, validateAtlasCraft } from "../src/skinPost";
import { DEFAULT_FACE_STYLE, packFrontViewToAtlas } from "../src/skinPack";
import { REFERENCE_SKIN_BASE64 } from "./fixtures/referenceSkin";
import { makeFrontView } from "./helpers";
import { ATLAS_SIZE, CLASSIC_LAYOUT } from "../src/uvLayout";

describe("handcrafted atlas quality metrics", () => {
  it("keeps the rich procedural reference style in the handcrafted skin quality range", async () => {
    const reference = await decodePng(
      Uint8Array.from(atob(REFERENCE_SKIN_BASE64), (character) =>
        character.charCodeAt(0),
      ),
    );
    const procedural = packFrontViewToAtlas(makeFrontView(), {
      ...DEFAULT_FACE_STYLE,
      hairstyle: "long",
      hairColor: "#6f4c45",
      bangs: "straight",
      bangsLength: "brow",
      bangsDensity: "dense",
      fringeEdge: "staggered",
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
      shoeStyle: "dress_shoes",
    })!.atlas;
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
    expect(proceduralMetrics.overlayPixelsByPart.head).toBeLessThanOrEqual(170);
    expect(proceduralMetrics.overlayPixelsByPart.body).toBeLessThanOrEqual(265);
    expect(proceduralMetrics.overlayPixelsByPart.rightArm).toBeLessThanOrEqual(
      125,
    );
    expect(proceduralMetrics.overlayPixelsByPart.leftArm).toBeLessThanOrEqual(
      125,
    );
    expect(proceduralMetrics.overlayPixelsByPart.rightLeg).toBeLessThanOrEqual(
      140,
    );
    expect(proceduralMetrics.overlayPixelsByPart.leftLeg).toBeLessThanOrEqual(
      195,
    );
    expect(proceduralMetrics.solidOverlayFaces).toBe(0);
    expect(proceduralMetrics.overlayVerticalSeamMismatches).toBe(0);
    expect(proceduralMetrics.overlayVerticalSeamColorDistance).toBe(0);
    expect(
      proceduralMetrics.overlayHorizontalSeamMismatches,
    ).toBeLessThanOrEqual(80);
    expect(
      proceduralMetrics.overlayHorizontalSeamColorDistance,
    ).toBeLessThanOrEqual(80);
    expect(
      proceduralMetrics.baseHorizontalSeamColorDistance,
    ).toBeLessThanOrEqual(200);

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
    expect(compactMetrics.overlayPixelsByPart.rightArm).toBeLessThanOrEqual(60);
    expect(compactMetrics.overlayPixelsByPart.leftArm).toBeLessThanOrEqual(60);
    expect(compactMetrics.overlayPixelsByPart.rightLeg).toBeLessThanOrEqual(
      110,
    );
    expect(compactMetrics.overlayPixelsByPart.leftLeg).toBeLessThanOrEqual(110);
    expect(compactMetrics.solidOverlayFaces).toBe(0);
    expect(compactMetrics.overlayVerticalSeamMismatches).toBe(0);
    expect(compactMetrics.overlayVerticalSeamColorDistance).toBe(0);
    expect(compactMetrics.overlayHorizontalSeamMismatches).toBeLessThanOrEqual(
      80,
    );
    expect(
      compactMetrics.overlayHorizontalSeamColorDistance,
    ).toBeLessThanOrEqual(80);
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
      expect(metrics.baseHorizontalSeamColorDistance).toBeLessThanOrEqual(200);
    },
  );
});
