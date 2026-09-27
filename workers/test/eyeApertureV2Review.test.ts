import { expect, it } from "vitest";
import { recoverApertureV2Overlays } from "./audit/eyeApertureV2Review";

// Local disk evidence only. This selector has no endpoint or provider execution path.
it.skipIf(process.env.RUN_EYE_APERTURE_V2_LOCAL_REVIEW !== "approved-local-review")(
  "recovers v2 evidence and creates local-only overlays", async () => {
    const result = await recoverApertureV2Overlays();
    expect(result.checkpointSequence).toBeGreaterThan(0);
    expect(result.quantitativeLandmarkAccuracy).toBe("NOT_MEASURED");
  }, 30000);
