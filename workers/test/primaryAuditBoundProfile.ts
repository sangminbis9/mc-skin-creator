export const APPROVED_AUDIT_ACCOUNT_ID = "8e83629048e42855e4d5a5777c769ba4";
export const AUDIT_ENTRYPOINT = "test/primaryFaceMeasurementAuditWorker.ts";

// Observation-only plan. Does not import Wrangler, select auth, or start a process.
// The resolver handles identifiers transiently; this boundary retains classes only.
export function planBoundProfileAudit(input: {
  resolveProfileClass(): "default" | "non_default";
  accountId: string | undefined;
  entrypoint: string;
  authOverrideAbsent: boolean;
}) {
  let selectedProfileClass: "default" | "non_default" | "unresolved" = "unresolved";
  try { selectedProfileClass = input.resolveProfileClass(); } catch { /* fail closed, no raw exception retained */ }
  const workersBoundProfileResolved = selectedProfileClass === "non_default";
  const approvedAccountIdMatch = input.accountId === APPROVED_AUDIT_ACCOUNT_ID;
  const auditEntrypointPreserved = input.entrypoint === AUDIT_ENTRYPOINT;
  const profileParityPreflightPassed = workersBoundProfileResolved && approvedAccountIdMatch
    && auditEntrypointPreserved && input.authOverrideAbsent;
  return {
    expectedProfileClass: "non_default" as const, selectedProfileClass, boundDirectory: "workers" as const,
    workersBoundProfileResolved, approvedAccountIdMatch, auditEntrypointPreserved,
    credentialContentsRead: false, credentialExtraction: false, profileParityPreflightPassed,
    selectedStrategy: "installed_cli_remote_dev" as const,
    // CLI auth alignment exists, but its only ready IPC is local proxy readiness.
    // Never claim this satisfies the existing reloadComplete + proxy-drain gate.
    existingReadinessGateAccessible: false,
    remoteStartAllowed: false,
    blocker: "cli_lacks_supported_remote_reload_drain_and_teardown_bridge" as const,
  };
}
