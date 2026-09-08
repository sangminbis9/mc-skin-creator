import type { PhotoAnalysis } from "./analysis";

/** Categories are observations, never normalized coordinates. */
export const FACE_MEASUREMENT_VALUES = {
  eyeSpacing: ["narrow", "medium", "wide", "unknown"],
  eyeOpenness: ["narrow", "normal", "open", "unknown"],
  eyeFootprint: ["compact", "medium", "wide", "unknown"],
  browEyeDistance: ["close", "normal", "high", "unknown"],
  browSlope: ["straight", "arched", "angled", "unknown"],
  mouthWidth: ["narrow", "medium", "wide", "unknown"],
  mouthOpenness: ["closed", "open", "teeth", "unknown"],
  expression: ["neutral", "smile", "unknown"],
} as const;
export type FaceMeasurementCue = keyof typeof FACE_MEASUREMENT_VALUES;
export type FaceMeasurementProvenance = "calibrated_geometry" | "observed_categorical" | "inferred" | "unknown";
type Category<K extends FaceMeasurementCue> = typeof FACE_MEASUREMENT_VALUES[K][number];
export type FaceMeasurementEvidence = {
  referenceImageIndex: number;
  cues: { [K in FaceMeasurementCue]: {
    value: Category<K>;
    provenance: Exclude<FaceMeasurementProvenance, "calibrated_geometry">;
    confidence: number;
  } };
};
export interface FaceMeasurementDecision {
  value: string;
  provenance: FaceMeasurementProvenance;
  confidence: number;
  selected: "continuous_geometry" | "categorical_grammar" | "legacy_fallback";
  reason: string;
}
export type FaceMeasurementTrace = Record<FaceMeasurementCue, FaceMeasurementDecision>;

export const FACE_MEASUREMENT_EVIDENCE_SCHEMA = {
  type: "object",
  properties: {
    referenceImageIndex: { type: "integer", minimum: 0, maximum: 4 },
    cues: {
      type: "object",
      properties: Object.fromEntries(Object.entries(FACE_MEASUREMENT_VALUES).map(([name, values]) => [name, {
        type: "object",
        properties: {
          value: { type: "string", enum: [...values] },
          provenance: { type: "string", enum: ["observed_categorical", "inferred", "unknown"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["value", "provenance", "confidence"],
      }])),
      required: Object.keys(FACE_MEASUREMENT_VALUES),
    },
  },
  required: ["referenceImageIndex", "cues"],
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Missing legacy blocks remain absent. Invalid/hidden/uncertain cues become unknown. */
export function parseFaceMeasurementEvidence(value: unknown, portraitIndex: number, faceVisible: boolean): FaceMeasurementEvidence | undefined {
  if (value === undefined || value === null) return undefined;
  const block = object(value);
  const cues = object(block?.cues);
  const referenceMatches = Number.isInteger(block?.referenceImageIndex) && portraitIndex >= 0 && portraitIndex <= 4 && block?.referenceImageIndex === portraitIndex;
  return {
    referenceImageIndex: portraitIndex,
    cues: Object.fromEntries(Object.entries(FACE_MEASUREMENT_VALUES).map(([name, values]) => {
      const cue = object(cues?.[name]);
      const valid = referenceMatches && faceVisible && cue &&
        (values as readonly unknown[]).includes(cue.value) && cue.value !== "unknown" &&
        ["observed_categorical", "inferred"].includes(String(cue.provenance)) &&
        typeof cue.confidence === "number" && Number.isFinite(cue.confidence) && cue.confidence >= 0.75 && cue.confidence <= 1;
      return [name, valid
        ? { value: cue.value, provenance: cue.provenance, confidence: cue.confidence }
        : { value: "unknown", provenance: "unknown", confidence: 0 }];
    })) as FaceMeasurementEvidence["cues"],
  };
}

export function resolveFaceMeasurements(analysis: PhotoAnalysis): FaceMeasurementTrace {
  const evidence = parseFaceMeasurementEvidence(analysis.faceMeasurementEvidence, analysis.sourceSelection.portraitImageIndex, analysis.visibleRegions.face);
  return Object.fromEntries(Object.keys(FACE_MEASUREMENT_VALUES).map((name) => {
    const key = name as FaceMeasurementCue;
    const group = key.startsWith("eye") ? "eyes" : key.startsWith("brow") ? "brows" : "mouth";
    const geometryConfidence = analysis.identityGeometry?.confidence[group] ?? 0;
    if (Number.isFinite(geometryConfidence) && geometryConfidence >= 0.55) return [key, {
      value: "continuous", provenance: "calibrated_geometry", confidence: geometryConfidence,
      selected: "continuous_geometry", reason: "accepted continuous geometry has priority",
    }];
    const cue = evidence?.cues[key];
    const glassesConstrained = group === "eyes" && analysis.fallbackFeatures.glasses !== "none";
    if (cue?.provenance === "observed_categorical" && cue.value !== "unknown" && !glassesConstrained) return [key, {
      ...cue, selected: "categorical_grammar", reason: "visible categorical relation selects existing pixel grammar",
    }];
    return [key, {
      value: cue?.value ?? "unknown", provenance: cue?.provenance ?? "unknown", confidence: cue?.confidence ?? 0,
      selected: "legacy_fallback", reason: glassesConstrained ? "existing glasses openings constrain eye placement" : "no confident observed category; preserve legacy fallback",
    }];
  })) as FaceMeasurementTrace;
}

export function observedFaceCategory<K extends FaceMeasurementCue>(trace: FaceMeasurementTrace, key: K): Category<K> | undefined {
  return trace[key].selected === "categorical_grammar" ? trace[key].value as Category<K> : undefined;
}
