// Offline equivalence/cost audit, not a reconstruction of the missing D018 response.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { boundedProjection } from "./audit/currentDefaultE2E";
import { freshAuditOutput } from "./freshAuditOutput";

// Frozen pre-change projection oracle. Keep redaction, limits and Unicode behavior exact.
function original(value: unknown, depth = 0, path = ""): unknown {
  if (depth > 18) return null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return /data:|base64|AIza|cfut_|Bearer |https?:\/\/|[A-Za-z0-9+/]{160,}/i.test(value)
    ? "[redacted]" : [...value].map(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char).join("").slice(0, 240);
  if (Array.isArray(value)) return value.slice(0,
    /(?:^|\.)skinPlan\.headIdentityPlan\.ownership\.cells$/.test(path) ? 768 : 512,
  ).map(item => original(item, depth + 1, `${path}[]`));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 128)
    .filter(([key]) => !/prompt|portraitEvidence|raw|secret|token|header|base64|dataUrl/i.test(key))
    .map(([key, item]) => [key, original(item, depth + 1, path ? `${path}.${key}` : key)]));
  return null;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sourceRoot = "evaluation-artifacts/reference-style-v3-e2e-teal-hat-hoodie-20261011-017";

it("reduces repeated categorical string scans without changing the saved D017 projection", () => {
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw Error("OFFLINE_ONLY"); });
  const bytes = readFileSync(`${sourceRoot}/summary.json`, "utf8");
  expect(sha(bytes)).toBe("50b1af0b444f88fa7d4d4f083a1617b7fd8787608d48b58b86ee7c2eaa14944d");
  const trace = JSON.parse(bytes).currentDefaultE2E.result.propagationTrace;
  const sample = { skinPlan: trace.skinPlan.skinPlan, primary: trace.primary, renderAnalysis: trace.renderAnalysis,
    referenceStyle: trace.referenceStyle, injectedParameters: trace.injectedParameters };
  const immutable = JSON.stringify(sample), nativeTest = RegExp.prototype.test;
  let scans = 0;
  const spy = vi.spyOn(RegExp.prototype, "test").mockImplementation(function(this: RegExp, value: string) {
    if (this.source.includes("Bearer ")) scans++;
    return nativeTest.call(this, value);
  });
  try {
    const before = original(sample), oldScans = scans;
    scans = 0; const after = boundedProjection(sample), newScans = scans;
    spy.mockRestore();
    expect(after).toEqual(before); expect(JSON.stringify(sample)).toBe(immutable);
    expect(newScans).toBeLessThan(oldScans / 2);
    const profile = (fn: typeof original) => {
      const samples: number[] = [];
      for (let i = 0; i < 15; i++) { const start = performance.now(); fn(sample); samples.push(performance.now() - start); }
      samples.sort((a, b) => a - b); return { medianWallMs: samples[7], samples: samples.length };
    };
    const timing = { original: profile(original), current: profile(boundedProjection) };
    const out = freshAuditOutput("evaluation-artifacts/audit-projection-memo-20261011-");
    writeFileSync(`${out}/summary.json`, JSON.stringify({ mode: "offline_saved_D017_projection_equivalence",
      sourceSummarySha256: sha(bytes), sourceRoot, projectionSha256: sha(JSON.stringify(after)),
      exactProjectionEquality: true, oldStringScans: oldScans, newStringScans: newScans,
      timing, remoteCpuMeasurement: false, D018FailureReproduced: false, D018AnalysisReconstructed: false,
      nodeVersion: process.version, providerCalls: 0, cacheScope: "one_projection_call", cacheMaxEntries: 512,
      maxMemoizedStringLength: 240, productionSourceChange: false,
    }, null, 2), { flag: "wx" });
    expect(network).not.toHaveBeenCalled(); console.info("PROJECTION_MEMO_REVIEW", out);
  } finally { spy.mockRestore(); network.mockRestore(); }
});

it("preserves redaction, bounds, Unicode and per-path ownership limits", () => {
  let deep: unknown = "leaf";
  for (let i = 0; i < 22; i++) deep = { child: deep };
  const strings = ["safe", "", "[redacted]", "a\u0000b\n\u007f", "😀".repeat(150),
    "x".repeat(160), "https://example.invalid", "Bearer synthetic-test", "data:image/test", "base64",
    "AIzaSynthetic", "cfut_synthetic", "café 漢字", ...Array.from({ length: 540 }, (_, i) => `value-${i}`)];
  const input = { repeated: strings.slice(0, 10).flatMap(v => [v, v]),
    beforeCacheFull: strings.slice(0, 400), afterCacheFull: strings.slice(400), again: strings.slice(0, 10),
    unsafeLongSuffix: `${"!".repeat(241)}Bearer synthetic-test`, deep,
    secret: "never", primaryPrompt: "never", rawResponse: "never", token: "never", headers: { any: "never" },
    invalid: [NaN, Infinity, -Infinity, undefined, null, false, true],
    skinPlan: { headIdentityPlan: { ownership: { cells: Array.from({ length: 800 }, (_, i) => ({ i, owner: "hair" })) } } },
    other: Array.from({ length: 800 }, (_, i) => i),
    entries: Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`key${i}`, "safe"])) };
  expect(boundedProjection(input)).toEqual(original(input));
  expect(boundedProjection(input, 17, "custom")).toEqual(original(input, 17, "custom"));
  expect(boundedProjection("safe")).toBe("safe");
  expect(boundedProjection("Bearer synthetic-test")).toBe("[redacted]");
  expect(boundedProjection(input)).toEqual(original(input));
});
