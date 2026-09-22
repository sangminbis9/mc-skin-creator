import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exceptionDiagnostic } from "./primaryAuditRunnerSupport";

const installed = resolve("node_modules/wrangler");
const cli = readFileSync(resolve(installed, "wrangler-dist/cli.js"), "utf8");
const proxySource = readFileSync(resolve(installed, "templates/startDevWorker/ProxyWorker.ts"), "utf8");
afterEach(() => vi.unstubAllGlobals());

describe("secret-safe startup/health exception diagnostics", () => {
  it("preserves a nested headers timeout without raw message, URL, token or stack", () => {
    const secret = "secret-token-never-store";
    const cause = Object.assign(new Error(secret), { name: "HeadersTimeoutError", code: "UND_ERR_HEADERS_TIMEOUT" });
    const error = new TypeError(`fetch failed https://example.invalid/?token=${secret}`, { cause });
    error.stack = `TypeError: ${secret}\n at caller (C:\\repo\\workers\\node_modules\\wrangler\\wrangler-dist\\cli.js:438827:20)`;
    expect(exceptionDiagnostic(error, "health")).toEqual({
      name: "TypeError", constructor: "TypeError", code: null, causeName: "HeadersTimeoutError", causeCode: "UND_ERR_HEADERS_TIMEOUT",
      messageClassified: "headers_timeout", repoOrWranglerTopFrame: "wrangler/wrangler-dist/cli.js:438827:20",
    });
    expect(JSON.stringify(exceptionDiagnostic(error, "health"))).not.toContain(secret);
    expect(JSON.stringify(exceptionDiagnostic(error, "health"))).not.toContain("https:");
  });
  it.each([
    ["UND_ERR_CONNECT_TIMEOUT", "connect_timeout"], ["UND_ERR_ABORTED", "aborted"],
  ])("classifies %s", (code, expected) => {
    expect(exceptionDiagnostic({ code, message: "secret" }, "health").messageClassified).toBe(expected);
  });
  it("classifies fetch failure/startup/unknown and removes arbitrary identifiers", () => {
    expect(exceptionDiagnostic(new TypeError("fetch failed secret"), "health").messageClassified).toBe("fetch_failed");
    expect(exceptionDiagnostic(new Error("secret"), "startup").messageClassified).toBe("wrangler_startup");
    const result = exceptionDiagnostic({ name: "secret", code: "secret", constructor: { name: "secret" }, cause: { name: "secret", code: "secret" }, stack: "secret" }, "health");
    expect(result).toEqual({ name: null, constructor: null, code: null, causeName: null, causeCode: null, messageClassified: "unknown", repoOrWranglerTopFrame: null });
  });
});

describe("installed Wrangler 4.120.0 remote health contract, no network", () => {
  it("rewrites absolute and path-only targets to the local proxy, preserving path/query", () => {
    const fn = cli.match(/function parseRequestInput\([^]*?\n}\n(?=var import_undici29;)/)?.[0];
    expect(fn).toBeDefined();
    // Execute only the extracted pure URL/Request adapter, never Wrangler startup.
    const parse = runInNewContext(`${fn}; parseRequestInput`, { URL, import_undici29: { Request } });
    for (const target of ["http://audit.invalid/primary-audit-health?check=1", "/primary-audit-health?check=1"]) {
      const [url, forwarded] = parse("127.0.0.1", 8787, target);
      expect(url.href).toBe("http://127.0.0.1:8787/primary-audit-health?check=1");
      expect(forwarded.headers.get("MF-Original-URL")).toBe(target.startsWith("http:") ? target : `http://placeholder${target}`);
    }
  });
  it("proves the installed proxy queues health before play, then targets the preview origin", async () => {
    const parsed = ts.createSourceFile("ProxyWorker.ts", proxySource, ts.ScriptTarget.ES2022, true);
    const declaration = parsed.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "ProxyWorker")!;
    const code = ts.transpileModule(declaration.getText(parsed).replace("export class", "class") + "\nglobalThis.TestProxyWorker = ProxyWorker;", {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const network = vi.fn(() => { throw new Error("external_network_forbidden"); }); vi.stubGlobal("fetch", network);
    const forwarded = vi.fn(async () => new Response("health mock"));
    const context = {
      URL, Headers, Request, Response, fetch: forwarded,
      createDeferred: () => { let resolve!: (value: Response) => void; let reject!: (error: unknown) => void;
        const promise = new Promise<Response>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; },
      isRequestForLiveReloadWebsocket: () => false, isRequestFromProxyController: () => false,
      urlFromParts: (parts: object, base: string) => Object.assign(new URL(base), parts),
      rewriteLegacyMiniflarePath: (path: string) => path, rewriteUrlRelatedHeaders: () => {},
      checkForPreviewTokenError: async () => {}, isHtmlResponse: () => false, isSseResponse: () => false,
    };
    const Proxy = runInNewContext(`${code}; TestProxyWorker`, context);
    const proxy = new Proxy({ getWebSockets: () => [] }, {});
    const pending = proxy.fetch(new Request("http://audit.invalid/primary-audit-health"));
    expect(proxy.requestQueue.size).toBe(1); expect(forwarded).not.toHaveBeenCalled();
    proxy.processProxyControllerRequest({ cf: { hostMetadata: { type: "play", proxyData: {
      userWorkerUrl: { protocol: "https:", hostname: "preview.example", port: "443" },
    } } } });
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(forwarded).toHaveBeenCalledTimes(1);
    expect(String(forwarded.mock.calls[0][0])).toBe("https://preview.example/primary-audit-health");
    expect(network).not.toHaveBeenCalled();
  });
  it("distinguishes local proxy readiness from runtime reload completion", () => {
    expect(cli).toContain("primaryDevEnv.proxy.ready.promise.then");
    expect(cli).toContain("await readyPromise");
    expect(cli).toContain("return devEnv.proxy.ready.promise.then(() => void 0)");
    expect(cli).toContain('this.emit("reloadComplete", event)');
    expect(cli).toContain('type: "play",\n          proxyData: data.proxyData');
    expect(proxySource).toContain("if (proxyData === undefined) return;");
    // Background remote errors are debug-only by default, not readiness rejection.
    expect(cli).toContain('this.on("error", (event) => {\n          logger2.debug');
  });
  it("confirms script override, account forwarding and 300s transport default", () => {
    expect(cli).toContain("remote: !local"); expect(cli).toContain("entrypoint: args.script");
    expect(cli).toContain("script: input.entrypoint");
    expect(cli).toContain("if (args.script) {\n    paths = resolveEntryWithScript(args.script);");
    expect(cli).toContain("let accountId = args.accountId");
    expect(cli).toContain("accountId: auth2.accountId");
    expect(cli).toContain("accountId: props.accountId");
    expect(cli).toContain("this[kHeadersTimeout] = headersTimeout != null ? headersTimeout : 3e5");
    expect(cli).toContain("util4.destroy(socket, new HeadersTimeoutError())");
  });
  it("statically audits the eager import graph for top-level I/O or await", () => {
    const visited = new Set<string>(); const violations: string[] = [];
    function visit(path: string) {
      if (visited.has(path)) return; visited.add(path);
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ES2022, true);
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
          if (statement.importClause?.isTypeOnly) continue;
          const bindings = statement.importClause?.namedBindings;
          if (!statement.importClause?.name && bindings && ts.isNamedImports(bindings) && bindings.elements.every(item => item.isTypeOnly)) continue;
          const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
          if (/^(node:|fs$|https?$)/.test(specifier)) violations.push("node_only_import");
          if (specifier.startsWith(".")) {
            const next = resolve(dirname(path), `${specifier}.ts`); if (existsSync(next)) visit(next);
          }
        }
      }
      function inspect(node: ts.Node) {
        if (ts.isFunctionLike(node)) return;
        if (ts.isAwaitExpression(node)) violations.push("top_level_await");
        if (ts.isCallExpression(node)) {
          const text = node.expression.getText(source);
          if (/^(fetch|env\.|.*\.AI\.(run|gateway)|.*\.(readFileSync|writeFileSync))/.test(text)) violations.push("top_level_io");
        }
        ts.forEachChild(node, inspect);
      }
      inspect(source);
    }
    visit(resolve("test/primaryFaceMeasurementAuditWorker.ts"));
    expect(visited.size).toBeGreaterThan(5); expect(violations).toEqual([]);
  });
});
