// Offline control removes only the immutable UV graph hoist, in memory.
// Does not edit production, historical artifacts, or a validation threshold.
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [{ name: "offline-seam-prechange", enforce: "pre", transform(source, id) {
    if (!id.replace(/\\/g, "/").split("?")[0].endsWith("/src/referenceStyleRenderer.ts")) return;
    if (!source.includes("const fixedSeamUnits = Object.freeze")) throw new Error("seam_control_delta_missing");
    const code = source.replace(/\/\/ These six graphs[\s\S]*?(?=const facePriority)/, "")
      .replace("function buildSeamUnits(part:", "function seamUnits(part:");
    if (code.includes("fixedSeamUnits") || code.includes("buildSeamUnits")) throw new Error("seam_control_incomplete");
    return { code, map: null };
  } }],
  test: { environment: "node", maxWorkers: 1, include: ["test/referenceLooseHair.test.ts", "test/referenceShortHair.test.ts", "test/referencePairedHair.test.ts"] },
});
