import { describe, expect, it, vi } from "vitest";
import {
  applyFocusedNeckDetail,
  applyFocusedPortraitDetail,
  buildProceduralGenerationReference,
  createUpperBodyDetailCrop,
  generateSkin,
  normalizeAnalysisForRendering,
} from "../src/generate";
import { bytesToBase64, decodePng, encodePng } from "../src/png";
import { DEFAULT_FACE_STYLE } from "../src/skinPack";
import type {
  ImageModelTier,
  SkinGenerationRequest,
  SkinGenerationProvider,
  SkinGenerationResult,
} from "../src/skinProvider";
import { validateFinalAtlas } from "../src/skinPost";
import type { Env } from "../src/types";
import { ATLAS_SIZE, CLASSIC_LAYOUT } from "../src/uvLayout";
import {
  makeAnalysis,
  makeFourViewSheet,
  makeFrontBackView,
  makeSyntheticAtlas,
} from "./helpers";

function makeEnv(
  analysis: unknown,
  imageGen = true,
  strategy = "front_view",
): Env {
  return {
    AI: {
      run: vi.fn(async () => ({ response: analysis })),
    } as unknown as Env["AI"],
    MCSKIN_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    } as unknown as Env["MCSKIN_KV"],
    IMAGE_GENERATION_ENABLED: imageGen ? "true" : "false",
    IMAGE_GEN_STRATEGY: strategy,
  };
}

async function photoDataUrl(): Promise<string> {
  const bytes = await encodePng(makeSyntheticAtlas());
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

async function portraitPhotoDataUrl(): Promise<string> {
  const width = 80;
  const height = 120;
  const rgba = new Uint8Array(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgba.set([224, 198, 186, 255], pixel * 4);
  }
  const bytes = await encodePng({ width, height, rgba });
  return `data:image/png;base64,${bytesToBase64(bytes)}`;
}

function focusedPortraitDetail() {
  return {
    faceConfidence: "high" as const,
    hairConfidence: "high" as const,
    skinTone: "light" as const,
    skinUndertone: "cool" as const,
    eyeColor: "dark-brown" as const,
    hairColor: "black" as const,
    faceShape: "oval" as const,
    eyeShape: "almond" as const,
    eyeSize: "small" as const,
    irisLightness: "dark" as const,
    eyeSpacing: "average" as const,
    eyeTilt: "level" as const,
    eyebrowShape: "straight" as const,
    eyebrowThickness: "thin" as const,
    noseShape: "straight" as const,
    mouthShape: "thin" as const,
    lipFullness: "thin" as const,
    lipColor: "berry" as const,
    jawShape: "soft" as const,
    bangs: "straight" as const,
    bangsLength: "brow" as const,
    hairSilhouette: "rounded" as const,
    bangsDensity: "dense" as const,
    fringeEdge: "staggered" as const,
    fringeOpening: "none" as const,
    hairTexture: "straight" as const,
    hairVolume: "normal" as const,
    hairPart: "none" as const,
    sideHairLength: "short" as const,
    sideHairShape: "ear_hugging" as const,
    sideHairAsymmetry: "none" as const,
    earExposure: "partial" as const,
    neckAccessory: "bow" as const,
    neckConfidence: "high" as const,
    faceEvidence: "Light cool skin, small almond eyes and a soft oval jaw.",
    hairEvidence: "A domed crown connects through the temples around the ears.",
    neckEvidence: "A central knot has two broad pointed hanging tails.",
  };
}

function providerOf(results: SkinGenerationResult[]): SkinGenerationProvider & {
  calls: number;
  modelTiers: ImageModelTier[];
  photoDataUrls: string[];
} {
  const provider = {
    calls: 0,
    modelTiers: [] as ImageModelTier[],
    photoDataUrls: [] as string[],
    async generate(
      request: SkinGenerationRequest,
    ): Promise<SkinGenerationResult> {
      provider.modelTiers.push(request.modelTier ?? "balanced");
      provider.photoDataUrls.push(request.photoDataUrl);
      return results[Math.min(provider.calls++, results.length - 1)];
    },
  };
  return provider;
}

async function goodFluxOutput(): Promise<SkinGenerationResult> {
  const png = await encodePng(makeFrontBackView());
  return { ok: true, imageBytes: png, inputTiles: 2, outputTiles: 2 };
}

describe("generateSkin", () => {
  it("creates a centered upper-body crop only for tall portraits", async () => {
    const crop = await createUpperBodyDetailCrop(await portraitPhotoDataUrl());
    expect(crop).not.toBeNull();
    const decoded = await decodePng(
      Uint8Array.from(atob((crop as string).split(",")[1]), (character) =>
        character.charCodeAt(0),
      ),
    );
    expect(decoded.width).toBe(66);
    expect(decoded.height).toBe(67);
    expect(await createUpperBodyDetailCrop(await photoDataUrl())).toBeNull();
  });

  it("builds an opaque sub-512px anonymized reference for moderated retries", async () => {
    const reference = await buildProceduralGenerationReference(
      {
        skinTone: "#edc8b4",
        hairColor: "#171719",
        eyeColor: "#3f3029",
        topColor: "#343438",
        topAccentColor: "#d8d8dc",
        bottomColor: "#333339",
        shoesColor: "#111113",
      },
      { ...DEFAULT_FACE_STYLE, hairstyle: "short" },
    );

    expect(reference).toMatch(/^data:image\/png;base64,/);
    const decoded = await decodePng(
      Uint8Array.from(atob((reference as string).split(",")[1]), (value) =>
        value.charCodeAt(0),
      ),
    );
    expect([decoded.width, decoded.height]).toEqual([448, 448]);
    expect(decoded.rgba[3]).toBe(255);
    expect(
      decoded.rgba.some((value, index) => index % 4 === 3 && value < 255),
    ).toBe(false);
  });

  it("uses decisive focused geometry to correct a full-body collar misread", async () => {
    const base = makeAnalysis();
    const main = makeAnalysis({
      framing: "full_body",
      visibleRegions: {
        face: true,
        hair: true,
        upperBody: true,
        lowerBody: true,
        feet: true,
      },
      observed: {
        ...base.observed,
        accessories: "Pink flowers in the hair.",
        clothing: "Pink cardigan over a white collared shirt.",
      },
      renderHints: {
        ...base.renderHints,
        faceShape: "round",
        eyeSize: "large",
        bangs: "side",
        hairSilhouette: "flat",
        sideHairShape: "tapered",
        neckAccessory: "collar",
      },
    });
    const env = makeEnv(main, false);
    env.AI.run = vi
      .fn()
      .mockResolvedValueOnce({ response: main })
      .mockResolvedValueOnce({
        response: focusedPortraitDetail(),
      }) as unknown as Env["AI"]["run"];

    const result = await generateSkin(env, await portraitPhotoDataUrl());

    expect(env.AI.run).toHaveBeenCalledTimes(2);
    expect(result.neuronsSpent).toBe(270);
    expect(result.body.analysis?.renderHints.neckAccessory).toBe("bow");
    expect(result.body.analysis?.renderHints).toMatchObject({
      faceShape: "oval",
      eyeSize: "small",
      bangs: "straight",
      hairSilhouette: "rounded",
      sideHairShape: "ear_hugging",
    });
    expect(result.body.analysis?.observed.face).toContain("dark brown eyes");
    expect(result.body.analysis?.observed.hair).toContain("domed crown");
    expect(result.body.analysis?.observed.accessories).toContain(
      "central knot",
    );
  });

  it("merges reliable portrait details without rewriting outfit or unseen hair", () => {
    const base = makeAnalysis();
    const main = makeAnalysis({
      observed: {
        ...base.observed,
        face: "medium skin and an average face",
        hair: "short black hair",
      },
      renderHints: {
        ...base.renderHints,
        faceShape: "round",
        eyeSize: "large",
        bangs: "side",
        bangsLength: "eye",
        hairTexture: "curly",
        hairVolume: "flat",
        hairSilhouette: "flat",
        sideHairLength: "none",
        sideHairShape: "tapered",
        sideHairAsymmetry: "right",
        hairBackShape: "tapered",
        overallHairLength: "ear",
      },
      fallbackFeatures: {
        ...base.fallbackFeatures,
        skinTone: "medium",
        eyeColor: "blue",
        hairColor: "brown",
      },
    });

    const merged = applyFocusedPortraitDetail(main, focusedPortraitDetail());

    expect(merged.renderHints).toMatchObject({
      skinUndertone: "cool",
      faceShape: "oval",
      eyeSize: "small",
      irisLightness: "dark",
      lipColor: "berry",
      hairSilhouette: "rounded",
      bangs: "straight",
      bangsLength: "brow",
      hairTexture: "straight",
      hairVolume: "normal",
      sideHairLength: "short",
      sideHairShape: "ear_hugging",
      sideHairAsymmetry: "none",
      hairBackShape: "tapered",
      overallHairLength: "ear",
    });
    expect(merged.fallbackFeatures.skinTone).toBe("light");
    expect(merged.fallbackFeatures.eyeColor).toBe("dark-brown");
    expect(merged.fallbackFeatures.hairColor).toBe("black");
    expect(merged.fallbackFeatures.eyebrowThickness).toBe("thin");
    expect(merged.observed.face).toContain("cool light skin");
    expect(merged.observed.face).toContain("dark brown eyes");
    expect(merged.observed.hair).toContain("domed crown");
    expect(merged.observed.clothing).toBe(main.observed.clothing);
    expect(merged.outfitPrompt).toBe(main.outfitPrompt);
    expect(merged.inferred).toBe(main.inferred);
  });

  it("keeps each low-confidence portrait group unchanged", () => {
    const main = makeAnalysis();
    const detail = focusedPortraitDetail();
    const merged = applyFocusedPortraitDetail(main, {
      ...detail,
      faceConfidence: "low",
      hairConfidence: "low",
      faceShape: "square",
      hairSilhouette: "spiky",
    });

    expect(merged).toBe(main);
  });

  it("does not let weak focused evidence replace a specific main result", () => {
    const base = makeAnalysis();
    const bow = makeAnalysis({
      renderHints: { ...base.renderHints, neckAccessory: "bow" },
    });
    const unchangedSpecific = applyFocusedNeckDetail(bow, {
      neckAccessory: "collar",
      confidence: "high",
      evidence: "Short paired collar flaps.",
    });
    const unchangedWeak = applyFocusedNeckDetail(
      makeAnalysis({
        renderHints: { ...base.renderHints, neckAccessory: "collar" },
      }),
      {
        neckAccessory: "bow",
        confidence: "high",
        evidence: "A white garment detail is visible.",
      },
    );

    expect(unchangedSpecific).toBe(bow);
    expect(unchangedWeak.renderHints.neckAccessory).toBe("collar");
  });

  it("stabilizes explicitly described eye apertures and lip fullness", () => {
    const base = makeAnalysis();
    const large = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          face: "oval face with large slightly downturned light brown eyes",
        },
        renderHints: { ...base.renderHints, eyeSize: "average" },
      }),
    );
    const small = normalizeAnalysisForRendering(
      makeAnalysis({
        identityPrompt:
          "A long face with compact dark-brown eyes, a straight nose and thin lips.",
        renderHints: { ...base.renderHints, eyeSize: "average" },
      }),
    );
    const compactFullLips = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          face: "oval face with large brown eyes and small full rosy lips",
        },
        renderHints: {
          ...base.renderHints,
          mouthShape: "small",
          lipFullness: "average",
        },
      }),
    );

    expect(large.renderHints.eyeSize).toBe("large");
    expect(small.renderHints.eyeSize).toBe("small");
    expect(small.renderHints.lipFullness).toBe("thin");
    expect(compactFullLips.renderHints.mouthShape).toBe("small");
    expect(compactFullLips.renderHints.lipFullness).toBe("full");
  });

  it("recovers a slight eye-corner downturn and a described flower cluster from prose", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          face: "Large brown eyes with level eye tilt and a slight downturn at the outer corners.",
          hair: "Long wavy brown hair with a cluster of pale pink artificial flowers and green leaves on viewer-left.",
          accessories:
            "Viewer-left cluster of pale pink flowers with green leaves in the hair.",
        },
        renderHints: {
          ...base.renderHints,
          eyeSize: "large",
          eyeTilt: "level",
          hairAccessory: "flower",
          hairAccessoryScale: "medium",
          hairAccessorySide: "left",
        },
      }),
    );

    expect(normalized.renderHints.eyeTilt).toBe("downturned");
    expect(normalized.renderHints.hairAccessoryScale).toBe("large");
  });

  it("preserves chest, waist and hip hair endpoints instead of collapsing all long hair to shoulder length", () => {
    const base = makeAnalysis();
    const normalizeLength = (
      hair: string,
      identityPrompt: string,
      overallHairLength: typeof base.renderHints.overallHairLength,
    ) =>
      normalizeAnalysisForRendering(
        makeAnalysis({
          observed: { ...base.observed, hair },
          identityPrompt,
          renderHints: {
            ...base.renderHints,
            hairBackShape: "long",
            overallHairLength,
          },
          fallbackFeatures: {
            ...base.fallbackFeatures,
            hairstyle: "long",
          },
        }),
      ).renderHints.overallHairLength;

    expect(
      normalizeLength(
        "long wavy hair falling past the shoulders to the chest",
        "Long wavy chest-length hair.",
        "shoulder",
      ),
    ).toBe("chest");
    expect(
      normalizeLength(
        "long straight hair reaching the waist",
        "Waist-length straight hair with a full back.",
        "shoulder",
      ),
    ).toBe("waist");
    expect(
      normalizeLength(
        "lowest substantial endpoints fall past the bust and approach the natural waist",
        "Long wavy hair approaching the natural waist.",
        "chest",
      ),
    ).toBe("waist");
    expect(
      normalizeLength(
        "lowest substantial hair endpoint reaches past chest toward the natural waist/belt line",
        "Long wavy hair flowing toward the waist.",
        "chest",
      ),
    ).toBe("waist");
    expect(
      normalizeLength(
        "very long curls falling to the hips",
        "Hip-length curly hair.",
        "chest",
      ),
    ).toBe("hip");

    const longFaceWithShortHair = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          face: "long oval face",
          hair: "short ear-length dark hair",
        },
        identityPrompt: "A long oval face with short hair around the ears.",
        renderHints: {
          ...base.renderHints,
          hairBackShape: "tapered",
          overallHairLength: "ear",
        },
      }),
    );
    expect(longFaceWithShortHair.renderHints.hairBackShape).toBe("tapered");
    expect(longFaceWithShortHair.renderHints.overallHairLength).toBe("ear");
  });

  it("clamps contradictory cheek-length side panels on a compact tapered cut", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "short black hair with a straight fringe and neatly tapered side hair",
        },
        identityPrompt:
          "Short straight black hair with a brow fringe and clean tapered sides.",
        renderHints: {
          ...base.renderHints,
          hairBackShape: "tapered",
          overallHairLength: "ear",
          sideHairLength: "cheek",
          sideHairShape: "tapered",
        },
      }),
    );

    expect(normalized.renderHints.sideHairLength).toBe("short");
    expect(normalized.renderHints.sideHairShape).toBe("tapered");
  });

  it("recovers a rounded compact crown when straight bangs are misclassified as a flat silhouette", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "short straight black hair with a dense blunt brow fringe and neat tapered sides",
        },
        identityPrompt:
          "Short ear-length black hair, dense eyebrow-level fringe and tapered side hair.",
        renderHints: {
          ...base.renderHints,
          bangs: "straight",
          bangsLength: "brow",
          bangsDensity: "dense",
          hairTexture: "straight",
          hairVolume: "normal",
          hairSilhouette: "flat",
          hairBackShape: "tapered",
          overallHairLength: "ear",
          sideHairLength: "short",
          sideHairShape: "tapered",
        },
      }),
    );

    expect(normalized.renderHints.hairSilhouette).toBe("rounded");
  });

  it("preserves an explicitly photographed flat-top crown", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "short straight black hair with an explicitly flat boxy crown and tapered sides",
        },
        renderHints: {
          ...base.renderHints,
          bangs: "straight",
          hairVolume: "normal",
          hairSilhouette: "flat",
          hairBackShape: "tapered",
          overallHairLength: "ear",
          sideHairLength: "short",
          sideHairShape: "tapered",
        },
      }),
    );

    expect(normalized.renderHints.hairSilhouette).toBe("flat");
  });

  it("stabilizes explicit low and full hair volume independently from length", () => {
    const base = makeAnalysis();
    const sleek = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "Long sleek ash-brown hair lies flat and close to the head with low volume.",
        },
        renderHints: {
          ...base.renderHints,
          hairVolume: "full",
          hairBackShape: "long",
          overallHairLength: "waist",
        },
      }),
    );
    const voluminous = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "Long voluminous wavy brown hair has an expanded full crown.",
        },
        renderHints: {
          ...base.renderHints,
          hairVolume: "flat",
          hairBackShape: "long",
          overallHairLength: "waist",
        },
      }),
    );

    expect(sleek.renderHints.hairVolume).toBe("flat");
    expect(sleek.renderHints.overallHairLength).toBe("waist");
    expect(voluminous.renderHints.hairVolume).toBe("full");
    expect(voluminous.renderHints.overallHairLength).toBe("waist");
  });

  it("does not mistake landmark comparison prose for shoulder-length hair", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "short black hair with a straight brow fringe, tapered temple contours, and the lowest substantial hair endpoint relative to the shoulders, chest, natural waist, and hips is at the jaw level",
        },
        identityPrompt:
          "Short straight black hair with a brow fringe and neat tapered sides.",
        renderHints: {
          ...base.renderHints,
          hairBackShape: "tapered",
          overallHairLength: "shoulder",
          sideHairLength: "cheek",
          sideHairShape: "tapered",
        },
      }),
    );

    expect(normalized.renderHints.overallHairLength).toBe("ear");
    expect(normalized.renderHints.sideHairLength).toBe("short");
  });

  it("preserves cheek-length face-framing hair on a rounded bob", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "rounded jaw-length bob with cheek-length face-framing locks",
        },
        identityPrompt:
          "A rounded jaw-length bob with visible cheek-length front locks.",
        renderHints: {
          ...base.renderHints,
          hairBackShape: "rounded",
          overallHairLength: "jaw",
          sideHairLength: "cheek",
          sideHairShape: "face_framing",
        },
      }),
    );

    expect(normalized.renderHints.sideHairLength).toBe("cheek");
    expect(normalized.renderHints.sideHairShape).toBe("face_framing");
  });

  it("preserves visible slouchy leg-warmer construction over sock height", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        framing: "full_body",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: true,
          feet: true,
        },
        observed: {
          ...base.observed,
          clothing:
            "Viewer-left only: a loose slouchy knit over-knee leg warmer with gathered folds and lace trim.",
        },
        renderHints: {
          ...base.renderHints,
          legwear: "thigh_highs",
          legwearAsymmetry: "left",
        },
      }),
    );

    expect(normalized.renderHints.legwear).toBe("leg_warmers");
    expect(normalized.renderHints.legwearAsymmetry).toBe("left");
  });

  it("adds a top-grounded construction cue when unseen lower-body analysis is completely generic", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        framing: "upper_body",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: false,
          feet: false,
        },
        observed: {
          ...base.observed,
          clothing: "dark gray cable-knit crewneck sweater",
        },
        inferred: {
          ...base.inferred,
          lowerBodyDesign: {
            bottomType: "pants",
            bottomPattern: "plain",
            bottomAccent: "none",
            legwear: "none",
            legwearAsymmetry: "none",
            thighAccessory: "none",
            thighAccessorySide: "none",
            shoeStyle: "sneakers",
            rationale: "plain pants and sneakers match the sweater",
          },
        },
        renderHints: {
          ...base.renderHints,
          garmentTexture: "knit",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
        },
        fallbackFeatures: {
          ...base.fallbackFeatures,
          topType: "sweater",
          bottomType: "pants",
        },
      }),
    );

    expect(normalized.renderHints.bottomAccent).toBe("cuffs");
    expect(normalized.inferred.lowerBodyDesign?.bottomAccent).toBe("cuffs");
    expect(normalized.inferred.lowerBodyDesign?.rationale).toContain(
      "readable low-resolution construction cue",
    );
    expect(normalized.inferred.lowerBody?.value).toContain("cuffed hems");
    expect(normalized.outfitPrompt).toContain("cuffed hems");
  });

  it("expands a generic unseen lower half into a complete preppy design from cardigan and bow cues", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        framing: "upper_body",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: false,
          feet: false,
        },
        observed: {
          ...base.observed,
          clothing: "soft knit cardigan over a blouse with a prominent neck bow",
        },
        inferred: {
          ...base.inferred,
          lowerBodyDesign: {
            bottomType: "pants",
            bottomPattern: "plain",
            bottomAccent: "none",
            legwear: "none",
            legwearAsymmetry: "none",
            thighAccessory: "none",
            thighAccessorySide: "none",
            shoeStyle: "sneakers",
            rationale: "generic safe completion",
          },
        },
        renderHints: {
          ...base.renderHints,
          garmentTexture: "knit",
          outerGarment: "cardigan",
          neckAccessory: "bow",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
          legwearAsymmetry: "none",
        },
        fallbackFeatures: {
          ...base.fallbackFeatures,
          topType: "sweater",
          bottomType: "pants",
        },
      }),
    );

    expect(normalized.inferred.lowerBodyDesign).toMatchObject({
      bottomType: "skirt",
      bottomPattern: "pleated",
      bottomAccent: "ribbon",
      legwear: "socks",
      legwearAsymmetry: "both",
      shoeStyle: "dress_shoes",
    });
    expect(normalized.renderHints).toMatchObject({
      bottomPattern: "pleated",
      bottomAccent: "ribbon",
      legwear: "socks",
      legwearAsymmetry: "both",
    });
    expect(normalized.inferred.lowerBodyDesign?.rationale).toContain(
      "cardigan and neck bow",
    );
    expect(normalized.outfitPrompt).toContain("pleated skirt");
    expect(normalized.outfitPrompt).toContain("strap dress shoes");
  });

  it("completes a generic shirt-and-tie lower half with tailored construction", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        framing: "upper_body",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: false,
          feet: false,
        },
        observed: {
          ...base.observed,
          clothing: "structured collared shirt and narrow tie",
        },
        inferred: {
          ...base.inferred,
          lowerBodyDesign: {
            bottomType: "pants",
            bottomPattern: "plain",
            bottomAccent: "none",
            legwear: "none",
            legwearAsymmetry: "none",
            thighAccessory: "none",
            thighAccessorySide: "none",
            shoeStyle: "sneakers",
            rationale: "generic safe completion",
          },
        },
        renderHints: {
          ...base.renderHints,
          outerGarment: "none",
          neckAccessory: "tie",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
        },
        fallbackFeatures: {
          ...base.fallbackFeatures,
          topType: "shirt",
          bottomType: "pants",
        },
      }),
    );

    expect(normalized.inferred.lowerBodyDesign).toMatchObject({
      bottomType: "pants",
      bottomPattern: "plain",
      bottomAccent: "belt",
      legwear: "none",
      shoeStyle: "dress_shoes",
    });
    expect(normalized.renderHints.bottomAccent).toBe("belt");
    expect(normalized.inferred.shoes?.value).toContain("leather dress shoes");
    expect(normalized.outfitPrompt).toContain("tailored trousers");
  });

  it("renders the inferred preppy completion as skirt volume and shoe straps end to end", async () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      framing: "upper_body",
      visibleRegions: {
        face: true,
        hair: true,
        upperBody: true,
        lowerBody: false,
        feet: false,
      },
      inferred: {
        ...base.inferred,
        lowerBodyDesign: {
          bottomType: "pants",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
          legwearAsymmetry: "none",
          thighAccessory: "none",
          thighAccessorySide: "none",
          shoeStyle: "sneakers",
          rationale: "generic safe completion",
        },
      },
      renderHints: {
        ...base.renderHints,
        outerGarment: "cardigan",
        neckAccessory: "bow",
        bottomPattern: "plain",
        bottomAccent: "none",
        legwear: "none",
      },
      fallbackFeatures: {
        ...base.fallbackFeatures,
        topType: "sweater",
        bottomType: "pants",
      },
    });
    const result = await generateSkin(
      makeEnv(analysis, false),
      await photoDataUrl(),
    );

    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(result.body.analysis?.inferred.lowerBodyDesign).toMatchObject({
      bottomType: "skirt",
      bottomPattern: "pleated",
      bottomAccent: "ribbon",
      legwear: "socks",
      shoeStyle: "dress_shoes",
    });
    const atlas = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (character) =>
        character.charCodeAt(0),
      ),
    );
    const body = CLASSIC_LAYOUT.body.overlay.front;
    const rightLeg = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const skirtHem =
      ((body.y + body.h - 1) * ATLAS_SIZE + body.x + 3) * 4 + 3;
    const shoeStrap =
      ((rightLeg.y + rightLeg.h - 2) * ATLAS_SIZE + rightLeg.x + 1) * 4 + 3;

    expect(atlas.rgba[skirtHem]).toBe(255);
    expect(atlas.rgba[shoeStrap]).toBe(255);
    expect(validateFinalAtlas(atlas).ok).toBe(true);
  });

  it("does not overwrite a concrete inferred lower-body design", () => {
    const base = makeAnalysis();
    const normalized = normalizeAnalysisForRendering(
      makeAnalysis({
        inferred: {
          ...base.inferred,
          lowerBodyDesign: {
            bottomType: "pants",
            bottomPattern: "plain",
            bottomAccent: "belt",
            legwear: "none",
            legwearAsymmetry: "none",
            thighAccessory: "none",
            thighAccessorySide: "none",
            shoeStyle: "dress_shoes",
            rationale: "tailored trousers use a visible belt",
          },
        },
        renderHints: {
          ...base.renderHints,
          bottomAccent: "belt",
        },
      }),
    );

    expect(normalized.renderHints.bottomAccent).toBe("belt");
    expect(normalized.inferred.lowerBodyDesign?.bottomAccent).toBe("belt");
  });

  it("preserves muted portrait colours instead of collapsing them to vivid fallback swatches", async () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      framing: "full_body",
      visibleRegions: {
        face: true,
        hair: true,
        upperBody: true,
        lowerBody: true,
        feet: true,
      },
      observed: {
        face: "oval face with pale porcelain skin",
        hair: "long wavy light-brown hair",
        accessories: "pink flower hair accessory",
        clothing:
          "dusty rose pink cardigan, light beige plaid skort and cream Mary Jane shoes",
        colorPalette: [
          "dusty rose pink",
          "light brown",
          "light beige",
          "cream",
        ],
      },
      identityPrompt:
        "An oval-faced person with pale skin and long wavy light-brown hair.",
      outfitPrompt:
        "A muted dusty-pink cardigan with a light beige plaid skort and off-white cream Mary Jane shoes.",
      fallbackFeatures: {
        ...base.fallbackFeatures,
        skinTone: "light",
        hairColor: "light-brown",
        hairstyle: "long",
        topColor: "pink",
        bottomType: "skirt",
        bottomColor: "beige",
        shoesColor: "beige",
      },
    });
    const result = await generateSkin(
      makeEnv(analysis, false),
      await photoDataUrl(),
    );

    expect(result.status).toBe(200);
    expect(result.body.features).toMatchObject({
      skinTone: "#f2d6c0",
      hairColor: "#806052",
      topColor: "#b7929d",
      bottomColor: "#cbb8a3",
      shoesColor: "#e8dfd1",
    });
  });

  it("uses explicit light-skin evidence over a conflicting medium palette enum", async () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      observed: {
        ...base.observed,
        face: "oval face with light warm skin, almond dark-brown eyes and a small nose",
        colorPalette: ["light warm skin", "black", "charcoal"],
      },
      identityPrompt:
        "An oval-faced person with light warm skin and short black hair.",
      renderHints: {
        ...base.renderHints,
        skinUndertone: "warm",
      },
      fallbackFeatures: {
        ...base.fallbackFeatures,
        skinTone: "medium",
      },
    });
    const result = await generateSkin(
      makeEnv(analysis, false),
      await photoDataUrl(),
    );

    expect(result.status).toBe(200);
    expect(result.body.features).toMatchObject({
      skinTone: "#ecb78c",
    });
  });

  it("preserves structured warm and cool skin undertones at the same lightness", async () => {
    const base = makeAnalysis();
    const makeTone = (skinUndertone: "warm" | "cool") =>
      makeAnalysis({
        observed: {
          ...base.observed,
          face: "oval face with almond dark-brown eyes",
        },
        identityPrompt: "An oval-faced person with short black hair.",
        renderHints: { ...base.renderHints, skinUndertone },
        fallbackFeatures: { ...base.fallbackFeatures, skinTone: "light" },
      });

    const warm = await generateSkin(
      makeEnv(makeTone("warm"), false),
      await photoDataUrl(),
    );
    const cool = await generateSkin(
      makeEnv(makeTone("cool"), false),
      await photoDataUrl(),
    );

    expect(warm.status).toBe(200);
    expect(cool.status).toBe(200);
    expect(warm.body.features?.skinTone).toBe("#ecb78c");
    expect(cool.body.features?.skinTone).toBe("#e5b5a6");
    expect(warm.body.features?.skinTone).not.toBe(cool.body.features?.skinTone);

    const decodeAtlas = (base64: string) =>
      decodePng(
        Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
      );
    const warmAtlas = await decodeAtlas(warm.body.skinPngBase64 as string);
    const coolAtlas = await decodeAtlas(cool.body.skinPngBase64 as string);
    const face = CLASSIC_LAYOUT.head.base.front;
    const cheek = ((face.y + 5) * ATLAS_SIZE + face.x) * 4;

    expect(warmAtlas.rgba[cheek]).toBeGreaterThan(coolAtlas.rgba[cheek]);
    expect(coolAtlas.rgba[cheek + 2]).toBeGreaterThan(
      warmAtlas.rgba[cheek + 2],
    );
  });

  it("stabilizes explicit center-parted curtain hair across inconsistent enum hints", async () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      observed: {
        ...base.observed,
        hair: "long wavy center-parted hair with curtain bangs and face-framing locks over the shoulders",
      },
      identityPrompt:
        "Long wavy hair parted down the middle, with curtain bangs and strands that frame the face.",
      renderHints: {
        ...base.renderHints,
        bangs: "straight",
        bangsLength: "short",
        fringeOpening: "left",
        hairBackShape: "rounded",
        hairPart: "left",
        sideHairLength: "short",
        sideHairShape: "flared",
      },
    });
    const result = await generateSkin(
      makeEnv(analysis, false),
      await photoDataUrl(),
    );

    expect(result.status).toBe(200);
    expect(result.body.analysis?.renderHints).toMatchObject({
      bangs: "curtain",
      bangsLength: "brow",
      fringeOpening: "center",
      hairBackShape: "long",
      hairPart: "center",
      sideHairLength: "shoulder",
      sideHairShape: "face_framing",
    });
  });

  it("keeps long face-framing hair on both shoulders unless shorter layers are explicitly described", async () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      observed: {
        ...base.observed,
        hair: "long full wavy light-brown hair with curtain bangs and a pink flower on viewer-left",
        accessories: "large pink flower on viewer-left hair",
      },
      identityPrompt:
        "A person with long full wavy light-brown hair, curtain bangs and a pink flower on viewer-left.",
      renderHints: {
        ...base.renderHints,
        bangs: "curtain",
        hairTexture: "wavy",
        hairVolume: "full",
        hairBackShape: "long",
        sideHairLength: "jaw",
        sideHairShape: "face_framing",
        sideHairAsymmetry: "left",
        hairAccessory: "flower",
        hairAccessorySide: "left",
      },
      fallbackFeatures: {
        ...base.fallbackFeatures,
        hairstyle: "long",
      },
    });
    const result = await generateSkin(
      makeEnv(analysis, false),
      await photoDataUrl(),
    );

    expect(result.status).toBe(200);
    expect(result.body.analysis?.renderHints).toMatchObject({
      hairBackShape: "long",
      sideHairLength: "shoulder",
      sideHairShape: "face_framing",
      sideHairAsymmetry: "none",
    });
  });

  it("preserves an explicitly described jaw-length asymmetric front layer", async () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      observed: {
        ...base.observed,
        hair: "long wavy hair with a jaw-length face-framing layer that is fuller on viewer-right",
      },
      identityPrompt:
        "Long wavy back hair with a fuller jaw-length lock on viewer-right.",
      renderHints: {
        ...base.renderHints,
        hairBackShape: "long",
        sideHairLength: "jaw",
        sideHairShape: "face_framing",
        sideHairAsymmetry: "right",
      },
      fallbackFeatures: {
        ...base.fallbackFeatures,
        hairstyle: "long",
      },
    });
    const result = await generateSkin(
      makeEnv(analysis, false),
      await photoDataUrl(),
    );

    expect(result.status).toBe(200);
    expect(result.body.analysis?.renderHints).toMatchObject({
      hairBackShape: "long",
      sideHairLength: "jaw",
      sideHairShape: "face_framing",
      sideHairAsymmetry: "right",
    });
  });

  it("recovers subtle center fringe separation without inventing a root part", async () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      observed: {
        ...base.observed,
        hair: "Long wavy hair with dense staggered brow bangs and a slight center separation between fringe clusters.",
      },
      identityPrompt:
        "Long full wavy hair with face-framing shoulder locks and a subtle center separation in the bangs.",
      renderHints: {
        ...base.renderHints,
        bangs: "straight",
        bangsLength: "brow",
        bangsDensity: "dense",
        fringeEdge: "staggered",
        fringeOpening: "left",
        hairTexture: "wavy",
        hairBackShape: "long",
        hairPart: "left",
        sideHairLength: "shoulder",
        sideHairShape: "face_framing",
      },
    });
    const result = await generateSkin(
      makeEnv(analysis, false),
      await photoDataUrl(),
    );

    expect(result.status).toBe(200);
    expect(result.body.analysis?.renderHints).toMatchObject({
      bangs: "straight",
      fringeOpening: "center",
      hairPart: "left",
      sideHairLength: "shoulder",
      sideHairShape: "face_framing",
    });
  });

  it("refines model-returned palette hex values using visible colour prose", async () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      framing: "full_body",
      visibleRegions: {
        face: true,
        hair: true,
        upperBody: true,
        lowerBody: true,
        feet: true,
      },
      observed: {
        face: "Oval face shape, pale skin and a soft jaw.",
        hair: "Long wavy light-brown hair.",
        accessories: "pink flower",
        clothing:
          "Light pink/mauve cardigan, beige/tan plaid shorts and cream Mary Jane shoes.",
        colorPalette: ["light pink", "mauve", "beige", "tan", "cream"],
      },
      identityPrompt:
        "An oval-faced person with pale skin and long wavy light-brown hair.",
      outfitPrompt:
        "Light pink/mauve cardigan with beige/tan plaid culottes and cream Mary Jane shoes.",
      fallbackFeatures: {
        ...base.fallbackFeatures,
        skinTone: "unexpected-model-value",
        hairColor: "#806052",
        topColor: "unexpected-model-value",
        bottomColor: "unexpected-model-value",
        shoesColor: "unexpected-model-value",
      },
    });
    const result = await generateSkin(
      makeEnv(analysis, false),
      await photoDataUrl(),
    );

    expect(result.status).toBe(200);
    expect(result.body.features).toMatchObject({
      skinTone: "#f2d6c0",
      hairColor: "#806052",
      topColor: "#b7929d",
      bottomColor: "#cbb8a3",
      shoesColor: "#e8dfd1",
    });
  });

  it("keeps vivid plain pink when the description does not say it is muted", async () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      observed: {
        ...base.observed,
        clothing: "bright pink athletic jacket over a white shirt",
      },
      outfitPrompt:
        "A vivid bright pink athletic jacket with black pants and white sneakers.",
      fallbackFeatures: {
        ...base.fallbackFeatures,
        topColor: "pink",
      },
    });
    const result = await generateSkin(
      makeEnv(analysis, false),
      await photoDataUrl(),
    );

    expect(result.status).toBe(200);
    expect(result.body.features?.topColor).toBe("#e58bb6");
  });

  it("does not transfer legwear or blouse colours onto unrelated garments", async () => {
    const base = makeAnalysis();
    const analysis = makeAnalysis({
      observed: {
        ...base.observed,
        clothing:
          "Blue denim jacket over a cream blouse, black shorts, soft pink leg warmers and black loafers.",
      },
      outfitPrompt:
        "Blue denim jacket, cream blouse, black shorts, soft pink leg warmers and black loafers.",
      fallbackFeatures: {
        ...base.fallbackFeatures,
        topColor: "blue",
        bottomColor: "black",
        shoesColor: "black",
      },
    });
    const result = await generateSkin(
      makeEnv(analysis, false),
      await photoDataUrl(),
    );

    expect(result.status).toBe(200);
    expect(result.body.features).toMatchObject({
      topColor: "#4d9de0",
      bottomColor: "#22201e",
      shoesColor: "#22201e",
    });
  });

  it("uses the high-resolution photo for analysis and the 448px photo for image generation", async () => {
    const env = makeEnv(makeAnalysis(), true, "front_view");
    const generationPhoto = await photoDataUrl();
    const analysisPhoto = "data:image/jpeg;base64,aGlnaC1yZXM=";
    const frontPng = await encodePng(makeFrontBackView());
    let providerPhoto = "";
    const provider: SkinGenerationProvider = {
      async generate(request) {
        providerPhoto = request.photoDataUrl;
        return {
          ok: true,
          imageBytes: frontPng,
          inputTiles: 2,
          outputTiles: 2,
        };
      },
    };

    const result = await generateSkin(
      env,
      generationPhoto,
      provider,
      analysisPhoto,
    );
    const calls = (
      env.AI.run as unknown as { mock: { calls: Array<[unknown, unknown]> } }
    ).mock.calls;
    const input = calls[0][1] as {
      messages: Array<{
        content: Array<{ image_url?: { url?: string } }>;
      }>;
    };

    expect(result.status).toBe(200);
    expect(input.messages[0].content[0].image_url?.url).toBe(analysisPhoto);
    expect(providerPhoto).toBe(generationPhoto);
  });

  it("front_view 전략(기본): 정면 뷰를 pack해 64x64 atlas를 반환한다", async () => {
    const env = makeEnv(makeAnalysis(), true, "front_view");
    const frontPng = await encodePng(makeFrontBackView());
    const provider = providerOf([
      { ok: true, imageBytes: frontPng, inputTiles: 2, outputTiles: 2 },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("image");
    expect(result.body.analysis?.renderHints).toEqual(
      makeAnalysis().renderHints,
    );
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    // 분석 170 + (사진+포즈가이드 2타일 x 6 + 출력 2타일 x 27) = 236
    expect(result.neuronsSpent).toBe(236);
  });

  it("four_view strategy packs front, back and both profiles into a valid atlas", async () => {
    const env = makeEnv(makeAnalysis(), true, "four_view");
    const sheetPng = await encodePng(makeFourViewSheet());
    const provider = providerOf([
      { ok: true, imageBytes: sheetPng, inputTiles: 2, outputTiles: 2 },
    ]);

    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("image");
    expect(provider.calls).toBe(1);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (character) =>
        character.charCodeAt(0),
      ),
    );
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    expect(result.neuronsSpent).toBe(236);
  });

  it("front_view preserves visible cardigan, hair flower and neck bow from observed text when render hints miss them", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        observed: {
          ...base.observed,
          hair: "long wavy brown hair with a large pink flower on viewer-left hair",
          accessories:
            "large pink flower on viewer-left hair and a white bow collar",
          clothing: "long-sleeve pink cardigan over a white bow collar",
        },
        renderHints: {
          ...base.renderHints,
          outerGarment: "none",
          outerLayer: "none",
          garmentTexture: "plain",
          hairAccessory: "none",
          hairAccessorySide: "center",
          neckAccessory: "none",
        },
        identityPrompt:
          "A person with long wavy brown hair and a large pink flower on viewer-left hair.",
        outfitPrompt:
          "Long-sleeve pink cardigan over a white bow collar, with the viewer-left hair flower preserved.",
        fallbackFeatures: {
          ...base.fallbackFeatures,
          hairstyle: "long",
          topType: "tshirt",
          sleeveLength: "short",
        },
      }),
      true,
      "front_view",
    );
    const frontPng = await encodePng(makeFrontBackView());
    const provider = providerOf([
      { ok: true, imageBytes: frontPng, inputTiles: 2, outputTiles: 2 },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    const head = CLASSIC_LAYOUT.head.overlay.front;
    const body = CLASSIC_LAYOUT.body.overlay.front;
    const bodyBase = CLASSIC_LAYOUT.body.base.front;
    const bodyBack = CLASSIC_LAYOUT.body.overlay.back;
    const bodyBaseSide = CLASSIC_LAYOUT.body.base.right;
    const armBaseFront = CLASSIC_LAYOUT.rightArm.base.front;
    const flowerPetal = ((head.y + 2) * ATLAS_SIZE + head.x + 1) * 4;
    const flowerLeaf = ((head.y + 1) * ATLAS_SIZE + head.x + 2) * 4;
    const bowWing = ((body.y + 1) * ATLAS_SIZE + body.x + 2) * 4;
    const bowKnot = ((body.y + 1) * ATLAS_SIZE + body.x + 3) * 4;
    const hairDrape = ((bodyBack.y + 5) * ATLAS_SIZE + bodyBack.x + 3) * 4;
    const cardiganPanel = ((bodyBase.y + 5) * ATLAS_SIZE + bodyBase.x + 1) * 4;
    const cardiganLowerPanel = ((body.y + 10) * ATLAS_SIZE + body.x + 1) * 4;
    const cardiganLowerTrim = ((body.y + 10) * ATLAS_SIZE + body.x + 2) * 4;
    const cardiganOpenCenter = ((body.y + 5) * ATLAS_SIZE + body.x + 3) * 4;
    const cardiganSidePanel =
      ((bodyBaseSide.y + 5) * ATLAS_SIZE + bodyBaseSide.x) * 4;
    const sleeve = ((armBaseFront.y + 4) * ATLAS_SIZE + armBaseFront.x + 1) * 4;
    const sleeveFold =
      ((armBaseFront.y + 3) * ATLAS_SIZE + armBaseFront.x + 1) * 4;

    expect(result.status).toBe(200);
    expect(decoded.rgba[flowerPetal + 3]).toBe(255);
    expect(decoded.rgba[flowerPetal]).toBeGreaterThan(
      decoded.rgba[flowerPetal + 1],
    );
    expect(decoded.rgba[flowerLeaf + 1]).toBeGreaterThan(
      decoded.rgba[flowerLeaf],
    );
    expect(decoded.rgba[bowWing + 3]).toBe(255);
    expect(decoded.rgba[bowKnot + 3]).toBe(255);
    expect(decoded.rgba[bowWing]).toBeGreaterThan(decoded.rgba[bowKnot]);
    expect(decoded.rgba[hairDrape + 3]).toBe(255);
    expect(decoded.rgba[cardiganPanel + 3]).toBe(255);
    expect(decoded.rgba[cardiganLowerPanel + 3]).toBe(255);
    expect(decoded.rgba[cardiganLowerTrim + 3]).toBe(255);
    expect(decoded.rgba[cardiganOpenCenter + 3]).toBe(0);
    expect(decoded.rgba[cardiganLowerTrim]).toBeLessThan(
      decoded.rgba[cardiganLowerPanel],
    );
    expect(decoded.rgba[cardiganSidePanel + 3]).toBe(255);
    expect(decoded.rgba[sleeve + 3]).toBe(255);
    expect(decoded.rgba[sleeveFold + 3]).toBe(255);
    expect(decoded.rgba[sleeve]).not.toBe(decoded.rgba[sleeveFold]);
  });

  it("legacy direct_atlas configuration is forced onto safe front-view packing", async () => {
    const env = makeEnv(makeAnalysis(), true, "direct_atlas");
    const frontPng = await encodePng(makeFrontBackView());
    let requestedMode = "";
    const provider: SkinGenerationProvider = {
      async generate(request) {
        requestedMode = request.mode;
        return {
          ok: true,
          imageBytes: frontPng,
          inputTiles: 2,
          outputTiles: 2,
        };
      },
    };

    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("image");
    expect(requestedMode).toBe("front_view");
    expect(result.neuronsSpent).toBe(236);
  });

  it("생성 결과가 atlas 검증에 실패하면 seed를 바꿔 1회 재시도한다", async () => {
    const flat = await encodePng({
      width: 512,
      height: 512,
      rgba: new Uint8Array(512 * 512 * 4).fill(100),
    });
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([
      { ok: true, imageBytes: flat, inputTiles: 3, outputTiles: 1 },
      await goodFluxOutput(),
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(provider.calls).toBe(2);
    expect(result.body.generationMode).toBe("image");
    expect(result.neuronsSpent).toBe(170 + 45 + 66);
  });

  it("두 번 모두 실패하면 분석 기반 절차적 atlas를 내려보낸다", async () => {
    const flat = await encodePng({
      width: 512,
      height: 512,
      rgba: new Uint8Array(512 * 512 * 4).fill(100),
    });
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([
      { ok: true, imageBytes: flat, inputTiles: 3, outputTiles: 1 },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(provider.calls).toBe(2);
    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(result.body.skinPngBase64).toBeTruthy();
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    // fallback features는 hex로 변환돼 있다 (yellow → #e3c14d)
    expect((result.body.features as Record<string, string>).topColor).toBe(
      "#e3c14d",
    );
  });

  it("quality tier retries a rejected 9B sheet once with the balanced model", async () => {
    const flat = await encodePng({
      width: 512,
      height: 512,
      rgba: new Uint8Array(512 * 512 * 4).fill(100),
    });
    const env = makeEnv(makeAnalysis());
    env.IMAGE_MODEL_TIER = "quality";
    const provider = providerOf([
      { ok: true, imageBytes: flat, inputTiles: 2, outputTiles: 2 },
      await goodFluxOutput(),
    ]);

    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(provider.calls).toBe(2);
    expect(provider.modelTiers).toEqual(["quality", "balanced"]);
    expect(result.body.generationMode).toBe("image");
    expect(result.neuronsSpent).toBe(170 + 1_460 + 66);
    expect(env.MCSKIN_KV.put).toHaveBeenCalledWith(
      "diagnostic:last-image-postprocess-failure",
      expect.stringContaining("could not isolate generated character views"),
      { expirationTtl: 60 * 60 * 48 },
    );
  });

  it("quality tier retries one consumed provider failure with 9B, then falls back to 4B", async () => {
    const env = makeEnv(makeAnalysis());
    env.IMAGE_MODEL_TIER = "quality";
    const provider = providerOf([
      {
        ok: false,
        error: "FLUX 호출 실패: 3030: output flagged",
        retryable: true,
        capacityConsumed: true,
      },
      {
        ok: false,
        error: "FLUX 호출 실패: 3030: output flagged again",
        retryable: true,
        capacityConsumed: true,
      },
      await goodFluxOutput(),
    ]);

    const sourcePhoto = await photoDataUrl();
    const result = await generateSkin(env, sourcePhoto, provider);

    expect(provider.calls).toBe(3);
    expect(provider.modelTiers).toEqual(["quality", "quality", "balanced"]);
    expect(provider.photoDataUrls[0]).toBe(sourcePhoto);
    expect(provider.photoDataUrls[1]).not.toBe(sourcePhoto);
    expect(provider.photoDataUrls[1]).toMatch(/^data:image\/png;base64,/);
    expect(provider.photoDataUrls[2]).toBe(provider.photoDataUrls[1]);
    expect(result.body.generationMode).toBe("image");
    expect(result.neuronsSpent).toBe(170 + 1_460 + 1_460 + 66);
  });

  it("stops image retries and reports shared quota exhaustion", async () => {
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([
      {
        ok: false,
        error: "4006: daily free allocation of 10,000 neurons used up",
        retryable: false,
        quotaExceeded: true,
      },
    ]);

    const result = await generateSkin(env, await photoDataUrl(), provider);

    expect(provider.calls).toBe(1);
    expect(result.status).toBe(200);
    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(result.providerQuotaExhausted).toBe(true);
  });

  it("procedural fallback preserves rich hair, cardigan, plaid and asymmetric legwear hints", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        framing: "full_body",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: true,
          feet: true,
        },
        observed: {
          ...base.observed,
          hair: "long wavy light-brown hair with curtain bangs and a large pink flower on viewer-left",
          accessories:
            "pink flower on viewer-left hair and a white ribbon on viewer-right thigh",
          clothing:
            "dusty-pink long cardigan, beige plaid pleated shorts. On viewer-left: one cream thigh-high sock. On viewer-right: no thigh-high sock, bare leg with a white ribbon. Cream Mary Jane shoes.",
          colorPalette: ["dusty pink", "beige", "cream", "light brown"],
        },
        renderHints: {
          ...base.renderHints,
          bangs: "curtain",
          bangsLength: "brow",
          hairTexture: "wavy",
          hairVolume: "full",
          hairBackShape: "long",
          sideHairLength: "shoulder",
          outerLayer: "light",
          outerGarment: "cardigan",
          hairAccessory: "flower",
          hairAccessorySide: "left",
          neckAccessory: "collar",
          bottomPattern: "plaid",
          bottomAccent: "belt",
          legwear: "thigh_highs",
          legwearColor: "beige",
          legwearAsymmetry: "left",
        },
        fallbackFeatures: {
          ...base.fallbackFeatures,
          hairColor: "light-brown",
          hairstyle: "long",
          topType: "sweater",
          topColor: "pink",
          topAccentColor: "white",
          sleeveLength: "long",
          bottomType: "shorts",
          bottomColor: "beige",
          shoesColor: "white",
          glasses: "none",
        },
      }),
      true,
      "front_view",
    );
    const provider = providerOf([
      {
        ok: false,
        error: "temporary image generation failure",
        retryable: false,
      },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    const head = CLASSIC_LAYOUT.head.overlay.front;
    const body = CLASSIC_LAYOUT.body.overlay.front;
    const bodyBase = CLASSIC_LAYOUT.body.base.front;
    const rightLeg = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const leftLeg = CLASSIC_LAYOUT.leftLeg.overlay.front;
    const flower = ((head.y + 2) * ATLAS_SIZE + head.x + 1) * 4;
    const leftEyeWindow = ((head.y + 4) * ATLAS_SIZE + head.x + 2) * 4;
    const rightEyeWindow = ((head.y + 4) * ATLAS_SIZE + head.x + 5) * 4;
    const hairDrape = ((body.y + 5) * ATLAS_SIZE + body.x) * 4;
    const cardiganPanel = ((bodyBase.y + 5) * ATLAS_SIZE + bodyBase.x + 1) * 4;
    const cardiganCenter = ((body.y + 5) * ATLAS_SIZE + body.x + 3) * 4;
    const plaidDark = (rightLeg.y * ATLAS_SIZE + rightLeg.x + 1) * 4;
    const plaidLight = (rightLeg.y * ATLAS_SIZE + rightLeg.x + 2) * 4;
    const leftThighHigh = ((leftLeg.y + 4) * ATLAS_SIZE + leftLeg.x + 1) * 4;
    const rightBare = ((rightLeg.y + 5) * ATLAS_SIZE + rightLeg.x + 3) * 4;

    expect(provider.calls).toBe(1);
    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    expect(decoded.rgba[flower + 3]).toBe(255);
    expect(decoded.rgba[flower]).toBeGreaterThan(decoded.rgba[flower + 1]);
    expect(decoded.rgba[leftEyeWindow + 3]).toBe(0);
    expect(decoded.rgba[rightEyeWindow + 3]).toBe(0);
    expect(decoded.rgba[hairDrape + 3]).toBe(255);
    expect(decoded.rgba[cardiganPanel + 3]).toBe(255);
    expect(decoded.rgba[cardiganCenter + 3]).toBe(0);
    expect(decoded.rgba[plaidDark + 3]).toBe(255);
    expect(decoded.rgba[plaidDark]).toBeLessThan(decoded.rgba[plaidLight]);
    expect(decoded.rgba[leftThighHigh + 3]).toBe(255);
    expect(decoded.rgba[leftThighHigh]).toBeGreaterThan(
      decoded.rgba[leftThighHigh + 1],
    );
    expect(decoded.rgba[leftThighHigh + 1]).toBeGreaterThan(
      decoded.rgba[leftThighHigh + 2],
    );
    expect(decoded.rgba[rightBare + 3]).toBe(0);
  });

  it("upper-body knit portraits keep a pendant and receive structured pants and dress shoes", async () => {
    const base = makeAnalysis();
    const env = makeEnv(
      makeAnalysis({
        framing: "upper_body",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: true,
          lowerBody: false,
          feet: false,
        },
        observed: {
          ...base.observed,
          face: "oval face, almond dark-brown eyes, straight eyebrows, small mouth",
          hair: "short straight black two-block hair with brow-length curtain fringe",
          accessories:
            "thin silver chain necklace with a small round silver pendant",
          clothing: "black cable-knit long-sleeve crewneck sweater",
          colorPalette: ["black", "charcoal", "silver", "warm skin"],
        },
        inferred: {
          ...base.inferred,
          hairBack: {
            value: "short tapered black hair at the back",
            rationale:
              "the visible short sides imply a neat tapered rear shape",
          },
          lowerBody: {
            value: "charcoal tailored trousers with a subtle black belt",
            rationale:
              "structured dark trousers match the polished cable-knit sweater and pendant",
          },
          lowerBodyDesign: {
            bottomType: "pants",
            bottomPattern: "plain",
            bottomAccent: "belt",
            legwear: "none",
            legwearAsymmetry: "none",
            thighAccessory: "none",
            thighAccessorySide: "none",
            shoeStyle: "dress_shoes",
            rationale:
              "dark tailored trousers and dress shoes complete the smart-casual upper body",
          },
          shoes: {
            value: "black leather dress shoes",
            rationale: "dress shoes preserve the refined monochrome outfit",
          },
        },
        renderHints: {
          ...base.renderHints,
          faceShape: "oval",
          eyeShape: "almond",
          eyebrowShape: "straight",
          mouthShape: "small",
          bangs: "curtain",
          bangsLength: "brow",
          hairTexture: "straight",
          hairVolume: "normal",
          hairSilhouette: "rounded",
          hairBackShape: "tapered",
          hairPart: "center",
          sideHairLength: "short",
          garmentTexture: "knit",
          outerLayer: "light",
          outerGarment: "none",
          necklace: "silver",
          neckAccessory: "none",
          bottomPattern: "plain",
          bottomAccent: "none",
          legwear: "none",
          legwearAsymmetry: "none",
        },
        fallbackFeatures: {
          ...base.fallbackFeatures,
          hairColor: "black",
          hairstyle: "short",
          glasses: "none",
          topType: "sweater",
          topColor: "black",
          topAccentColor: "gray",
          sleeveLength: "long",
          bottomType: "pants",
          bottomColor: "gray",
          shoesColor: "black",
        },
        outfitPrompt:
          "Black cable-knit sweater and silver pendant; complete the hidden lower body with charcoal tailored trousers, a black belt and black leather dress shoes.",
      }),
      true,
      "front_view",
    );
    const provider = providerOf([
      {
        ok: false,
        error: "temporary image generation failure",
        retryable: false,
      },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    const decoded = await decodePng(
      Uint8Array.from(atob(result.body.skinPngBase64 as string), (c) =>
        c.charCodeAt(0),
      ),
    );
    const head = CLASSIC_LAYOUT.head.overlay.front;
    const body = CLASSIC_LAYOUT.body.overlay.front;
    const arm = CLASSIC_LAYOUT.rightArm.overlay.front;
    const leg = CLASSIC_LAYOUT.rightLeg.overlay.front;
    const leftEyeWindow = ((head.y + 4) * ATLAS_SIZE + head.x + 2) * 4;
    const rightEyeWindow = ((head.y + 4) * ATLAS_SIZE + head.x + 5) * 4;
    const pendant = ((body.y + 4) * ATLAS_SIZE + body.x + 3) * 4;
    const belt = ((body.y + body.h - 3) * ATLAS_SIZE + body.x + 3) * 4;
    const cuff = ((arm.y + arm.h - 2) * ATLAS_SIZE + arm.x) * 4;
    const kneeFold = ((leg.y + 4) * ATLAS_SIZE + leg.x + 1) * 4;
    const shoeStrap = ((leg.y + leg.h - 3) * ATLAS_SIZE + leg.x + 1) * 4;

    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(validateFinalAtlas(decoded).ok).toBe(true);
    expect(decoded.rgba[leftEyeWindow + 3]).toBe(0);
    expect(decoded.rgba[rightEyeWindow + 3]).toBe(0);
    expect(decoded.rgba[pendant + 3]).toBe(255);
    expect(decoded.rgba[pendant]).toBeGreaterThan(170);
    expect(decoded.rgba[pendant + 2]).toBeGreaterThan(170);
    expect(decoded.rgba[belt + 3]).toBe(255);
    expect(decoded.rgba[cuff + 3]).toBe(255);
    expect(decoded.rgba[kneeFold + 3]).toBe(255);
    expect(decoded.rgba[shoeStrap + 3]).toBe(255);
  });

  it("재시도 불가 오류(입력 크기 등)는 즉시 fallback한다", async () => {
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([
      { ok: false, error: "사진이 FLUX 입력 제한 초과", retryable: false },
    ]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(provider.calls).toBe(1);
    expect(result.body.generationMode).toBe("procedural_fallback");
    expect(result.neuronsSpent).toBe(170);
  });

  it("재시도 가능 오류(moderation flag 등)는 seed를 바꿔 1회 더 시도한다", async () => {
    const env = makeEnv(makeAnalysis());
    const provider = providerOf([
      { ok: false, error: "FLUX 호출 실패: 3030: flagged", retryable: true },
      await goodFluxOutput(),
    ]);
    const sourcePhoto = await photoDataUrl();
    const result = await generateSkin(env, sourcePhoto, provider);
    expect(provider.calls).toBe(2);
    expect(provider.photoDataUrls[0]).toBe(sourcePhoto);
    expect(provider.photoDataUrls[1]).not.toBe(sourcePhoto);
    expect(result.body.generationMode).toBe("image");
    // 실패한 1회차는 과금 집계에서 제외(성공 응답을 받지 못함), 성공 1회차만 45
    expect(result.neuronsSpent).toBe(236);
  });

  it("feature flag가 꺼져 있으면 provider를 호출하지 않는다", async () => {
    const env = makeEnv(makeAnalysis(), false);
    const provider = providerOf([await goodFluxOutput()]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(provider.calls).toBe(0);
    expect(result.body.generationMode).toBe("procedural_fallback");
  });

  it("얼굴만 있는 사진(framing=face)도 실패 처리하지 않는다", async () => {
    const env = makeEnv(
      makeAnalysis({
        framing: "face",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: false,
          lowerBody: false,
          feet: false,
        },
      }),
    );
    const provider = providerOf([await goodFluxOutput()]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
  });

  it("quality=fail은 422 photo_rejected", async () => {
    const env = makeEnv({ quality: "fail", failReason: "no_face" });
    const provider = providerOf([await goodFluxOutput()]);
    const result = await generateSkin(env, await photoDataUrl(), provider);
    expect(result.status).toBe(422);
    expect(result.body.errorCode).toBe("photo_rejected");
    expect(provider.calls).toBe(0);
  });

  it("스키마 검증 실패는 502 (조용한 기본값 대체 없음)", async () => {
    const env = makeEnv({ quality: "pass", framing: "??" });
    const result = await generateSkin(env, await photoDataUrl());
    expect(result.status).toBe(502);
    expect(result.body.errorCode).toBe("ai_failed");
    expect(result.neuronsSpent).toBe(2 * 170);
    expect(env.MCSKIN_KV.put).toHaveBeenCalledWith(
      "diagnostic:last-analysis-failure",
      expect.stringContaining('"attempts":2'),
      { expirationTtl: 60 * 60 * 48 },
    );
  });

  it("Workers AI shared quota exhaustion returns quota_exceeded without fallback calls", async () => {
    const env = makeEnv(makeAnalysis());
    env.AI.run = vi.fn(async () => {
      throw new Error(
        "4006: you have used up your daily free allocation of 10,000 neurons",
      );
    }) as unknown as Env["AI"]["run"];

    const result = await generateSkin(env, await photoDataUrl());

    expect(result.status).toBe(429);
    expect(result.body.errorCode).toBe("quota_exceeded");
    expect(result.neuronsSpent).toBe(170);
    expect(env.AI.run).toHaveBeenCalledTimes(1);
  });

  it("data URL이 아니면 400", async () => {
    const env = makeEnv(makeAnalysis());
    const result = await generateSkin(env, "http://example.com/x.png");
    expect(result.status).toBe(400);
    expect(result.neuronsSpent).toBe(0);
  });
});
