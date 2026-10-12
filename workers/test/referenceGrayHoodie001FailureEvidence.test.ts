// Read-only consumed evidence and A-H coverage; no runner or inference imports.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { decodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { freshAuditOutput } from "./freshAuditOutput";

const sha = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const root = "evaluation-artifacts/reference-style-v3-e2e-gray-hoodie-20261010-001";
const bytes = readFileSync(`${root}/summary.json`), s = JSON.parse(bytes.toString());
it("recovers F001 as a non-JSON 503 without inventing provider counts or remote deletion", () => {
  expect(sha(bytes)).toBe("41a0dcebc0e4d1814e7ba7ef0d647626b97cdf353c17f31695695f1a70c22e34");
  const files = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  // The summary's counter precedes the final lifecycle snapshot itself.
  expect(files).toHaveLength(30);
  for (const [i, name] of files.entries()) {
    const c = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(c.sequence).toBe(i + 1); expect(sha(JSON.stringify(c.snapshot))).toBe(c.snapshotSha256);
  }
  const last = JSON.parse(readFileSync(`${root}/${files.at(-1)}`, "utf8"));
  expect(last.event).toBe("auditLifecycleFinalized"); expect(last.snapshot).toEqual(s);
  expect(s.currentDefaultE2E).toMatchObject({ runId: "378491e0efb20d13bfb12d6e30950d46", generationPosts: 1,
    providerRetry: 0, accounting: "unknown", httpStatus: 503, elapsedMs: 39796, result: null, png: null,
    httpObservation: { stage: "json_parse", httpStatus: 503, exception: { name: "SyntaxError" } },
    gateBoundary: "unobserved", diskRecovery: true });
  expect(s.currentDefaultE2E.httpObservation.rejectedBody).toBeUndefined(); // Not retrospectively recoverable.
  expect(existsSync(`${root}/skin.png`)).toBe(false);
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, health: { status: "passed", httpStatus: 200 },
    qSentCount: 1, wrapperExitObserved: true, wrapperCloseObserved: true, wrapperExitCode: 0,
    ptyExitObserved: true, ptyExitCode: 0, ownerResultFlushed: true, ownerExitObserved: true,
    ownerCloseObserved: true, ownerExitCode: 0, ownedProcessInventoryClean: true, cleanupFailed: false,
    temporaryConfigRemoved: true, temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashBefore).toBe(s.productionConfigHashAfter);
});

it("separates eight reference coverage states from structural PNG validity and quality acceptance", async () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("OFFLINE_ONLY"); });
  try {
    const approved = JSON.parse(readFileSync("test/audit/approvedGeneralizationE2E.json", "utf8")) as
      Record<string, { sourcePath?: string; sourceSha256: string; artifactRoot: string }>;
    const entries = [];
    for (const [i, pair] of [..."ABCDEFGH"].entries()) {
      const sourceImage = `image-${(i + 1) * 2}.png`;
      const runs = [];
      for (const config of Object.values(approved).filter(v => v.sourcePath?.endsWith(`/${sourceImage}`))) {
        const file = `${config.artifactRoot}/summary.json`;
        if (!existsSync(file)) continue;
        const data = readFileSync(file), summary = JSON.parse(data.toString()), e = summary.currentDefaultE2E;
        expect(e.preprocessing.source.sha256).toBe(config.sourceSha256);
        const pngFile = `${config.artifactRoot}/skin.png`, hasPng = existsSync(pngFile);
        let png = null;
        if (hasPng) {
          const encoded = readFileSync(pngFile), decoded = await decodePng(encoded);
          expect([decoded.width, decoded.height]).toEqual([64, 64]);
          expect(sha(encoded)).toBe(e.png.sha256);
          expect(validateFinalAtlas(decoded)).toEqual({ ok: true, problems: [] });
          png = { sha256: sha(encoded), atlasValid: true };
        }
        runs.push({ root: config.artifactRoot, summarySha256: sha(data), runId: e.runId,
          httpStatus: e.httpStatus, accounting: e.accounting, hasPng, png,
          providerCalls: e.accounting === "known" ? e.result.bindingAttempts.length : null,
          strictErrors: e.result?.diagnostics?.primaryValidation?.strictErrors ?? null,
          classification: e.classification, cleanupComplete: summary.ownedProcessInventoryClean && !summary.cleanupFailed });
      }
      entries.push({ pair, sourceImage, runs, pngCount: runs.filter(r => r.hasPng).length,
        coverage: runs.some(r => r.hasPng) ? "historical_png_available_not_quality_signoff"
          : runs.length ? "attempted_no_png" : "no_live_baseline",
        qualityAcceptedByThisAudit: false });
    }
    expect(entries).toHaveLength(8);
    // This census grows with newly approved runs. The first test pins F001's
    // immutable failure; future evidence must not be forced into stale gaps.
    for (const entry of entries) {
      expect(entry.qualityAcceptedByThisAudit).toBe(false);
      if (entry.coverage === "no_live_baseline") expect(entry.runs).toHaveLength(0);
      if (entry.coverage === "attempted_no_png") expect(entry.pngCount).toBe(0);
      if (entry.coverage === "historical_png_available_not_quality_signoff") expect(entry.pngCount).toBeGreaterThan(0);
    }
    const out = freshAuditOutput("evaluation-artifacts/reference-coverage-and-f001-review-20261010-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_saved_evidence_census", entries,
      newProviderCalls: 0, goalComplete: false, currentFProviderCounts: null,
      reason: "F response lacks protected envelope; inference and inner handler boundaries remain unknown" }, null, 2), { flag: "wx" });
    console.info("REFERENCE_COVERAGE_F001", out);
    expect(network).not.toHaveBeenCalled(); expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
  } finally { network.mockRestore(); }
});
