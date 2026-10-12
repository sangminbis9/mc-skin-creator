import { describe, expect, it } from "vitest";
import { buildReferenceStylePlan, FACE_STYLE_TEMPLATES, HAIR_STYLE_TEMPLATES, OUTFIT_STYLE_TEMPLATES } from "../src/referenceStyleTemplates";
import { validateReferenceStyleSurfaces, type StyledSurfaceCell } from "../src/referenceStyleConstraints";
import { CLASSIC_LAYOUT, type BodyPart } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

function source(hair: string, clothing = "plain gray top") {
  const a = makeAnalysis();
  a.observed.hair = hair; a.observed.clothing = clothing;
  a.observed.face = "ordinary face"; a.observed.accessories = "none";
  a.canonicalIdentity.features = [];
  a.renderHints.faceShape = "angular"; a.renderHints.eyeShape = "almond";
  a.renderHints.overallHairLength = "ear";
  return a;
}

describe("reference style vocabulary and source-gated selection", () => {
  it("defines six eye-led face families, nine hair families and eight garment families", () => {
    expect(Object.keys(FACE_STYLE_TEMPLATES)).toHaveLength(6);
    expect(Object.keys(HAIR_STYLE_TEMPLATES)).toHaveLength(9);
    expect(Object.keys(OUTFIT_STYLE_TEMPLATES)).toHaveLength(8);
    for (const [family, f] of Object.entries(FACE_STYLE_TEMPLATES)) {
      expect(f.noseCells).toBeLessThanOrEqual(1); expect(f.mouthCells).toBe(["clean_masculine_soft", "soft_feminine_calm"].includes(family) ? 0 : 2);
      expect(f.complexionContrast).toBeLessThanOrEqual(0.1);
    }
    for (const h of Object.values(HAIR_STYLE_TEMPLATES)) expect(h.outerHairRatio).toBeLessThanOrEqual(0.3);
    for (const o of Object.values(OUTFIT_STYLE_TEMPLATES)) expect(o.patternPolicy).toBe("observed_only");
  });
  it.each([
    ["short shaggy hair", "ear", "straight", "staggered", "short_shaggy_masculine"],
    ["short smooth hair", "ear", "straight", "wispy", "short_soft_feminine"],
    ["jaw length layered hair", "jaw", "straight", "wispy", "medium_layered"],
    ["long straight hair with bangs", "chest", "straight", "wispy", "long_straight_with_bangs"],
    ["long wavy hair with bangs", "chest", "wavy", "wispy", "long_wavy_with_bangs"],
    ["two long braids", "chest", "straight", "wispy", "twin_braids"],
    ["pink twin tails", "chest", "straight", "wispy", "twin_tails"],
    ["long pastel pink straight hair", "chest", "straight", "wispy", "long_pastel_straight"],
  ] as const)("selects %s without an identity/fixture key", (hair, length, texture, edge, family) => {
    const a = source(hair); a.renderHints.overallHairLength = length;
    a.renderHints.hairTexture = texture; a.renderHints.fringeEdge = edge;
    expect(buildReferenceStylePlan(a).hair.family).toBe(family);
  });
  it("preserves real covering and curl/bun/buzz topology rather than forcing a loose style", () => {
    for (const hair of ["short buzz cut", "curly coily hair", "bald scalp", "hair in a bun", "hair under a headscarf"]) {
      expect(buildReferenceStylePlan(source(hair)).hair.family, hair).toBe("preserve_existing");
    }
    const a = source("long straight hair", "pastel mint hoodie with the hood worn over the head");
    a.renderHints.overallHairLength = "chest";
    expect(buildReferenceStylePlan(a).hair.family).toBe("hoodie_beanie_compatible");
  });
  it.each(["black hoodie", "pastel mint hooded sweatshirt", "black hoodie with the hood down",
    "hoodie with a hood resting on the shoulders", "hoodie with a possibly raised hood",
    "hoodie with a graphic of a hood worn over the head"])("does not suppress source hair from clothing alone: %s", clothing => {
    const a = source("short staggered hair", clothing); a.renderHints.fringeEdge = "staggered";
    expect(buildReferenceStylePlan(a).hair.family).toBe("short_shaggy_masculine");
    expect(buildReferenceStylePlan(a).candidates.hair.some(c => c.family === "hoodie_beanie_compatible")).toBe(false);
  });
  it.each(["black hoodie with the hood up", "black hoodie with the hood worn over the head",
    "gray coat; hood pulled over the head"])("retains an explicitly worn hood candidate: %s", clothing => {
    expect(buildReferenceStylePlan(source("short hair", clothing)).hair.family).toBe("hoodie_beanie_compatible");
  });
  it.each(["wearing a beanie", "a knit cap on the head"])("retains positive headwear evidence: %s", accessories => {
    const a = source("short hair"); a.observed.accessories = accessories;
    expect(buildReferenceStylePlan(a).hair.family).toBe("hoodie_beanie_compatible");
  });
  it.each(["ear", "jaw", "chest"] as const)("keeps %s hair candidates independent of an unworn hoodie", length => {
    const a = source("straight loose hair", "black shirt"); a.renderHints.overallHairLength = length;
    const original = buildReferenceStylePlan(a).candidates.hair;
    a.observed.clothing = "black hoodie with the hood down";
    expect(buildReferenceStylePlan(a).candidates.hair).toEqual(original);
  });
  it.each(["no beanie", "possibly a beanie", "beanie held in a hand", "a picture of a knit cap"])("does not promote uncertain or unworn headwear: %s", accessories => {
    const a = source("short hair"); a.observed.accessories = accessories;
    expect(buildReferenceStylePlan(a).hair.family).not.toBe("hoodie_beanie_compatible");
  });
  it.each([
    ["brown knit cardigan", "casual_knit_cardigan"],
    ["plain black sweatshirt", "clean_sweatshirt_casual"],
    ["pastel lavender blouse", "pastel_cute_top"],
    ["white ribbon top and gray skirt", "ribbon_top_skirt"],
    ["school uniform with cardigan", "school_cardigan_uniform"],
    ["dark black hoodie", "dark_hoodie_streetwear"],
    ["black sweater with floral sleeve motif", "black_floral_streetwear"],
    ["pastel pink hoodie", "pastel_hoodie_streetwear"],
  ] as const)("selects outfit from %s", (clothing, family) => {
    expect(buildReferenceStylePlan(source("short hair", clothing)).outfit.family).toBe(family);
  });
  it.each([
    ["ordinary", "plain gray top", "cool_androgynous"],
    ["round", "plain gray top", "soft_feminine_calm"],
    ["large round eyes", "plain gray top", "soft_feminine_doll"],
    ["ordinary", "pastel pink top", "cute_pastel"],
    ["clean-shaven smooth complexion", "plain gray top", "clean_masculine_soft"],
    ["ordinary", "black top", "dark_stylish"],
  ] as const)("selects aesthetic family %s, not a demographic label", (face, clothing, family) => {
    const a = source("short hair", clothing); a.observed.face = face;
    if (face === "round") a.renderHints.faceShape = "round";
    if (face === "large round eyes") { a.renderHints.eyeShape = "round"; a.renderHints.eyeSize = "large"; }
    expect(buildReferenceStylePlan(a).face.family).toBe(family);
  });
  it("does not borrow floral/braid/pastel claims from inferred or wrong-category prose", () => {
    const a = source("short hair");
    a.inferred.hairBack.value = "pink twin braids";
    a.inferred.upperBody = { value: "black floral blouse", rationale: "design completion" };
    a.canonicalIdentity.features = [{ feature: "black floral top and twin braids", evidence: "unrelated category", category: "face", confidence: "high", priority: 5, targetRegions: ["head.front"] }];
    const plan = buildReferenceStylePlan(a);
    expect(plan.outfit.family).toBe("preserve_existing");
    expect(plan.hair.family).not.toBe("twin_braids");
    expect(plan.hair.family).not.toBe("long_pastel_straight");
  });
  it("rejects negative and low-confidence special identity claims", () => {
    const a = source("no twin braids; short straight hair", "no floral print; black shirt");
    a.canonicalIdentity.features = [{ feature: "pink twin tails", evidence: "uncertain", category: "hair", confidence: "low", priority: 5, targetRegions: ["head.front"] }];
    const plan = buildReferenceStylePlan(a);
    expect(plan.hair.family).not.toBe("twin_braids"); expect(plan.hair.family).not.toBe("twin_tails");
    expect(plan.outfit.family).toBe("preserve_existing");
  });
  it("needs explicit long-hair drape evidence, not merely long length", () => {
    const a = source("long straight hair"); a.renderHints.overallHairLength = "chest";
    expect(buildReferenceStylePlan(a).drape.eligible).toBe(false);
    a.observed.hair = "long straight hair drapes over shoulders";
    expect(buildReferenceStylePlan(a).drape).toEqual({ eligible: true, evidence: ["observed long hair drapes over shoulder"], maxShoulderColumns: 1 });
    a.renderHints.overallHairLength = "ear";
    expect(buildReferenceStylePlan(a).drape.eligible).toBe(false);
  });
  it("never styles hidden hair or authorizes shoulder drape from a hidden region", () => {
    const a = source("long straight hair drapes over shoulders");
    a.renderHints.overallHairLength = "chest"; a.visibleRegions.hair = false;
    expect(buildReferenceStylePlan(a).hair.family).toBe("preserve_existing");
    expect(buildReferenceStylePlan(a).drape.eligible).toBe(false);
  });
  it.each(["two long braids", "long twin tails"])("does not select hidden %s from stale descriptive text", hair => {
    const a = source(hair); a.visibleRegions.hair = false;
    expect(buildReferenceStylePlan(a).candidates.hair.map(c => c.family)).toEqual(["preserve_existing"]);
  });
  it("is deterministic, bounded and leaves all original source/geometry data untouched", () => {
    const a = makeAnalysis(); const before = JSON.stringify(a);
    const first = buildReferenceStylePlan(a), second = buildReferenceStylePlan(a);
    expect(first).toEqual(second); expect(JSON.stringify(a)).toBe(before);
    for (const c of Object.values(first.candidates)) expect(c.length).toBeLessThanOrEqual(3);
    expect(first.provenance).toBe("template_design");
    expect(first.preserve).toContain("eye_geometry");
    expect(first.preserve).toContain("facial_hair");
  });
});

describe("ownership-aware style guard contract", () => {
  const style = buildReferenceStylePlan(source("short hair"));
  const shoulder: StyledSurfaceCell = { part: "leftArm", face: "front", layer: "overlay", x: 0, y: 0, owner: "hair" };
  it("rejects hair in upper shoulder but keeps same-color garment and accessory cells", () => {
    expect(validateReferenceStyleSurfaces([shoulder], style).violations).toContain("hair_in_outer_upper_shoulder_zone");
    expect(validateReferenceStyleSurfaces([{ ...shoulder, owner: "garment" }], style).ok).toBe(true);
    expect(validateReferenceStyleSurfaces([{ ...shoulder, owner: "accessory" }], style).ok).toBe(true);
  });
  it("permits only a narrow source-supported named drape; rejects top-plane hair", () => {
    const a = source("long hair drapes over shoulders"); a.renderHints.overallHairLength = "chest";
    const plan = buildReferenceStylePlan(a);
    const base: StyledSurfaceCell = { ...shoulder, part: "head", layer: "base", x: 7, y: 7, drapeGroup: "left_lock" };
    const connection: StyledSurfaceCell = { ...shoulder, part: "body", layer: "base", x: 7, drapeGroup: "left_lock" };
    expect(validateReferenceStyleSurfaces([base, connection, { ...shoulder, drapeGroup: "left_lock" }], plan).ok).toBe(true);
    expect(validateReferenceStyleSurfaces([base, { ...shoulder, drapeGroup: "left_lock" }], plan).violations).toContain("hair_drape_disconnected");
    expect(validateReferenceStyleSurfaces([base, { ...shoulder, drapeGroup: "left_lock", face: "top" }], plan).violations).toContain("hair_in_outer_upper_shoulder_zone");
    expect(validateReferenceStyleSurfaces([base, { ...shoulder, drapeGroup: "left_lock" }, { ...shoulder, drapeGroup: "left_lock", x: 1 }], plan).violations).toContain("hair_drape_too_wide");
  });
  it("rejects a detached lower body lock even if its group name matches a real origin", () => {
    const a = source("long hair drapes over shoulders"); a.renderHints.overallHairLength = "chest";
    const origin: StyledSurfaceCell = { part: "head", face: "front", layer: "base", x: 0, y: 7, owner: "hair", drapeGroup: "lock" };
    const detached: StyledSurfaceCell = { ...origin, part: "body", y: 3 };
    expect(validateReferenceStyleSurfaces([origin, detached], buildReferenceStylePlan(a)).violations).toContain("hair_drape_disconnected");
    const chain = [0, 1, 2, 3].map(y => ({ ...detached, y }));
    expect(validateReferenceStyleSurfaces([origin, ...chain], buildReferenceStylePlan(a)).ok).toBe(true);
    expect(validateReferenceStyleSurfaces([{ ...origin, layer: "overlay" }, ...chain], buildReferenceStylePlan(a)).violations).toContain("hair_drape_disconnected");
    expect(validateReferenceStyleSurfaces([origin, ...chain.map(c => ({ ...c, drapeGroup: "other" }))], buildReferenceStylePlan(a)).violations).toContain("hair_drape_disconnected");
  });
  it.each(Object.keys(CLASSIC_LAYOUT) as BodyPart[])("rejects a fully stuffed %s outer layer", part => {
    const cells: StyledSurfaceCell[] = [];
    for (const [face, rect] of Object.entries(CLASSIC_LAYOUT[part].overlay)) {
      for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) cells.push({ part, face: face as StyledSurfaceCell["face"], layer: "overlay", x, y, owner: "garment" });
    }
    const result = validateReferenceStyleSurfaces(cells, style);
    expect(result.outerCoverage[part]).toBe(1); expect(result.violations).toContain(`outer_coverage:${part}`);
  });
  it("counts unique cells; rejects conflicting ownership, bad coordinates and outer-first hair", () => {
    const c: StyledSurfaceCell = { part: "head", face: "front", layer: "base", x: 0, y: 0, owner: "hair" };
    expect(validateReferenceStyleSurfaces([c, c], style).baseHairCells).toBe(1);
    expect(validateReferenceStyleSurfaces([c, { ...c, owner: "face" }], style).violations).toContain("ownership_conflict");
    expect(validateReferenceStyleSurfaces([{ ...c, x: 8 }], style).violations).toContain("surface_coordinate_invalid");
    expect(validateReferenceStyleSurfaces([{ ...c, layer: "overlay" }], style).violations).toContain("hair_not_inner_first");
  });
});
