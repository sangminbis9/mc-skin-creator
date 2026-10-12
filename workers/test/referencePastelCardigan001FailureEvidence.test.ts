// Read-only consumed G-001 verification. No live runner imports or network.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";

const root = "evaluation-artifacts/reference-style-v3-e2e-pastel-cardigan-20261010-001";
const bytes = readFileSync(`${root}/summary.json`);
const s = JSON.parse(bytes.toString()), e = s.currentDefaultE2E;
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

it("recovers all 30 consecutive checkpoints without rewriting consumed evidence", () => {
  expect(sha(bytes)).toBe("8f5e7aeedd39ac0163d684b8b379efa9dfc47ddfbc57cf9e3b64b0d6927d7f10");
  const names = readdirSync(root).filter(n => /^summary\.json\.checkpoint-\d+\.json$/.test(n)).sort();
  expect(names).toHaveLength(30);
  for (const [i, name] of names.entries()) {
    const checkpoint = JSON.parse(readFileSync(`${root}/${name}`, "utf8"));
    expect(checkpoint.sequence).toBe(i + 1);
    expect(sha(JSON.stringify(checkpoint.snapshot))).toBe(checkpoint.snapshotSha256);
  }
  expect(JSON.parse(readFileSync(`${root}/${names.at(-1)}`, "utf8")).snapshot).toEqual(s);
  expect(e.diskRecovery).toBe(true);
});

it("keeps the observed HTTP 503 separate from unknown provider dispatch and completion", () => {
  expect(e).toMatchObject({ runId: "2935b78a92554bbf2fb800ca087de9f6", generationPosts: 1,
    providerRetry: 0, accounting: "unknown", httpStatus: 503, elapsedMs: 43125,
    gateBoundary: "unobserved", result: null, e2eGateTrace: null,
    httpObservation: { stage: "json_parse", httpStatus: 503, jsonRootType: null,
      exception: { name: "SyntaxError" } } });
  expect(s.classification).toBe("BLOCKED: E2E HTTP response JSON unavailable; provider accounting unknown");
  expect(e.png).toBeNull(); expect(e.propagationLink).toBeNull();
  expect(existsSync(`${root}/skin.png`)).toBe(false);
  // Neither provider-specific failure nor zero inference can be inferred from this envelope.
  expect(e.result?.bindingAttempts).toBeUndefined();
});

it("pins G source and actual production derivatives without inventing appearance evidence", () => {
  expect(e.preprocessing.source).toMatchObject({ caseId: "reference-pastel-cardigan-001", bytes: 1775358,
    width: 1024, height: 1536, sha256: "7dc7f6592c6c53567a90b18557057f2736df0565666e3c3a1ca64e7546214381" });
  expect(e.preprocessing.analysis).toMatchObject({ width: 597, height: 896, bytes: 35819,
    sha256: "7a3b74482ec859c08111360013c478753699fb0170bbea935c0645d5e55cac8c" });
  expect(e.preprocessing.generation).toMatchObject({ width: 299, height: 448, bytes: 12977,
    sha256: "c06b9366d6def96d35b364c332db3ef5d1c60762dcde54442e8e287e76eeb088" });
  expect(e.preprocessing.rawOriginalTransmitted).toBe(false);
  expect(e.contract.version).toBe("primary_compact_v3_legacy_suffix");
  expect(e.contract).toMatchObject({ primaryTimeoutMs: 45000, gemmaPrimaryTimeoutMs: 55000, geometryTimeoutMs: 25000 });
});

it("confirms health and graceful teardown while not claiming independent remote deletion", () => {
  expect(s).toMatchObject({ startupAttempts: 1, healthAttempts: 1, qSentCount: 1,
    health: { status: "passed", httpStatus: 200 }, wrapperExitObserved: true, wrapperCloseObserved: true,
    ptyExitObserved: true, ownerResultFlushed: true, ownerExitObserved: true, ownerCloseObserved: true,
    ownedProcessInventoryClean: true, cleanupFailed: false, temporaryConfigRemoved: true,
    temporaryTokenFileRemoved: true, productionConfigChanged: false,
    serverSidePreviewDeletionIndependentlyConfirmed: false });
  expect(s.productionConfigHashAfter).toBe(s.productionConfigHashBefore);
  expect(s.shutdownLatch.phase).toBe("finalized");
  expect(readFileSync(`${root}/summary.json`)).toEqual(bytes);
});
