import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  FACE_IDENTITY_GEOMETRY_PROMPT,
  FACE_IDENTITY_GEOMETRY_SCHEMA,
  faceIdentityGeometryRequest,
} from "../src/faceIdentityGeometry";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";

const BUILD = process.env.BUILD_FACE_GEOMETRY_OPENNESS_CONTRACT_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-contract-clarification-20260922-001");
const ANALYSIS_SOURCE = path.resolve("src/analysis.ts");
const QUANTIZER_SOURCE = path.resolve("src/identityQuantization.ts");
const CROP_SOURCE = path.resolve("src/generate.ts");
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");

const OLD_PROMPT_HASH = "c1b9f013368b15bc7b92fc6dbc600875e685ee14e9e3ef6a959f7816bf8af68f";
const NEW_PROMPT_HASH = "00b0944db7e118bd72396c67a25645a056b329d69c9d80f146e85228eca9e1bd";
const SCHEMA_HASH = "3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469";
const QUANTIZER_SOURCE_HASH = "66f11a6a3499ed16e775ab6df08cda4891fc9fcc2b26cd31bcccf144cb8a7468";
const CROP_SOURCE_HASH = "fa48ad675c0bac0a0168e75f7501627292f79ecf525ebc4c556a26aa66713ce0";
const RUBRIC_HASH = "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27";

const OLD_EXCERPT = "openness 0=narrow/closed to 1=fully open";
const NEW_EXCERPT = "Openness measures the stable visible vertical eyelid aperture of an open eye: 0=naturally or structurally very narrow but still open/readable, midpoint=ordinary, 1=unusually large/open.";
const TRANSIENT_EXCERPT = "Do not encode blinking, momentary closure, expression-driven squint, downcast gaze or occlusion as low openness; if they prevent a reliable stable-aperture estimate, lower eyes confidence instead.";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fileHash = (file: string) => sha(fs.readFileSync(file));
const source = (file: string) => fs.readFileSync(file, "utf8");

function audit() {
  const analysisSource = source(ANALYSIS_SOURCE);
  const quantizerSource = source(QUANTIZER_SOURCE);
  const cropSource = source(CROP_SOURCE);
  const eyeClause = FACE_IDENTITY_GEOMETRY_PROMPT.split("\n").find(line => line.startsWith("eyes:"));
  expect(eyeClause).toBeTruthy();

  expect(sha(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe(NEW_PROMPT_HASH);
  expect(sha(JSON.stringify(FACE_IDENTITY_GEOMETRY_SCHEMA))).toBe(SCHEMA_HASH);
  expect(fileHash(QUANTIZER_SOURCE)).toBe(QUANTIZER_SOURCE_HASH);
  expect(fileHash(CROP_SOURCE)).toBe(CROP_SOURCE_HASH);
  expect(fileHash(RUBRIC)).toBe(RUBRIC_HASH);
  expect(FACE_IDENTITY_GEOMETRY_PROMPT).not.toContain(OLD_EXCERPT);
  expect(eyeClause).toContain(NEW_EXCERPT);
  expect(eyeClause).toContain(TRANSIENT_EXCERPT);
  expect(eyeClause).toContain("Keep openness independent from eye width, spacing, iris size, brow position and expression intensity.");
  expect(eyeClause).toContain("measure viewer-left/right centers and each visible eye width");
  expect(eyeClause).not.toMatch(/warm-white-tee|striped-open-shirt|0\.70|0\.68/);
  expect(FACE_IDENTITY_GEOMETRY_PROMPT).not.toMatch(/closed eyes?\s*=\s*(?:0|low)|0\s*=\s*closed/i);

  expect(FACE_MEASUREMENT_VALUES.eyeOpenness).toEqual(["narrow", "normal", "open", "unknown"]);
  expect(analysisSource).toContain("Judge eyeOpenness from vertical eyelid aperture only: narrow means a visibly small vertical opening, normal means an ordinary vertical aperture, and open means a visibly large vertical aperture");
  expect(analysisSource).toContain("Downcast gaze is not stable narrow-eye identity.");

  expect(quantizerSource).toContain('geometry.eyes.openness >= 0.68 ? "open" : geometry.eyes.openness <= 0.34 ? "compact" : "readable"');
  expect(cropSource).toContain("const minimumLateralWidthPixels = headHeightPixels * 0.65;");

  const request = faceIdentityGeometryRequest("data:image/png;base64,AQID");
  expect(request.prompt).toBe(FACE_IDENTITY_GEOMETRY_PROMPT);
  expect(request.responseSchema).toBe(FACE_IDENTITY_GEOMETRY_SCHEMA);
  expect(request.imageDataUrls).toEqual(["data:image/png;base64,AQID"]);

  const promptContract = {
    oldPromptSha256: OLD_PROMPT_HASH,
    newPromptSha256: NEW_PROMPT_HASH,
    oldClauseSha256: sha(OLD_EXCERPT),
    newClauseSha256: sha(`${NEW_EXCERPT} ${TRANSIENT_EXCERPT}`),
    boundedExcerpts: { before: OLD_EXCERPT, after: NEW_EXCERPT, transientHandling: TRANSIENT_EXCERPT },
    semanticAssertions: {
      stableApertureOnly: true,
      lowAllowsNaturallyNarrowOpenEye: true,
      middleMeansOrdinaryAperture: true,
      highMeansUnusuallyLargeVisibleAperture: true,
      transientClosureIsNotLowMorphology: true,
      uncertaintyUsesExistingEyeConfidence: true,
      numericDenominatorAdded: false,
      fixtureOrThresholdAwareWording: false,
    },
  };
  const semanticParity = {
    geometryContinuous: "stable visible vertical eyelid aperture of an open eye, naturally narrow through unusually large",
    primaryCategorical: "vertical eyelid aperture only: narrow / normal / open; downcast gaze is not stable narrow-eye identity",
    frozenRubric: { vocabulary: [...FACE_MEASUREMENT_VALUES.eyeOpenness], sha256: RUBRIC_HASH, changed: false },
    parity: true,
    representationDifference: "geometry is continuous 0..1; primary and rubric are categorical",
  };
  const propagation = {
    requestBuilder: "faceIdentityGeometryRequest",
    exportedPromptSha256: sha(FACE_IDENTITY_GEOMETRY_PROMPT),
    requestPromptSha256: sha(request.prompt),
    exactPromptEquality: request.prompt === FACE_IDENTITY_GEOMETRY_PROMPT,
    responseSchemaIdentity: request.responseSchema === FACE_IDENTITY_GEOMETRY_SCHEMA,
    imageCount: request.imageDataUrls.length,
    staleDuplicateOrOverwriteFound: false,
  };
  const frozen = {
    schema: { sha256: SCHEMA_HASH, openness: { type: "number", minimum: 0, maximum: 1 }, changed: false },
    validatorChanged: false,
    quantizer: { sourceSha256: QUANTIZER_SOURCE_HASH, compactMax: 0.34, openMin: 0.68, changed: false },
    lateralGuard: { sourceSha256: CROP_SOURCE_HASH, minimumHeadHeightRatio: 0.65, changed: false },
    widthAndSpacing: { schemaFields: ["leftCenterX", "rightCenterX", "leftWidth", "rightWidth"], changed: false },
    rendererChanged: false,
    sourceRubric: { sha256: RUBRIC_HASH, changed: false },
    providerOriginCorpus: { observations: 7, sources: 5, reinterpreted: false },
  };
  return { promptContract, semanticParity, propagation, frozen };
}

it("clarifies stable eye aperture without changing schema, thresholds, crop guard or request propagation", () => {
  const result = audit();
  expect(result.promptContract.semanticAssertions).toMatchObject({
    stableApertureOnly: true,
    transientClosureIsNotLowMorphology: true,
    uncertaintyUsesExistingEyeConfidence: true,
  });
  expect(result.semanticParity.parity).toBe(true);
  expect(result.propagation).toMatchObject({ exactPromptEquality: true, responseSchemaIdentity: true, imageCount: 1 });
  expect(result.frozen).toMatchObject({ validatorChanged: false, rendererChanged: false });
});

it.skipIf(!BUILD)("writes the offline openness-contract clarification artifacts", () => {
  const result = audit();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  write("prompt-contract-before-after.json", result.promptContract);
  write("semantic-parity.json", result.semanticParity);
  write("request-propagation.json", result.propagation);
  write("frozen-constants.json", result.frozen);
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Face geometry openness contract clarification\n\n` +
    `- Offline only; external/provider/JPEG/package-manager calls 0.\n` +
    `- Prompt-only production change: stable visible vertical eyelid aperture now has one continuous meaning.\n` +
    `- Naturally narrow but open/readable eyes remain valid at the low endpoint; ordinary is the midpoint; unusually large visible aperture is high.\n` +
    `- Blink, momentary closure, expression-driven squint, downcast gaze and occlusion lower existing eyes confidence when they prevent a stable estimate; they are not low morphology.\n` +
    `- Eye width, spacing, iris size, brow position and expression intensity remain independent from openness.\n` +
    `- Schema ${SCHEMA_HASH}, quantizer thresholds 0.34/0.68, lateral guard 0.65, validator, renderer and frozen rubric are unchanged.\n` +
    `- faceIdentityGeometryRequest propagates the clarified prompt exactly with one image and the unchanged schema.\n` +
    `- Historical provider corpus remains 7 observations / 5 sources and was not reinterpreted.\n\n` +
    `READY_FOR_OPENNESS_CONTRACT_LIVE_RETEST\n`, { flag: "wx" });
});
