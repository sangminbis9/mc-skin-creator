// Diagnostic only: same historical test input, existing sweatshirt ablation.
import previous from "./vitest.sweatshirtPrechange.config";
import { defineConfig } from "vitest/config";
export default defineConfig({ ...previous,
  test: { environment: "node", include: ["test/referenceLongHairAccents.test.ts"] },
});
