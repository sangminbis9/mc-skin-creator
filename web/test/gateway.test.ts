import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../server/index.ts";

function environment(reply = () => Response.json({ ok: true })) {
  const calls: Request[] = [];
  return { calls, env: {
    SKIN_API: { fetch: async (req: Request) => { calls.push(req); return reply(); } },
    ASSETS: { fetch: async () => new Response("asset") },
  } };
}
test("quota is forwarded without caching or wildcard CORS", async () => {
  const { env, calls } = environment(() => Response.json({ level: "open" }, { headers: { "Access-Control-Allow-Origin": "*" } }));
  const res = await worker.fetch(new Request("https://demo.example/api/quota"), env);
  assert.equal(res.status, 200); assert.equal(calls.length, 1);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("access-control-allow-origin"), null);
});
test("generation preserves the request body and upstream errors", async () => {
  const { env, calls } = environment(() => Response.json({ errorCode: "quota_exceeded" }, { status: 429 }));
  const body = JSON.stringify({ image: "test-only" });
  const res = await worker.fetch(new Request("https://demo.example/api/generate", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://demo.example" }, body }), env);
  assert.equal(res.status, 429); assert.equal(await calls[0].text(), body);
});
test("admin, stats and ad tracking endpoints are not exposed", async () => {
  const { env, calls } = environment();
  for (const path of ["/api/stats", "/api/track", "/api/admin", "/api/proxy"]) {
    assert.equal((await worker.fetch(new Request("https://demo.example" + path), env)).status, 404);
  }
  assert.equal(calls.length, 0);
});
test("reject wrong method, cross-site request, non-JSON and oversized body", async () => {
  const { env, calls } = environment();
  assert.equal((await worker.fetch(new Request("https://demo.example/api/generate"), env)).status, 405);
  for (const [headers, status] of [
    [{ "Content-Type": "application/json", Origin: "https://evil.example" }, 403],
    [{ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }, 403],
    [{ "Content-Type": "text/plain" }, 415],
    [{ "Content-Type": "application/json", "Content-Length": "9000001" }, 413],
  ] as const) {
    assert.equal((await worker.fetch(new Request("https://demo.example/api/generate", { method: "POST", headers, body: "{}" }), env)).status, status);
  }
  assert.equal(calls.length, 0);
});
test("provider exception is a controlled 503, not a fake skin", async () => {
  const { env } = environment(() => { throw new Error("private provider details"); });
  const res = await worker.fetch(new Request("https://demo.example/api/quota"), env);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).errorCode, "provider_unavailable");
});
test("non-api requests go to static assets", async () => {
  const { env, calls } = environment();
  assert.equal(await (await worker.fetch(new Request("https://demo.example/"), env)).text(), "asset");
  assert.equal(calls.length, 0);
});
