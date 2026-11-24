/** Opt-in synthetic visual audit. The compact audit prompt is NOT the app's
 * production prompt. It takes one real cropped portrait per call, never a grid. */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import jpeg from "jpeg-js";

const root = process.env.HAIR_BENCH_DIR;
if (!root) throw Error("HAIR_BENCH_DIR is required");
const sorted = (await readdir(root)).filter(f => f.endsWith(".sheet.png")).sort();
const photoRoot = join(root, "photos"), observationRoot = join(root, "vision");
await mkdir(photoRoot, { recursive: true }); await mkdir(observationRoot, { recursive: true });
const manifest = [];
for (const filename of sorted) {
  const sheetId = filename.slice(0, -10);
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", join(root, filename), "-vf", "scale=1252:1252", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"], { maxBuffer: 8_000_000 });
  for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
    const size = 309, bytes = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      const i = ((row * 313 + y + 2) * 1252 + col * 313 + 2) * 4;
      bytes.set(raw.subarray(i, i + size * 4), y * size * 4);
    }
    const id = `${sheetId}-${row + 1}${col + 1}`;
    const jpg = jpeg.encode({ data: bytes, width: size, height: size }, 86).data;
    await writeFile(join(photoRoot, `${id}.jpg`), jpg);
    manifest.push({ id, sheetId, row: row + 1, col: col + 1, sha256: createHash("sha256").update(jpg).digest("hex") });
  }
}
if (new Set(manifest.map(x => x.sha256)).size !== manifest.length || manifest.length < 100) throw Error("Need at least 100 distinct portraits");
await writeFile(join(root, "portraits.json"), JSON.stringify(manifest, null, 2));
console.log(`Prepared ${manifest.length} distinct cropped inputs from ${sorted.length} generated sheets.`);
if (process.env.HAIR_BENCH_CROP_ONLY === "1") process.exit(0);

const fields = {
  cut: ["bald", "buzz", "crew", "crop", "spiky", "slick", "side_part", "curtain", "bowl", "pixie", "bob", "shag", "long", "wave", "curls", "coils", "braids", "locs", "tied"],
  part: ["none", "left", "center", "right"], fringe: ["none", "straight", "side", "curtain", "wispy", "textured"],
  length: ["cropped", "ear", "jaw", "shoulder", "chest", "waist", "hip"], texture: ["straight", "wavy", "curly", "coily"],
  sides: ["tapered", "undercut", "ear_hugging", "face_framing", "flared"],
  front: ["none", "left", "right", "both"], tied: ["none", "bun", "ponytail", "twintails"], tuck: ["none", "left", "right", "both"],
  color: ["black", "dark-brown", "brown", "blonde", "gray", "red", "other"],
};
const schema = { type: "object", properties: Object.fromEntries(Object.entries(fields).map(([k,v]) => [k,{type:"string",enum:v}])), required:Object.keys(fields), additionalProperties:false };
const prompt = `Describe the actual haircut in this ONE synthetic portrait for a pixel avatar. Return only JSON using these fields and vocabularies: ${JSON.stringify(fields)}.
Left/right mean the displayed image's left/right, NOT the person's anatomy. Locate the part at the scalp; the larger sweep goes to the other side. A forehead gap by itself is not a root part. A buzz cut is extremely short and skin-close all over; crew has short top and mostly exposed forehead; crop has short sides plus a downward fringe; slick is brushed back with a fully exposed forehead; bowl has a rounded solid fringe; bob ends near the jaw. A tied bun/ponytail is not loose long hair. Use length from the lowest clearly visible hair. 'front' means hair over clothing below the neck/shoulder, never a jaw-level fringe. Don't invent hidden hair. No identity or demographic inference.`;
const bridge = process.env.HAIR_BENCH_BRIDGE ?? "http://127.0.0.1:8799/";
const workerCount = Number(process.env.HAIR_BENCH_CONCURRENCY ?? 6);
const accepted = new Set(), failures = [];
let cursor = 0, available = 0, spend = 0, closed = false;
const sampleLimit = Math.min(manifest.length, Number(process.env.HAIR_BENCH_LIMIT ?? manifest.length));
async function runPhoto(job) {
  const output = join(observationRoot, `${job.id}.json`);
  try {
    const last = JSON.parse(await readFile(output, "utf8"));
    if (last.sha256 === job.sha256 && last.observed) { accepted.add(job.id); return; }
  } catch { /* resume a missing result */ }
  const url = `data:image/jpeg;base64,${(await readFile(join(photoRoot, `${job.id}.jpg`))).toString("base64")}`;
  for (let retry = 0; retry < 2 && !closed; retry++) {
    try {
      const response = await fetch(bridge, { method: "POST", signal: AbortSignal.timeout(85_000), headers:{"content-type":"application/json"},
        body: JSON.stringify({ max_completion_tokens: 512, temperature: 0, seed: 0, store: false, chat_template_kwargs: { enable_thinking: false },
          messages:[{role:"user",content:[{type:"text",text:prompt},{type:"image_url", image_url:{url}}]}],
          response_format:{type:"json_schema",json_schema:{name:"synthetic_hair_observation",strict:true,schema}} }) });
      const raw = await response.json();
      if (!response.ok) throw Error(`${response.status}: ${raw.error ?? "provider"}`);
      const usage = raw.usage ?? {};
      spend += Math.ceil(((usage.prompt_tokens ?? 0) * 9091 + (usage.completion_tokens ?? 0) * 27273) / 1_000_000);
      const content = raw.response ?? raw.choices?.[0]?.message?.content ?? raw;
      const value = Array.isArray(content) ? content.map(c => typeof c === "string" ? c : c?.text ?? "").join("") : content;
      const observed = typeof value === "string" ? JSON.parse(value.replace(/^```(?:json)?\s*|\s*```$/g, "")) : value;
      if (!Object.entries(fields).every(([k,v]) => v.includes(observed?.[k]))) throw Error(`invalid compact observation: ${JSON.stringify(observed).slice(0,220)}`);
      await writeFile(output, JSON.stringify({ sha256:job.sha256, observed, usage },null,2));
      accepted.add(job.id);
      if (++available % 8 === 0) console.log(`New successful photo observations: ${available}; estimated audited neurons ${spend}`);
      return;
    } catch (e) {
      if (/daily|allocation|neurons quota|account limited|4006/i.test(e.message)) closed = true;
      if (retry === 1 || closed) {
        if (failures.length < 3) console.warn(job.id, e.message.slice(0,240));
        failures.push({ id:job.id, reason:e.message.slice(0,240) });
      }
      else await new Promise(r => setTimeout(r, 900));
    }
  }
}
await Promise.all(Array.from({length:workerCount}, async () => { while (!closed && cursor < sampleLimit) await runPhoto(manifest[cursor++]); }));
await writeFile(join(root, "vision-status.json"), JSON.stringify({ portraits:manifest.length, successful:accepted.size, failed: failures, closed, neuronsThisRun:spend },null,2));
console.log(`Vision: ${accepted.size}/${manifest.length}; ${failures.length} failed, closed=${closed}.`);
