// Test-only extraction of installed implementation into a fake dependency scope.
// Never import this in a real CLI runner; operational shutdown uses literal q.
const fs = require("node:fs");
const vm = require("node:vm");
const Stream = require("node:stream");
const readline = require("node:readline");
const path = require("node:path");

function installedHotkeys(testProcess, extra = {}) {
  const source = fs.readFileSync(path.resolve(__dirname, "../../node_modules/wrangler/wrangler-dist/cli.js"), "utf8");
  const section = (start, end) => {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin);
    if (begin < 0 || finish < begin) throw new Error("installed_hotkey_contract_changed");
    return source.slice(begin, finish);
  };
  const scope = {
    process: testProcess, Stream, readline2__default: { default: readline },
    import_ci_info: { default: {} }, __name: fn => fn,
    unwrapHook: value => typeof value === "function" ? value() : value,
    debounce: fn => fn, LocalRuntimeController: class {},
    logger2: { error: () => {}, console: () => {}, warn: () => {} },
    ...extra,
  };
  const code = [
    section("function isTtyInteractive()", "function isNonInteractiveOrCI()"),
    section("function onKeyPress(callback2, options)", "var init_onKeyPress ="),
    section("function cli_hotkeys_default(options", "var init_cli_hotkeys ="),
    section("function registerDevHotKeys(devEnvs", "var init_hotkeys ="),
    "({ isInteractive, registerDevHotKeys })",
  ].join("\n");
  return vm.runInNewContext(code, scope);
}
module.exports = { installedHotkeys };
