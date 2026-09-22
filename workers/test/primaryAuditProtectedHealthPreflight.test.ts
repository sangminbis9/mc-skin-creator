import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import ts from "typescript";
import { AUTH_ENV_NAMES } from "./primaryAuditAuthInspection";
import { APPROVED_AUDIT_ACCOUNT_ID } from "./primaryAuditBoundProfile";
import { atomicCheckpoint } from "./primaryAuditRunnerSupport";

// Installed-source evaluation is an offline contract test, never an operational
// auth/lifecycle API. Dotenv inputs below are synthetic and contain no secrets.
const cli = fs.readFileSync("node_modules/wrangler/wrangler-dist/cli.js", "utf8");
const configPath = path.resolve("wrangler.jsonc");
const parsed = ts.parseConfigFileTextToJson(configPath, fs.readFileSync(configPath, "utf8"));
if (parsed.error) throw new Error("config_parse_failed");
const config = parsed.config;
const fakeToken = "offline-only-placeholder";
function installedVars(secrets: unknown = config.secrets, vars = config.vars) {
  const begin = cli.indexOf("function getVarsForDev(");
  const end = cli.indexOf("function tryLoadDotDevDotVars(", begin);
  if (begin < 0 || end < 0) throw new Error("installed_contract_not_found");
  const context = vm.createContext({
    path31__namespace: path,
    loadDotEnv: () => ({ PRIMARY_AUDIT_TOKEN: fakeToken }),
    loadDotDevDotVars: () => { throw new Error("unexpected_dev_vars_read"); },
    getCloudflareLoadDevVarsFromDotEnv: () => true,
    getCloudflareIncludeProcessEnvFromEnv: () => false,
    logger2: { warn: () => {}, log: () => {}, debug: () => {} },
  });
  vm.runInContext(cli.slice(begin, end), context);
  return context.getVarsForDev(configPath, ["offline-only.env"], vars, undefined, true, secrets) as Record<string, unknown>;
}

function localMetadataPreflight() {
  const legacy = path.join(os.homedir(), ".wrangler");
  const xdg = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "xdg.config"), ".wrangler");
  const base = fs.existsSync(legacy) ? legacy : xdg;
  // Directory binding metadata only; no credential store or profile identifier
  // is returned, hashed, logged, or persisted.
  const bindings = JSON.parse(fs.readFileSync(path.join(base, "profiles", "directory-bindings.json"), "utf8"));
  const begin = cli.indexOf("function getProfileForDirectoryFromBindings(");
  const end = cli.indexOf("function getLineColFromPtr2(", begin);
  if (begin < 0 || end < 0) throw new Error("installed_binding_contract_not_found");
  const context = vm.createContext({ path31__namespace: { default: path } });
  vm.runInContext(cli.slice(begin, end), context);
  const selected = context.getProfileForDirectoryFromBindings(process.cwd(), bindings);
  const selectedProfileClass = selected?.profile && selected.profile !== "default" ? "non_default" : "default";
  const extraOverrideNames = ["CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL", "CLOUDFLARE_COMPLIANCE_REGION",
    "WRANGLER_OUTPUT_FILE_DIRECTORY", "WRANGLER_OUTPUT_FILE_PATH", "CLOUDFLARE_PAGES", "CLOUDFLARE_WORKERS"];
  const blockedNames = [...AUTH_ENV_NAMES.filter(name => name !== "CI"), ...extraOverrideNames];
  const authOverrideAbsent = !Object.keys(process.env).some(key => blockedNames.some(name => name.toLowerCase() === key.toLowerCase()));
  const dotenvFilesAbsent = [".env", ".env.local"].every(name => !fs.existsSync(path.resolve(name)));
  const root = path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code");
  const candidates = fs.existsSync(root) ? [root, ...fs.readdirSync(root, { withFileTypes: true })
    .filter(item => item.isDirectory()).map(item => path.join(root, item.name))] : [];
  const ptyDir = candidates.map(dir => path.join(dir, "resources", "app", "node_modules", "node-pty"))
    .find(dir => fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "build", "Release", "conpty.node")));
  const requireLocal = createRequire(import.meta.url);
  let publicSpawnLoaded = false;
  let nativeBackendLoaded = false;
  let ptyVersion: string | null = null;
  if (ptyDir) {
    ptyVersion = JSON.parse(fs.readFileSync(path.join(ptyDir, "package.json"), "utf8")).version;
    publicSpawnLoaded = typeof requireLocal(ptyDir).spawn === "function";
    nativeBackendLoaded = Boolean(requireLocal(path.join(ptyDir, "build", "Release", "conpty.node")));
  }
  return { selectedProfileClass, approvedAccountIdMatch: config.account_id === APPROVED_AUDIT_ACCOUNT_ID,
    authOverrideAbsent, dotenvFilesAbsent, ptyVersion, publicSpawnLoaded, nativeBackendLoaded,
    officialBinPresent: fs.existsSync("node_modules/wrangler/bin/wrangler.js"),
    wranglerVersion: JSON.parse(fs.readFileSync("node_modules/wrangler/package.json", "utf8")).version,
    auditTokenDeclaredInConfigVars: Object.hasOwn(config.vars, "PRIMARY_AUDIT_TOKEN"),
    auditTokenDeclaredInRequiredSecrets: config.secrets.required.includes("PRIMARY_AUDIT_TOKEN"),
    auditTokenIncludedByInstalledEnvFileLoader: Object.hasOwn(installedVars(), "PRIMARY_AUDIT_TOKEN"),
    credentialContentsRead: false, credentialExtraction: false };
}

it("installed env-file loader excludes the undeclared audit token with the unchanged production secrets contract", () => {
  expect(config.secrets.required).toEqual(["GEMINI_API_KEY"]);
  expect(config.vars).not.toHaveProperty("PRIMARY_AUDIT_TOKEN");
  expect(installedVars()).not.toHaveProperty("PRIMARY_AUDIT_TOKEN");
  // Positive controls distinguish actual filtering from a broken synthetic load.
  expect(installedVars(undefined, { PRIMARY_AUDIT_TOKEN: "declaration-only" })).toHaveProperty("PRIMARY_AUDIT_TOKEN", { type: "secret_text", value: fakeToken });
  expect(installedVars({ required: ["PRIMARY_AUDIT_TOKEN"] })).toHaveProperty("PRIMARY_AUDIT_TOKEN", { type: "secret_text", value: fakeToken });
  expect(installedVars(null)).toHaveProperty("PRIMARY_AUDIT_TOKEN", { type: "secret_text", value: fakeToken });
});

it("CLI var overrides cannot declare an env-file secret without replacing it with an argv value", () => {
  const begin = cli.indexOf("function getBindings2(");
  const end = cli.indexOf("function getAssetChangeMessage(", begin);
  const body = cli.slice(begin, end);
  expect(body).toContain("configParam.vars,");
  expect(body).toContain("return { ...defaultBindings, ...bindings2, ...inputBindings }");
  const setup = cli.slice(cli.indexOf("async function setupDevEnv("), cli.indexOf("async function getPagesAssetsFetcher("));
  expect(setup).toContain("...collectPlainTextVars(args.var)");
  const placeholderBinding = { type: "plain_text", value: "argv-placeholder" };
  const context = vm.createContext({ applyHyperdriveEnvVars: () => {}, convertConfigToBindings: () => ({}),
    getVarsForDev: () => installedVars() });
  vm.runInContext(body, context);
  const result = context.getBindings2(config, undefined, ["offline-only.env"], false,
    { PRIMARY_AUDIT_TOKEN: placeholderBinding }, {});
  expect(result.PRIMARY_AUDIT_TOKEN).toEqual(placeholderBinding);
});

it("health authenticates before its provider-free GET route; no token cannot produce a protected PASS", () => {
  const worker = fs.readFileSync("test/primaryFaceMeasurementAuditWorker.ts", "utf8");
  expect(worker.indexOf("if (!env.PRIMARY_AUDIT_TOKEN")).toBeLessThan(worker.indexOf('url.pathname === "/primary-audit-health"'));
  expect(worker).toContain('return new Response("forbidden", { status: 403 })');
  const healthRoute = worker.slice(worker.indexOf('url.pathname === "/primary-audit-health"'), worker.indexOf('url.pathname === "/primary-audit-status"'));
  expect(healthRoute).toContain("providerCalls: 0");
  expect(healthRoute).not.toContain("runPhotoAnalysis");
});

it("fresh local preflight confirms metadata/installed capability and fails closed before remote startup", async () => {
  const preflight = localMetadataPreflight();
  expect(preflight.selectedProfileClass).toBe("non_default");
  expect(preflight.approvedAccountIdMatch).toBe(true);
  expect(preflight.authOverrideAbsent).toBe(true);
  expect(preflight.dotenvFilesAbsent).toBe(true);
  expect(preflight.publicSpawnLoaded).toBe(true);
  expect(preflight.nativeBackendLoaded).toBe(true);
  expect(preflight.officialBinPresent).toBe(true);
  expect(preflight.auditTokenIncludedByInstalledEnvFileLoader).toBe(false);
  const root = process.env.BOUND_PROFILE_PREFLIGHT_ARTIFACT_ROOT;
  if (root) {
    fs.mkdirSync(root, { recursive: false });
    await atomicCheckpoint(path.join(root, "summary.json"), {
      branch: "main", head: "0b9d6dec4346076736ad21d92b4125481808efc1", preflight,
      classification: "BLOCKED: unchanged production secrets contract excludes the env-file audit token",
      startupAttempts: 0, devServerReadyObserved: false, healthAttempts: 0, qSentCount: 0,
      wrapperExitObserved: false, ownerExitObserved: false,
      cliOwnedProcessesCreated: 0, inventoryClean: true,
      tokenCreated: false, tokenFileCreated: false, tokenFileCleanup: "not_needed",
      gracefulTeardown: "not_attempted", serverSidePreviewDeletionIndependentlyConfirmed: false,
      prohibited: { jpegReads: 0, hashChecks: 0, base64Preparations: 0, jpegTransmissions: 0,
        primaryPosts: 0, Gemini: 0, Gemma: 0, retry: 0, geometry: 0, imageGeneration: 0,
        critique: 0, pairwise: 0, evaluator: 0 },
      networkCalls: 0, remotePreviewUploads: 0, packageManagerCalls: 0,
      productionAdditionalDiff: 0,
    });
  }
});
