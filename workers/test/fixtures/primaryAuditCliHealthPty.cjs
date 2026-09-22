// Audit-only real CLI adapter. No raw terminal output is persisted or forwarded.
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { parseReady } = require("../primaryAuditCliHealthSupport.cjs");
const role = process.argv[2];

function registerBridgeIdentity(registry, candidatePid, terminalPid) {
  if (!Number.isInteger(candidatePid) || candidatePid <= 0
    || !Number.isInteger(terminalPid) || terminalPid <= 0
    || candidatePid !== terminalPid) return "reject";
  if (registry.pid === null) {
    registry.pid = candidatePid;
    return "publish";
  }
  return registry.pid === candidatePid ? "duplicate" : "reject";
}
module.exports = { registerBridgeIdentity };

if (require.main === module && role === "owner") {
  const pty = require(process.argv[3]);
  const config = process.argv[4];
  const envFile = process.argv[5];
  const pipe = `\\\\.\\pipe\\primary-audit-${randomUUID()}`;
  let terminal;
  let ready = false;
  let interactive = false;
  let qSent = false;
  let bridgeComplete = false;
  let ptyExit = null;
  let resultFlushed = false;
  let socket;
  const bridgeIdentity = { pid: null };
  const state = { wrapperExitObserved: false, wrapperCloseObserved: false,
    wrapperExitCode: null, wrapperSignalAbsent: false, bridgeCompletionObserved: false,
    ptyExitObserved: false, ptyExitCode: null, qSentCount: 0 };
  const send = value => { if (process.connected) process.send(value, () => {}); };
  const finish = () => {
    if (!bridgeComplete || !ptyExit || resultFlushed) return;
    resultFlushed = true;
    server.close(() => {
      send({ kind: "result", state });
      // Native owner handles are released only after wrapper close + bridge/PTY
      // exit. Owner termination is never a means of terminating live Wrangler.
      const exitOwner = () => {
        process.disconnect?.();
        process.exit(state.wrapperExitCode === 0 && state.ptyExitCode === 0 ? 0 : 7);
      };
      if (process.connected) process.send({ kind: "owner_result_flushed" }, exitOwner);
      else exitOwner();
    });
  };
  const server = net.createServer(connection => {
    if (socket) { connection.end(); return; }
    socket = connection;
    let pending = "";
    connection.on("data", chunk => {
      pending += chunk.toString("utf8");
      if (pending.length > 8192) { connection.end(); return; }
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.kind === "bridge_started") {
          if (!Number.isInteger(message.wrapperPid) || message.wrapperPid <= 0
            || message.stdinTTY !== true || message.stdoutTTY !== true) continue;
          const identity = registerBridgeIdentity(bridgeIdentity, message.bridgePid, terminal?.pid);
          if (identity !== "publish") continue;
          interactive = message.stdinTTY === true && message.stdoutTTY === true;
          // Publish the validated positive bridge identity once, immediately
          // before forwarding the same bridge_started message. Node IPC keeps
          // these synchronous sends ordered for the supervisor.
          send({ kind: "owner_started", ownerPid: process.pid, bridgePid: bridgeIdentity.pid });
          send({ kind: "bridge_started", bridgePid: bridgeIdentity.pid, wrapperPid: message.wrapperPid,
            stdinTTY: message.stdinTTY === true, stdoutTTY: message.stdoutTTY === true });
        } else if (message.bridgePid !== bridgeIdentity.pid) continue;
        else if (message.kind === "ready" && interactive && !ready) {
          const payload = parseReady(message.payload);
          if (!payload) continue;
          ready = true;
          send({ kind: "ready", payload, bridgePid: bridgeIdentity.pid, wrapperPid: message.wrapperPid,
            hotkeysProvenByInstalledOrdering: true });
        } else if (message.kind === "wrapper_exit") {
          state.wrapperExitObserved = true;
          state.wrapperExitCode = Number.isInteger(message.code) ? message.code : null;
          state.wrapperSignalAbsent = message.signalAbsent === true;
          send({ kind: "wrapper_exit", code: state.wrapperExitCode });
        } else if (message.kind === "wrapper_close") {
          state.wrapperCloseObserved = true;
          state.bridgeCompletionObserved = true;
          bridgeComplete = true;
          send({ kind: "wrapper_close" });
        } else if (message.kind === "spawn_error") send({ kind: "classification", value: "unknown_error" });
      }
    });
    connection.on("close", finish);
    connection.on("error", () => {});
  });
  server.listen(pipe, () => {
    terminal = pty.spawn(process.execPath, [__filename, "bridge", pipe, config, envFile], {
      cwd: process.cwd(), cols: 120, rows: 30,
      env: { ...process.env, CI: "true", WRANGLER_WRITE_LOGS: "false", WRANGLER_SEND_METRICS: "false",
        WRANGLER_SEND_ERROR_REPORTS: "false", CLOUDFLARE_INCLUDE_PROCESS_ENV: "false" },
    });
    const classes = new Set();
    let boundedText = "";
    terminal.onData(chunk => {
      boundedText = (boundedText + chunk).slice(-4096).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      // UI registration evidence is transient. No arbitrary output leaves owner.
      if (interactive && /\[x\]\s+to exit/.test(boundedText) && !ready) {
        send({ kind: "hotkeys_registered" });
      }
      const value = /authentication|not authenticated|unauthorized|unable to authenticate|not logged in/i.test(boundedText)
        ? "auth_error" : /build failed|build failure|failed to build/i.test(boundedText)
          ? "build_error" : /\berror\b/i.test(boundedText) ? "unknown_error" : null;
      if (value && !classes.has(value)) { classes.add(value); send({ kind: "classification", value }); }
    });
    terminal.onExit(event => {
      ptyExit = event;
      state.ptyExitObserved = true; state.ptyExitCode = event.exitCode;
      send({ kind: "pty_exit", code: event.exitCode });
      finish();
    });
  });
  process.on("message", message => {
    if (message?.command === "q" && terminal && interactive && message.registrationProven === true && !qSent && !ptyExit) {
      qSent = true; state.qSentCount = 1;
      terminal.write("q");
      send({ kind: "q_sent", count: 1 });
    }
  });
} else if (require.main === module && role === "bridge") {
  const pipe = process.argv[3];
  const config = process.argv[4];
  const envFile = process.argv[5];
  const connection = net.createConnection(pipe);
  const send = value => connection.write(JSON.stringify({ ...value, bridgePid: process.pid }) + "\n");
  connection.on("connect", () => {
    const child = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev",
      "test/primaryFaceMeasurementAuditWorker.ts", "--remote", "--config", config,
      "--env-file", envFile, "--ip", "127.0.0.1", "--port", "0", "--local-protocol", "http",
      "--show-interactive-dev-session", "true", "--log-level", "info", "--no-types",
      "--var", "FACE_GEOMETRY_ENRICHMENT_ENABLED:false",
      "--var", "IDENTITY_GEOMETRY_ENRICHMENT_ENABLED:false",
      "--var", "SYNCHRONOUS_ENHANCEMENTS_ENABLED:false"], {
      cwd: process.cwd(), stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true,
    });
    send({ kind: "bridge_started", wrapperPid: child.pid,
      stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true });
    child.on("message", raw => {
      const payload = parseReady(raw);
      if (payload) send({ kind: "ready", wrapperPid: child.pid, payload });
    });
    child.on("error", () => { send({ kind: "spawn_error" }); process.exitCode = 3; });
    child.on("exit", (code, signal) => {
      send({ kind: "wrapper_exit", code, signalAbsent: signal === null });
      process.exitCode = code ?? 3;
    });
    child.on("close", code => {
      send({ kind: "wrapper_close", code });
      connection.end();
    });
  });
  connection.on("error", () => { process.exitCode = 3; });
} else if (require.main === module) throw new Error("audit_pty_role_required");
