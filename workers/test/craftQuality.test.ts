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
    expect(proceduralMetrics.opaqueOverlayPixels).toBeLessThanOrEqual(1_000);
    expect(proceduralMetrics.overlayColorCount).toBeGreaterThan(
      referenceMetrics.overlayColorCount,
    );
    expect(proceduralMetrics.shadedOverlayFaces).toBeGreaterThanOrEqual(
      referenceMetrics.shadedOverlayFaces,
    );
    expect(proceduralMetrics.overlayPixelsByPart.head).toBeLessThanOrEqual(220);
    expect(proceduralMetrics.overlayPixelsByPart.body).toBeLessThanOrEqual(280);
    expect(proceduralMetrics.overlayPixelsByPart.rightArm).toBeLessThanOrEqual(
      110,
    );
    expect(proceduralMetrics.overlayPixelsByPart.leftArm).toBeLessThanOrEqual(
      110,
    );
    expect(proceduralMetrics.overlayPixelsByPart.rightLeg).toBeLessThanOrEqual(
      130,
    );
    expect(proceduralMetrics.overlayPixelsByPart.leftLeg).toBeLessThanOrEqual(
      180,
    );

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
      referenceMetrics.opaqueOverlayPixels * 2,
    );
    expect(compactMetrics.overlayPixelsByPart.head).toBeLessThanOrEqual(150);
    expect(compactMetrics.overlayPixelsByPart.body).toBeLessThanOrEqual(130);
    expect(compactMetrics.overlayPixelsByPart.rightArm).toBeLessThanOrEqual(50);
    expect(compactMetrics.overlayPixelsByPart.leftArm).toBeLessThanOrEqual(50);
    expect(compactMetrics.overlayPixelsByPart.rightLeg).toBeLessThanOrEqual(85);
    expect(compactMetrics.overlayPixelsByPart.leftLeg).toBeLessThanOrEqual(85);
  });
});
