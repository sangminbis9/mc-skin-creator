import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { decodeImage, decodePng, encodePng } from "../src/png";
import { validateFinalAtlas } from "../src/skinPost";
import { renderSkinViews } from "../src/skinRender";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("conservatively follows production local imports, including dynamic/type imports, without aperture audit reachability", () => {
  const seen = new Set<string>();
  const pending = [resolve("src/index.ts")];
  const computedImports: string[] = [];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      let specifier: ts.Node | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        specifier = node.arguments[0];
        if (!specifier || !ts.isStringLiteral(specifier)) computedImports.push(relative(process.cwd(), file));
      }
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith(".")) {
        const base = resolve(dirname(file), specifier.text);
        const target = [base, `${base}.ts`, `${base}/index.ts`].find(candidate => existsSync(candidate));
        expect(target, `${file}: ${specifier.text}`).toBeDefined();
        pending.push(target!);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const modules = [...seen].map(file => relative(process.cwd(), file).replaceAll("\\", "/"));
  expect(computedImports).toEqual([]);
  expect(modules.filter(file => /eyeAperture|eye-aperture|^test\//i.test(file))).toEqual([]);
  expect(modules).toContain("src/faceIdentityGeometry.ts");
  expect(modules).toContain("src/compactPhotoAnalysisV4.ts"); // Imported opt-in code is not the default selection.
});

it("validates one historical source-linked actual PNG without regenerating a skin or calling a provider", async () => {
  const historical = "evaluation-artifacts/face-geometry-production-live-20260914";
  const manifest = JSON.parse(readFileSync(`${historical}/smoke.json`, "utf8"));
  const source = readFileSync("evaluation-artifacts/generalization-20260905/sources/29002888.jpg");
  const png = readFileSync(`${historical}/skin.png`);
  expect(source.length).toBe(manifest.source.bytes);
  expect(sha(source)).toBe(manifest.source.sha256);
  expect(png.length).toBe(manifest.png.bytes);
  expect(sha(png)).toBe(manifest.png.sha256);
  const sourceImage = await decodeImage(source);
  const atlas = await decodePng(png);
  expect([sourceImage.width, sourceImage.height]).toEqual([900, 1350]);
  expect([atlas.width, atlas.height]).toEqual([64, 64]);
  const validation = validateFinalAtlas(atlas);
  expect(validation.ok).toBe(true);
  const alphaCounts: Record<string, number> = {};
  for (let i = 3; i < atlas.rgba.length; i += 4) alphaCounts[atlas.rgba[i]] = (alphaCounts[atlas.rgba[i]] ?? 0) + 1;
  expect(Object.keys(alphaCounts).every(alpha => alpha === "0" || alpha === "255")).toBe(true);
  if (process.env.BASELINE_REVIEW_ARTIFACTS === "1") {
    const root = "evaluation-artifacts/default-generation-baseline-review-20260926-001";
    await mkdir(root); // Fresh-only; never overwrite historical or previous review evidence.
    await writeFile(`${root}/output-validation.json`, JSON.stringify({
      historicalManifest: `${historical}/smoke.json`, sourceSha256: sha(source), pngSha256: sha(png),
      manifestSha256: sha(readFileSync(`${historical}/smoke.json`)),
      sourceDimensions: [sourceImage.width, sourceImage.height], atlasDimensions: [atlas.width, atlas.height],
      validation, alphaCounts, currentBaselineEquivalence: "unconfirmed", exactReplayAvailable: false,
      reviewMode: "existing_atlas_local_views_only", actualProviderCalls: 0,
    }, null, 2));
    for (const view of renderSkinViews(atlas).filter(view => ["front", "back", "front_left_three_quarter"].includes(view.name))) {
      await writeFile(`${root}/${view.name}.png`, await encodePng(view.image));
    }
  }
});
