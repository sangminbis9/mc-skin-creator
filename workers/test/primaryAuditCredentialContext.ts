import { dirname, resolve } from "node:path";

export type CredentialContextInput = {
  cwd: string;
  config?: string;
  bindingProfileClass: (directory: string) => "default" | "non_default";
  envCredentialPresent: boolean;
  dotenvAuthOverride: boolean;
  defaultPlaintextStorePresent: boolean;
  plaintextBackendConfirmed: boolean;
  apiEnvironmentDefault: boolean;
  cliOnlyCredentialSource: boolean;
};

// Installed createHandler2 selects explicit config dirname, otherwise cwd.
// Only classes leave the resolver; profile identifiers/credentials never do.
export function credentialContext(input: CredentialContextInput) {
  const lookupDirectory = input.config ? dirname(resolve(input.cwd, input.config)) : resolve(input.cwd);
  const selectedProfileClass = input.bindingProfileClass(lookupDirectory);
  const credentialSourceEquivalent = selectedProfileClass === "default"
    && !input.envCredentialPresent && !input.dotenvAuthOverride
    && input.defaultPlaintextStorePresent && input.plaintextBackendConfirmed
    && input.apiEnvironmentDefault && !input.cliOnlyCredentialSource;
  return { selectedProfileClass,
    selectedCredentialStoreClass: selectedProfileClass === "default" ? "default" : "non_default",
    credentialSourceEquivalent };
}

// Future raw stdout stays in memory. No identity/account list/scopes escape.
export function summarizeWhoami(raw: unknown, commandSucceeded: boolean, approvedAccountId: string) {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  const accounts = data?.accounts;
  if (!commandSucceeded || data?.loggedIn !== true || !Array.isArray(accounts)
    || !accounts.every(account => account && typeof account === "object" && typeof account.id === "string")) {
    return { credentialAccepted: "unknown" as const, approvedAccountAccessible: "unknown" as const };
  }
  return { credentialAccepted: true,
    approvedAccountAccessible: accounts.some(account => account.id === approvedAccountId) };
}
