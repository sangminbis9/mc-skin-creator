const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const ts = require("typescript");

function parseConfig(text) {
  const result = ts.parseConfigFileTextToJson("audit.jsonc", text);
  if (result.error) throw new Error("config_parse_failed");
  return result.config;
}
function deriveConfig(text) {
  const production = parseConfig(text);
  if (Object.hasOwn(production.vars, "PRIMARY_AUDIT_TOKEN")) throw new Error("token_already_declared");
  const marker = /("vars"\s*:\s*\{)/;
  if (!marker.test(text)) throw new Error("vars_marker_missing");
  const auditText = text.replace(marker, '$1\n    "PRIMARY_AUDIT_TOKEN": "",');
  assertConfigDelta(production, parseConfig(auditText));
  return auditText;
}
function assertConfigDelta(production, audit) {
  const copy = structuredClone(audit);
  if (copy.vars.PRIMARY_AUDIT_TOKEN !== "" || Object.hasOwn(production.vars, "PRIMARY_AUDIT_TOKEN")) throw new Error("token_declaration_invalid");
  delete copy.vars.PRIMARY_AUDIT_TOKEN;
  if (JSON.stringify(copy) !== JSON.stringify(production)) throw new Error("unexpected_config_delta");
  return ["vars.PRIMARY_AUDIT_TOKEN"];
}
function tokenBindingPreflight(cli, production, audit, configPath) {
  const synthetic = "offline-synthetic-token";
  const start = cli.indexOf("function getVarsForDev(");
  const end = cli.indexOf("function tryLoadDotDevDotVars(", start);
  const bindingsStart = cli.indexOf("function getBindings2(");
  const bindingsEnd = cli.indexOf("function getAssetChangeMessage(", bindingsStart);
  if ([start, end, bindingsStart, bindingsEnd].some(index => index < 0)) throw new Error("installed_contract_missing");
  const context = vm.createContext({ path31__namespace: path,
    loadDotEnv: () => ({ PRIMARY_AUDIT_TOKEN: synthetic }),
    loadDotDevDotVars: () => { throw new Error("unexpected_secret_read"); },
    getCloudflareLoadDevVarsFromDotEnv: () => true,
    getCloudflareIncludeProcessEnvFromEnv: () => false,
    logger2: { warn() {}, log() {}, debug() {} },
    applyHyperdriveEnvVars() {}, convertConfigToBindings: () => ({}),
  });
  // Offline-only evaluation: no Wrangler runtime/auth API is invoked.
  vm.runInContext(cli.slice(start, end) + cli.slice(bindingsStart, bindingsEnd), context);
  const load = config => context.getBindings2({ ...config, userConfigPath: configPath }, undefined,
    ["synthetic.env"], false, {
      FACE_GEOMETRY_ENRICHMENT_ENABLED: { type: "plain_text", value: "false" },
      IDENTITY_GEOMETRY_ENRICHMENT_ENABLED: { type: "plain_text", value: "false" },
      SYNCHRONOUS_ENHANCEMENTS_ENABLED: { type: "plain_text", value: "false" },
    }, {});
  const negative = load(production);
  const positive = load(audit);
  return !Object.hasOwn(negative, "PRIMARY_AUDIT_TOKEN")
    && positive.PRIMARY_AUDIT_TOKEN?.type === "secret_text"
    && positive.PRIMARY_AUDIT_TOKEN?.value === synthetic
    && positive.FACE_GEOMETRY_ENRICHMENT_ENABLED.value === "false"
    && positive.IDENTITY_GEOMETRY_ENRICHMENT_ENABLED.value === "false"
    && positive.SYNCHRONOUS_ENHANCEMENTS_ENABLED.value === "false";
}
function metadataPreflight(cli, config, workersDir) {
  const legacy = path.join(os.homedir(), ".wrangler");
  const base = fs.existsSync(legacy) ? legacy : path.join(process.env.XDG_CONFIG_HOME
    || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "xdg.config"), ".wrangler");
  const bindings = JSON.parse(fs.readFileSync(path.join(base, "profiles", "directory-bindings.json"), "utf8"));
  const start = cli.indexOf("function getProfileForDirectoryFromBindings(");
  const end = cli.indexOf("function getLineColFromPtr2(", start);
  if (start < 0 || end < 0) throw new Error("binding_contract_missing");
  const context = vm.createContext({ path31__namespace: { default: path } });
  vm.runInContext(cli.slice(start, end), context);
  const selected = context.getProfileForDirectoryFromBindings(workersDir, bindings);
  const names = ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_KEY",
    "CLOUDFLARE_EMAIL", "CF_EMAIL", "CLOUDFLARE_ACCOUNT_ID", "CF_ACCOUNT_ID",
    "CLOUDFLARE_ACCESS_CLIENT_ID", "CLOUDFLARE_ACCESS_CLIENT_SECRET", "CLOUDFLARE_AUTH_USE_KEYRING",
    "WRANGLER_API_ENVIRONMENT", "CLOUDFLARE_API_BASE_URL", "CF_API_BASE_URL", "CLOUDFLARE_COMPLIANCE_REGION",
    "WRANGLER_OUTPUT_FILE_DIRECTORY", "WRANGLER_OUTPUT_FILE_PATH", "CLOUDFLARE_PAGES", "CLOUDFLARE_WORKERS"];
  return { selectedProfileClass: selected?.profile && selected.profile !== "default" ? "non_default" : "default",
    approvedAccountIdMatch: config.account_id === "8e83629048e42855e4d5a5777c769ba4",
    authOverrideAbsent: !Object.keys(process.env).some(key => names.some(name => name.toLowerCase() === key.toLowerCase())),
    dotenvOverrideAbsent: [".env", ".env.local"].every(name => !fs.existsSync(path.join(workersDir, name))),
    credentialContentsRead: false, credentialExtraction: false };
}
function discoverPty() {
  const root = path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code");
  const candidates = fs.existsSync(root) ? [root, ...fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name))] : [];
  for (const base of candidates) {
    const directory = path.join(base, "resources", "app", "node_modules", "node-pty");
    if (!fs.existsSync(path.join(directory, "package.json")) || !fs.existsSync(path.join(directory, "build", "Release", "conpty.node"))) continue;
    try {
      if (typeof require(directory).spawn !== "function" || !require(path.join(directory, "build", "Release", "conpty.node"))) continue;
      return { directory, version: JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).version,
        publicSpawnLoaded: true, nativeBackendLoaded: true };
    } catch { /* Try only already installed candidates, never install. */ }
  }
  throw new Error("installed_conpty_unavailable");
}
function processSnapshot() {
  const command = '$ErrorActionPreference = "Stop"; @(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { @{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; created = $_.CreationDate.ToUniversalTime().Ticks.ToString() } }) | ConvertTo-Json -Compress';
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8", windowsHide: true, timeout: 15_000,
  });
  const result = JSON.parse(raw);
  return Array.isArray(result) ? result : [result];
}
function descendants(snapshot, rootPid) {
  const ids = new Set([rootPid]);
  let added;
  do { added = false; for (const item of snapshot) {
    if (ids.has(item.parent) && !ids.has(item.pid)) { ids.add(item.pid); added = true; }
  } } while (added);
  return snapshot.filter(item => item.pid !== rootPid && ids.has(item.pid));
}
function windowsExecutable(name, override, errorCode) {
  const executable = override || path.join(process.env.SystemRoot || "C:\\Windows", "System32", name);
  if (!fs.existsSync(executable)) throw new Error(errorCode);
  return executable;
}
function runWindowsFile(executable, args, errorCode) {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch { throw new Error(errorCode); }
}
function currentUserIdentity(options = {}) {
  const whoami = windowsExecutable("whoami.exe", options.whoamiPath, "current_user_sid_unavailable");
  const raw = runWindowsFile(whoami, ["/user", "/fo", "csv", "/nh"], "current_user_sid_unavailable").trim();
  const match = raw.match(/^"((?:[^"]|"")*)","(S-\d+(?:-\d+)+)"$/);
  if (!match) throw new Error("current_user_sid_unavailable");
  return { account: match[1].replace(/""/g, '"'), sid: match[2] };
}
function readAclSddl(target, icacls) {
  const aclFile = path.join(path.dirname(target), `.acl-verification-${process.pid}-${randomUUID()}.tmp`);
  try {
    runWindowsFile(icacls, [target, "/save", aclFile, "/Q"], "windows_icacls_failed");
    const sddl = fs.readFileSync(aclFile, "utf16le").replace(/^\uFEFF/, "")
      .split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith("D:"));
    if (!sddl) throw new Error("windows_acl_verification_failed");
    return sddl;
  } finally {
    if (fs.existsSync(aclFile)) fs.unlinkSync(aclFile);
  }
}
function parseAclSddl(sddl) {
  const firstAce = sddl.indexOf("(");
  if (!sddl.startsWith("D:") || firstAce < 0) throw new Error("windows_acl_verification_failed");
  const control = sddl.slice(2, firstAce);
  const entries = [...sddl.matchAll(/\(([^)]*)\)/g)].map(match => {
    const parts = match[1].split(";");
    if (parts.length !== 6) throw new Error("windows_acl_verification_failed");
    return { type: parts[0], flags: parts[1], rights: parts[2], trustee: parts[5] };
  });
  return { control, entries };
}
function inspectTemporaryDirectoryAcl(directory, options = {}) {
  const identity = options.identity || currentUserIdentity(options);
  const icacls = windowsExecutable("icacls.exe", options.icaclsPath, "windows_icacls_unavailable");
  const { control, entries } = parseAclSddl(readAclSddl(directory, icacls));
  const allowed = new Set([identity.sid, "SY", "S-1-5-18"]);
  const broad = new Set(["WD", "BU", "AU", "S-1-1-0", "S-1-5-32-545", "S-1-5-11"]);
  const inheritanceDisabled = control.includes("P") && entries.every(entry => !entry.flags.includes("ID"));
  const currentUserAccessPresent = entries.some(entry => entry.trustee === identity.sid
    && entry.type === "A" && entry.rights === "FA" && entry.flags.includes("OI") && entry.flags.includes("CI"));
  const systemAccessPresent = entries.some(entry => (entry.trustee === "SY" || entry.trustee === "S-1-5-18")
    && entry.type === "A" && entry.rights === "FA" && entry.flags.includes("OI") && entry.flags.includes("CI"));
  const broadInheritedAccessPresent = entries.some(entry => entry.flags.includes("ID") && broad.has(entry.trustee));
  const unexpectedAccessPresent = entries.some(entry => !allowed.has(entry.trustee));
  return {
    aclRestricted: inheritanceDisabled && currentUserAccessPresent && systemAccessPresent
      && !broadInheritedAccessPresent && !unexpectedAccessPresent && entries.length === 2,
    inheritanceDisabled, currentUserAccessPresent, systemAccessPresent,
    broadInheritedAccessPresent, unexpectedAccessPresent,
  };
}
function inspectInheritedFileAcl(file, options = {}) {
  const identity = options.identity || currentUserIdentity(options);
  const icacls = windowsExecutable("icacls.exe", options.icaclsPath, "windows_icacls_unavailable");
  const { entries } = parseAclSddl(readAclSddl(file, icacls));
  const allowed = new Set([identity.sid, "SY", "S-1-5-18"]);
  return {
    inheritedFromRestrictedDirectory: entries.length === 2 && entries.every(entry => entry.type === "A"
      && entry.rights === "FA" && entry.flags.includes("ID") && allowed.has(entry.trustee)),
    unexpectedAccessPresent: entries.some(entry => !allowed.has(entry.trustee)),
  };
}
function restrictTemporaryDirectory(directory, options = {}) {
  const identity = currentUserIdentity(options);
  const icacls = windowsExecutable("icacls.exe", options.icaclsPath, "windows_icacls_unavailable");
  runWindowsFile(icacls, [directory, "/inheritance:r", "/Q"], "windows_icacls_failed");
  runWindowsFile(icacls, [directory, "/grant:r", `*${identity.sid}:(OI)(CI)F`, "*S-1-5-18:(OI)(CI)F", "/Q"],
    "windows_icacls_failed");
  const result = inspectTemporaryDirectoryAcl(directory, { ...options, identity, icaclsPath: icacls });
  if (!result.aclRestricted) throw new Error("windows_acl_verification_failed");
  return result;
}
function parseReady(raw) {
  let value = raw;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || value.event !== "DEV_SERVER_READY" || value.ip !== "127.0.0.1"
    || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) return null;
  return { event: "DEV_SERVER_READY", ip: "127.0.0.1", port: value.port };
}
module.exports = { parseConfig, deriveConfig, assertConfigDelta, tokenBindingPreflight, metadataPreflight,
  discoverPty, processSnapshot, descendants, currentUserIdentity, inspectTemporaryDirectoryAcl,
  inspectInheritedFileAcl, restrictTemporaryDirectory, parseReady };
