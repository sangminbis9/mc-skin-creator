// Offline A/B check only: restore the original per-primary cap without editing production/user files.
import { vi } from "vitest";

vi.mock("../../src/gemini", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/gemini")>(), GEMMA_PRIMARY_TIMEOUT_MS: 45000,
}));
