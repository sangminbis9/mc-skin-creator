import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { FACE_MEASUREMENT_VALUES } from "../src/faceMeasurementEvidence";
import { FACE_IDENTITY_GEOMETRY_PROMPT, FACE_IDENTITY_GEOMETRY_SCHEMA } from "../src/faceIdentityGeometry";

const BUILD = process.env.BUILD_FACE_GEOMETRY_OPENNESS_OPEN_DISCOVERY_ARTIFACTS === "approved-offline";
const ROOT = path.resolve("evaluation-artifacts/face-geometry-openness-open-anchor-discovery-20260922-001");
const RUBRIC = path.resolve("evaluation-artifacts/production-primary-face-measurement-audit-20260915/source-rubric.json");
const ANNOTATIONS = path.resolve("evaluation-artifacts/generalization-20260905/annotations.json");
const MANIFEST = path.resolve("evaluation-artifacts/generalization-20260905/frozen-manifest.json");
const MANUAL_REVIEW = path.resolve("evaluation-artifacts/generalization-20260905/manual-review.json");
const LICENSE = path.resolve("evaluation-artifacts/generalization-20260905/license-supplement.json");
const LOCALIZATION = path.resolve("evaluation-artifacts/face-crop-lateral-guard-20260922-001/localization-corpus.json");
const LOW_BOUNDARY = path.resolve("evaluation-artifacts/face-geometry-openness-normal-anchor-live-20260922-001/low-boundary-evidence.json");
const TOPOLOGY = path.resolve("evaluation-artifacts/face-geometry-openness-threshold-evidence-review-20260922-001/topology-mapping.json");
const EVIDENCE_AUDIT = path.resolve("evaluation-artifacts/face-measurement-coverage-20260908/evidence-audit.json");
const QUANTIZATION = path.resolve("evaluation-artifacts/face-identity-quantization-20260904/summary.json");
const GENERALIZATION_QUANTIZATION = path.resolve("evaluation-artifacts/face-quantization-generalization-20260907/before/summary.json");

const EXPECTED = {
  head: "3922d659989c237bf7dc011f1dac6659cc4b3a27",
  prompt: "00b0944db7e118bd72396c67a25645a056b329d69c9d80f146e85228eca9e1bd",
  schema: "3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469",
  rubric: "4f460662742a531e0068e54dfe7a2394dc1b8f13ac01dc39e1babbe2d604cd27",
  annotations: "b8980cec01868f40d2d0975b9987b895eefe1dfaf9221cb0863d7ff8b1c9f5d8",
  manifest: "672bfa8bdba158c48f9d4d36ed1e474f11ffd1c757d34dfe0e1cd9adb4659999",
  manualReview: "c8cc7674c539a11ce28dd641b5f83deedd487aa4bbf7ecde704cd29c73aafa00",
  license: "23d370913aaa50fa7fedecf11406acca49756aabc1efeacd18fccd3581cdff65",
  localization: "8712374c47a72bc97177aeae8808b0bae7a5c28cc362ae886d24f975e180264d",
  lowBoundary: "00dde701c5d7b64673d438ab115a2447989649a339f8ebb2e42741ab9992dc93",
  topology: "246cbd7cbbd7a98347948441c04e3bcda6c42ecac8b490e14a9de11434a16d37",
  evidenceAudit: "1dadbdad64c0a6180ec16ffce8632d0cc1ced0ad9d6f92cac94c0f6e0425a890",
  quantization: "663918e2abfdd4c81890e5d12510ad1c49584bf30888fcd5bc18204a0629320c",
  generalizationQuantization: "6e07aad77cc99ecf6a3bf73ba8b5d3af12f83217e1ba1a1f63e23c0f0fb23a28",
} as const;

type Label = "narrow" | "normal" | "open" | "unknown";
type Rubric = { rubricFrozenBeforeProviderResults: boolean; cases: Array<{
  id: string; photoId: number; sourceSha256: string; sourceBytes: number; cropOrFraming: string;
  faceVisibility: string; glassesOrCovering: string; pose: string;
  rubric: { eyeOpenness: { kind: string; values?: string[]; reason?: string } };
}> };
type Annotation = { id: string; framing: string; pose: string; headBox: number[]; face: string;
  accessories: string; hints: Record<string, unknown>; cues: string[] };
type Manifest = { annotationFileHash: string; sources: Array<{ caseId: string; sourceHash: string;
  dimensions: [number, number]; annotationHash: string; analysisOrigin: string; pipelineProvidedAnalysis: boolean }> };

const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8")) as T;
const sha = (value: string | Buffer | object) => createHash("sha256").update(
  typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value),
).digest("hex");
const fileSha = (file: string) => sha(fs.readFileSync(file));

function buildDiscovery() {
  const integrityFiles = {
    rubric: RUBRIC, annotations: ANNOTATIONS, manifest: MANIFEST, manualReview: MANUAL_REVIEW,
    license: LICENSE, localization: LOCALIZATION, lowBoundary: LOW_BOUNDARY, topology: TOPOLOGY,
    evidenceAudit: EVIDENCE_AUDIT, quantization: QUANTIZATION,
    generalizationQuantization: GENERALIZATION_QUANTIZATION,
  } as const;
  for (const [key, file] of Object.entries(integrityFiles)) {
    expect(fileSha(file)).toBe(EXPECTED[key as keyof typeof integrityFiles]);
  }
  expect(sha(FACE_IDENTITY_GEOMETRY_PROMPT)).toBe(EXPECTED.prompt);
  expect(sha(FACE_IDENTITY_GEOMETRY_SCHEMA)).toBe(EXPECTED.schema);
  expect(FACE_MEASUREMENT_VALUES.eyeOpenness).toEqual(["narrow", "normal", "open", "unknown"]);

  const rubric = read<Rubric>(RUBRIC);
  const annotations = read<Annotation[]>(ANNOTATIONS);
  const manifest = read<Manifest>(MANIFEST);
  const localization = read<{ cases: Array<{ caseId: string; source: string; availability: string;
    region: unknown | null; metrics: unknown | null }> }>(LOCALIZATION);
  const lowBoundary = read<Record<string, unknown>>(LOW_BOUNDARY);
  const topology = read<{ categoricalMapping: Record<string, string>; continuousBoundaries: Array<{
    score: number; bin: string; topology: string }> }>(TOPOLOGY);
  expect(rubric.rubricFrozenBeforeProviderResults).toBe(true);
  expect(manifest.annotationFileHash).toBe(EXPECTED.annotations);
  expect(topology.categoricalMapping).toEqual({ narrow: "compact", normal: "readable", open: "open" });
  expect(topology.continuousBoundaries).toEqual(expect.arrayContaining([
    expect.objectContaining({ score: 0.34, bin: "compact", topology: "compact_dark" }),
    expect.objectContaining({ score: 0.68, bin: "open", topology: "open_iris_sclera" }),
  ]));

  const rubricLabels = new Map<string, Label>(rubric.cases.map(item => [item.id,
    item.rubric.eyeOpenness.kind === "expected" ? item.rubric.eyeOpenness.values?.[0] as Label : "unknown"]));
  expect(Object.fromEntries(rubricLabels)).toEqual({
    "buzz-striped": "normal", "bun-check": "narrow", "warm-white-tee": "narrow",
    "full-body-layered": "unknown", "wavy-open-blazer": "normal",
    "striped-open-shirt": "narrow", "sleeveless-bag-skirt": "normal",
  });

  const generalizationLabels: Record<string, Label> = {
    "short-hair-red-shirt": "narrow", "glasses-monochrome": "unknown", "curly-hair": "unknown",
    "headscarf-color-blocks": "unknown", "long-straight-hair": "unknown",
  };
  const inventory = [
    ...rubric.cases.map(item => ({
      caseId: item.id, photoId: item.photoId, sourceArtifact: `generalization-20260905/sources/${item.photoId}.jpg`,
      label: rubricLabels.get(item.id), labelProvenance: "production-primary source rubric frozen before provider results",
      providerIndependent: true, sourceSha256: item.sourceSha256, sourceBytes: item.sourceBytes,
      framing: item.cropOrFraming, visibility: item.faceVisibility, pose: item.pose,
      glassesOrOcclusion: item.glassesOrCovering,
    })),
    ...Object.entries(generalizationLabels).map(([caseId, label]) => {
      const annotation = annotations.find(item => item.id === caseId)!;
      const source = manifest.sources.find(item => item.caseId === caseId)!;
      const localArtifact = path.resolve(`evaluation-artifacts/facial-feature-renderer-20260904/${caseId}/01-source.png`);
      expect(annotation).toBeTruthy();
      expect(source).toBeTruthy();
      expect(source.analysisOrigin).toBe("manual_source_annotation_adapter");
      expect(source.pipelineProvidedAnalysis).toBe(false);
      expect(fs.existsSync(localArtifact)).toBe(true);
      return {
        caseId, photoId: null, sourceArtifact: path.relative(path.resolve("."), localArtifact), label,
        labelProvenance: label === "narrow"
          ? "frozen manual source annotation explicitly says narrow eyes"
          : "no canonical source-only eyeOpenness label; unknown retained",
        providerIndependent: true, canonicalSourceSha256: source.sourceHash,
        localArtifactSha256: fileSha(localArtifact), sourceBytes: fs.statSync(localArtifact).size,
        sourceDimensions: { width: source.dimensions[0], height: source.dimensions[1] },
        framing: annotation.framing, visibility: annotation.face, pose: annotation.pose,
        glassesOrOcclusion: annotation.accessories,
      };
    }),
  ];
  expect(inventory).toHaveLength(12);
  const labelCounts = { narrow: 0, normal: 0, open: 0, unknown: 0 };
  for (const row of inventory) labelCounts[row.label as Label] += 1;
  expect(labelCounts).toEqual({ narrow: 4, normal: 3, open: 0, unknown: 5 });

  const headscarf = annotations.find(item => item.id === "headscarf-color-blocks")!;
  const headscarfManifest = manifest.sources.find(item => item.caseId === headscarf.id)!;
  expect(headscarf.face).toContain("wide eyes");
  expect(headscarf.cues).toContain("wide eyes");
  expect(headscarf.hints.eyeSize).toBe("large");
  const manualReviewText = fs.readFileSync(MANUAL_REVIEW, "utf8");
  const licenseText = fs.readFileSync(LICENSE, "utf8");
  expect(manualReviewText).toContain("wide eyes not readable");
  expect(manualReviewText).toContain("pixel-to-original linkage needs verification");
  expect(licenseText).toContain("crop-to-file linkage is not independently verified");
  const storedLocalization = localization.cases.find(item => item.caseId === headscarf.id)!;
  expect(storedLocalization).toEqual(expect.objectContaining({ availability: "unavailable", region: null, metrics: null }));

  const openCandidates = [{
    caseId: headscarf.id,
    canonicalEyeOpennessLabel: "unknown",
    sourceOnlyOpenLikeCue: "wide eyes",
    cueProvenance: "generalization-20260905/annotations.json; manual source annotation predates provider results",
    sourceSemanticsDecision: "not silently convertible to canonical open",
    selectionReason: "only frozen source-only annotation in the audited pool with an explicit bilateral open-like eye cue",
    sourceDimensions: { width: headscarfManifest.dimensions[0], height: headscarfManifest.dimensions[1] },
    canonicalSourceSha256: headscarfManifest.sourceHash,
    localArtifactSha256: fileSha(path.resolve("evaluation-artifacts/facial-feature-renderer-20260904/headscarf-color-blocks/01-source.png")),
  }];
  const eligibility = {
    caseId: headscarf.id,
    frozenCanonicalOpenLabel: false,
    noSunglasses: true,
    bilateralCueInFrozenText: true,
    bothEyesVisibilityVerifiedUnderCurrentRubric: false,
    blinkOrClosureAmbiguityRuledOut: false,
    heavyOcclusionRuledOut: false,
    stableMorphologyRatherThanExpressionVerified: false,
    eyelinerOrContrastIllusionRuledOut: false,
    canonicalSourceLinkageVerified: false,
    sourceImageAvailable: true,
    productionPortraitRegionAvailable: false,
    poseAndFraming: { pose: headscarf.pose, framing: headscarf.framing, sourceClipping: "major" },
    tier: "NOT_YET_ELIGIBLE_REQUIRES_SOURCE_FREEZE",
    reason: "open-like frozen wording exists, but canonical open semantics, source linkage, visibility/confounders, and production localization are not yet frozen",
  };
  const localizationAvailability = {
    caseId: headscarf.id,
    currentProductionLocalization: storedLocalization,
    manualHeadBoxPresent: true,
    manualHeadBox: headscarf.headBox,
    manualRegionUseForProductionCrop: "PROHIBITED",
    predictedProductionCropDimensions: null,
    lateralGuardApplicability: "not evaluable without a valid production portraitRegion",
  };
  const acquisitionPlan = {
    order: [
      "verify local crop/source linkage or freeze the exact local source artifact as the calibration source",
      "perform source-only visual review under stable aperture semantics; verify both eyes and rule out expression, blink, eyeliner, and contrast confounders",
      "freeze canonical eyeOpenness=open plus source hash, bytes, and artifact hash before any provider call",
      "in a later authorized live iteration, acquire production localization then POST_CONTRACT face-only geometry",
    ],
    futureLiveBudget: {
      caseId: headscarf.id, primary: "Gemini max 1 + conditional Gemma fallback max 1 because production portraitRegion is absent",
      faceOnlyGeometry: "Gemma max 1", retry: 0,
    },
    callsThisIteration: { remoteWrangler: 0, health: 0, Gemini: 0, Gemma: 0, geometry: 0,
      jpegTransmission: 0, evaluator: 0, packageManager: 0 },
  };
  const thresholdState = {
    lowBoundary: { narrow: 0.5, normal: 0.6, feasibleInterval: "(0.50, 0.60)", status: "LOW_BOUNDARY_SEPARABLE", thresholdSelected: false },
    normalAnchor: { caseId: "wavy-open-blazer", score: 0.6, tier: "TIER_A_NORMAL_ANCHOR" },
    highBoundary: { openMin: 0.68, status: "FROZEN_UNASSESSED_WITHOUT_TIER_A_OPEN", scoreSelected: false,
      identifiabilityRequirement: "Tier A normal plus Tier A open with 0.60 < O" },
    productionQuantizerChanged: false,
    classification: "OPEN_ANCHOR_SOURCE_FREEZE_REQUIRED",
  };
  expect(lowBoundary).toMatchObject({ classification: "LOW_BOUNDARY_SEPARABLE", thresholdSelected: false });
  expect(openCandidates).toHaveLength(1);
  expect(eligibility.frozenCanonicalOpenLabel).toBe(false);

  return {
    integrity: { head: EXPECTED.head, branch: "main", hashes: EXPECTED,
      localSourceHashesVerified: rubric.cases.every(item => {
        const file = path.resolve(`evaluation-artifacts/generalization-20260905/sources/${item.photoId}.jpg`);
        return fs.existsSync(file) && fileSha(file) === item.sourceSha256 && fs.statSync(file).size === item.sourceBytes;
      }) },
    inventory: { searchedSources: Object.keys(integrityFiles), labelCounts, entries: inventory,
      excludedEvidence: [
        "provider output labels", "geometry-derived labels", "synthetic fixtures", "test seeds",
        "inferred labels", "topology-backsolved labels",
      ] },
    openCandidates, eligibility, localizationAvailability, acquisitionPlan, thresholdState,
  };
}

it("audits frozen source-only openness labels without promoting open-like wording", () => {
  const audit = buildDiscovery();
  expect(audit.integrity.localSourceHashesVerified).toBe(true);
  expect(audit.inventory.labelCounts).toEqual({ narrow: 4, normal: 3, open: 0, unknown: 5 });
  expect(audit.openCandidates[0]).toMatchObject({ caseId: "headscarf-color-blocks", canonicalEyeOpennessLabel: "unknown" });
  expect(audit.thresholdState.classification).toBe("OPEN_ANCHOR_SOURCE_FREEZE_REQUIRED");
});

it.skipIf(!BUILD)("writes the open-anchor discovery artifacts", () => {
  const audit = buildDiscovery();
  fs.mkdirSync(ROOT, { recursive: false });
  const write = (name: string, value: unknown) => fs.writeFileSync(
    path.join(ROOT, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" },
  );
  write("frozen-label-inventory.json", audit.inventory);
  write("open-candidates.json", audit.openCandidates);
  write("candidate-eligibility.json", audit.eligibility);
  write("localization-availability.json", audit.localizationAvailability);
  write("acquisition-plan.json", audit.acquisitionPlan);
  write("threshold-state.json", audit.thresholdState);
  write("integrity.json", audit.integrity);
  fs.writeFileSync(path.join(ROOT, "REPORT.md"), `# Open eye-openness anchor discovery\n\n` +
    `- Offline only: all remote, provider, geometry, JPEG transmission, evaluator, and package-manager calls were 0.\n` +
    `- Twelve source-reviewed cases were inventoried: narrow 4, normal 3, open 0, unknown 5.\n` +
    `- No provider-, geometry-, synthetic-, inferred-, or topology-derived value was accepted as a source label.\n` +
    `- No canonical frozen open label exists. headscarf-color-blocks is the only deterministic source-freeze candidate because its pre-provider annotation says "wide eyes".\n` +
    `- The wording remains an open-like cue, not a canonical open label. Stable morphology, both-eye visibility, expression/blink/eyeliner/contrast confounders, and crop-to-source linkage still require source-only review.\n` +
    `- Current production portraitRegion is unavailable; the manual head box is not used as a production region and no crop was fabricated.\n` +
    `- Wavy remains the Tier A normal reference at 0.60. openMin 0.68 is frozen and unassessed. No low or high threshold was selected.\n` +
    `- Exact next boundary: freeze a source-only open-openness calibration anchor before provider execution.\n\n` +
    `OPEN_ANCHOR_SOURCE_FREEZE_REQUIRED\n`, { flag: "wx" });
});
