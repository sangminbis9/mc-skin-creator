import { describe, expect, it } from "vitest";
import { decodePng } from "../src/png";
import { measureAtlasCraft } from "../src/skinPost";
import { DEFAULT_FACE_STYLE, packFrontViewToAtlas } from "../src/skinPack";
import { REFERENCE_SKIN_BASE64 } from "./fixtures/referenceSkin";
import { makeFrontView } from "./helpers";

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
      bangs: "curtain",
      bangsLength: "eye",
      hairTexture: "wavy",
      hairVolume: "full",
      hairBackShape: "long",
      sideHairLength: "shoulder",
      hairAccessory: "flower",
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
    expect(proceduralMetrics.opaqueOverlayPixels).toBeLessThanOrEqual(1_120);
    expect(proceduralMetrics.overlayColorCount).toBeGreaterThan(
      referenceMetrics.overlayColorCount,
    );
    expect(proceduralMetrics.shadedOverlayFaces).toBeGreaterThanOrEqual(
      referenceMetrics.shadedOverlayFaces,
    );
    expect(proceduralMetrics.overlayPixelsByPart.head).toBeLessThanOrEqual(230);
    expect(proceduralMetrics.overlayPixelsByPart.body).toBeLessThanOrEqual(295);
    expect(proceduralMetrics.overlayPixelsByPart.rightArm).toBeLessThanOrEqual(
      140,
    );
    expect(proceduralMetrics.overlayPixelsByPart.leftArm).toBeLessThanOrEqual(
      140,
    );
    expect(proceduralMetrics.overlayPixelsByPart.rightLeg).toBeLessThanOrEqual(
      140,
    );
    expect(proceduralMetrics.overlayPixelsByPart.leftLeg).toBeLessThanOrEqual(
      200,
    );
    expect(proceduralMetrics.solidOverlayFaces).toBe(0);
    expect(proceduralMetrics.overlayVerticalSeamMismatches).toBe(0);
    expect(proceduralMetrics.overlayVerticalSeamColorDistance).toBe(0);
    expect(
      proceduralMetrics.overlayHorizontalSeamMismatches,
    ).toBeLessThanOrEqual(60);
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
      60,
    );
    expect(
      compactMetrics.overlayHorizontalSeamColorDistance,
    ).toBeLessThanOrEqual(80);
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
      maxOverlayPixels: 1_114,
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
      expect(metrics.overlayHorizontalSeamMismatches).toBeLessThanOrEqual(60);
      expect(metrics.overlayHorizontalSeamColorDistance).toBeLessThanOrEqual(
        80,
      );
      expect(metrics.baseHorizontalSeamColorDistance).toBeLessThanOrEqual(200);
    },
  );
});
