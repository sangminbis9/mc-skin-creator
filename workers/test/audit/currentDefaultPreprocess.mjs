// Loopback-only, single-source bridge. Images live in memory, never in artifacts.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { buildSync } from "esbuild";
import { resolve } from "node:path";

const approved = JSON.parse(readFileSync("test/audit/approvedGeneralizationE2E.json", "utf8"));
const selector = process.env.RUN_CURRENT_DEFAULT_V3_E2E;
if (selector && selector !== "approved-29002888-20260928-033" && !Object.hasOwn(approved, selector))
  throw new Error("e2e_selector_not_approved");
const selected = approved[selector] ?? {
  photoId: "29002888", sourceBytes: 204067,
  sourceSha256: "0c5a890f0e54275e2851a66f5f6ba92578c0d4feabf83c826aafa57cbf7a1d5a",
};
const sourceMime = selected.sourceMime ?? "image/jpeg";
if (!["image/jpeg", "image/png"].includes(sourceMime)) throw new Error("e2e_source_mime_not_supported");
const source = readFileSync(selected.sourcePath ?? `evaluation-artifacts/generalization-20260905/sources/${selected.photoId}.jpg`);
const sha = value => createHash("sha256").update(value).digest("hex");
if (source.length !== selected.sourceBytes || sha(source) !== selected.sourceSha256)
  throw new Error("e2e_source_mismatch");
const production = resolve("../src/lib/imageQuality.ts");
const bundle = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
  import { preparePhotoForUpload } from ${JSON.stringify(production.replaceAll("\\", "/"))};
  async function main() {
    const selectedQualities = [];
    const original = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      const result = original.apply(this, args);
      selectedQualities.push({ width: this.width, height: this.height, quality: args[1], chars: result.length });
      return result;
    };
    try {
      const source = new File([await (await fetch('/source.jpg')).blob()], ${JSON.stringify(selected.photoId + (sourceMime === "image/png" ? ".png" : ".jpg"))}, {type:${JSON.stringify(sourceMime)}});
      const prepared = await preparePhotoForUpload(source);
      await fetch('/result', {method:'POST', body:JSON.stringify({prepared, selectedQualities, userAgent:navigator.userAgent})});
      document.body.textContent = 'PRODUCTION_PREPROCESSING_COMPLETE';
    } finally { HTMLCanvasElement.prototype.toDataURL = original; }
  }
  main().catch(() => {document.body.textContent = 'PREPROCESSING_FAILED';});
` }, bundle: true, write: false, platform: "browser", format: "iife" }).outputFiles[0].contents;
let prepared = null;
let sourceServed = false;
const server = createServer(async (request, response) => {
  const send = (status, type, body) => { response.writeHead(status, { "content-type": type, "cache-control": "no-store" }); response.end(body); };
  if (request.method === "GET" && request.url === "/") return send(200, "text/html", '<!doctype html><meta charset="utf-8"><body>RUNNING<script src="/bundle.js"></script>');
  if (request.method === "GET" && request.url === "/bundle.js") return send(200, "text/javascript", bundle);
  if (request.method === "GET" && request.url === "/source.jpg" && !sourceServed) { sourceServed = true; return send(200, sourceMime, source); }
  if (request.method === "POST" && request.url === "/result" && !prepared) {
    const chunks = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > 3_100_000) return send(413, "text/plain", "too_large"); chunks.push(chunk); }
    prepared = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    console.log("PRODUCTION_PREPROCESSING_COMPLETE");
    return send(200, "text/plain", "ok");
  }
  if (request.method === "GET" && request.url === "/consume" && prepared) {
    send(200, "application/json", JSON.stringify({ ...prepared, sourceSha256: sha(source), sourceBytes: source.length,
      preprocessingSourceSha256: sha(readFileSync(production)) }));
    prepared = null; clearTimeout(timer); server.close(); return;
  }
  return send(404, "text/plain", "not_ready_or_consumed");
});
const timer = setTimeout(() => { prepared = null; server.close(); }, 15 * 60_000);
server.listen(59926, "127.0.0.1", () => console.log("LOCAL_PREPROCESS_READY 59926"));
