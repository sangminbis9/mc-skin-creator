// Offline comparison only: remove this iteration's ownership/material branches
// in memory. Historical evidence and production files are never rewritten.
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [{ name: "offline-headwear-prechange", enforce: "pre", transform(source, id) {
    const path = id.replace(/\\/g, "/").split("?")[0];
    let code = source;
    if (path.endsWith("/src/generate.ts")) {
      code = code.replace(/ {2}const explicitHeadwearColor = observedHeadwearColor\(analysis\);\r?\n {2}if \(explicitHeadwearColor\) refined.hatColor = explicitHeadwearColor;/,
        "// observed headwear material branch disabled for offline comparison");
    } else if (path.endsWith("/src/headOwnership.ts")) {
      code = code.replace(/ {2}\/\/ Cap\/beanie evidence owns[\s\S]*?(?= {2}\/\/ Face-window ownership)/,
        "// bounded headwear ownership disabled for offline comparison\n");
    } else if (path.endsWith("/src/skinPack.ts")) {
      code = code.replace(/ {4}const coveredFront = new Set[^\n]*\r?\n {4}applyFacePixelPlan\(atlas,[\s\S]*?\}, hairColor, skinColor, style\);/,
        '    applyFacePixelPlan(atlas, ownership.covering ? { ...facePlan, pixels: facePlan.pixels.filter(p => p.cluster !== "fringe") } : facePlan, hairColor, skinColor, style);');
    } else return;
    if (code === source) throw new Error(`headwear_prechange_not_applied:${path.split("/").pop()}`);
    return { code, map: null };
  } }],
  test: { environment: "node", include: ["test/hairMaterialColorScope.test.ts"] },
});
