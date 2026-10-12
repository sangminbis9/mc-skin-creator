import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  environment: "node", include: ["test/hairAccessoryRecovery.test.ts"],
  setupFiles: ["test/audit/flowerOwnershipPrechange.setup.ts"],
} });
