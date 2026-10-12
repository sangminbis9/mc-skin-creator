// Offline negative control: remove only the sweatshirt delta in memory.
// Never imported by a live runner; no production file or golden is rewritten.
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [{ name: "offline-sweatshirt-prechange", enforce: "pre", transform(source, id) {
    const path = id.replace(/\\/g, "/").split("?")[0];
    if (!path.endsWith("/src/generate.ts") && !path.endsWith("/src/outfitIdentity.ts")) return;
    let code = source;
    if (path.endsWith("/src/generate.ts")) {
      code = code.replace('import { observedStandaloneSweatshirt } from "./outfitIdentity";', "")
        .replace('  if (observedStandaloneSweatshirt(analysis)) style.topType = "sweater";', "")
        .replace('const sweatshirt = observedStandaloneSweatshirt(analysis) ? "|sweatshirt" : "";', "")
        .replaceAll("${sweatshirt}", "").replaceAll("|sweatshirt", "");
    } else {
      code = code.replaceAll("|sweatshirt", "")
        .replace('  if (observedStandaloneSweatshirt(analysis)) return "sweater";', "")
        .replace('  const sweatshirt = observedStandaloneSweatshirt(analysis);', '  const sweatshirt = false;')
        .replace(/^\s*if \(item\[0\] === "sweatshirt"[^\n]+continue;\r?\n/m, "\n");
    }
    if (code === source) throw new Error(`negative_control_not_applied:${path.split("/").pop()}`);
    return { code, map: null };
  } }],
  test: { environment: "node", include: ["test/observedSleeveColor.test.ts", "test/plaidPaletteEvidence.test.ts"] },
});
