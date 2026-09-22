import fs from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { credentialContext, summarizeWhoami, type CredentialContextInput } from "./primaryAuditCredentialContext";

const cli = fs.readFileSync(path.resolve("node_modules/wrangler/wrangler-dist/cli.js"), "utf8");
const source = cli.match(/function getProfileForDirectoryFromBindings\(startDir, bindings2\) \{[^]*?\n}\n(?=function getLineColFromPtr2)/)?.[0];
if (!source) throw new Error("installed_profile_resolver_not_found");
const lookup = runInNewContext(`${source}; getProfileForDirectoryFromBindings`, { path31__namespace: { default: path } }) as
  (directory: string, bindings: Record<string, string>) => { profile: string } | undefined;
const root = path.resolve("synthetic-repository");
const workers = path.join(root, "workers");
const neutral = path.resolve("synthetic-neutral");
const bindings = { [root]: "synthetic-profile" };
const base: CredentialContextInput = {
  cwd: neutral, bindingProfileClass: directory => {
    const binding = lookup(directory, bindings);
    return binding && binding.profile !== "default" ? "non_default" : "default";
  },
  envCredentialPresent: false, dotenvAuthOverride: false, defaultPlaintextStorePresent: true,
  plaintextBackendConfirmed: true, apiEnvironmentDefault: true, cliOnlyCredentialSource: false,
};

it("workers-like inherited binding is not equivalent", () => {
  expect(credentialContext({ ...base, cwd: workers })).toEqual({ selectedProfileClass: "non_default", selectedCredentialStoreClass: "non_default", credentialSourceEquivalent: false });
});
it("neutral no-binding context selects equivalent default plaintext store", () => {
  expect(credentialContext(base).credentialSourceEquivalent).toBe(true);
});
it.each(["envCredentialPresent", "dotenvAuthOverride", "cliOnlyCredentialSource"] as const)("rejects %s", key => {
  expect(credentialContext({ ...base, [key]: true }).credentialSourceEquivalent).toBe(false);
});
it.each(["defaultPlaintextStorePresent", "plaintextBackendConfirmed", "apiEnvironmentDefault"] as const)("rejects unconfirmed %s", key => {
  expect(credentialContext({ ...base, [key]: false }).credentialSourceEquivalent).toBe(false);
});
it("neutral cwd plus production config re-enters bound profile directory", () => {
  expect(credentialContext({ ...base, config: path.join(workers, "wrangler.jsonc") }).credentialSourceEquivalent).toBe(false);
});
it("installed lookup chooses longest lexical ancestor, not git-root traversal", () => {
  expect(lookup(workers, { [root]: "parent", [workers]: "child" })?.profile).toBe("child");
  expect(lookup(`${root}-unrelated`, bindings)).toBeUndefined();
  expect(lookup(neutral, bindings)).toBeUndefined();
});
it("installed handler/config/dotenv/whoami semantics match the context proof", () => {
  expect(cli).toContain("const cwd2 = firstConfigPath ? path31__namespace.default.dirname(path31__namespace.default.resolve(firstConfigPath)) : process.cwd();");
  expect(cli).toContain("const dirProfile = bindings2.getProfileForDirectory(resolveArgs.cwd);");
  expect(cli).toContain('return "default";');
  expect(cli).toContain('let activeProfile = "default";');
  expect(cli).toContain("return ctx.storageFactory(profile ?? activeProfile);");
  expect(cli).toContain('const envFiles = [".env", ".env.local"];');
  expect(cli).toContain('process.env = loadDotEnv(resolvedEnvFilePaths, {');
  expect(cli).toContain('const user2 = await getUserInfo(complianceConfig);');
  expect(cli).toContain('accounts: user2.accounts');
  expect(cli).toContain('getCloudflareApiEnvironmentFromEnv();');
});
it("synthetic whoami parsing only emits credential/account booleans", () => {
  const raw = { loggedIn: true, email: "synthetic-private-identity", accounts: [{ id: "approved", name: "private" }, { id: "other", name: "private" }], tokenPermissions: ["private"] };
  expect(summarizeWhoami(raw, true, "approved")).toEqual({ credentialAccepted: true, approvedAccountAccessible: true });
  expect(summarizeWhoami(raw, true, "absent")).toEqual({ credentialAccepted: true, approvedAccountAccessible: false });
  expect(summarizeWhoami(raw, false, "approved")).toEqual({ credentialAccepted: "unknown", approvedAccountAccessible: "unknown" });
  expect(summarizeWhoami({}, true, "approved")).toEqual({ credentialAccepted: "unknown", approvedAccountAccessible: "unknown" });
});
