import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { classifyCliStderr, exerciseCliAuditLifecycle } from "./primaryAuditCliLifecycle";
import { boundedHealthProbe } from "./primaryAuditRemoteReadiness";

const requireFixture = createRequire(import.meta.url);
const { installedHotkeys } = requireFixture("./fixtures/primaryAuditInstalledHotkeys.cjs") as {
  installedHotkeys(process: unknown, extra?: object): {
    isInteractive(): boolean;
    registerDevHotKeys(devs: unknown[], args: object, options: object): () => void;
  };
};
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.useRealTimers(); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(tty = true) {
  const input = Object.assign(new PassThrough(), { isTTY: tty, setRawMode: vi.fn() });
  const rawErrors: string[] = [];
  const api = installedHotkeys({ stdin: input, stdout: { isTTY: tty }, env: {} }, {
    logger2: { error: (text: string) => rawErrors.push(text) },
  });
  const trace: string[] = [];
  let release!: () => void;
  const disposal = new Promise<void>(resolve => { release = resolve; });
  const dev = Object.assign(new EventEmitter(), { config: {}, runtimes: [],
    teardown: vi.fn(async () => { trace.push("teardown_requested"); await disposal;
      trace.push("controllers_disposed"); dev.emit("teardown"); }),
  });
  let unregister = () => {};
  const completed = new Promise<void>(resolve => dev.once("teardown", () => {
    void Promise.resolve().then(() => {
      trace.push("secondary_disposed"); unregister(); trace.push("handler_completed"); resolve();
    });
  }));
  if (api.isInteractive()) unregister = api.registerDevHotKeys([dev], { remote: true }, { render: false });
  cleanups.push(() => { unregister(); input.destroy(); release(); });
  return { api, input, dev, trace, completed, release, unregister, rawErrors };
}

it.each(["q", "x", "\u0003"])("installed hotkey %j awaits controller and secondary completion", async key => {
  const f = fixture();
  f.input.write(key); await tick();
  expect(f.dev.teardown).toHaveBeenCalledOnce(); expect(f.trace).toEqual(["teardown_requested"]);
  f.release(); await f.completed;
  expect(f.trace).toEqual(["teardown_requested", "controllers_disposed", "secondary_disposed", "handler_completed"]);
  expect(f.input.setRawMode).toHaveBeenCalledWith(true); expect(f.input.setRawMode).toHaveBeenCalledWith(false);
});
it("registered q works before local proxy/health readiness", async () => {
  const f = fixture(); f.input.write("q"); await tick(); f.release(); await f.completed;
  expect(f.dev.teardown).toHaveBeenCalledOnce(); expect(f.trace).toContain("handler_completed");
});
it("pipe stdin does not register hotkeys and true flag cannot override isInteractive", async () => {
  const f = fixture(false); expect(f.api.isInteractive()).toBe(false);
  f.input.write("q"); await tick(); expect(f.dev.teardown).not.toHaveBeenCalled();
  expect(f.input.setRawMode).not.toHaveBeenCalled();
  const source = fs.readFileSync("node_modules/wrangler/wrangler-dist/cli.js", "utf8");
  expect(source).toContain("isInteractive() && args.showInteractiveDevSession !== false");
});
it("health timeout leads to one q and awaited teardown without request retry", async () => {
  vi.useFakeTimers(); const f = fixture(); const fetch = vi.fn(() => new Promise<never>(() => {}));
  const result = boundedHealthProbe({ fetch }, "fake-token", () => {}, 20);
  await vi.advanceTimersByTimeAsync(20); expect((await result).status).toBe("timeout");
  vi.useRealTimers(); f.input.write("q"); await tick(); f.release(); await f.completed;
  expect(f.dev.teardown).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
});
it("hung teardown fails cleanup without q retry or kill", async () => {
  const f = fixture(); f.input.write("q"); await tick();
  const cleanup = await Promise.race([f.completed.then(() => "verified"),
    new Promise<string>(resolve => setTimeout(() => resolve("cleanup_failed"), 10))]);
  expect(cleanup).toBe("cleanup_failed"); expect(f.dev.teardown).toHaveBeenCalledOnce();
  expect(f.trace).not.toContain("handler_completed");
});
it("unexpected exit closes the input path: no q or retry is sent", async () => {
  const f = fixture();
  const send = vi.fn(async () => { f.input.write("q"); });
  const fetch = vi.fn(() => new Promise<never>(() => {}));
  const result = await exerciseCliAuditLifecycle({
    exited: Promise.resolve({ code: 1, signal: null }),
    start: () => { f.unregister(); f.input.destroy(); },
    requestShutdown: send, verifyOwnedProcessesGone: async () => true,
  }, { fetch }, { localReadyMs: 20, healthMs: 20, shutdownMs: 20 });
  expect(result.readiness).toBe("child_exited");
  expect(send).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  expect(f.dev.teardown).not.toHaveBeenCalled();
});
it("stderr diagnostic stores only a class", () => {
  expect(JSON.stringify({ messageClassified: classifyCliStderr("authentication error: synthetic-secret url=https://private.invalid") }))
    .toBe('{"messageClassified":"auth"}');
});

function installedPtyDirectory(): string | null {
  const root = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code");
  if (!fs.existsSync(root)) return null;
  const candidates = [root, ...fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => path.join(root, item.name))];
  return candidates.map(dir => path.join(dir, "resources", "app", "node_modules", "node-pty"))
    .find(dir => fs.existsSync(path.join(dir, "package.json"))) ?? null;
}
const ptyDirectory = installedPtyDirectory();
function ownedProcessSnapshot(): { pid: number; created: string }[] {
  // Read only: enumerate descendants of this test process, excluding the query
  // process itself. Creation time prevents confusing PID reuse with ownership.
  const script = `$all = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[int]]::new();
    [void]$ids.Add(${process.pid}); do { $added = $false; foreach ($item in $all) {
      if ($item.ProcessId -ne $PID -and $ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $added = $true }
    } } while ($added); @($all | Where-Object { $_.ProcessId -ne ${process.pid} -and $ids.Contains([int]$_.ProcessId) } |
      ForEach-Object { @{ pid = [int]$_.ProcessId; created = $_.CreationDate.ToUniversalTime().Ticks.ToString() } }) | ConvertTo-Json -Compress`;
  const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true });
  if (!raw.trim()) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}
it("PTY availability is discovered from installed files, without package-manager execution", () => {
  expect(ptyDirectory, "NO_PTY_AVAILABLE").not.toBeNull();
  const pkg = JSON.parse(fs.readFileSync(path.join(ptyDirectory!, "package.json"), "utf8"));
  expect(pkg.name).toBe("node-pty"); expect(pkg.version).toBe("1.2.0-beta.13");
  expect(fs.existsSync(path.join(ptyDirectory!, "build", "Release", "conpty.node"))).toBe(true);
});

it.skipIf(process.platform !== "win32" || !ptyDirectory)("installed ConPTY preserves TTY/IPC through wrapper, receives q, awaits exit/close and removes owned children", async () => {
  const before = ownedProcessSnapshot();
  let spawnedInventory: { pid: number; created: string }[] = [];
  const owner = spawn(process.execPath, [path.resolve("test/fixtures/primaryAuditPtyOffline.cjs"), "owner", ptyDirectory!], {
    cwd: process.cwd(), stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  let sent = false; let info: Record<string, unknown> | undefined; let result: Record<string, unknown> | undefined;
  const exited = new Promise<number | null>((resolve, reject) => { owner.once("exit", resolve); owner.once("error", reject); });
  const closed = new Promise<number | null>(resolve => owner.once("close", resolve));
  owner.on("message", raw => {
    const message = raw as Record<string, unknown>;
    if (message.kind === "offline_owner_ready" && !sent) {
      info = message; sent = true;
      spawnedInventory = ownedProcessSnapshot().filter(item => !before.some(old => old.pid === item.pid && old.created === item.created));
      owner.send({ command: "q" });
    }
    if (message.kind === "offline_owner_result") result = message.result as Record<string, unknown>;
  });
  const code = await exited;
  expect(await closed).toBe(0);
  expect(code).toBe(0); expect(sent).toBe(true);
  expect(info?.stdinTTY).toBe(true); expect(info?.stdoutTTY).toBe(true);
  expect(result).toEqual({ exitCode: 0, qSent: true, teardownAwaited: true, childExitObserved: true, childCloseObserved: true });
  const ids = [info?.ownerPid, info?.bridgePid, info?.wrapperPid, info?.leafPid];
  expect(ids.every(id => Number.isInteger(id) && Number(id) > 0)).toBe(true);
  // Read-only process query. No kill/signal operation or raw command line retained.
  const inventory = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `$ids = @(${ids.join(",")}); @((Get-Process -Id $ids -ErrorAction SilentlyContinue)).Count`], { encoding: "utf8", windowsHide: true });
  expect(Number(inventory.trim())).toBe(0);
  expect(ids.every(id => spawnedInventory.some(item => item.pid === id))).toBe(true);
  const after = ownedProcessSnapshot();
  expect(after.filter(item => spawnedInventory.some(owned => owned.pid === item.pid && owned.created === item.created))).toEqual([]);
}, 30_000);
