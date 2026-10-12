import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import type { PhotoAnalysis } from "../src/analysis";
import type { RawImage } from "../src/png";
import { strictBoundaryAnalysisFromAnnotation } from "./strictBoundaryFixtureSupport";
import type { AnnotatedCase } from "./generalizationSupport";

it("compares the HEAD ownership scan with the indexed engine on the same twelve frozen observations", async () => {
  const previous = execFileSync("git", ["show", "HEAD:workers/src/referenceHeadProportion.ts"], { encoding: "utf8" });
  type Pipeline = { render: (analysis: PhotoAnalysis) => RawImage };
  async function pipeline(old: boolean): Promise<Pipeline> {
    const entry = 'import {normalizeAnalysisForRendering,buildFaceStyle,buildProceduralSourceAtlas,fallbackFeaturesToHex,refineFeatureColorsFromAnalysis} from "./src/generate"; import {buildSkinPlan} from "./src/skinPlan"; import {renderSkinEngine} from "./src/skinEngine"; export function render(raw){const a=normalizeAnalysisForRendering(raw),p=buildSkinPlan(a),f=refineFeatureColorsFromAnalysis(a,fallbackFeaturesToHex(a.fallbackFeatures,a.renderHints.skinUndertone)),s=buildFaceStyle(a,f,p.hairPlan),b=buildProceduralSourceAtlas(f,s,p),r=renderSkinEngine(b,p,a,s);if(!r.ok)throw Error(r.reason);return r.atlas;}';
    const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd() }, platform: "node", format: "cjs", bundle: true, write: false,
      plugins: old ? [{ name: "prior-owned-scan", setup(b) { b.onLoad({ filter: /referenceHeadProportion\.ts$/ }, args =>
        ({ contents: previous, loader: "ts", resolveDir: args.path.slice(0, args.path.lastIndexOf("\\")) })); } }] : [] });
    const module = { exports: {} };
    new Function("module", "exports", "require", bundle.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
    return module.exports as Pipeline;
  }
  const [before, after] = await Promise.all([pipeline(true), pipeline(false)]);
  const cases: AnnotatedCase[] = JSON.parse(readFileSync("evaluation-artifacts/generalization-20260905/annotations.json", "utf8"));
  const rows = [], hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  before.render(strictBoundaryAnalysisFromAnnotation(cases[0]).analysis); after.render(strictBoundaryAnalysisFromAnnotation(cases[0]).analysis);
  for (const c of cases) {
    const a = strictBoundaryAnalysisFromAnnotation(c).analysis, times = { before: [] as number[], after: [] as number[] };
    let oldHash = "", newHash = "";
    for (let n = 0; n < 3; n++) for (const label of n % 2 ? ["after", "before"] as const : ["before", "after"] as const) {
      const start = performance.now(), atlas = (label === "before" ? before : after).render(a);
      times[label].push(performance.now()-start);
      if(label === "before") oldHash=hash(atlas.rgba); else newHash=hash(atlas.rgba);
    }
    expect(newHash, c.id).toBe(oldHash);
    const median = (ns: number[]) => ns.sort((a,b)=>a-b)[1];
    rows.push({ id: c.id, calibrated: !!c.existing, beforeMs: median(times.before), afterMs: median(times.after), oldHash, newHash });
  }
  const root = mkdtempSync("evaluation-artifacts/engine-comparison-20261013-");
  writeFileSync(`${root}/comparison.json`, JSON.stringify({ method: "interleaved 3-run local median, same observations; isolates ownership index optimization",
    unchangedOutputs: rows.length, providerCalls: 0, measuredInferenceLatency: null, measuredPhotoLikeness: null, rows }, null, 2), { flag: "wx" });
  console.info(`ENGINE_COMPARISON ${root}`);
}, 120000);
