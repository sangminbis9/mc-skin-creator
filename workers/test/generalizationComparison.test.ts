/** Post-hoc report only: reads frozen before/after artifacts, never replays baseline. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { describe, it, expect } from "vitest";
import type { SkinPlan } from "../src/skinPlan";
import { convergence, semanticConvergence, semanticSignatures, type AnnotatedCase, type Failure } from "./generalizationSupport";

interface CaseMetrics {
  caseId: string; noAtlas?: boolean; productionAccepted: boolean; checked: number; retained: number;
  signatures: { head: string; body: string; whole: string }; failures: Failure[];
  performance?: Record<string, number>; headBytesUnchanged?: boolean;
  completion?: { inventedPattern: boolean; provenance: Record<string, number> };
}
interface Review { caseId: string; retainedBefore: string[]; retainedAfter: string[]; remaining: Failure[]; note: string }
const ROOT = resolve("evaluation-artifacts/generalization-20260905");
async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(join(ROOT, path), "utf8")); }
function median(v: number[]) { const sorted = [...v].sort((a, b) => a - b); return (sorted[Math.floor((v.length - 1) / 2)] + sorted[Math.floor(v.length / 2)]) / 2; }
function escape(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"); }

describe.skipIf(process.env.RUN_GENERALIZATION_COMPARE !== "1")("frozen generalization evidence report", () => {
  it("compares the same denominator and labels failed-output diagnostics", async () => {
    const annotations = await json<AnnotatedCase[]>("annotations.json");
    const review = await json<{ cases: Review[] }>("manual-review.json");
    const before = await json<{ cases: CaseMetrics[] }>("before/summary.json");
    const after = await json<{ cases: CaseMetrics[] }>("after/summary.json");
    expect(before.cases.map(c => c.caseId)).toEqual(after.cases.map(c => c.caseId));
    expect(review.cases.map(c => c.caseId)).toEqual(annotations.map(c => c.id));
    const common = before.cases.filter(c => !c.noAtlas).map(c => c.caseId);
    const plans = { before: new Map<string, SkinPlan>(), after: new Map<string, SkinPlan>() };
    for (const phase of ["before", "after"] as const) for (const c of annotations) {
      const stored = await json<{ plan?: SkinPlan }>(`${phase}/${c.id}/analysis-and-plan.json`);
      if (stored.plan) plans[phase].set(c.id, stored.plan);
    }
    const byPhase = (phase: "before" | "after", cases: CaseMetrics[]) => {
      const comparable = cases.filter(c => common.includes(c.caseId));
      const counts = { critical: 0, major: 0, minor: 0 };
      for (const c of cases) for (const f of c.failures) counts[f.severity]++;
      const provenance: Record<string, number> = {};
      for (const c of comparable) for (const [key, value] of Object.entries(c.completion?.provenance ?? {})) provenance[key] = (provenance[key] ?? 0) + value;
      return {
        accepted: cases.filter(c => c.productionAccepted).length, noAtlas: cases.filter(c => c.noAtlas).length,
        limitedAutomatedFailures: counts,
        commonChecked: comparable.reduce((s, c) => s + c.checked, 0), commonRetained: comparable.reduce((s, c) => s + c.retained, 0),
        commonPixelPartitionConvergence: Object.fromEntries((["head", "body", "whole"] as const).map(k => [k, convergence(comparable.map(c => c.signatures[k]))])),
        commonSemanticPlanConvergence: Object.fromEntries((["face", "hair", "head", "body", "whole"] as const).map(k => [k, semanticConvergence(common.map(id => semanticSignatures(plans[phase].get(id)!)[k]))])),
        commonProvenanceFieldCounts: provenance,
        commonPerformanceMedians: Object.fromEntries(["productionWallMedianMs", "productionCpuMedianMs", "bodyRenderMedianMs", "artifactOnlyMs"].map(key => [key, median(comparable.map(c => c.performance![key]))])),
        maxCandidates: Math.max(...comparable.map(c => c.performance!.candidateCount)),
        inventedHiddenPatternCases: cases.filter(c => c.completion?.inventedPattern).map(c => c.caseId),
      };
    };
    const rows = annotations.map((a, i) => {
      const b = before.cases[i], c = after.cases[i], m = review.cases[i];
      for (const cue of [...m.retainedBefore, ...m.retainedAfter]) expect(a.cues).toContain(cue);
      expect(new Set(m.retainedBefore).size).toBe(m.retainedBefore.length);
      expect(new Set(m.retainedAfter).size).toBe(m.retainedAfter.length);
      return { caseId: a.id, observableAnnotatedCues: a.cues.length,
        diagnosticVisibleRetainedBefore: m.retainedBefore.length, diagnosticVisibleRetainedAfter: m.retainedAfter.length,
        usableRetainedBefore: b.productionAccepted ? m.retainedBefore.length : 0, usableRetainedAfter: c.productionAccepted ? m.retainedAfter.length : 0,
        acceptedBefore: b.productionAccepted, acceptedAfter: c.productionAccepted,
        limitedChecksBefore: `${b.retained}/${b.checked}`, limitedChecksAfter: `${c.retained}/${c.checked}`,
        headByteEqual: b.noAtlas ? "not comparable" : c.headBytesUnchanged,
        remainingVisualFindings: m.remaining, note: m.note };
    });
    const report = { scope: "manual-annotation downstream generalization, not production AI end-to-end accuracy", commonInspectableIds: common,
      before: byPhase("before", before.cases), after: byPhase("after", after.cases), rows,
      semanticCaveat: "Coarse semantic plan equality is separated from actual pixel partitions. Neither unique signatures nor gate acceptance prove source likeness. Missing before atlas excluded from common comparisons; rejected atlases explicitly diagnostic.",
      manualCaveat: "Post-hoc conservative visual cue review, not a calibrated evaluator. Additional remaining findings must not be merged with automated subset to imply an exhaustive before/after failure reduction." };
    await writeFile(join(ROOT, "comparison.json"), JSON.stringify(report, null, 2));
    const status = (m: CaseMetrics) => m.noAtlas ? "NO ATLAS: planner exception" : m.productionAccepted ? "Accepted by production craft gate" : "REJECTED: pre-gate diagnostic only";
    const panels = annotations.map((a, i) => `<section><h2>${i + 1}. ${escape(a.id)}</h2><p>${escape(review.cases[i].note)}</p><div class="grid"><figure><figcaption>Source head crop (manual)</figcaption><img src="after/${a.id}/head-crop.png"></figure>${["before", "after"].map((phase, j) => {
      const m = j ? after.cases[i] : before.cases[i];
      return `<figure><figcaption>${phase.toUpperCase()}: ${status(m)}</figcaption>${m.noAtlas ? "<p>No skin produced</p>" : `<img class="skin" src="${phase}/${a.id}/front.png">`}</figure>`;
    }).join("")}</div><details><summary>Six-view / layer / seam artifacts</summary>${["before", "after"].map((phase, j) => {
      if ((j ? after.cases[i] : before.cases[i]).noAtlas) return "";
      return `<h3>${phase.toUpperCase()}</h3><div class="views">${["front", "front_left_three_quarter", "front_right_three_quarter", "back", "left", "right", "base-only", "outer-only", "seams", "pixel-diff"].map(view => `<figure><figcaption>${view}</figcaption><img src="${phase}/${a.id}/${view}.png"></figure>`).join("")}</div>`;
    }).join("")}</details></section>`).join("");
    await writeFile(join(ROOT, "review.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><title>Frozen generalization review · 12 real photos</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;background:#f2f4f6;color:#202b36;padding:20px}h1{font-size:26px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}figure{margin:0}figcaption{font-weight:600;padding:12px 0}img{max-width:100%;max-height:260px;object-fit:contain}.skin,.views img{image-rendering:pixelated}.skin{height:260px}section{background:white;border:1px solid #c5ced6;margin:24px 0;padding:20px}.views{display:flex;flex-wrap:wrap;gap:16px}.views img{height:200px}.banner{border-left:5px solid #bd5029;padding:16px;background:#fff0dc}</style><h1>Frozen 12-person downstream generalization</h1><p class="banner">INTERNAL TESTING ONLY · Not endorsement. Manual annotation adapter, NOT successful AI analysis. 9/12 accepted before AND after. Rejected images below are diagnostic artifacts, NOT delivered skins. Headscarf legacy source linkage remains unverified; do not redistribute.</p><p><a href="report.md">20-section report</a> · <a href="comparison.json">Metrics</a> · <a href="frozen-manifest.json">Frozen source manifest</a> · <a href="license-supplement.json">License/attribution</a> · <a href="manual-review.json">Visual cue review</a></p><p>Contact sheets: <a href="after/full-body-contact-sheet.png">full body</a> · <a href="after/head-contact-sheet.png">head</a>. Columns: source | before | after. Rows match the numbered cases below.</p>${panels}</html>`);
  });
});
