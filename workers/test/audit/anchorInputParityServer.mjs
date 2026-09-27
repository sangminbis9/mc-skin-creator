import { createServer } from "node:http";
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const cases = {
  striped: { file: "2881786.jpg", sha256: "7d5b593c474be26cf5df09fbe034993d7ce02bf8d561e300ee4a9216692d6573" },
  wavy: { file: "19908659.jpg", sha256: "fbfd573be40b623d70da02a56bb876a1b53abb88f1806188b1a40b74f2ef2702" },
};
const caseName = process.argv[2];
const port = Number(process.argv[3]);
if (!(caseName in cases) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid_case_or_port");
const selected = cases[caseName];
const root = resolve("evaluation-artifacts/face-geometry-openness-anchor-input-parity-audit-20260925-001", caseName);
if (existsSync(root)) throw new Error("fresh_case_artifact_required");
const source = readFileSync(resolve("evaluation-artifacts/generalization-20260905/sources", selected.file));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (sha256(source) !== selected.sha256) throw new Error("historical_source_mismatch");
const bundle = readFileSync(resolve("test/audit/productionPreprocessBrowser.bundle.js"));
mkdirSync(root, { recursive: true });
const html = '<!doctype html><meta charset="utf-8"><title>Local preprocessing audit</title><p id="status">RUNNING</p><script src="/bundle.js"></script>';
let completed = false;
const server = createServer(async (request, response) => {
  const send = (code, type, data) => { response.writeHead(code, { "content-type": type, "cache-control": "no-store" }); response.end(data); };
  if (request.method === "GET" && request.url === "/") return send(200, "text/html", html);
  if (request.method === "GET" && request.url === "/bundle.js") return send(200, "text/javascript", bundle);
  if (request.method === "GET" && request.url === "/source.jpg") return send(200, "image/jpeg", source);
  if (request.method !== "POST" || request.url !== "/result" || completed) return send(404, "text/plain", "not found");
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const dataUrl = submitted.analysisDataUrl;
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/jpeg;base64,")) throw new Error("analysis_not_jpeg_data_url");
    const derivative = Buffer.from(dataUrl.slice("data:image/jpeg;base64,".length), "base64");
    if (derivative[0] !== 0xff || derivative[1] !== 0xd8 || derivative[2] !== 0xff) throw new Error("analysis_not_jpeg_bytes");
    writeFileSync(resolve(root, "analysis-derivative.jpg"), derivative, { flag: "wx" });
    writeFileSync(resolve(root, "browser-execution.json"), `${JSON.stringify({ execution: "actual preparePhotoForUpload in local browser", caseName, sourceSha256: selected.sha256, analysis: { mime: "image/jpeg", bytes: derivative.length, dataUrlChars: dataUrl.length, sha256: sha256(derivative) } }, null, 2)}\n`, { flag: "wx" });
    completed = true;
    send(200, "text/plain", "saved");
    setTimeout(() => server.close(), 1000);
  } catch (error) {
    send(400, "text/plain", error instanceof Error ? error.message : "invalid_result");
  }
});
server.listen(port, "127.0.0.1", () => process.stdout.write("LOCAL_AUDIT_READY\n"));
setTimeout(() => server.close(), 120_000).unref();
