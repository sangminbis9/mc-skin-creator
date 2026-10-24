// Only the public generation/quota routes are exposed. This is not an open proxy.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    const json = (body: unknown, status: number) => Response.json(body, {
      status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
    const methods: Record<string, string> = {
      "/api/generate": "POST", "/api/quota": "GET",
    };
    if (!methods[url.pathname]) return json({ ok: false, error: "Not found" }, 404);
    if (request.method !== methods[url.pathname]) return json({ ok: false, error: "Method not allowed" }, 405);
    if (request.method === "POST") {
      const origin = request.headers.get("Origin");
      if ((origin && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site") {
        return json({ ok: false, error: "Origin not allowed" }, 403);
      }
      if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) {
        return json({ ok: false, error: "Expected JSON" }, 415);
      }
      if (Number(request.headers.get("Content-Length")) > 9_000_000) {
        return json({ ok: false, error: "Request too large" }, 413);
      }
    }
    try {
      // Stream the request; the existing engine enforces actual body limits,
      // provider deadlines, and the shared account's atomic free-tier budget.
      const upstream = await env.SKIN_API.fetch(new Request(request));
      const response = new Response(upstream.body, upstream);
      response.headers.delete("Access-Control-Allow-Origin");
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    } catch {
      return json({ ok: false, errorCode: "provider_unavailable", error: "The generation service is temporarily unavailable." }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
