import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
const root = resolve(import.meta.dirname, "..");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(f => f.isDirectory() ? files(resolve(dir, f.name)) : [resolve(dir, f.name)]);
}
test("every relative source import remains within the standalone web directory", () => {
  for (const file of [...files(resolve(root, "src")), ...files(resolve(root, "shared"))].filter(p => /\.(ts|tsx|css)$/.test(p))) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\(?)["'](\.[^"']+)["']/g)) {
      assert.ok(resolve(dirname(file), match[1]).startsWith(root + sep), file + ": " + match[1]);
    }
    assert.doesNotMatch(source, /@apps-in-toss|@toss\/|ait-ad-test|AdLoadingPanel/);
  }
});
test("package is standalone, without file links or app SDKs", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
  assert.doesNotMatch(JSON.stringify(pkg), /file:|workspace:|@apps-in-toss|@toss\//);
});
test("curated demo is a real 64 by 64 PNG, not a promotional render", () => {
  const png = readFileSync(resolve(root, "public/images/woman-lace-skin-64.png"));
  assert.equal(png.readUInt32BE(0), 0x89504e47);
  assert.equal(png.readUInt32BE(16), 64); assert.equal(png.readUInt32BE(20), 64);
});
