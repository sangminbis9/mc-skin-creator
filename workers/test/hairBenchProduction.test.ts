/** Opt-in, loopback-only live production-prompt spot check of synthetic photos. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { generateFreeSkin } from "../src/engineService";
import { decodePng } from "../src/png";
import type { Env } from "../src/types";

const directory = process.env.HAIR_BENCH_DIR;
const live = process.env.HAIR_BENCH_PRODUCTION === "1";
it.skipIf(!directory || !live)("spot-checks the actual application request on 16 individual synthetic portraits", async () => {
  const root = directory!, output = join(root, "production");
  await mkdir(output, { recursive: true });
  const manifest = JSON.parse(await readFile(join(root, "portraits.json"), "utf8")) as {id:string; row:number; col:number; sha256:string}[];
  const jobs = manifest.filter(p => p.col === 2 && [1, 3].includes(p.row));
  let cursor = 0;
  const checked: Array<{id:string; status:number; neurons:number; cached?:true}> = [];
  await Promise.all(Array.from({length: 4}, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      let cached: { status: number; raw?: unknown; neurons?: number } | undefined;
      try {
        const saved = JSON.parse(await readFile(join(output, `${job.id}.json`), "utf8"));
        if (saved.sha256 === job.sha256 && saved.status === 200 && saved.raw) cached = saved;
      } catch { /* not yet tested */ }
      const image = `data:image/jpeg;base64,${(await readFile(join(root,"photos",`${job.id}.jpg`))).toString("base64")}`;
      let raw: unknown;
      const env = { AI: { run: async (_model: string, wire: unknown) => {
        if (cached) { raw = cached.raw; return raw; }
        const r = await fetch("http://127.0.0.1:8799/", { method:"POST", headers:{"content-type":"application/json"},
          body:JSON.stringify(wire), signal:AbortSignal.timeout(80_000) });
        raw = await r.json();
        if (!r.ok) throw new Error("Synthetic provider call unavailable");
        return raw;
      } }, FREE_IMAGE_GENERATION_ENABLED:"false" } as unknown as Env;
      const result = await generateFreeSkin(env, { image, presentation:"source" });
      checked.push({ id:job.id, status:result.status, neurons:result.neuronsSpent, ...(cached ? { cached:true } : {}) });
      await writeFile(join(output, `${job.id}.json`), JSON.stringify({ sha256:job.sha256, status:result.status,
        neurons:result.neuronsSpent, mask:result.body.features?.fixedHairMask, error:result.body.errorCode, raw },null,2));
      if (!result.success || !result.body.skinPngBase64) continue;
      const bytes = Buffer.from(result.body.skinPngBase64, "base64"), atlas = await decodePng(bytes);
      expect([atlas.width, atlas.height]).toEqual([64,64]);
      await writeFile(join(output, `${job.id}.png`), bytes);
    }
  }));
  checked.sort((a,b) => a.id.localeCompare(b.id));
  await writeFile(join(root, "production-results.json"), JSON.stringify(checked,null,2));
  console.log(`Production-prompt spot checks: ${checked.filter(x => x.status === 200).length}/${jobs.length}.`);
  expect(checked).toHaveLength(16);
}, 420_000);
