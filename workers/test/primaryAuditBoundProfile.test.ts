import fs from "node:fs";
import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { APPROVED_AUDIT_ACCOUNT_ID, AUDIT_ENTRYPOINT, planBoundProfileAudit } from "./primaryAuditBoundProfile";
import { startRemoteAudit } from "./primaryAuditRemoteReadiness";

const cli = fs.readFileSync(resolve("node_modules/wrangler/wrangler-dist/cli.js"), "utf8");
const types = fs.readFileSync(resolve("node_modules/wrangler/wrangler-dist/cli.d.ts"), "utf8");
const base = { resolveProfileClass: () => "non_default" as const, accountId: APPROVED_AUDIT_ACCOUNT_ID,
  entrypoint: AUDIT_ENTRYPOINT, authOverrideAbsent: true };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("bound profile/account preflight passes without claiming CLI startup is gate-safe", () => {
  const plan = planBoundProfileAudit(base);
  expect(plan.profileParityPreflightPassed).toBe(true);
  expect(plan.selectedProfileClass).toBe("non_default");
  expect(plan.selectedStrategy).toBe("installed_cli_remote_dev");
  expect(plan.remoteStartAllowed).toBe(false);
});
it("no binding/default profile blocks remote startup", () => {
  const plan = planBoundProfileAudit({ ...base, resolveProfileClass: () => "default" });
  expect(plan.profileParityPreflightPassed).toBe(false); expect(plan.remoteStartAllowed).toBe(false);
});
it("binding lookup error fails closed without retaining a raw exception", () => {
  const plan = planBoundProfileAudit({ ...base, resolveProfileClass: () => { throw new Error("synthetic-private-profile"); } });
  expect(plan.selectedProfileClass).toBe("unresolved");
  expect(plan.remoteStartAllowed).toBe(false); expect(JSON.stringify(plan)).not.toContain("synthetic-private-profile");
});
it("account mismatch blocks, not inferred from historical account-access evidence", () => {
  const plan = planBoundProfileAudit({ ...base, accountId: "synthetic-wrong-account" });
  expect(plan.approvedAccountIdMatch).toBe(false); expect(plan.profileParityPreflightPassed).toBe(false);
  expect(plan.remoteStartAllowed).toBe(false);
});
it("production entrypoint and auth overrides block", () => {
  expect(planBoundProfileAudit({ ...base, entrypoint: "src/index.ts" }).profileParityPreflightPassed).toBe(false);
  expect(planBoundProfileAudit({ ...base, authOverrideAbsent: false }).profileParityPreflightPassed).toBe(false);
});
it("plan has classes only, no identifiers/credentials/access hardcode", () => {
  const plan = planBoundProfileAudit(base);
  expect(plan.credentialContentsRead).toBe(false); expect(plan.credentialExtraction).toBe(false);
  expect(plan).not.toHaveProperty("profileName"); expect(plan).not.toHaveProperty("approvedAccountAccessible");
  expect(Object.keys(plan).some(key => /token|identifier|profileHash/i.test(key))).toBe(false);
});
it("installed DevEnv and startWorker do not execute the CLI profile bootstrap", () => {
  const dev = cli.slice(cli.indexOf("exports.unstable_DevEnv = class"), cli.indexOf("// src/api/startDevWorker/types.ts"));
  const start = cli.slice(cli.indexOf("async function startWorker(options)"), cli.indexOf("var init_startDevWorker"));
  expect(dev).not.toContain("setProfile("); expect(dev).not.toContain("createWranglerProfileStore");
  expect(start).not.toContain("setProfile(");
  expect(cli).toContain('let activeProfile = "default";');
  expect(cli).toContain("return ctx.storageFactory(profile ?? activeProfile);");
  expect(cli).toContain("auth = createWranglerAuth({");
});
it("installed public exports have no profile selector/resolver/main", () => {
  const exports = [...cli.matchAll(/^exports\.(\w+)\s*=/gm)].map(match => match[1]);
  for (const name of ["setProfile", "getActiveProfile", "createWranglerProfileStore", "main", "startDev"]) expect(exports).not.toContain(name);
  const constructor = types.slice(types.indexOf("declare class DevEnv"), types.indexOf("declare function startWorker"));
  expect(constructor).not.toMatch(/profile\??\s*:/);
  const unstable = types.slice(types.indexOf("interface Unstable_DevOptions"), types.indexOf("interface Unstable_DevWorker"));
  expect(unstable).not.toMatch(/profile\??\s*:/);
  expect(types).toContain('type DevArguments = Omit<(typeof dev)["args"], "installSkills" | "profile">;');
  expect(cli).toContain("function setProfile(profile) {\n  auth.setProfile(profile);");
});
it("public auth hook is not a profile selector and default login precedes it", () => {
  const config = cli.slice(cli.indexOf("async function resolveDevConfig"), cli.indexOf("async function resolveBindings", cli.indexOf("async function resolveDevConfig")));
  expect(config.indexOf("loginOrRefreshIfRequired(config5)")).toBeLessThan(config.indexOf("input.dev?.auth"));
  expect(config).toContain("apiToken: requireApiToken2()");
  expect(config).not.toContain("setProfile(");
});
it("CLI dev selects bound auth but explicit script still wins over config.main", () => {
  expect(cli).toContain("const profile = createWranglerProfileStore({ logger: logger2 }).resolve({");
  expect(cli).toContain("setProfile(profile)");
  expect(cli).toContain("entrypoint: args.script");
  const entry = cli.slice(cli.indexOf("async function getEntry(args"), cli.indexOf("async function getEntry(args") + 650);
  expect(entry.indexOf("if (args.script)")).toBeLessThan(entry.indexOf("config5.main"));
  expect(cli).toContain('"show-interactive-dev-session": {');
  expect(cli).toContain("...collectPlainTextVars(args.var)");
  // whoami's profile rejection is not a general dev flag restriction.
  const dev = cli.slice(cli.indexOf("dev = createCommand({"), cli.indexOf("// src/deployment-bundle/esbuild-plugins/log-build-output.ts"));
  expect(dev).not.toContain("if (args.profile)");
});
it("exported runCfWranglerDev and command-definition API skip profile middleware", () => {
  const run = cli.slice(cli.indexOf("async function runCfWranglerDev(options)"), cli.indexOf('__name(runCfWranglerDev'));
  expect(run).toContain("startDev(options)"); expect(run).not.toContain("setProfile(");
  expect(run).not.toContain("createWranglerProfileStore");
  const definitions = cli.slice(cli.indexOf("function experimental_getWranglerCommands()"), cli.indexOf("var init_experimental_commands_api"));
  expect(definitions).toContain("createCLIParser([])"); expect(definitions).not.toContain(".parse(");
});
it("CLI IPC is local-ready only; existing gate still times out without remote reload/drain", async () => {
  const start = cli.slice(cli.indexOf("async function startDev(args)"), cli.indexOf("async function setupDevEnv"));
  expect(start).toContain('event: "DEV_SERVER_READY"');
  expect(start).toContain("primaryDevEnv.proxy.ready.promise.then");
  expect(start).not.toContain('on("reloadComplete"');
  expect(start).not.toContain('on("message"');
  vi.useFakeTimers();
  const network = vi.fn(() => { throw new Error("network_forbidden"); }); vi.stubGlobal("fetch", network);
  const dev = Object.assign(new EventEmitter(), { proxy: { runtimeMessageMutex: { drained: vi.fn(async () => {}) } } });
  const worker = { ready: Promise.resolve(), fetch: network };
  const pending = startRemoteAudit(dev, async () => worker, 20);
  dev.emit("DEV_SERVER_READY", { event: "DEV_SERVER_READY", ip: "127.0.0.1", port: 8787 });
  await vi.advanceTimersByTimeAsync(20);
  expect((await pending).readiness.status).toBe("timeout");
  expect(dev.proxy.runtimeMessageMutex.drained).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
});
