// Offline, one-source visual review. Never imports a remote/live selector.
// Original/derivative bytes stay in memory; only identities are persisted.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import jpeg from "jpeg-js";

const require = createRequire(import.meta.url);
const { chromium } = require("C:/Users/sangm/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const sha = value => createHash("sha256").update(value).digest("hex");
const summaryPath = "evaluation-artifacts/real-app-formal-suit-diagnostic-v3-e2e-20261007-004/summary.json";
const summaryBytes = fs.readFileSync(summaryPath);
if (sha(summaryBytes) !== "c47ee4e58111e816a5cd1c27150028b229724e5b9f2ecce7e0e120796a706561") throw new Error("historical_identity_mismatch");
const run = JSON.parse(summaryBytes.toString()).currentDefaultE2E;
const productionPath = path.resolve("../src/lib/imageQuality.ts");
if (sha(fs.readFileSync(productionPath)) !== run.preprocessing.preprocessingSourceSha256) throw new Error("preprocessing_contract_changed");
const original = fs.readFileSync("C:/Users/sangm/OneDrive/사진/Saved Pictures/원본-01.jpg");
if (sha(original) !== run.preprocessing.source.sha256 || original.length !== run.preprocessing.source.bytes) throw new Error("original_identity_mismatch");
const decodedOriginal = jpeg.decode(original, { useTArray: true, maxMemoryUsageInMB: 256 });
if (sha(decodedOriginal.data) !== run.preprocessing.source.decodedRgbaSha256) throw new Error("original_rgba_mismatch");
const bundle = buildSync({ stdin: { resolveDir: process.cwd(), contents: `import { preparePhotoForUpload } from ${JSON.stringify(productionPath.replaceAll("\\", "/"))}; window.productionPreparePhotoForUpload = preparePhotoForUpload;` },
  bundle: true, write: false, platform: "browser", format: "iife" }).outputFiles[0].text;
let browser, context, analysisBytes, watchdog;
const blocked = [];
try {
  browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run", "--host-resolver-rules=MAP * ~NOTFOUND"] });
  context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", async route => { blocked.push(new URL(route.request().url()).protocol); await route.abort(); });
  const page = await context.newPage();
  await page.addScriptTag({ content: bundle });
  const prepared = await page.evaluate(async input => {
    const encodings = [], originalEncoder = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (...args) {
      const result = originalEncoder.apply(this, args);
      encodings.push({ width: this.width, height: this.height, quality: args[1], chars: result.length });
      return result;
    };
    try { return { prepared: await window.productionPreparePhotoForUpload(input), encodings }; }
    finally { HTMLCanvasElement.prototype.toDataURL = originalEncoder; }
  }, `data:image/jpeg;base64,${original.toString("base64")}`);
  const describe = dataUrl => {
    if (!dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("jpeg_representation_mismatch");
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
    const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256 });
    return { bytes: bytes.length, sha256: sha(bytes), rgbaSha256: sha(decoded.data), width: decoded.width, height: decoded.height,
      dataUrlChars: dataUrl.length, quality: prepared.encodings.find(e => e.width === decoded.width && e.chars === dataUrl.length)?.quality };
  };
  const analysis = describe(prepared.prepared.analysisDataUrl), generation = describe(prepared.prepared.generationDataUrl);
  const analysisEqual = JSON.stringify(analysis) === JSON.stringify(run.preprocessing.analysis);
  const generationEqual = JSON.stringify(generation) === JSON.stringify(run.preprocessing.generation);
  const root = fs.mkdtempSync("evaluation-artifacts/real-app-analysis-input-fidelity-offline-20261007-");
  fs.writeFileSync(`${root}/verification.json`, JSON.stringify({ providerCalls: 0, remoteStartup: 0,
    productionChanges: 0, sourceSummarySha256: sha(summaryBytes), runId: run.runId,
    originalSha256: sha(original), originalBytes: original.length, originalRgbaSha256: sha(decodedOriginal.data),
    preprocessingSourceSha256: run.preprocessing.preprocessingSourceSha256, browserVersion: browser.version(),
    analysis, generation, exactAnalysisIdentity: analysisEqual, exactGenerationIdentity: generationEqual,
    externalPageRequests: 0, blockedPageRequestCount: blocked.length,
    rawImagesPersisted: false, rawBase64Persisted: false,
    manualCueReview: "pending_in_memory_visual_review" }, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ root, exactAnalysisIdentity: analysisEqual, exactGenerationIdentity: generationEqual }));
  if (!analysisEqual || !generationEqual) throw new Error("reproduction_not_exact_do_not_claim_actual_input");
  analysisBytes = Buffer.from(prepared.prepared.analysisDataUrl.split(",")[1], "base64");
} finally {
  await context?.close();
  await browser?.close();
}

// One-shot loopback transfer to the local visual tool, not a provider request.
// The browser is already closed. No image is written to disk or stdout.
const server = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/analysis.jpg" || !analysisBytes) {
    response.writeHead(404); response.end(); return;
  }
  const bytes = analysisBytes; analysisBytes = null;
  response.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" });
  response.end(bytes, () => { clearTimeout(watchdog); server.close(); });
});
watchdog = setTimeout(() => { analysisBytes = null; server.close(); }, 120_000);
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ localVisualPort: server.address().port })));
