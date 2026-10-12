import { expect, it } from "vitest";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { MAX_CALL_NEURONS } from "../src/freeBudget";

it("serializes simultaneous reservations in real local workerd and persists across distinct stubs", async () => {
  const bundle = await build({ stdin: { contents: 'export { NeuronBudget } from "./src/NeuronBudget"; export default { fetch(){return new Response("offline");} };',
    resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", target: "es2022", external: ["cloudflare:workers"] });
  const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-08",
    durableObjects: { BUDGET: { className: "NeuronBudget", useSQLite: true } } });
  try {
    const bindings = await mf.getBindings<{ BUDGET: DurableObjectNamespace<import("../src/NeuronBudget").NeuronBudget> }>();
    const stub = bindings.BUDGET.getByName("project");
    const ids = Array.from({length: 30}, () => crypto.randomUUID());
    const results = await Promise.all(ids.map(id => stub.reserve(id)));
    expect(results.filter(r => r.accepted)).toHaveLength(1);
    expect((await stub.status()).used).toBe(MAX_CALL_NEURONS);
    const n = results.findIndex(r => r.accepted);
    await stub.settle(results[n].day, ids[n], 250);
    await stub.settle(results[n].day, ids[n], 1); // Duplicate cannot refund twice.
    expect((await stub.status()).used).toBe(250);
    const round2 = await stub.reserve(crypto.randomUUID()); expect(round2.accepted).toBe(true);
    // A new stub sees the same persisted reservations; failed calls retain them.
    const again = bindings.BUDGET.getByName("project");
    expect((await again.status()).used).toBe(250+MAX_CALL_NEURONS);
    expect((await again.reserve(crypto.randomUUID())).accepted).toBe(false);
  } finally { await mf.dispose(); }
}, 60000);
