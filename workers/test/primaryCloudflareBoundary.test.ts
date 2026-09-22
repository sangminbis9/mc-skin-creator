import { describe, expect, it } from "vitest";
import { stringifyWithStreams, structuredSerializableReducers } from "miniflare";

describe("primary audit Cloudflare runtime boundary", () => {
  it("proves Node platform-proxy serialization stops at the gateway AbortSignal before dispatch", () => {
    const implementation = {
      Blob,
      isReadableStream: (value: unknown) => value instanceof ReadableStream,
    };
    const args = [
      { provider: "google-ai-studio", endpoint: "redacted", headers: {}, query: {} },
      {
        signal: new AbortController().signal,
        gateway: {
          id: "default",
          skipCache: true,
          collectLog: false,
          retries: { maxAttempts: 1 },
          requestTimeoutMs: 45_000,
        },
      },
    ];
    let diagnostic: { name: string; path: string | null } | null = null;
    try {
      stringifyWithStreams(
        implementation as never,
        args,
        structuredSerializableReducers,
        true,
      );
    } catch (error) {
      const value = error as Error & { path?: string };
      diagnostic = { name: value.name, path: value.path ?? null };
    }
    expect(diagnostic).toEqual({ name: "DevalueError", path: "[1].signal" });
  });
});
