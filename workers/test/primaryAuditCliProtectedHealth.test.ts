import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { expect, it } from "vitest";
import { bytesToBase64 } from "../src/png";
import { createIdentityCrops } from "../src/generate";
import type { PhotoAnalysis, PortraitRegion } from "../src/analysis";
import type { AdaptiveHeadCropContext } from "../src/adaptiveHeadCrop";
import { boundedHealthProbe } from "./primaryAuditRemoteReadiness";
import { accountingOf, atomicCheckpoint, exceptionDiagnostic } from "./primaryAuditRunnerSupport";

type ProcessRecord = { pid: number; parent: number; created: string };
type Config = { vars: Record<string, unknown>; account_id: string; secrets: { required: string[] } };
type AclRestriction = {
  aclRestricted: boolean; inheritanceDisabled: boolean; currentUserAccessPresent: boolean;
  systemAccessPresent: boolean; broadInheritedAccessPresent: boolean; unexpectedAccessPresent: boolean;
};
const support = createRequire(import.meta.url)("./primaryAuditCliHealthSupport.cjs") as {
  parseConfig(text: string): Config;
  deriveConfig(text: string): string;
  assertConfigDelta(production: Config, audit: Config): string[];
  tokenBindingPreflight(cli: string, production: Config, audit: Config, configPath: string): boolean;
  metadataPreflight(cli: string, config: Config, workersDir: string): {
    selectedProfileClass: string; approvedAccountIdMatch: boolean; authOverrideAbsent: boolean;
    dotenvOverrideAbsent: boolean; credentialContentsRead: boolean; credentialExtraction: boolean;
  };
  discoverPty(): { directory: string; version: string; publicSpawnLoaded: boolean; nativeBackendLoaded: boolean };
  processSnapshot(): ProcessRecord[];
  descendants(snapshot: ProcessRecord[], rootPid: number): ProcessRecord[];
  restrictTemporaryDirectory(directory: string): AclRestriction;
  parseReady(raw: unknown): { event: string; ip: string; port: number } | null;
};
const productionText = fs.readFileSync("wrangler.jsonc", "utf8");
const production = support.parseConfig(productionText);
const cli = fs.readFileSync("node_modules/wrangler/wrangler-dist/cli.js", "utf8");
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const RUN_HEALTH = process.env.RUN_BOUND_PROFILE_CLI_HEALTH === "approved";
const RUN_SINGLE_PRIMARY = process.env.RUN_BOUND_PROFILE_CLI_PRIMARY_CANARY === "approved-canary";
const RUN_SIX_CASE_PRIMARY = process.env.RUN_BOUND_PROFILE_CLI_PRIMARY_BATCH === "approved-six-case";
const RUN_TARGETED_PRIMARY = process.env.RUN_BOUND_PROFILE_CLI_PRIMARY_TARGETED === "approved-three-case";
const RUN_FACE_GEOMETRY_TARGETS = process.env.RUN_BOUND_PROFILE_CLI_FACE_GEOMETRY === "approved-two-case";
const RUN_PRIMARY = RUN_SINGLE_PRIMARY || RUN_SIX_CASE_PRIMARY || RUN_TARGETED_PRIMARY;
const RUN_REMOTE = RUN_PRIMARY || RUN_FACE_GEOMETRY_TARGETS;
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");
const GENERALIZATION = path.resolve("evaluation-artifacts/generalization-20260905");
const TARGETED_PRIMARY = path.resolve("evaluation-artifacts/primary-eye-category-targeted-live-20260921-001/summary.json");
const RUBRIC_HASH = "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27";
type RubricCell = { kind: "expected" | "ambiguous" | "unscorable"; values?: string[]; reason?: string };
type RubricCase = { id: string; photoId: number; sourceSha256: string; sourceBytes: number; faceVisibility: string;
  glassesOrCovering: string; rubric: Record<string, RubricCell> };
type RemoteResult = {
  ok?: boolean;
  elapsedMs?: number;
  attempts?: number;
  providerSequence?: Array<Record<string, unknown>>;
  validation?: Record<string, string>;
  auditState?: unknown;
  analysis?: {
    quality?: unknown; visibleRegions?: unknown; sourceSelection?: unknown;
    faceMeasurementEvidence?: { cues?: Record<string, { value: string; provenance: string; confidence: number }> };
    relevantRenderHints?: unknown; canonicalFaceCues?: unknown;
    fallbackFeaturesGlasses?: "none" | "regular" | "round" | "sunglasses";
    observedAccessories?: string;
    canonicalAccessoryCues?: Array<{ feature: string; evidence: string; confidence: string; priority: number; targetRegions: string[] }>;
    consumerTrace?: { measurementTrace?: Record<string, { selected?: string }>; faceLayoutPlan?: Record<string, unknown> } | null;
  };
  failure?: { reason?: string; detail?: string };
};
type GeometryRemoteResult = {
  ok?: boolean;
  elapsedMs?: number;
  auditState?: unknown;
  crop?: Record<string, unknown> | null;
  providerShapeValid?: boolean;
  errors?: string[];
  measurements?: Record<string, unknown> | null;
  geometry?: Record<string, unknown> | null;
  httpStatus?: number | null;
  providerStatus?: string | null;
  error?: string;
};
async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation.then(value => ({ done: true as const, value })),
    new Promise<{ done: false }>(resolve => { timer = setTimeout(() => resolve({ done: false }), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}

it("derived audit config preserves every production setting with exactly one empty declaration", () => {
  const auditText = support.deriveConfig(productionText);
  const audit = support.parseConfig(auditText);
  expect(support.assertConfigDelta(production, audit)).toEqual(["vars.PRIMARY_AUDIT_TOKEN"]);
  expect(audit.secrets.required).toEqual(production.secrets.required);
  expect(audit.vars.PRIMARY_AUDIT_TOKEN).toBe("");
  expect(auditText.replace(/\n {4}"PRIMARY_AUDIT_TOKEN": "",/, "")).toBe(productionText);
  expect(support.tokenBindingPreflight(cli, production, audit, path.resolve("wrangler.audit.tmp.jsonc"))).toBe(true);
  const invalid = structuredClone(audit); invalid.vars.VISION_MODEL = "unexpected-model";
  expect(() => support.assertConfigDelta(production, invalid)).toThrow("unexpected_config_delta");
});
it("only exact structured loopback-ready payloads can open the single health gate", () => {
  expect(support.parseReady(JSON.stringify({ event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 8787 }))).toEqual({ event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 8787 });
  for (const value of [{ event: "OTHER", ip: "127.0.0.1", port: 8787 },
    { event: "DEV_SERVER_READY", ip: "public.invalid", port: 8787 },
    { event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 0 }, null, "secret-bearing-invalid"]) {
    expect(support.parseReady(value)).toBeNull();
  }
});

it.skipIf(!RUN_HEALTH && !RUN_REMOTE)("runs one approved temporary-config bound-profile CLI audit and gracefully quits", async () => {
  const root = RUN_FACE_GEOMETRY_TARGETS
    ? process.env.BOUND_PROFILE_CLI_FACE_GEOMETRY_ARTIFACT_ROOT
    : RUN_PRIMARY
    ? process.env.BOUND_PROFILE_CLI_PRIMARY_CANARY_ARTIFACT_ROOT
    : process.env.BOUND_PROFILE_CLI_HEALTH_ARTIFACT_ROOT;
  if (!root) throw new Error("fresh_artifact_root_required");
  fs.mkdirSync(root, { recursive: false });
  const rubricBytes = fs.readFileSync(RUBRIC);
  expect(hash(rubricBytes)).toBe(RUBRIC_HASH);
  const rubric = JSON.parse(rubricBytes.toString("utf8")) as { cases: RubricCase[] };
  expect(rubric.cases).toHaveLength(7);
  const ordered = [...rubric.cases].sort((a, b) => {
    const high = (value: string) => value === "high" ? 0 : 1;
    return high(a.faceVisibility) - high(b.faceVisibility) || a.sourceBytes - b.sourceBytes || a.id.localeCompare(b.id);
  });
  const selected = ordered[0];
  const sixCaseIds = ["buzz-striped", "bun-check", "warm-white-tee", "full-body-layered", "striped-open-shirt", "sleeveless-bag-skirt"];
  const sixCases = sixCaseIds.map(id => rubric.cases.find(item => item.id === id));
  expect(sixCases.every(Boolean)).toBe(true);
  const targetedCaseIds = ["warm-white-tee", "striped-open-shirt", "sleeveless-bag-skirt"];
  const targetedCases = targetedCaseIds.map(id => rubric.cases.find(item => item.id === id));
  expect(targetedCases.every(Boolean)).toBe(true);
  const selectedCases = RUN_TARGETED_PRIMARY ? targetedCases as RubricCase[]
    : RUN_FACE_GEOMETRY_TARGETS
      ? ["warm-white-tee", "striped-open-shirt"].map(id => rubric.cases.find(item => item.id === id)!)
      : RUN_SIX_CASE_PRIMARY ? sixCases as RubricCase[] : RUN_SINGLE_PRIMARY ? [selected] : [];
  const configName = `wrangler.primary-audit-${randomUUID()}.tmp.jsonc`;
  const configPath = path.resolve(configName);
  const artifact = {
    mode: RUN_FACE_GEOMETRY_TARGETS ? "face_geometry_low_eye_target_audit"
      : RUN_TARGETED_PRIMARY ? "targeted_eye_category_recheck"
      : RUN_SIX_CASE_PRIMARY ? "six_case_primary_batch" : RUN_PRIMARY ? "single_primary_canary" : "protected_health_only",
    branch: "main", head: "0b9d6dec4346076736ad21d92b4125481808efc1",
    sourceRubricSha256: hash(rubricBytes),
    selectedCanary: RUN_SINGLE_PRIMARY ? { id: selected.id, photoId: selected.photoId,
      expectedSha256: selected.sourceSha256, expectedBytes: selected.sourceBytes } : null,
    selectedCases: RUN_SIX_CASE_PRIMARY || RUN_TARGETED_PRIMARY || RUN_FACE_GEOMETRY_TARGETS ? selectedCases.map(item => ({ id: item.id, photoId: item.photoId,
      expectedSha256: item.sourceSha256, expectedBytes: item.sourceBytes })) : null,
    wranglerVersion: JSON.parse(fs.readFileSync("node_modules/wrangler/package.json", "utf8")).version as string,
    ptyVersion: null as string | null, ptyBackendVerified: false,
    temporaryConfigUsed: false, temporaryConfigPathClass: "workers_directory",
    temporaryConfigName: configName, temporaryConfigSemanticDiff: [] as string[],
    productionConfigChanged: false, productionConfigHashBefore: hash(productionText), productionConfigHashAfter: null as string | null,
    tokenBindingPreflightPassed: false,
    preflight: null as ReturnType<typeof support.metadataPreflight> | null,
    lifecycle: [] as { stage: string; elapsedMs: number }[], outputClasses: [] as string[],
    startupAttempts: 0, devServerReadyReceived: false, localProxyReadyElapsedMs: null as number | null,
    hotkeyRegistrationProven: false, senderOwnedRelationshipVerified: false,
    healthAttempts: 0, healthElapsedMs: null as number | null,
    health: null as Awaited<ReturnType<typeof boundedHealthProbe>> | null,
    qSentCount: 0, shutdownRequested: false,
    wrapperExitObserved: false, wrapperCloseObserved: false, wrapperExitCode: null as number | null,
    wrapperSignalAbsent: false, bridgeCompletionObserved: false,
    ptyExitObserved: false, ptyExitCode: null as number | null,
    ownerResultFlushed: false, ownerExitObserved: false, ownerCloseObserved: false, ownerExitCode: null as number | null,
    ownedProcessCount: 0, ownedProcessInventoryClean: false, cleanupFailed: false,
    temporaryConfigRemoved: false, temporaryTokenFileRemoved: false, temporaryTokenFileCreated: false,
    temporaryDirectoryAclRestricted: false, inheritanceDisabled: false,
    currentUserAccessPresent: false, systemAccessPresent: false,
    broadInheritedAccessPresent: false, unexpectedAccessPresent: false,
    wranglerGracefulTeardownPathCompleted: false, serverSidePreviewDeletionIndependentlyConfirmed: false,
    calls: { jpegReads: 0, hashChecks: 0, base64Preparations: 0, jpegTransmissions: 0, primaryPosts: 0,
      faceCropPreparations: 0, geometryPosts: 0 },
    providerCalls: null as null | { geminiStarted: number; geminiCompleted: number; geminiFailed: number;
      gemmaStarted: number; gemmaCompleted: number; gemmaFailed: number; retry: 0 },
    providerAccounting: "not_attempted" as "not_attempted" | "known" | "unknown",
    primary: null as null | Record<string, unknown>,
    primaryResults: [] as Array<Record<string, unknown>>,
    geometryResults: [] as Array<Record<string, unknown>>,
    rubricComparison: null as null | Array<Record<string, unknown>>,
    remainingSixAnalyzed: 0,
    prohibited: { primaryGemini: 0, primaryGemma: 0, fullIdentityGeometry: 0, portraitDetail: 0, neckDetail: 0,
      imageGeneration: 0, skinImageGeneration: 0,
      critique: 0, pairwise: 0, evaluator: 0 },
    packageManagerCalls: 0, productionAdditionalDiff: 0,
    classification: "not_started",
  };
  const start = Date.now();
  const checkpoint = path.join(root, "summary.json");
  let writes = Promise.resolve();
  const persist = () => {
    // Snapshot before asynchronous IO so later lifecycle changes cannot mutate
    // the checkpoint payload that is already queued.
    const snapshot = structuredClone(artifact);
    writes = writes.then(() => atomicCheckpoint(checkpoint, snapshot));
    void writes.catch(() => {});
  };
  const observe = (stage: string) => { artifact.lifecycle.push({ stage, elapsedMs: Date.now() - start }); persist(); };
  let token = "";
  let tokenDirectory: string | null = null;
  let tokenFile: string | null = null;
  let owner: ReturnType<typeof spawn> | null = null;
  const owned: ProcessRecord[] = [];
  let before: ProcessRecord[] = [];
  let ownerClosed = false;
  let ownerExited = false;
  let qRequested = false;
  let exitPromise: Promise<number | null> | null = null;
  let closePromise: Promise<number | null> | null = null;
  const updateInventory = () => {
    const snapshot = support.processSnapshot();
    const records = support.descendants(snapshot, process.pid)
      .filter(record => !before.some(old => old.pid === record.pid && old.created === record.created));
    for (const record of records) if (!owned.some(old => old.pid === record.pid && old.created === record.created)) owned.push(record);
    artifact.ownedProcessCount = owned.length;
    return snapshot;
  };
  persist();
  try {
    const auditText = support.deriveConfig(productionText);
    const audit = support.parseConfig(auditText);
    artifact.temporaryConfigSemanticDiff = support.assertConfigDelta(production, audit);
    artifact.tokenBindingPreflightPassed = support.tokenBindingPreflight(cli, production, audit, configPath);
    artifact.preflight = support.metadataPreflight(cli, audit, path.dirname(configPath));
    expect(artifact.tokenBindingPreflightPassed).toBe(true);
    expect(artifact.preflight.selectedProfileClass).toBe("non_default");
    expect(artifact.preflight.approvedAccountIdMatch && artifact.preflight.authOverrideAbsent && artifact.preflight.dotenvOverrideAbsent).toBe(true);
    expect(artifact.wranglerVersion).toBe("4.120.0");
    expect(cli).toContain("isInteractive() && args.showInteractiveDevSession !== false");
    const registration = cli.indexOf("unregisterHotKeys = registerDevHotKeys(devEnvs, args, { tunnelManager });");
    const readyEmission = cli.indexOf('event: "DEV_SERVER_READY"', registration);
    expect(registration).toBeGreaterThan(0); expect(readyEmission).toBeGreaterThan(registration);
    const pty = support.discoverPty();
    artifact.ptyVersion = pty.version;
    artifact.ptyBackendVerified = pty.publicSpawnLoaded && pty.nativeBackendLoaded;
    before = support.processSnapshot();
    fs.writeFileSync(configPath, auditText, { flag: "wx" });
    artifact.temporaryConfigUsed = true;
    // Secure the empty directory before any token is written. Tokens never
    // enter command arguments, config, checkpoints, output, or exceptions.
    tokenDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-skin-audit-token-"));
    const acl = support.restrictTemporaryDirectory(tokenDirectory);
    artifact.temporaryDirectoryAclRestricted = acl.aclRestricted;
    artifact.inheritanceDisabled = acl.inheritanceDisabled;
    artifact.currentUserAccessPresent = acl.currentUserAccessPresent;
    artifact.systemAccessPresent = acl.systemAccessPresent;
    artifact.broadInheritedAccessPresent = acl.broadInheritedAccessPresent;
    artifact.unexpectedAccessPresent = acl.unexpectedAccessPresent;
    expect(artifact.temporaryDirectoryAclRestricted).toBe(true);
    token = randomBytes(32).toString("hex");
    tokenFile = path.join(tokenDirectory, "audit.env");
    fs.writeFileSync(tokenFile, `PRIMARY_AUDIT_TOKEN=${token}\n`, { flag: "wx" });
    artifact.temporaryTokenFileCreated = true;
    observe("preflightPassed");
    let resolveReady!: (value: { ip: string; port: number }) => void;
    const localReady = new Promise<{ ip: string; port: number }>(resolve => { resolveReady = resolve; });
    owner = spawn(process.execPath, [path.resolve("test/fixtures/primaryAuditCliHealthPty.cjs"), "owner", pty.directory, configName, tokenFile], {
      cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
    });
    artifact.startupAttempts = 1;
    observe("cliOwnerSpawnRequested");
    exitPromise = new Promise(resolve => owner!.once("exit", code => {
      ownerExited = true; artifact.ownerExitObserved = true; artifact.ownerExitCode = code;
      observe("ownerExitObserved"); resolve(code);
    }));
    closePromise = new Promise(resolve => owner!.once("close", code => {
      ownerClosed = true; artifact.ownerCloseObserved = true; observe("ownerCloseObserved"); resolve(code);
    }));
    let bridgePid: number | null = null;
    let wrapperPid: number | null = null;
    owner.on("error", () => { artifact.classification = "BLOCKED: PTY owner startup failed"; observe("ownerSpawnError"); });
    owner.on("message", raw => {
      if (!raw || typeof raw !== "object") return;
      const message = raw as Record<string, unknown>;
      if (message.kind === "owner_started") {
        if (message.ownerPid !== owner?.pid || !Number.isInteger(message.bridgePid)) return;
        bridgePid = message.bridgePid as number;
        updateInventory(); observe("ptyOwnerStarted");
      } else if (message.kind === "bridge_started") {
        if (message.bridgePid !== bridgePid || !Number.isInteger(message.wrapperPid) || message.stdinTTY !== true || message.stdoutTTY !== true) return;
        wrapperPid = message.wrapperPid as number;
        updateInventory(); observe("ttyBridgeStarted");
      } else if (message.kind === "ready" && !artifact.devServerReadyReceived) {
        const payload = support.parseReady(message.payload);
        if (!payload || message.bridgePid !== bridgePid || message.wrapperPid !== wrapperPid) return;
        const inventory = updateInventory();
        const bridge = inventory.find(item => item.pid === bridgePid && item.parent === owner?.pid);
        const wrapper = inventory.find(item => item.pid === wrapperPid && item.parent === bridgePid);
        const innerCli = inventory.find(item => item.parent === wrapperPid);
        if (!bridge || !wrapper || !innerCli) return;
        artifact.senderOwnedRelationshipVerified = true;
        artifact.devServerReadyReceived = true;
        artifact.hotkeyRegistrationProven = true;
        artifact.localProxyReadyElapsedMs = Date.now() - start;
        observe("localProxyReady"); resolveReady(payload);
      } else if (message.kind === "hotkeys_registered") {
        artifact.hotkeyRegistrationProven = true; observe("interactiveUiRegistered");
      } else if (message.kind === "classification" && ["auth_error", "build_error", "unknown_error"].includes(message.value as string)) {
        if (!artifact.outputClasses.includes(message.value as string)) artifact.outputClasses.push(message.value as string);
        observe("cliOutputClassified");
      } else if (message.kind === "q_sent") { artifact.qSentCount = 1; observe("qSent"); }
      else if (message.kind === "wrapper_exit") { artifact.wrapperExitObserved = true; observe("wrapperExitObserved"); }
      else if (message.kind === "wrapper_close") { artifact.wrapperCloseObserved = true; observe("wrapperCloseObserved"); }
      else if (message.kind === "pty_exit") { artifact.ptyExitObserved = true; observe("ptyExitObserved"); }
      else if (message.kind === "owner_result_flushed") { artifact.ownerResultFlushed = true; observe("ownerResultFlushed"); }
      else if (message.kind === "result") {
        const state = message.state as Record<string, unknown>;
        for (const key of ["wrapperExitObserved", "wrapperCloseObserved", "wrapperSignalAbsent", "bridgeCompletionObserved", "ptyExitObserved"] as const) artifact[key] = state[key] === true;
        artifact.wrapperExitCode = Number.isInteger(state.wrapperExitCode) ? state.wrapperExitCode as number : null;
        artifact.ptyExitCode = Number.isInteger(state.ptyExitCode) ? state.ptyExitCode as number : null;
        artifact.qSentCount = state.qSentCount === 1 ? 1 : 0;
        observe("ptyOwnerResult");
      }
    });
    const startup = await bounded(Promise.race([localReady.then(value => ({ status: "ready" as const, value })),
      exitPromise.then(() => ({ status: "exit" as const }))]), 30_000);
    if (!startup.done || startup.value.status !== "ready") {
      artifact.classification = artifact.outputClasses.includes("auth_error")
        ? "BLOCKED: bound-profile remote preview authentication failed" : "BLOCKED: DEV_SERVER_READY not observed";
    } else {
      const url = `http://${startup.value.value.ip}:${startup.value.value.port}`;
      updateInventory();
      const healthStart = Date.now();
      artifact.health = await boundedHealthProbe({ fetch: (_url, init) => fetch(`${url}/primary-audit-health`, init) }, token, stage => {
        if (stage === "healthRequestStarted") artifact.healthAttempts++;
        observe(stage);
      });
      artifact.healthElapsedMs = Date.now() - healthStart;
      artifact.classification = artifact.health.status === "passed" ? "health_passed_cleanup_pending"
        : artifact.health.httpStatus === 403 ? "BLOCKED: protected health token binding failed" : "BLOCKED: protected remote health failed";
      updateInventory(); observe("healthCompleted");
      if (RUN_FACE_GEOMETRY_TARGETS && artifact.health.status === "passed") {
        observe("geometryTargetsSelected");
        artifact.providerCalls = {
          geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0,
          gemmaStarted: 0, gemmaCompleted: 0, gemmaFailed: 0, retry: 0,
        };
        const targeted = JSON.parse(fs.readFileSync(TARGETED_PRIMARY, "utf8")) as {
          primaryResults?: Array<{
            caseId?: string;
            sourceSha256?: string;
            sourceBytes?: number;
            sourceSelection?: { portraitImageIndex?: number; portraitRegion?: PortraitRegion | null };
            faceMeasurementEvidence?: unknown;
            relevantRenderHints?: unknown;
            fallbackFeaturesGlasses?: unknown;
          }>;
        };
        for (const selectedCase of selectedCases) {
          observe(`geometryCaseSelected:${selectedCase.id}`);
          const stored = targeted.primaryResults?.find(item => item.caseId === selectedCase.id);
          const portraitRegion = stored?.sourceSelection?.portraitRegion;
          if (!stored || stored.sourceSha256 !== selectedCase.sourceSha256 || stored.sourceBytes !== selectedCase.sourceBytes
            || stored.sourceSelection?.portraitImageIndex !== 0 || !portraitRegion?.faceBox) {
            artifact.classification = `BLOCKED: missing production-equivalent stored face localization for ${selectedCase.id}`;
            break;
          }
          const frozen = JSON.parse(fs.readFileSync(path.resolve(GENERALIZATION,
            `after/${selectedCase.id}/analysis-and-plan.json`), "utf8")) as { analysis?: PhotoAnalysis };
          if (!frozen.analysis) {
            artifact.classification = `BLOCKED: missing frozen replay analysis for ${selectedCase.id}`;
            break;
          }
          const hints = frozen.analysis.renderHints;
          const cropContext: AdaptiveHeadCropContext = {
            hairVolume: hints.hairVolume,
            hairTexture: hints.hairTexture,
            overallHairLength: hints.overallHairLength,
            sideHairAsymmetry: hints.sideHairAsymmetry,
            headCovering: frozen.analysis.fallbackFeatures.hat === "headscarf",
          };
          const source = fs.readFileSync(path.resolve(GENERALIZATION, `sources/${selectedCase.photoId}.jpg`));
          artifact.calls.jpegReads++;
          artifact.calls.hashChecks++;
          expect(source.byteLength).toBe(selectedCase.sourceBytes);
          expect(hash(source)).toBe(selectedCase.sourceSha256);
          expect(Array.from(source.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
          observe(`geometrySourceHashVerified:${selectedCase.id}`);
          const imageDataUrl = `data:image/jpeg;base64,${bytesToBase64(source)}`;
          artifact.calls.base64Preparations++;
          const localCrop = await createIdentityCrops(imageDataUrl, portraitRegion, cropContext);
          expect(localCrop?.diagnostics.quality.usableForFaceGeometry).toBe(true);
          if (!localCrop) {
            artifact.classification = `BLOCKED: production face crop unavailable for ${selectedCase.id}`;
            break;
          }
          artifact.calls.faceCropPreparations++;
          const cropBytes = Buffer.from(localCrop.faceDataUrl.slice(localCrop.faceDataUrl.indexOf(",") + 1), "base64");
          observe(`geometryCropPrepared:${selectedCase.id}`);
          const runId = randomBytes(16).toString("hex");
          artifact.calls.jpegTransmissions++;
          artifact.calls.geometryPosts++;
          observe(`geometryPostStarted:${selectedCase.id}`);
          const response = await fetch(`${url}/face-geometry-audit`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-primary-audit-token": token, "x-primary-audit-run-id": runId },
            body: JSON.stringify({ imageDataUrl, portraitRegion, cropContext }),
            signal: AbortSignal.timeout(60_000),
          });
          observe(`geometryHeadersReceived:${selectedCase.id}`);
          const result = await response.json() as GeometryRemoteResult;
          observe(`geometryBodyParsed:${selectedCase.id}`);
          const accounting = accountingOf(result.auditState, runId);
          artifact.providerAccounting = accounting.dispatch;
          if (accounting.dispatch === "known") {
            for (const key of ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const) {
              artifact.providerCalls[key] += accounting.providerCalls[key];
            }
          }
          expect(result.crop).toEqual(localCrop.diagnostics);
          artifact.geometryResults.push({
            caseId: selectedCase.id,
            sourceSha256: selectedCase.sourceSha256,
            sourceBytes: selectedCase.sourceBytes,
            sourceImageIndex: stored.sourceSelection.portraitImageIndex,
            storedPortraitRegion: portraitRegion,
            primaryFaceMeasurementEvidence: stored.faceMeasurementEvidence ?? null,
            primaryRelevantRenderHints: stored.relevantRenderHints ?? null,
            primaryFallbackFeaturesGlasses: stored.fallbackFeaturesGlasses ?? null,
            cropContext,
            crop: localCrop.diagnostics,
            faceCropSha256: hash(cropBytes),
            faceCropEncodedBytes: cropBytes.byteLength,
            httpStatus: response.status,
            ok: result.ok === true,
            elapsedMs: result.elapsedMs ?? null,
            providerShapeValid: result.providerShapeValid ?? false,
            semanticValidationPassed: result.ok === true && (result.errors?.length ?? 0) === 0,
            errors: result.errors ?? [],
            measurements: result.measurements ?? null,
            geometry: result.geometry ?? null,
            providerHttpStatus: result.httpStatus ?? null,
            providerStatus: result.providerStatus ?? null,
            providerAccounting: accounting.dispatch,
            providerCalls: accounting.dispatch === "known" ? accounting.providerCalls : null,
          });
          observe(`geometryCompleted:${selectedCase.id}`);
          if (!response.ok || accounting.dispatch !== "known") {
            artifact.classification = !response.ok
              ? "BLOCKED: geometry POST did not return HTTP success"
              : "BLOCKED: provider accounting became unknown";
            break;
          }
        }
        if (artifact.geometryResults.length === selectedCases.length && artifact.providerAccounting === "known") {
          artifact.classification = "geometry_audit_completed_cleanup_pending";
        }
      }
      if (RUN_PRIMARY && artifact.health.status === "passed") {
        observe(RUN_TARGETED_PRIMARY ? "targetedCasesSelected" : RUN_SIX_CASE_PRIMARY ? "batchSelected" : "canarySelected");
        artifact.providerCalls = {
          geminiStarted: 0, geminiCompleted: 0, geminiFailed: 0,
          gemmaStarted: 0, gemmaCompleted: 0, gemmaFailed: 0, retry: 0,
        };
        const cueNames = ["eyeSpacing", "eyeOpenness", "eyeFootprint", "browEyeDistance",
          "browSlope", "mouthWidth", "mouthOpenness", "expression"];
        for (const selectedCase of selectedCases) {
          observe(`caseSelected:${selectedCase.id}`);
          const source = fs.readFileSync(path.resolve(GENERALIZATION, `sources/${selectedCase.photoId}.jpg`));
          artifact.calls.jpegReads++;
          artifact.calls.hashChecks++;
          expect(source.byteLength).toBe(selectedCase.sourceBytes);
          expect(hash(source)).toBe(selectedCase.sourceSha256);
          expect(Array.from(source.subarray(0, 3))).toEqual([0xff, 0xd8, 0xff]);
          observe(`sourceHashVerified:${selectedCase.id}`);
          const imageDataUrl = `data:image/jpeg;base64,${bytesToBase64(source)}`;
          artifact.calls.base64Preparations++;
          observe(`payloadPreparedInMemory:${selectedCase.id}`);
          const runId = randomBytes(16).toString("hex");
          artifact.calls.jpegTransmissions++;
          artifact.calls.primaryPosts++;
          observe(`primaryPostStarted:${selectedCase.id}`);
          const response = await fetch(`${url}/primary-audit`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-primary-audit-token": token, "x-primary-audit-run-id": runId },
            body: JSON.stringify({ imageDataUrl }),
            signal: AbortSignal.timeout(120_000),
          });
          observe(`primaryHeadersReceived:${selectedCase.id}`);
          const result = await response.json() as RemoteResult;
          observe(`primaryBodyParsed:${selectedCase.id}`);
          const accounting = accountingOf(result.auditState, runId);
          artifact.providerAccounting = accounting.dispatch;
          if (accounting.dispatch === "known") {
            for (const key of ["geminiStarted", "geminiCompleted", "geminiFailed", "gemmaStarted", "gemmaCompleted", "gemmaFailed"] as const) {
              artifact.providerCalls[key] += accounting.providerCalls[key];
            }
          }
          const evidence = result.analysis?.faceMeasurementEvidence;
          const cues = evidence?.cues;
          const rubricComparison = cueNames.map(cue => {
            const expected = selectedCase.rubric[cue];
            const provider = cues?.[cue];
            const coverage = expected.kind === "unscorable" ? "unscorable"
              : !provider ? "absent" : provider.value === "unknown" ? "unknown" : "covered";
            const agreement = coverage !== "covered" || !provider ? "n/a"
              : expected.values?.includes(provider.value)
                ? expected.kind === "ambiguous" ? "ambiguous-compatible" : "exact"
                : "wrong";
            return { caseId: selectedCase.id, cue, sourceExpected: expected.values ?? null,
              sourceScorable: expected.kind !== "unscorable", providerValue: provider?.value ?? null,
              providerProvenance: provider?.provenance ?? null, providerConfidence: provider?.confidence ?? null,
              coverage, agreement };
          });
          const primary = {
            caseId: selectedCase.id,
            sourceSha256: selectedCase.sourceSha256,
            sourceBytes: selectedCase.sourceBytes,
            sourceGlassesOrCovering: selectedCase.glassesOrCovering,
            httpStatus: response.status,
            ok: result.ok === true,
            elapsedMs: result.elapsedMs ?? null,
            attempts: result.attempts ?? null,
            providerSequence: result.providerSequence ?? [],
            validation: result.validation ?? null,
            providerAccounting: accounting.dispatch,
            providerCalls: accounting.dispatch === "known" ? accounting.providerCalls : null,
            failure: result.failure ? { reason: result.failure.reason ?? null, detail: result.failure.detail ?? null } : null,
            quality: result.analysis?.quality ?? null,
            visibleRegions: result.analysis?.visibleRegions ?? null,
            sourceSelection: result.analysis?.sourceSelection ?? null,
            faceMeasurementEvidence: evidence ?? null,
            relevantRenderHints: result.analysis?.relevantRenderHints ?? null,
            canonicalFaceCues: result.analysis?.canonicalFaceCues ?? null,
            fallbackFeaturesGlasses: result.analysis?.fallbackFeaturesGlasses ?? null,
            observedAccessories: result.analysis?.observedAccessories ?? null,
            canonicalAccessoryCues: result.analysis?.canonicalAccessoryCues ?? null,
            measurementTraceSelected: result.analysis?.consumerTrace?.measurementTrace
              ? Object.fromEntries(Object.entries(result.analysis.consumerTrace.measurementTrace)
                .map(([cue, decision]) => [cue, decision.selected ?? null])) : null,
            categoricalOnlyFaceLayoutPlan: result.analysis?.consumerTrace?.faceLayoutPlan ?? null,
            rubricComparison,
          };
          if (RUN_SINGLE_PRIMARY) {
            artifact.primary = primary;
            artifact.rubricComparison = rubricComparison;
          } else artifact.primaryResults.push(primary);
          artifact.remainingSixAnalyzed = RUN_SIX_CASE_PRIMARY ? artifact.primaryResults.length : 0;
          observe(`primaryCompleted:${selectedCase.id}`);
          if (!response.ok || accounting.dispatch !== "known") {
            artifact.classification = !response.ok
              ? "BLOCKED: primary POST did not return HTTP success"
              : "BLOCKED: provider accounting became unknown";
            break;
          }
        }
        if (RUN_TARGETED_PRIMARY && artifact.primaryResults.length === selectedCases.length
          && artifact.providerAccounting === "known") artifact.classification = "targeted_recheck_completed_cleanup_pending";
        else if (RUN_SIX_CASE_PRIMARY && artifact.primaryResults.length === selectedCases.length
          && artifact.providerAccounting === "known") artifact.classification = "six_case_batch_completed_cleanup_pending";
        else if (RUN_SINGLE_PRIMARY) {
          const primary = artifact.primary;
          const passed = primary?.ok === true && Boolean(primary.faceMeasurementEvidence)
            && (primary.validation as Record<string, string> | null)?.compactProviderSchema === "passed"
            && (primary.validation as Record<string, string> | null)?.compactStrictRuntime === "passed"
            && (primary.validation as Record<string, string> | null)?.richPhotoAnalysis === "passed";
          artifact.classification = passed ? "canary_passed_cleanup_pending" : "BLOCKED: primary analysis validation failed";
        }
      }
    }
  } catch (error) {
    // Error detail is classified, never the raw message/path/token.
    artifact.classification = artifact.calls.primaryPosts > 0
      ? "BLOCKED: primary POST failed before a validated response"
      : artifact.calls.hashChecks > 0
        ? "BLOCKED: canary source hash or byte-count verification failed"
        : "BLOCKED: audit config or lifecycle preflight failed";
    const safe = exceptionDiagnostic(error, "startup");
    observe(`exception_${safe.messageClassified}`);
  } finally {
    if (owner && !ownerExited && artifact.hotkeyRegistrationProven && !qRequested) {
      qRequested = true; artifact.shutdownRequested = true; observe("shutdownRequested");
      owner.send({ command: "q", registrationProven: true });
    }
    if (owner && exitPromise && closePromise) {
      const completion = await bounded(Promise.all([exitPromise, closePromise]), 30_000);
      if (!completion.done || !ownerClosed) {
        artifact.cleanupFailed = true; artifact.classification = "BLOCKED: graceful q teardown was not confirmed";
        // Fail closed: do not close the terminal or terminate live Wrangler.
        // Keep the dedicated owner alive and identifiable; no further run.
        owner.unref(); if (owner.connected) owner.disconnect();
      }
    }
    if (!owner || ownerClosed) {
      try {
        const after = support.processSnapshot();
        artifact.ownedProcessInventoryClean = !after.some(record => owned.some(old => old.pid === record.pid && old.created === record.created));
        if (!artifact.ownedProcessInventoryClean) { artifact.cleanupFailed = true; artifact.classification = "BLOCKED: owned process cleanup was incomplete"; }
      } catch { artifact.cleanupFailed = true; artifact.classification = "BLOCKED: owned process cleanup could not be verified"; }
      if (artifact.ownedProcessInventoryClean) {
        try {
          if (tokenFile) fs.unlinkSync(tokenFile);
          artifact.temporaryTokenFileRemoved = !tokenFile || !fs.existsSync(tokenFile);
          if (tokenDirectory) fs.rmdirSync(tokenDirectory);
          if (artifact.temporaryConfigUsed) fs.unlinkSync(configPath);
          artifact.temporaryConfigRemoved = !fs.existsSync(configPath);
        } catch { artifact.cleanupFailed = true; artifact.classification = "BLOCKED: temporary audit file cleanup failed"; }
      }
    }
    token = "";
    artifact.productionConfigHashAfter = hash(fs.readFileSync("wrangler.jsonc"));
    artifact.productionConfigChanged = artifact.productionConfigHashAfter !== artifact.productionConfigHashBefore;
    artifact.wranglerGracefulTeardownPathCompleted = artifact.shutdownRequested && artifact.qSentCount === 1
      && artifact.wrapperExitObserved && artifact.wrapperCloseObserved && artifact.wrapperExitCode === 0 && artifact.wrapperSignalAbsent
      && artifact.bridgeCompletionObserved && artifact.ptyExitObserved && artifact.ptyExitCode === 0
      && artifact.ownerResultFlushed && artifact.ownerExitObserved && artifact.ownerCloseObserved && artifact.ownerExitCode === 0;
    if (artifact.startupAttempts === 1 && !artifact.wranglerGracefulTeardownPathCompleted) {
      artifact.cleanupFailed = true; artifact.classification = "BLOCKED: graceful q teardown was not confirmed";
    }
    if (artifact.health?.status === "passed" && artifact.wranglerGracefulTeardownPathCompleted
      && artifact.ownedProcessInventoryClean && artifact.temporaryConfigRemoved && artifact.temporaryTokenFileRemoved
      && !artifact.productionConfigChanged && !artifact.cleanupFailed) {
      if (!RUN_REMOTE) artifact.classification = "READY_FOR_SINGLE_BOUND_PROFILE_PRIMARY_CANARY";
      else if (RUN_FACE_GEOMETRY_TARGETS && artifact.classification === "geometry_audit_completed_cleanup_pending") {
        artifact.classification = "READY_TO_REVIEW_FACE_GEOMETRY_LOW_EYE_TARGET_AUDIT";
      }
      else if (artifact.classification === "canary_passed_cleanup_pending") artifact.classification = "READY_TO_REVIEW_PRIMARY_FACE_MEASUREMENT_CANARY";
      else if (artifact.classification === "six_case_batch_completed_cleanup_pending") artifact.classification = "READY_TO_REVIEW_SIX_CASE_PRIMARY_FACE_MEASUREMENT_AUDIT";
      else if (artifact.classification === "targeted_recheck_completed_cleanup_pending") artifact.classification = "READY_TO_REVIEW_TARGETED_EYE_CATEGORY_RECHECK";
    }
    observe("finalCheckpoint"); await writes;
  }
  expect(artifact.startupAttempts).toBeLessThanOrEqual(1);
  expect(artifact.healthAttempts).toBeLessThanOrEqual(1);
  expect(artifact.qSentCount).toBeLessThanOrEqual(1);
  const primaryLimit = RUN_TARGETED_PRIMARY ? 3 : RUN_SIX_CASE_PRIMARY ? 6 : RUN_SINGLE_PRIMARY ? 1 : 0;
  const geometryLimit = RUN_FACE_GEOMETRY_TARGETS ? 2 : 0;
  expect(artifact.calls.primaryPosts).toBeLessThanOrEqual(primaryLimit);
  expect(artifact.calls.geometryPosts).toBeLessThanOrEqual(geometryLimit);
  expect(artifact.calls.jpegReads).toBeLessThanOrEqual(primaryLimit + geometryLimit);
  expect(artifact.providerCalls?.geminiStarted ?? 0).toBeLessThanOrEqual(primaryLimit);
  expect(artifact.providerCalls?.gemmaStarted ?? 0).toBeLessThanOrEqual(primaryLimit + geometryLimit);
  expect(artifact.providerCalls?.retry ?? 0).toBe(0);
  expect(Object.values(artifact.prohibited).every(value => value === 0)).toBe(true);
  expect(artifact.productionConfigChanged).toBe(false);
}, RUN_SIX_CASE_PRIMARY || RUN_TARGETED_PRIMARY || RUN_FACE_GEOMETRY_TARGETS ? 900_000 : 300_000);
