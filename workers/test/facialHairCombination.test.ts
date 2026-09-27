import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { buildFaceStyle, buildProceduralFallbackAtlas, fallbackFeaturesToHex, normalizeAnalysisForRendering, refineFeatureColorsFromAnalysis } from "../src/generate";
import { buildSkinPlan } from "../src/skinPlan";
import { decodePng, encodePng } from "../src/png";
import { validateFinalAtlas, validateAtlasCraft } from "../src/skinPost";
import { extractRenderedHeadView, renderSkinViews, scaleNearestNeighbor } from "../src/skinRender";
import { CLASSIC_LAYOUT } from "../src/uvLayout";
import { makeAnalysis } from "./helpers";

const liveRoot = "evaluation-artifacts/current-default-v3-e2e-baseline-20260926-004";
const snapshotBytes = readFileSync(`${liveRoot}/summary.json.checkpoint-000029.json`);
const record = JSON.parse(snapshotBytes.toString("utf8"));
const live = record.snapshot.currentDefaultE2E;
const observed = live.result.diagnostics.normalizedPrimary;
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
let root: string;
let network: ReturnType<typeof vi.spyOn>;
const metrics: Record<string, unknown> = { providerCalls: 0, mode: "offline_component_replay_not_new_live_output" };
beforeAll(() => {
  network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  root = mkdtempSync("evaluation-artifacts/facial-hair-combination-20260926-");
  console.info(`FRESH_COMBINATION_ROOT=${root}`);
});
afterAll(() => {
  expect(network).not.toHaveBeenCalled(); network.mockRestore();
  expect(readFileSync(`${liveRoot}/summary.json.checkpoint-000029.json`)).toEqual(snapshotBytes);
  writeFileSync(path.join(root, "results.json"), JSON.stringify(metrics, null, 2), { flag: "wx" });
});

it("verifies actual -004 PNG, live category propagation and saved combined source evidence", async () => {
  expect(sha(JSON.stringify(record.snapshot))).toBe(record.snapshotSha256);
  expect(live.httpStatus).toBe(200);
  expect(observed.fallbackFeatures.facialHair).toBe("goatee");
  expect(live.result.features.facialHair).toBe("goatee");
  expect(observed.observed.face).toMatch(/goatee and mustache/i);
  expect(observed.canonicalIdentity.mustPreserve.join(" ")).toMatch(/goatee and mustache/i);
  const png = readFileSync(`${liveRoot}/skin.png`);
  expect(sha(png)).toBe(live.png.sha256);
  const atlas = await decodePng(png);
  expect(validateFinalAtlas(atlas).ok).toBe(true);
  const head = extractRenderedHeadView(renderSkinViews(atlas).find(v => v.name === "front")!);
  writeFileSync(path.join(root, "actual-004-head.png"), await encodePng(scaleNearestNeighbor(head, 192, 192)), { flag: "wx" });
  metrics.live = { snapshotSha256: record.snapshotSha256, pngSha256: sha(png), category: "goatee", finalAtlas: true };
});

function fixture(face: string, preserve: string[]) {
  const base = makeAnalysis();
  return makeAnalysis({ observed: { ...base.observed, face, accessories: "none" },
    canonicalIdentity: { ...base.canonicalIdentity, mustPreserve: preserve },
    fallbackFeatures: { ...base.fallbackFeatures, facialHair: "goatee", glasses: "none", expression: "neutral" },
    renderHints: { ...base.renderHints, mouthOpening: "closed", mouthShape: "small" } });
}

it("preserves the explicitly observed mustache component instead of collapsing it into chin-only goatee", () => {
  const analysis = fixture(observed.observed.face, observed.canonicalIdentity.mustPreserve);
  const style = buildFaceStyle(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  expect(style).toMatchObject({ facialHair: "goatee", goateeHasMustache: true });
});

it.each([
  ["Trimmed goatee", ["Trimmed goatee"]],
  ["Goatee without a mustache", ["Goatee without a mustache"]],
  ["Possibly a goatee and mustache", ["Goatee and mustache"]],
  ["Goatee and mustache", ["Goatee", "No mustache"]],
  ["Goatee and mustache", ["Goatee"]],
] as const)("does not invent a mustache from %s", (face, preserve) => {
  const analysis = fixture(face, [...preserve]);
  expect(buildFaceStyle(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, "neutral")))
    .not.toHaveProperty("goateeHasMustache", true);
});

it.each(["#eec2a4", "#b57e5b", "#57392b"])("renders only the observed component on %s, preserving identity and body", async skin => {
  const input = fixture(observed.observed.face, observed.canonicalIdentity.mustPreserve);
  input.fallbackFeatures.skinTone = skin;
  const analysis = normalizeAnalysisForRendering(input);
  const features = refineFeatureColorsFromAnalysis(analysis, fallbackFeaturesToHex(analysis.fallbackFeatures, analysis.renderHints.skinUndertone));
  const style = buildFaceStyle(analysis, features);
  expect(style).toHaveProperty("goateeHasMustache", true);
  const plan = buildSkinPlan(analysis);
  const before = buildProceduralFallbackAtlas(features, { ...style, goateeHasMustache: false }, plan)!;
  const after = buildProceduralFallbackAtlas(features, style, plan)!;
  expect(before).not.toBeNull(); expect(after).not.toBeNull();
  expect(validateFinalAtlas(after).ok).toBe(true);
  expect(validateAtlasCraft(after, style, undefined, undefined, plan).ok).toBe(true);
  const changed = [];
  for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => before.rgba[p * 4 + c] !== after.rgba[p * 4 + c])) changed.push({ x: p % 64, y: Math.floor(p / 64) });
  expect(changed.length).toBeGreaterThan(0);
  const front = CLASSIC_LAYOUT.head.base.front;
  expect(changed.every(p => p.y === front.y + 5 && [front.x + 2, front.x + 5].includes(p.x))).toBe(true);
  for (const pixel of plan.facePixelPlan.pixels.filter(p => /eye|brow|mouth/.test(p.cluster))) {
    const at = ((front.y + pixel.y) * 64 + front.x + pixel.x) * 4;
    expect(after.rgba.slice(at, at + 4)).toEqual(before.rgba.slice(at, at + 4));
  }
  expect(buildProceduralFallbackAtlas(features, style, plan)).toEqual(after);
  for (const [name, atlas] of [["before", before], ["after", after]] as const) {
    const head = extractRenderedHeadView(renderSkinViews(atlas).find(v => v.name === "front")!);
    writeFileSync(path.join(root, `${skin.slice(1)}-${name}.png`), await encodePng(scaleNearestNeighbor(head, 192, 192)), { flag: "wx" });
  }
  ((metrics.replays ??= []) as unknown[]).push({ skin, changed, finalAtlas: true, craft: true, identityPixelsChanged: 0, bodyPixelsChanged: 0 });
});
