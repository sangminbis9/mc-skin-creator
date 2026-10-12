// Offline-only census of stored provider-origin timing. Never imports a live runner.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const model = "@cf/google/gemma-4-26b-a4b-it";
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v)
  ? v as Record<string, unknown> : {};
const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const boolean = (v: unknown): boolean | null => typeof v === "boolean" ? v : null;

export function collectGemmaTimeoutEvidence() {
  const rows: Record<string, unknown>[] = [];
  const auxiliary: Record<string, unknown>[] = [];
  const excluded: string[] = [];
  const historicalHashes: Record<string, string> = {};
  let summariesScanned = 0;
  for (const base of ["evaluation-artifacts", "../evaluation-artifacts"]) {
    if (!fs.existsSync(base)) continue;
    for (const dir of fs.readdirSync(base).sort()) {
      const file = path.join(base, dir, "summary.json");
      if (!fs.existsSync(file)) continue;
      summariesScanned++;
      if (/offline|synthetic/i.test(dir)) { excluded.push(file); continue; }
      const bytes = fs.readFileSync(file);
      let snapshot = object(JSON.parse(bytes.toString()));
      // Explicit observed remote lifecycle, not a suggestive directory name.
      if (snapshot.devServerReadyReceived !== true) continue;
      const checkpoints = fs.readdirSync(path.dirname(file))
        .filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
      if (!checkpoints.length) { excluded.push(file); continue; }
      const checkpointFile = path.join(path.dirname(file), checkpoints.at(-1)!);
      const checkpointBytes = fs.readFileSync(checkpointFile);
      const checkpoint = object(JSON.parse(checkpointBytes.toString()));
      if (sha(JSON.stringify(checkpoint.snapshot)) !== checkpoint.snapshotSha256)
        throw new Error("historical_checkpoint_checksum_mismatch");
      snapshot = object(checkpoint.snapshot);
      historicalHashes[file] = sha(bytes);
      historicalHashes[checkpointFile] = sha(checkpointBytes);
      const e2e = object(snapshot.currentDefaultE2E);
      const result = object(e2e.result);
      const diagnostic = object(result.diagnostics);
      const primary = object(diagnostic.primaryDiagnostic);
      const validation = object(diagnostic.primaryValidation);
      const binding = (Array.isArray(result.bindingAttempts) ? result.bindingAttempts : [])
        .map(object).find(x => x.stage === "gemmaPrimary");
      function visit(v: unknown, location: string) {
        if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${location}[${i}]`)); return; }
        const x = object(v);
        if (x.provider === "workers_ai" && x.model === model && (x.outcome === "completed" || x.outcome === "failed")) {
          const e2eAttempt = location.startsWith("currentDefaultE2E.result.diagnostics.primaryDiagnostic.");
          const parent = object(snapshot.primary);
          const isPrimaryTrace = location.startsWith("primary.providerSequence") || location.startsWith("primary.providerObservations");
          const currentV4 = object(object(snapshot.currentSourceV4).primary);
          const late = e2eAttempt && x.origin === "LOCAL_DEADLINE" && binding?.completion === "returned"
            && number(binding.elapsedMs) !== null && number(binding.elapsedMs)! > number(x.configuredDeadlineMs)!;
          rows.push({ artifact: file.replace(/\\/g, "/"), checkpoint: path.basename(checkpointFile),
            snapshotSha256: checkpoint.snapshotSha256, tracePath: location, outcome: x.outcome,
            elapsedMs: number(x.elapsedMs), configuredDeadlineMs: number(x.configuredDeadlineMs),
            deadlineTimerFired: boolean(x.deadlineTimerFired), origin: x.origin ?? null,
            providerShape: x.providerSchemaValidation ?? null, strictValidation: x.strictValidation ?? null,
            bindingElapsedMs: e2eAttempt ? number(binding?.elapsedMs) : null,
            bindingSettlement: e2eAttempt ? binding?.completion ?? null : null,
            lateResultObserved: late ? true : null,
            lateShapeValid: late ? boolean(validation.providerShapePass) : null,
            lateSemanticValid: late ? boolean(validation.strictRuntimePass) : null,
            lateRichValid: late ? boolean(validation.richValidationPass) : null,
            primarySucceeded: e2eAttempt ? boolean(primary.ok) : isPrimaryTrace ? boolean(parent.ok)
              : location.startsWith("currentSourceV4.primary.") ? boolean(currentV4.ok) : null,
          });
        }
        // Geometry is a separate workload; retain only explicitly identified timings.
        if (x.stage === "faceGeometry" && number(x.elapsedMs) !== null
          && object(snapshot.primaryContract).gemmaModel === model)
          auxiliary.push({ artifact: file.replace(/\\/g, "/"), tracePath: location,
            scope: "geometry_binding", elapsedMs: number(x.elapsedMs), configuredDeadlineMs: number(x.deadlineMs),
            bindingSettlement: x.completion ?? null, timerFired: null });
        if (x.geometryModel === model && number(x.elapsedMs) !== null)
          auxiliary.push({ artifact: file.replace(/\\/g, "/"), tracePath: location,
            scope: "geometry_audit_roundtrip_not_binding_latency", elapsedMs: number(x.elapsedMs),
            configuredDeadlineMs: null, timerFired: null });
        for (const [key, value] of Object.entries(x)) visit(value, location ? `${location}.${key}` : key);
      }
      visit(snapshot, "");
    }
  }
  // Earlier single remote probe: immutable result, different schema; not used for deadline calibration.
  const probeFile = "evaluation-artifacts/gemma-full-compact-20260913/result.json";
  if (fs.existsSync(probeFile)) {
    const bytes = fs.readFileSync(probeFile), probe = object(JSON.parse(bytes.toString()));
    if (probe.model === model && probe.providerCalls === 1 && probe.providerBindingCompleted === true) {
      historicalHashes[probeFile] = sha(bytes);
      auxiliary.push({ artifact: probeFile, scope: "old_schema_probe_roundtrip_not_binding_latency",
        elapsedMs: number(probe.elapsedMs), configuredDeadlineMs: null, timerFired: null,
        providerSchemaValid: boolean(probe.providerSchemaValidation), strictValid: boolean(probe.strictRuntimeValidation) });
    }
  }
  const validCompletions = rows.filter(x => x.outcome === "completed" && x.strictValidation === "passed")
    .map(x => number(x.elapsedMs)).filter((x): x is number => x !== null);
  const validLate = rows.filter(x => x.lateResultObserved === true && x.lateShapeValid === true
    && x.lateSemanticValid === true && x.lateRichValid === true)
    .map(x => number(x.bindingElapsedMs)).filter((x): x is number => x !== null);
  const maxValidatedMs = Math.max(...validCompletions, ...validLate);
  return { summariesScanned, excluded, historicalHashes, rows, auxiliary,
    statistics: { terminalPrimaryAttempts: rows.length, completed: rows.filter(x => x.outcome === "completed").length,
      localDeadline: rows.filter(x => x.origin === "LOCAL_DEADLINE").length,
      bindingRejection: rows.filter(x => x.origin === "BINDING_REJECTION").length,
      validatedLateObserved: validLate.length, maxValidatedMs,
      safetyMarginMs: 2000, roundingMs: 5000,
      selectedGemmaPrimaryDeadlineMs: Math.ceil((maxValidatedMs + 2000) / 5000) * 5000 },
  };
}

export function writeGemmaTimeoutEvidence(root: string) {
  const evidence = collectGemmaTimeoutEvidence();
  fs.mkdirSync(root, { recursive: false }); // refuses existing root; historical files remain read-only
  fs.writeFileSync(path.join(root, "timing-evidence.json"), JSON.stringify(evidence, null, 2), { flag: "wx" });
  const table = ["| Artifact | Outcome | Elapsed ms | Deadline ms | Fired | Late ms | Late shape/semantic | Primary success |",
    "| --- | --- | ---: | ---: | --- | ---: | --- | --- |",
    ...evidence.rows.map(x => `| ${String(x.artifact).split("/").at(-2)} | ${x.origin ?? x.outcome} | ${x.elapsedMs ?? "unknown"} | ${x.configuredDeadlineMs ?? "unknown"} | ${x.deadlineTimerFired ?? "unknown"} | ${x.lateResultObserved ? x.bindingElapsedMs : "unobserved"} | ${x.lateResultObserved ? `${x.lateShapeValid}/${x.lateSemanticValid}` : "unobserved"} | ${x.primarySucceeded ?? "unknown"} |`)];
  fs.writeFileSync(path.join(root, "TIMINGS.md"), table.join("\n") + "\n", { flag: "wx" });
  return evidence;
}
