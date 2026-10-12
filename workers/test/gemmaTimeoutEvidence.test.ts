import fs from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { collectGemmaTimeoutEvidence, writeGemmaTimeoutEvidence } from "./audit/gemmaTimeoutEvidence";

it("derives a bounded Gemma deadline from authoritative real timing, excluding offline simulations", () => {
  const evidence = process.env.WRITE_GEMMA_TIMEOUT_EVIDENCE_ROOT
    ? writeGemmaTimeoutEvidence(process.env.WRITE_GEMMA_TIMEOUT_EVIDENCE_ROOT)
    : collectGemmaTimeoutEvidence();
  // Pin the reviewed census, not a moving expected maximum that silently follows
  // each future provider sample. New observations do not auto-change production.
  const bytes = fs.readFileSync("evaluation-artifacts/gemma-deadline-review-20261011-684b3970/timing-evidence.json");
  expect(createHash("sha256").update(bytes).digest("hex"))
    .toBe("1ed0162308b08b457a3afdb1a76422ab02585a4c9aa90d36a21a3bd866586c47");
  const reviewed = JSON.parse(bytes.toString());
  expect(reviewed.statistics).toMatchObject({ maxValidatedMs: 55414, validatedLateObserved: 3,
    safetyMarginMs: 2000, roundingMs: 5000, selectedGemmaPrimaryDeadlineMs: 60000 });
  for (const row of reviewed.rows) expect(evidence.rows).toContainEqual(row);
  for (const [file, hash] of Object.entries(reviewed.historicalHashes))
    expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(hash);
  expect(evidence.statistics.localDeadline).toBeGreaterThan(0);
  expect(evidence.rows.every(x => !/offline|synthetic/i.test(String(x.artifact)))).toBe(true);
  expect(evidence.rows.filter(x => x.origin === "LOCAL_DEADLINE" && x.lateResultObserved !== true)
    .every(x => x.lateShapeValid === null && x.lateSemanticValid === null)).toBe(true);
  for (const [file, hash] of Object.entries(evidence.historicalHashes))
    expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(hash);
  console.log(JSON.stringify({ gemmaTimingCensus: evidence.statistics, newProviderCalls: 0 }));
}, 30000);
