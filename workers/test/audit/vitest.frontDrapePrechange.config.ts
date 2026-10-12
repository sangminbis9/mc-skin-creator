// Read-only in-memory ablation: diagnose unrelated existing historical tests.
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [{ name: "front-drape-prechange", enforce: "pre", transform(_source, id) {
    const path = id.replace(/\\/g, "/").split("?")[0];
    if (!path.endsWith("/src/observedFrontHairDrape.ts")) return;
    return { code: `export function observedFrontHairDrape(text) {
      return text.toLowerCase().split(/[.;\\n]/).some(s =>
        /\\b(?:drap(?:e|es|ing)|over (?:the )?shoulders?|across (?:the )?shoulders?)\\b/.test(s)
        && !/\\b(?:no|not|without|absent|unknown|unseen|hidden|occluded)\\b/.test(s)
        && (!/\\bback\\b/.test(s) || /\\bshoulders?\\b/.test(s))) ? 'observed_shoulder_drape' : null;
    }`, map: null };
  } }],
  test: { environment: "node", include: ["test/referenceLongHairAccents.test.ts"] },
});
