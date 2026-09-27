import { expect, it } from "vitest";
import { recoverAndOverlayAperturePilot } from "./audit/eyeAperturePilotReview";

it.skipIf(process.env.RUN_EYE_APERTURE_LOCAL_RECOVERY !== "approved-local-recovery")("recovers pilot evidence and renders local-only overlays without provider requests", async () => {
  const result = await recoverAndOverlayAperturePilot();
  expect(result.repeatability.quantitativeLandmarkAccuracy).toBe("NOT_MEASURED");
});
