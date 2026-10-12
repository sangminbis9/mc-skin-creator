import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildProceduralFallbackAtlas, generateSkin } from "../src/generate";
import { bytesToBase64, decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import type { SkinPlan } from "../src/skinPlan";
import type { FaceStyle } from "../src/skinPack";
import type { Env } from "../src/types";
import { makeAnalysis, makeSyntheticAtlas } from "./helpers";
import { wireFixture } from "./compactV3Support";

it("audits planned mouth ownership instead of assuming legacy mouth coordinates", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("offline_only"); });
  try {
    const root = mkdtempSync("evaluation-artifacts/current-028-mouth-coordinate-audit-20260928-");
    const records = [];
    for (const mouthOpening of ["closed", "teeth_visible"] as const) {
      const base = makeAnalysis();
      const a = makeAnalysis({ observed: { ...base.observed, face: mouthOpening === "closed"
        ? "A mature oval face with a soft closed-mouth smile."
        : "A mature round face with a broad smile showing visible teeth." },
      renderHints: { ...base.renderHints, mouthShape: "wide", mouthOpening },
      fallbackFeatures: { ...base.fallbackFeatures, glasses: "none", expression: "smile" } });
      const env = { WORKERS_VISION_MODEL: "test-multi-image-model",
        AI: { run: vi.fn(async () => ({ response: wireFixture(a) })) },
        MCSKIN_KV: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) },
        SYNCHRONOUS_ENHANCEMENTS_ENABLED: "true", IMAGE_GENERATION_ENABLED: "false", IMAGE_GEN_STRATEGY: "front_view" } as unknown as Env;
      const r = await generateSkin(env, `data:image/png;base64,${bytesToBase64(await encodePng(makeSyntheticAtlas(1)))}`);
      expect(r.status).toBe(200);
      const png = Uint8Array.from(atob(r.body.skinPngBase64 as string), c => c.charCodeAt(0));
      const raw = await decodePng(png);
      const plan = (r.body.analysis as { skinPlan: SkinPlan }).skinPlan;
      const cells = [];
      for (let y = 4; y < 8; y++) for (let x = 0; x < 8; x++) {
        const i = ((y + 8) * 64 + x + 8) * 4;
        cells.push({ x, y, roles: plan.facePixelPlan.pixels.filter(p => p.x === x && p.y === y).map(p => p.role),
          rgba: Array.from(raw.rgba.slice(i, i + 4)) });
      }
      expect(validateFinalAtlas(raw).ok).toBe(true);
      const oldSamples = cells.filter(c => c.x === 2 && (c.y === 5 || c.y === 6));
      expect(oldSamples).toHaveLength(2);
      expect(oldSamples.every(c => c.roles.length === 0)).toBe(true);
      expect(plan.facePixelPlan.pixels.filter(p => p.role === "teeth")).toHaveLength(mouthOpening === "closed" ? 0 : 2);
      records.push({ mouthOpening, facePixelPlan: plan.facePixelPlan, cells });
      writeFileSync(`${root}/${mouthOpening}.png`, png);
    }
    writeFileSync(`${root}/audit.json`, JSON.stringify({ providerCalls: 0, records }, null, 2));
    expect(network).not.toHaveBeenCalled();
  } finally { network.mockRestore(); }
});

it("retains current fixed-plan mouth authority across twelve frozen subjects", async () => {
  const subjects: { id: string; baselinePlan: SkinPlan; baselineStyle: FaceStyle; baselineFeatures: Record<string, unknown> }[] =
    JSON.parse(readFileSync("evaluation-artifacts/sclera-role-frozen-counterfactual-20260926-li8W2P/results.json", "utf8")).cases;
  const root = mkdtempSync("evaluation-artifacts/current-028-fixed-mouth-authority-20260928-");
  const cases = [];
  for (const s of subjects) {
    const base = buildProceduralFallbackAtlas(s.baselineFeatures, s.baselineStyle, s.baselinePlan)!;
    expect(base, s.id).not.toBeNull();
    const old = await decodePng(readFileSync(`evaluation-artifacts/planned-mouth-authority-20260926-0IpgoT/${s.id}.png`));
    const historicalDelta = [];
    for (let p = 0; p < 4096; p++) if ([0, 1, 2, 3].some(c => old.rgba[p * 4 + c] !== base.rgba[p * 4 + c])) {
      const x = p % 64, y = Math.floor(p / 64);
      historicalDelta.push({ x, y, roles: s.baselinePlan.facePixelPlan.pixels.filter(cell => cell.x + 8 === x && cell.y + 8 === y).map(cell => cell.role) });
    }
    const perturbations: Partial<FaceStyle>[] = [
      ...["small", "wide", "full", "thin"].map(mouthShape => ({ mouthShape: mouthShape as FaceStyle["mouthShape"] })),
      ...["closed", "slightly_open", "teeth_visible"].map(mouthOpening => ({ mouthOpening: mouthOpening as FaceStyle["mouthOpening"] })),
      ...["thin", "average", "full"].map(lipFullness => ({ lipFullness: lipFullness as FaceStyle["lipFullness"] })),
    ];
    for (const perturbation of perturbations) {
      const candidate = buildProceduralFallbackAtlas(s.baselineFeatures, { ...s.baselineStyle, ...perturbation }, s.baselinePlan)!;
      expect(candidate, s.id).not.toBeNull();
      expect(candidate.rgba, s.id).toEqual(base.rgba);
    }
    expect(validateFinalAtlas(base).ok).toBe(true);
    cases.push({ id: s.id, fixedPlanMouthPerturbations: perturbations.length, historicalDelta });
  }
  expect(cases).toHaveLength(12);
  writeFileSync(`${root}/audit.json`, JSON.stringify({ providerCalls: 0, cases }, null, 2));
}, 30_000);
