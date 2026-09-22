import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AUTH_ENV_NAMES = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY",
  "CLOUDFLARE_EMAIL", "CF_EMAIL", "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID", "CI",
  "CLOUDFLARE_ACCESS_CLIENT_ID", "CLOUDFLARE_ACCESS_CLIENT_SECRET", "CLOUDFLARE_AUTH_USE_KEYRING", "WRANGLER_API_ENVIRONMENT"] as const;
export type AuthSource = { sourceType: string; present: boolean; selectedByWrangler: boolean };
export type StorePresence = { directory: boolean; plaintext: boolean; encrypted: boolean; preferences: boolean; profileBindings: boolean };
export function summarizeAuthPresence(has: (name: string) => boolean, store: StorePresence) {
  const env = AUTH_ENV_NAMES.map(sourceType => ({ sourceType, present: has(sourceType), selectedByWrangler: false }));
  const envCredentialPossible = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL"].some(has);
  const defaultFileSelected = !envCredentialPossible && !has("CLOUDFLARE_AUTH_USE_KEYRING")
    && !has("WRANGLER_API_ENVIRONMENT") && !store.preferences && store.plaintext;
  const sources: AuthSource[] = [...env,
    { sourceType: "wrangler_config_directory", present: store.directory, selectedByWrangler: true },
    { sourceType: "default_plaintext_store", present: store.plaintext, selectedByWrangler: defaultFileSelected },
    { sourceType: "default_encrypted_store", present: store.encrypted, selectedByWrangler: false },
    { sourceType: "storage_preferences", present: store.preferences, selectedByWrangler: false },
    { sourceType: "cli_profile_binding_metadata", present: store.profileBindings, selectedByWrangler: false },
  ];
  // Presence is not truthiness, nor proof of a field inside an unread store.
  // Never invoke Wrangler auth APIs: these read credentials and may refresh them.
  return { sources, selectedCredentialMode: "ambiguous" as const,
    selectedCredentialSource: defaultFileSelected ? "default_plaintext_store" : "unresolved_presence_only",
    ambiguityReason: defaultFileSelected ? "stored_credential_subtype_not_inspected" : "nonempty_env_or_storage_selection_not_inspected",
    oauthValidity: "unknown_without_remote_check", apiTokenPermissions: "unknown",
    accountAccess: "unknown_without_remote_check", credentialContentsRead: false };
}
export function inspectLocalAuthPresence() {
  const directory = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };
  const legacy = join(homedir(), ".wrangler");
  const xdg = join(process.env.XDG_CONFIG_HOME || join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "xdg.config"), ".wrangler");
  const base = directory(legacy) ? legacy : xdg;
  return summarizeAuthPresence(name => Object.hasOwn(process.env, name), {
    directory: directory(base), plaintext: existsSync(join(base, "config", "default.toml")),
    encrypted: existsSync(join(base, "config", "default.enc")), preferences: existsSync(join(base, "preferences.json")),
    profileBindings: existsSync(join(base, "profiles", "directory-bindings.json")),
  });
}
