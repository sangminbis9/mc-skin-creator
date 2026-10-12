import type { PixelRenderHints } from "./analysis";

/** Pixel grammar, not a new measurement: dense, unparted straight bangs can
 * retain a small central break without becoming a two-wing curtain. Keep the
 * observed opening; never derive one from a root part or density alone.
 * Measured hairlines must not use this semantic fallback decision.
 */
export function narrowDenseSemanticOpening(hints: Pick<PixelRenderHints,
  "bangs" | "bangsDensity" | "bangsLength" | "fringeOpening" | "hairPart">): boolean {
  return hints.bangs === "straight" && hints.bangsDensity === "dense"
    && (hints.bangsLength === "brow" || hints.bangsLength === "eye")
    && hints.fringeOpening === "center" && hints.hairPart === "none";
}
