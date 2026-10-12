import { defineConfig } from "vitest/config";

export default defineConfig({ test: { environment: "node",
  include: ["test/currentDefaultE2E.test.ts", "test/compactPhotoAnalysisV3.test.ts", "test/structuredLocalizationV4.test.ts"],
  setupFiles: ["test/audit/gemmaTimeoutBaseline.setup.ts"],
} });
