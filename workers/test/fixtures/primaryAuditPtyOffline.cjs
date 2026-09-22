// No Wrangler startup, auth, HTTP, image or provider code. Tests inherited TTY
// and outbound IPC through the same public spawn topology as bin/wrangler.js.
const { spawn } = require("node:child_process");
const { EventEmitter, once } = require("node:events");
const { installedHotkeys } = require("./primaryAuditInstalledHotkeys.cjs");
const role = process.argv[2];

if (role === "owner") {
  // Own the native PTY handles in a disposable process, not the long-running
  // test runner. Exit this owner ONLY AFTER the app tree has exited via q.
  const pty = require(process.argv[3]);
  const terminal = pty.spawn(process.execPath, [__filename, "bridge"], {
    cwd: process.cwd(), cols: 120, rows: 30,
  });
  let text = "";
  let ready = false;
  let sent = false;
  process.on("message", message => {
    if (message?.command === "q" && ready && !sent) { sent = true; terminal.write("q"); }
  });
  terminal.onData(chunk => {
    text = (text + chunk).slice(-16384);
    const match = text.match(/OFFLINE_TTY_READY (\{[^\r\n]+\})/);
    if (match && !ready) {
      ready = true;
      process.send?.({ kind: "offline_owner_ready", ...JSON.parse(match[1]), ownerPid: process.pid });
    }
  });
  terminal.onExit(event => {
    const result = { exitCode: event.exitCode, qSent: sent,
      teardownAwaited: text.includes("OFFLINE_TEARDOWN_AWAITED"),
      childExitObserved: text.includes("OFFLINE_CHILD_EXIT 0"),
      childCloseObserved: text.includes("OFFLINE_CHILD_CLOSE 0") };
    const code = result.exitCode === 0 && result.qSent && result.teardownAwaited
      && result.childExitObserved && result.childCloseObserved ? 0 : 6;
    process.send?.({ kind: "offline_owner_result", result }, () => {
      process.disconnect?.();
      // The app process is already gone. This releases owner-only ConPTY/native
      // handles and worker threads; it never requests app termination or kill.
      process.exit(code);
    });
  });
} else if (role === "bridge" || role === "wrapper") {
  const child = spawn(process.execPath, [__filename, role === "bridge" ? "wrapper" : "leaf"], {
    stdio: ["inherit", "inherit", "inherit", "ipc"], windowsHide: true,
  });
  child.on("message", message => {
    if (role === "wrapper") process.send?.(message);
    else if (message && typeof message === "object" && message.kind === "offline_tty_ready") {
      process.stdout.write(`OFFLINE_TTY_READY ${JSON.stringify({ stdinTTY: message.stdinTTY,
        stdoutTTY: message.stdoutTTY, bridgePid: process.pid, wrapperPid: child.pid, leafPid: message.pid })}\n`);
    } else if (message?.kind === "offline_teardown_awaited") {
      process.stdout.write("OFFLINE_TEARDOWN_AWAITED\n");
    }
  });
  child.on("error", () => { process.exitCode = 3; });
  child.on("exit", code => {
    if (role === "bridge") process.stdout.write(`OFFLINE_CHILD_EXIT ${code}\n`);
    process.exitCode = code ?? 3;
  });
  child.on("close", code => {
    if (role === "bridge") process.stdout.write(`OFFLINE_CHILD_CLOSE ${code}\n`);
    process.disconnect?.();
  });
} else if (role === "leaf") {
  const events = [];
  const dev = Object.assign(new EventEmitter(), {
    runtimes: [], config: { latestConfig: { dev: { remote: true } } },
    async teardown() {
      events.push("requested");
      await new Promise(resolve => setImmediate(resolve));
      events.push("controllers_disposed");
      this.emit("teardown");
    },
  });
  const hotkeys = installedHotkeys(process);
  if (!hotkeys.isInteractive()) {
    process.send?.({ kind: "offline_tty_ready", stdinTTY: false, stdoutTTY: false, pid: process.pid });
    process.exitCode = 4;
    process.disconnect?.();
  } else {
    const complete = once(dev, "teardown");
    const unregister = hotkeys.registerDevHotKeys([dev], { remote: true }, { render: false });
    // Fixture-only self deadline: never a hard-kill fallback for a real Worker.
    const timer = setTimeout(() => {
      unregister(); process.stdin.pause(); process.exitCode = 5; process.disconnect?.();
    }, 20_000);
    void complete.then(async () => {
      await Promise.resolve(); // fake secondary environment completion
      unregister();
      clearTimeout(timer);
      process.send?.({ kind: "offline_teardown_awaited", passed: events.join(",") === "requested,controllers_disposed" });
      process.stdin.pause();
      process.disconnect?.();
    });
    process.send?.({ kind: "offline_tty_ready", stdinTTY: process.stdin.isTTY === true,
      stdoutTTY: process.stdout.isTTY === true, pid: process.pid });
  }
} else {
  throw new Error("offline_fixture_role_required");
}
