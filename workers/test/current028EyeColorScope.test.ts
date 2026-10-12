import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { makeAnalysis } from "./helpers";
import { buildProceduralFallbackAtlas, fallbackFeaturesToHex, refineFeatureColorsFromAnalysis } from "../src/generate";
import { decodePng, encodePng } from "../src/png";
import { validateAtlasCraft, validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
const root = "evaluation-artifacts/current-default-v3-e2e-baseline-20260928-028";
const live = JSON.parse(readFileSync(`${root}/summary.json`, "utf8")).currentDefaultE2E.result;
const baseline = JSON.parse(readFileSync("evaluation-artifacts/current-028-live-verification-20260928-NKL61L/verification.json", "utf8"));
function input() {
  return makeAnalysis({ ...structuredClone(live.diagnostics.normalizedPrimary),
    // The original free-text identityPrompt was not persisted. Omit it;
    // this proves an independent reproducible cause in stored canonical cues.
    identityPrompt: "", outfitPrompt: "", negativePrompt: "" });
}
function eye(a = input()) { return refineFeatureColorsFromAnalysis(a, fallbackFeaturesToHex(a.fallbackFeatures)).eyeColor; }
it("does not join actual eye and shirt mustPreserve entries into invented blue eyes", () => {
  const a = input();
  expect(a.fallbackFeatures.eyeColor).toBe("dark-brown");
  expect(live.features.eyeColor).toBe("#4a7fae");
  expect(a.canonicalIdentity.mustPreserve.slice(-2)).toEqual(["Dark, deep-set eyes", "Blue and tan plaid patterned shirt"]);
  expect(eye(a)).toBe(fallbackFeaturesToHex(a.fallbackFeatures).eyeColor);
});
it.each(["blue", "green", "gray"])("keeps field ownership when a separate garment starts with %s", color => {
  const a = input(); a.canonicalIdentity.overallImpression = ""; a.canonicalIdentity.features = [];
  a.canonicalIdentity.mustPreserve = ["Dark eyes", `${color} shirt`];
  expect(eye(a)).toBe(fallbackFeaturesToHex(a.fallbackFeatures).eyeColor);
});
it.each(["overall", "feature", "evidence"])("preserves %s boundaries instead of treating adjoining color as ocular", field => {
  const a = input(); a.canonicalIdentity.mustPreserve = []; a.canonicalIdentity.features = [];
  a.canonicalIdentity.overallImpression = field === "overall" ? "Dark eyes" : "";
  if (field === "overall") a.canonicalIdentity.mustPreserve = ["Blue shirt"];
  else a.canonicalIdentity.features = [{ category: "face", feature: "Dark eyes", evidence: field === "feature" ? "Blue shirt" : "visible eyes",
    priority: 5, confidence: "high", targetRegions: ["face.front"] },
    { category: "outfit", feature: "Blue shirt", evidence: "Visible shirt", priority: 3, confidence: "high", targetRegions: ["torso.front"] }];
  expect(eye(a)).toBe(fallbackFeaturesToHex(a.fallbackFeatures).eyeColor);
});
it.each(["face", "identity", "overall", "preserve", "feature", "evidence"])("retains explicit same-field blue-eye evidence in %s", field => {
  const a = input(); a.canonicalIdentity.mustPreserve = []; a.canonicalIdentity.features = [];
  a.canonicalIdentity.overallImpression = "";
  if (field === "face") a.observed.face = "Clearly visible blue eyes";
  if (field === "identity") a.identityPrompt = "Clearly visible blue eyes";
  if (field === "overall") a.canonicalIdentity.overallImpression = "Clearly visible blue eyes";
  if (field === "preserve") a.canonicalIdentity.mustPreserve = ["Clearly visible blue eyes"];
  if (field === "feature" || field === "evidence") a.canonicalIdentity.features = [{ category: "face",
    feature: field === "feature" ? "Clearly visible blue eyes" : "Eye color",
    evidence: field === "evidence" ? "Clearly visible blue eyes" : "Visible iris",
    priority: 5, confidence: "high", targetRegions: ["face.front"] }];
  expect(eye(a)).toBe("#4a7fae");
});
it("leaves the separately failing closed-smile fixture's eye-color evidence unchanged", () => {
  const base = makeAnalysis();
  for (const face of ["A mature oval face with a soft closed-mouth smile.", "A mature round face with a broad smile showing visible teeth."]) {
    const a = makeAnalysis({ observed: { ...base.observed, face } });
    // No legacy candidate matches any old color/eye relation; mention of
    // spectacle frames around eyes alone cannot change this mouth case.
    const legacy = [a.observed.face, a.identityPrompt,
      [a.canonicalIdentity.overallImpression, ...a.canonicalIdentity.mustPreserve].join(" "),
      a.canonicalIdentity.features.flatMap(f => [f.feature, f.evidence]).join(" ")];
    for (const text of legacy) for (const cue of ["dark[- ]brown", "light[- ]brown|brown", "hazel", "green", "blue", "gr[ae]y", "black"]) {
      const bridge = "(?:\\s+[a-z-]+){0,2}\\s+";
      expect(text.toLowerCase()).not.toMatch(new RegExp(`\\b(?:${cue})${bridge}eyes?\\b|\\beyes?${bridge}(?:${cue})\\b`));
    }
    expect(eye(a)).toBe(fallbackFeaturesToHex(a.fallbackFeatures).eyeColor);
  }
});
it("replays only the evidenced eye-color correction from actual 028 PNG", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const plan = live.analysis.skinPlan, style = { ...baseline.style, eyeColor: eye() };
    expect(style.eyeColor).not.toBe(baseline.style.eyeColor);
    const before = await decodePng(readFileSync(`${root}/skin.png`));
    expect(buildProceduralFallbackAtlas(live.features, baseline.style, plan)!.rgba).toEqual(before.rgba);
    const after = buildProceduralFallbackAtlas({ ...live.features, eyeColor: style.eyeColor }, style, plan)!;
    const changed = [];
    for (let p = 0; p < 4096; p++) {
      expect(after.rgba[p * 4 + 3]).toBe(before.rgba[p * 4 + 3]);
      if ([0, 1, 2].some(c => after.rgba[p * 4 + c] !== before.rgba[p * 4 + c])) {
        const x = p % 64, y = Math.floor(p / 64);
        expect(plan.facePixelPlan.pixels.some((cell: { x: number; y: number; role: string }) =>
          cell.x + 8 === x && cell.y + 8 === y && cell.role === "iris")).toBe(true);
        changed.push({ x, y });
      }
    }
    expect(changed.length).toBeGreaterThan(0);
    const craft = validateAtlasCraft(after, style, undefined, undefined, plan);
    expect(craft.ok).toBe(true); expect(validateFinalAtlas(after).ok).toBe(true);
    const out = mkdtempSync("evaluation-artifacts/current-028-eye-scope-offline-20260928-");
    for (const [name, atlas] of [["before", before], ["after", after]] as const) {
      writeFileSync(`${out}/${name}.png`, await encodePng(atlas), { flag: "wx" });
      const view = renderSkinViews(atlas).find(v => v.name === "front_left_three_quarter")!;
      writeFileSync(`${out}/${name}-preview.png`, await encodePng(scaleNearestNeighbor(view.image, view.image.width * 5, view.image.height * 5)), { flag: "wx" });
    }
    writeFileSync(`${out}/results.json`, JSON.stringify({ providerCalls: 0, originalCategory: input().fallbackFeatures.eyeColor,
      actualColor: baseline.style.eyeColor, correctedColor: style.eyeColor, changed, craft,
      bodyDiff: 0, alphaDiff: 0, hairDiff: 0, geometryDiff: 0,
      afterRgbaSha256: createHash("sha256").update(after.rgba).digest("hex"),
      limitation: "Offline field-boundary correction. Original identityPrompt was not saved; independent canonical cross-entry contamination reproduced without it. Not new live evidence." }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info(`EYE_SCOPE_028 ${out}`);
  } finally { network.mockRestore(); }
}, 30_000);
