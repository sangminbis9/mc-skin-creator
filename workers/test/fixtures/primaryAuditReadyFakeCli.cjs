// Synthetic offline roles: no Wrangler runtime, HTTP, credentials or files read.
const { spawn } = require("node:child_process");
const role = process.argv[2];
if (role === "terminal") {
  process.stdout.write("offline fixture\n");
  setTimeout(() => process.exit(0), 50);
} else if (role === "owner" || role === "bridge") {
  const args = role === "owner" ? [__filename, "bridge", process.argv[3]] : [process.argv[3]];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(), env: process.env, windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let ownerRegistry;
  child.on("message", raw => {
    if (role === "owner") {
      const { registerBridgeIdentity } = require(process.argv[4]);
      ownerRegistry ??= { pid: null };
      if (raw?.kind === "bridge_started") {
        if (registerBridgeIdentity(ownerRegistry, raw.bridgePid, raw.bridgePid) !== "publish") return;
        process.send?.({ kind: "owner_started", ownerPid: process.pid, bridgePid: ownerRegistry.pid });
        process.send?.(raw);
      } else if (raw?.bridgePid === ownerRegistry.pid) process.send?.(raw);
      return;
    }
    let value;
    try { value = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return; }
    if (value?.event === "DEV_SERVER_READY" && value.ip === "127.0.0.1"
      && Number.isInteger(value.port) && value.port > 0 && value.port <= 65535) {
      process.send?.({ kind: "ready", bridgePid: process.pid, wrapperPid: child.pid, payload: value });
    }
  });
  if (role === "bridge") process.send?.({ kind: "bridge_started", bridgePid: process.pid,
    wrapperPid: child.pid, stdinTTY: true, stdoutTTY: true });
  child.on("close", code => { process.exitCode = code ?? 1; process.disconnect?.(); });
} else {
  const mode = process.env.AUDIT_READY_FAKE_MODE;
  if (mode === "silent") process.disconnect?.();
  else process.send?.(JSON.stringify({ event: "DEV_SERVER_READY", ip: "127.0.0.1",
    port: mode === "malformed" ? 0 : 8787 }), () => {
      // Keep the synthetic inner CLI alive briefly so a real process snapshot
      // can prove owner -> bridge -> wrapper -> inner CLI ancestry.
      setTimeout(() => process.disconnect?.(), mode === "ready" ? 3000 : 100);
    });
}
