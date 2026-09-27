import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve("evaluation-artifacts/open-anchor-production-preprocessing-parity-20260924-001");
const source = resolve("evaluation-artifacts/face-geometry-openness-external-open-source-freeze-20260923-001/source/200916_EPFL_Raffaella_Buonsanti_Portrait.jpg");
const expected = "a24cb362e475595fd77582fa6c2dfade0e1d7633449d57c44f4dd3647d85fdac";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceBytes = readFileSync(source);
if (sourceBytes.length !== 3_497_355 || sha(sourceBytes) !== expected) throw new Error("canonical_source_mismatch");
if (existsSync(root)) throw new Error("fresh_artifact_root_required");
mkdirSync(root, { recursive: false });
const bundle = readFileSync(resolve("test/audit/productionPreprocessBrowser.bundle.js"));
const html = '<!doctype html><meta charset="utf-8"><title>Production preprocessing audit</title><p id="status">RUNNING</p><script src="/bundle.js"></script>';
let completed = false;
const server = createServer(async (request, response) => {
  const send = (code, type, data) => { response.writeHead(code, { "content-type": type, "cache-control": "no-store" }); response.end(data); };
  if (request.method === "GET" && request.url === "/") return send(200, "text/html", html);
  if (request.method === "GET" && request.url === "/bundle.js") return send(200, "text/javascript", bundle);
  if (request.method === "GET" && request.url === "/source.jpg") return send(200, "image/jpeg", sourceBytes);
  if (request.method !== "POST" || request.url !== "/result" || completed) return send(404, "text/plain", "not found");
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const summaries = {};
    for (const [role, field] of [["analysis", "analysisDataUrl"], ["generation", "generationDataUrl"]]) {
      const dataUrl = submitted[field];
      if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error(`${role}_not_jpeg_data_url`);
      const bytes = Buffer.from(dataUrl.slice("data:image/jpeg;base64,".length), "base64");
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error(`${role}_not_jpeg_bytes`);
      writeFileSync(resolve(root, `${role}-derivative.jpg`), bytes, { flag: "wx" });
      summaries[role] = { mime: "image/jpeg", bytes: bytes.length, dataUrlChars: dataUrl.length, sha256: sha(bytes) };
    }
    writeFileSync(resolve(root, "browser-execution.json"), JSON.stringify({ execution: "actual preparePhotoForUpload in browser", sourceSha256: expected, derivatives: summaries }, null, 2), { flag: "wx" });
    completed = true;
    send(200, "text/plain", "saved");
    setTimeout(() => server.close(), 1000);
  } catch (error) {
    send(400, "text/plain", error instanceof Error ? error.message : "invalid_result");
  }
});
server.listen(43127, "127.0.0.1", () => process.stdout.write("LOCAL_AUDIT_READY\n"));
