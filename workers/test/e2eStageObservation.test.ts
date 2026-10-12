// Offline only: no remote runner, binding, image or provider execution.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { E2E_STAGES, createStageEmitter, stageObservation, type StageObservation } from "./audit/e2eStageObservation";
import { atomicCheckpoint, readLatestAuditCheckpoint } from "./primaryAuditRunnerSupport";
import { freshAuditOutput } from "./freshAuditOutput";

const fixture = createRequire(import.meta.url)("./fixtures/primaryAuditCliHealthPty.cjs") as {
  createStageLogParser(): (chunk: string) => StageObservation[];
};
const runId = "a".repeat(32);
const frame = (stage: string, id = runId) => `MCSKIN_E2E_STAGE_V1|${id}|${stage}|END`;
afterEach(() => vi.restoreAllMocks());

it("emits each fixed stage once, with no caller payload and no changes on logger failure", () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const mark = createStageEmitter(runId);
  for (const stage of E2E_STAGES) { mark(stage); mark(stage); }
  expect(log.mock.calls).toEqual(E2E_STAGES.map(s => [frame(s)]));
  expect(fixture.createStageLogParser()(log.mock.calls.map(c => c[0]).join("\r\n")))
    .toEqual(E2E_STAGES.map(stage => ({ runId, stage })));
  const bad = createStageEmitter("secret/path/not-a-run"); bad("handler_entered");
  expect(log).toHaveBeenCalledTimes(E2E_STAGES.length);
  log.mockImplementation(() => { throw new Error("synthetic log unavailable"); });
  expect(() => createStageEmitter(runId)("handler_entered")).not.toThrow();
});

it("recovers fixed frames across every chunk boundary and drops noise, duplicates, invalid stages/IDs", () => {
  const text = `untrusted raw details\r\n\x1b[32m${frame("gemmaPrimary_returned")}\x1b[0m\r\n`;
  for (let i = 0; i <= text.length; i++) {
    const parse = fixture.createStageLogParser();
    expect([...parse(text.slice(0, i)), ...parse(text.slice(i))])
      .toEqual([{ runId, stage: "gemmaPrimary_returned" }]);
    expect(parse(text)).toEqual([]);
  }
  const parse = fixture.createStageLogParser();
  expect(parse(`${frame("arbitrary_secret")}\n${frame("handler_entered", "not-valid")}\n`
    + frame("handler_entered").slice(0, -1))).toEqual([]);
  expect(parse("D")).toEqual([{ runId, stage: "handler_entered" }]);
  expect(parse("untrusted ".repeat(10_000))).toEqual([]);
});

it("installed remote-dev formatter forwards console lines but does not expose resource outcome", () => {
  const cli = readFileSync("node_modules/wrangler/wrangler-dist/cli.js", "utf8");
  expect(cli).toContain('this.#activeTail.on("message", realishPrintLogs2)');
  const body = cli.slice(cli.indexOf("function realishPrintLogs2(data) {"), cli.indexOf("function prettyPrintLogs(data) {"));
  expect(body).not.toContain("outcome");
  const logger = { console: vi.fn(), error: vi.fn() };
  vm.runInNewContext(`${body}; realishPrintLogs2(data);`, { logger2: logger, data: JSON.stringify({
    logs: [{ level: "info", message: [frame("handler_entered")] }], exceptions: [], outcome: "exceededCpu",
  }) });
  expect(logger.console.mock.calls).toEqual([["info", frame("handler_entered")]]);
  expect(logger.error).not.toHaveBeenCalled();
});

function supervisor() {
  const source = readFileSync("test/primaryAuditCliProtectedHealth.test.ts", "utf8");
  const start = source.indexOf('} else if (message.kind === "e2e_stage") {');
  const end = source.indexOf('} else if (message.kind === "classification"', start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const artifact = { health: { status: "passed" }, currentDefaultE2E: { runId, generationPosts: 1 },
    terminalStageEvidence: { scope: "best_effort_cli_log_observation_not_provider_accounting",
      observations: [] as Array<StageObservation & { receivedElapsedMs: number }> },
    providerAccounting: "unknown", providerCalls: null, qSentCount: 0 };
  const observe = vi.fn();
  const receive = (message: unknown) => vm.runInNewContext(
    `(function() { ${source.slice(start + '} else if (message.kind === "e2e_stage") {'.length, end)} })();`,
    { message, artifact, observe, stageObservation, Date: { now: () => 123 }, start: 100 },
  );
  return { artifact, observe, receive };
}

it("supervisor only checkpoints same-run post-dispatch markers, without upgrading unknown accounting", async () => {
  const s = supervisor();
  s.receive({ runId: "b".repeat(32), stage: "handler_entered" });
  s.artifact.health.status = "failed"; s.receive({ runId, stage: "handler_entered" });
  s.artifact.health.status = "passed"; s.artifact.currentDefaultE2E.generationPosts = 0;
  s.receive({ runId, stage: "handler_entered" });
  expect(s.observe).not.toHaveBeenCalled();
  s.artifact.currentDefaultE2E.generationPosts = 1;
  s.receive({ runId, stage: "handler_entered", raw: "must never persist", secret: "must never persist" });
  s.receive({ runId, stage: "handler_entered" });
  s.receive({ runId, stage: "not_allowed" });
  expect(s.observe).toHaveBeenCalledExactlyOnceWith("e2eStageLogObserved");
  expect(s.artifact.terminalStageEvidence.observations).toEqual([{ runId, stage: "handler_entered", receivedElapsedMs: 23 }]);
  expect(s.artifact.providerAccounting).toBe("unknown"); expect(s.artifact.providerCalls).toBeNull();
  expect(s.artifact.qSentCount).toBe(0);
  const out = freshAuditOutput("evaluation-artifacts/e2e-stage-observation-offline-20261010-");
  await atomicCheckpoint(`${out}/summary.json`, s.artifact, "syntheticStageObserved");
  const recovered = await readLatestAuditCheckpoint(`${out}/summary.json`);
  expect(recovered?.snapshot).toEqual(s.artifact);
  expect(readFileSync(`${out}/summary.json`, "utf8")).not.toContain("must never persist");
  console.info("OFFLINE_STAGE_OBSERVATION", out);
});

it("PTY callback forwards only parsed fields and keeps the original feature-mode gate", () => {
  const source = readFileSync("test/fixtures/primaryAuditCliHealthPty.cjs", "utf8");
  const start = source.indexOf("terminal.onData(chunk => {") + "terminal.onData(chunk => {".length;
  const end = source.indexOf("\n    });", start);
  const send = vi.fn();
  for (const featureMode of ["primary-only", "current-default-e2e"]) {
    send.mockClear();
    vm.runInNewContext(`let boundedText = ""; ${source.slice(start, end)}`, {
      chunk: `untrusted secret\n${frame("handler_entered")}\n`, send, featureMode,
      parseStages: fixture.createStageLogParser(), interactive: false, classes: new Set(),
    });
    expect(send.mock.calls).toEqual(featureMode === "primary-only" ? [] : [[{ kind: "e2e_stage", runId, stage: "handler_entered" }]]);
  }
});
