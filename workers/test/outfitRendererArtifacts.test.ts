import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { PhotoAnalysis } from "../src/analysis";
import { buildOutfitPlan } from "../src/outfitIdentity";
import { measureOutfitIdentityRetention, measureOutfitPixelDifference, outfitConvergence, headUvIsByteIdentical } from "../src/outfitIdentityRetention";
import { applyOutfitPlan } from "../src/outfitRenderer";
import { decodePng } from "../src/png";
import { DEFAULT_FACE_STYLE, packFrontViewToAtlas } from "../src/skinPack";
import { makeAnalysis, makeFrontView } from "./helpers";
import { writeOutfitEvaluationArtifacts } from "./outfitEvaluationArtifacts";

const RUN = process.env.RUN_OUTFIT_ARTIFACTS === "1";
const OUTPUT = resolve(process.env.OUTFIT_ARTIFACT_DIR ?? "evaluation-artifacts/outfit-identity-20260905");
const SOURCE_ROOT = resolve("evaluation-artifacts/facial-feature-renderer-20260904");

interface RealOutfitCase {
  id: string;
  clothing: string;
  upperVisible: boolean;
  topType: string;
  topColor: string;
  accent: string;
  sleeve: string;
  bottomType: string;
  bottomColor: string;
  hints?: Partial<PhotoAnalysis["renderHints"]>;
}

const CASES: RealOutfitCase[] = [
  { id: "short-hair-red-shirt", clothing: "observed bright red crew-neck short-sleeve top with a small white shoulder strap detail", upperVisible: true, topType: "tshirt", topColor: "red", accent: "white", sleeve: "short", bottomType: "pants", bottomColor: "black" },
  { id: "glasses-monochrome", clothing: "no clothing is visible in the tight monochrome face crop; use a plain conservative neutral sweater", upperVisible: false, topType: "sweater", topColor: "gray", accent: "light-gray", sleeve: "long", bottomType: "pants", bottomColor: "black" },
  { id: "curly-hair", clothing: "observed light gray cable-knit crew-neck sweater with large connected vertical knit ribs", upperVisible: true, topType: "sweater", topColor: "light-gray", accent: "white", sleeve: "long", bottomType: "pants", bottomColor: "navy", hints: { garmentTexture: "knit", outerLayer: "light" } },
  { id: "headscarf-color-blocks", clothing: "observed dark charcoal outer garment below the dark gray patterned headscarf; torso clothing remains a broad dark block", upperVisible: true, topType: "coat", topColor: "gray", accent: "black", sleeve: "long", bottomType: "pants", bottomColor: "black", hints: { outerGarment: "coat", outerLayer: "heavy" } },
  { id: "long-straight-hair", clothing: "only bare shoulders and a very narrow dark sleeveless upper edge are visible; complete with a plain conservative dark tank", upperVisible: false, topType: "tank", topColor: "black", accent: "green", sleeve: "sleeveless", bottomType: "pants", bottomColor: "black" },
];

const CONTROLLED: RealOutfitCase[] = [
  { id: "controlled-a-solid-short", clothing: "solid red crew-neck short-sleeve shirt and black pants", upperVisible: true, topType: "tshirt", topColor: "red", accent: "white", sleeve: "short", bottomType: "pants", bottomColor: "black" },
  { id: "controlled-b-contrast-long", clothing: "blue shirt with long contrasting white raglan sleeves", upperVisible: true, topType: "shirt", topColor: "blue", accent: "white", sleeve: "long", bottomType: "pants", bottomColor: "navy" },
  { id: "controlled-c-open-jacket", clothing: "open black jacket over a white inner shirt", upperVisible: true, topType: "jacket", topColor: "black", accent: "white", sleeve: "long", bottomType: "jeans", bottomColor: "denim", hints: { outerGarment: "open_jacket", outerLayer: "heavy" } },
  { id: "controlled-d-horizontal-stripe", clothing: "green and yellow horizontal striped short-sleeve shirt", upperVisible: true, topType: "shirt", topColor: "green", accent: "yellow", sleeve: "short", bottomType: "pants", bottomColor: "brown", hints: { garmentTexture: "striped" } },
  { id: "controlled-e-dress", clothing: "purple v-neck dress continuing into a pleated skirt", upperVisible: true, topType: "dress", topColor: "purple", accent: "pink", sleeve: "short", bottomType: "skirt", bottomColor: "purple", hints: { bottomPattern: "pleated" } },
  { id: "controlled-f-shorts", clothing: "yellow sleeveless top with blue shorts and bare legs", upperVisible: true, topType: "tank", topColor: "yellow", accent: "white", sleeve: "sleeveless", bottomType: "shorts", bottomColor: "blue" },
  { id: "controlled-g-crossbody", clothing: "cream long-sleeve sweater with a dark crossbody bag strap", upperVisible: true, topType: "sweater", topColor: "cream", accent: "brown", sleeve: "long", bottomType: "pants", bottomColor: "brown" },
  { id: "controlled-h-center-graphic", clothing: "orange crew-neck short-sleeve shirt with a large blue center graphic", upperVisible: true, topType: "tshirt", topColor: "orange", accent: "blue", sleeve: "short", bottomType: "jeans", bottomColor: "denim" },
];

function analysisFor(item: RealOutfitCase): PhotoAnalysis {
  const base = makeAnalysis();
  return makeAnalysis({
    framing: item.upperVisible ? "upper_body" : "face",
    visibleRegions: { ...base.visibleRegions, upperBody: item.upperVisible, lowerBody: false, feet: false },
    observed: { ...base.observed, clothing: item.clothing, accessories: item.clothing, colorPalette: [item.topColor, item.accent, item.bottomColor] },
    inferred: {
      ...base.inferred,
      upperBody: item.upperVisible ? null : { value: item.clothing, rationale: "minimum-invention completion because the source crop does not show a full garment" },
      lowerBody: { value: `plain ${item.bottomColor} ${item.bottomType}`, rationale: "unseen lower body continues visible formality without a new pattern or accessory" },
      shoes: { value: "plain dark low shoes", rationale: "feet are unseen; preserve a neutral low-salience completion" },
    },
    renderHints: { ...base.renderHints, garmentTexture: "plain", outerLayer: "none", outerGarment: "none", bottomPattern: "plain", bottomAccent: "none", ...item.hints },
    fallbackFeatures: {
      ...base.fallbackFeatures,
      topType: item.topType,
      topColor: item.topColor,
      topAccentColor: item.accent,
      sleeveLength: item.sleeve,
      bottomType: item.bottomType,
      bottomColor: item.bottomColor,
      shoesColor: "black",
    },
    outfitPrompt: item.clothing,
  });
}

describe.skipIf(!RUN)("real-photo OutfitPlan artifact suite", () => {
  it("writes five source/body artifact sets without changing head bytes", async () => {
    const plans = [];
    const atlases = [];
    const summary: Record<string, unknown> = {};
    for (const item of CASES) {
      const source = await decodePng(new Uint8Array(await readFile(resolve(SOURCE_ROOT, item.id, "01-source.png"))));
      const before = await decodePng(new Uint8Array(await readFile(resolve(SOURCE_ROOT, item.id, "13-final-skin.png"))));
      const after = { ...before, rgba: before.rgba.slice() };
      const analysis = analysisFor(item);
      const plan = buildOutfitPlan(analysis);
      applyOutfitPlan(after, plan, "#d39e80");
      const retention = measureOutfitIdentityRetention(plan, after);
      const difference = measureOutfitPixelDifference(before, after);
      const metrics = {
        case: item.id,
        sourceAudit: { clothing: item.clothing, upperVisible: item.upperVisible, lowerVisible: false, feetVisible: false },
        outfitPlan: plan,
        retention,
        pixelDifference: difference,
        headByteIdentical: headUvIsByteIdentical(before, after),
        apiUsage: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactions: 0 },
      };
      await writeOutfitEvaluationArtifacts(OUTPUT, item.id, { source, before, after, plan, metrics });
      expect(metrics.headByteIdentical, item.id).toBe(true);
      expect(difference.torso + difference.arms + difference.legs, item.id).toBeGreaterThan(0);
      plans.push(plan);
      atlases.push(after);
      summary[item.id] = metrics;
    }
    const convergence = outfitConvergence(plans, atlases);
    expect(convergence.unique).toBe(CASES.length);
    expect(convergence.pairCollisions).toBe(0);
    await writeFile(resolve(OUTPUT, "summary.json"), JSON.stringify({ cases: summary, convergence, apiUsage: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactions: 0 } }, null, 2), "utf8");
  });

  it("writes all eight controlled garment grammar artifacts", async () => {
    const source = makeFrontView();
    const neutral = packFrontViewToAtlas(source, { ...DEFAULT_FACE_STYLE, hairstyle: "short", hairColor: "#392b24", skinTone: "#d39e80" })!.atlas;
    const plans = [];
    const atlases = [];
    for (const item of CONTROLLED) {
      const plan = buildOutfitPlan(analysisFor(item));
      const after = { ...neutral, rgba: neutral.rgba.slice() };
      applyOutfitPlan(after, plan, "#d39e80");
      const metrics = {
        case: item.id,
        outfitPlan: plan,
        retention: measureOutfitIdentityRetention(plan, after),
        pixelDifference: measureOutfitPixelDifference(neutral, after),
        headByteIdentical: headUvIsByteIdentical(neutral, after),
        apiUsage: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactions: 0 },
      };
      await writeOutfitEvaluationArtifacts(OUTPUT, item.id, { source, before: neutral, after, plan, metrics });
      plans.push(plan);
      atlases.push(after);
    }
    const beforeConvergence = outfitConvergence(plans, plans.map(() => neutral));
    const convergence = outfitConvergence(plans, atlases);
    expect(beforeConvergence).toMatchObject({ unique: 1, total: 8, pairCollisions: 28, pairCount: 28, rate: 1 });
    expect(convergence).toMatchObject({ unique: 8, total: 8, pairCollisions: 0, pairCount: 28, rate: 0 });
    await writeFile(resolve(OUTPUT, "controlled-summary.json"), JSON.stringify({ beforeConvergence, convergence, apiUsage: { geminiGeometry: 0, absoluteEvaluator: 0, pairwiseEvaluator: 0, interactions: 0 } }, null, 2), "utf8");
  });
});
