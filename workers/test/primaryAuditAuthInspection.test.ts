import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import { inspectLocalAuthPresence, summarizeAuthPresence } from "./primaryAuditAuthInspection";
import { atomicCheckpoint } from "./primaryAuditRunnerSupport";

const cli = fs.readFileSync(resolve("node_modules/wrangler/wrangler-dist/cli.js"), "utf8");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it("presence-only inventory never reads credential values or files", () => {
  const reader = vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("credential_read_forbidden"); });
  const network = vi.fn(() => { throw new Error("network_forbidden"); }); vi.stubGlobal("fetch", network);
  const result = inspectLocalAuthPresence();
  expect(reader).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  for (const source of result.sources) expect(Object.keys(source)).toEqual(["sourceType", "present", "selectedByWrangler"]);
  expect(result.credentialContentsRead).toBe(false);
});
it("default stored source can be selected without claiming OAuth contents or validity", () => {
  const result = summarizeAuthPresence(() => false, { directory: true, plaintext: true, encrypted: false, preferences: false, profileBindings: true });
  expect(result.selectedCredentialSource).toBe("default_plaintext_store");
  expect(result.selectedCredentialMode).toBe("ambiguous");
  expect(result.sources.find(source => source.sourceType === "default_plaintext_store")?.selectedByWrangler).toBe(true);
});
it("does not equate env variable presence to a selected nonempty credential", () => {
  const result = summarizeAuthPresence(name => name === "CLOUDFLARE_API_TOKEN", { directory: true, plaintext: true, encrypted: false, preferences: false, profileBindings: false });
  expect(result.selectedCredentialSource).toBe("unresolved_presence_only");
  expect(result.sources.every(source => source.sourceType === "wrangler_config_directory" || !source.selectedByWrangler)).toBe(true);
});
it("installed selection gives global key pair priority over token, env over stored state", () => {
  const fn = cli.match(/function getAuthFromEnv\(options\) \{[^]*?\n}\n(?=function getAPIToken\()/)?.[0];
  expect(fn).toBeDefined();
  const select = (key?: string, email?: string, token?: string) => runInNewContext(`${fn}; getAuthFromEnv()`, {
    getCloudflareGlobalAuthKeyFromEnv: () => key, getCloudflareGlobalAuthEmailFromEnv: () => email,
    getCloudflareAPITokenFromEnv: () => token,
  });
  expect(select("synthetic-key", "synthetic-identity", "synthetic-token")).toEqual({ authKey: "synthetic-key", authEmail: "synthetic-identity" });
  expect(select(undefined, undefined, "synthetic-token")).toEqual({ apiToken: "synthetic-token" });
  expect(select()).toBeUndefined();
  const tokenSource = cli.slice(cli.indexOf("function getAPIToken(options)"), cli.indexOf("function requireApiToken(options)"));
  expect(tokenSource.indexOf("if (envAuth)")).toBeLessThan(tokenSource.indexOf("readStoredAuthState"));
  expect(tokenSource.indexOf("stored.deprecatedApiToken")).toBeLessThan(tokenSource.indexOf("stored.accessToken"));
});
it("installed preview auth classification uses ParseError codes 9106/10000, not HTTP status alone", () => {
  const fn = cli.match(/function isAuthenticationError2\(e9\) \{[^]*?\n}\n(?=function getErrorType\()/)?.[0];
  expect(fn).toBeDefined();
  class ParseError extends Error { code?: number; status?: number; }
  const classify = runInNewContext(`${fn}; isAuthenticationError2`, { ParseError, AUTHENTICATION_ERROR_CODES: [9106, 10000] });
  for (const code of [9106, 10000]) expect(classify(Object.assign(new ParseError(), { code }))).toBe(true);
  for (const code of [10063, 9109, undefined]) expect(classify(Object.assign(new ParseError(), { code, status: 403 }))).toBe(false);
  expect(classify({ code: 10000, status: 401 })).toBe(false);
  expect(cli).toContain("AUTHENTICATION_ERROR_CODES = [9106, 1e4]");
});
it("account selection does not prove membership; preview auth object is separate", () => {
  expect(cli).toContain("if (config5.account_id) {\n      return validateAccountId(");
  expect(cli).toContain("apiToken: props.apiToken ?? requireApiToken2()");
  expect(cli).toContain("/accounts/${accountId}/workers/subdomain/edge-preview");
  expect(cli).toContain("/zones/${ctx.zone}/workers/edge-preview");
  expect(cli).toContain("/accounts/${accountId}/workers/scripts/${worker.name}/edge-preview");
});
it("whoami rejects explicit profile; CLI bindings and dotenv differ from direct DevEnv", () => {
  expect(cli).toContain("--profile cannot be used with the whoami command as it only works on the currently active profile.");
  expect(cli).toContain("const profile = createWranglerProfileStore({ logger: logger2 }).resolve({");
  expect(cli).toContain("process.env = loadDotEnv(resolvedEnvFilePaths, {");
  expect(cli).toContain("setProfile(profile)");
});
it.skipIf(process.env.RUN_AUTH_PRESENCE_INSPECTION !== "offline")("writes fresh secret-safe presence artifact only, no auth API", async () => {
  const root = process.env.AUTH_PRESENCE_ARTIFACT_ROOT;
  if (!root) throw new Error("fresh AUTH_PRESENCE_ARTIFACT_ROOT required");
  await mkdir(root, { recursive: false });
  await atomicCheckpoint(resolve(root, "auth-source-summary.json"), inspectLocalAuthPresence());
});
