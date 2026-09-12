import { describe, expect, it } from "vitest";
import { PHOTO_ANALYSIS_SCHEMA } from "../src/analysis";
import {
  COMPACT_HINT_GROUPS,
  type CompactPhotoAnalysisV2,
} from "../src/compactPhotoAnalysis";
import {
  adaptGemmaNamedPhotoAnalysis,
  GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT,
  GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA,
  validateGemmaNamedPhotoAnalysis,
  type GemmaNamedPhotoAnalysis,
} from "../src/gemmaPhotoAnalysis";
import { normalizeCompactPhotoAnalysisV3 } from "../src/compactPhotoAnalysisV3";
import { semanticFixture, wireFixture } from "./compactV3Support";

function namedFixture(compact: CompactPhotoAnalysisV2): GemmaNamedPhotoAnalysis {
  return {
    ...compact,
    renderHints: Object.fromEntries(
      Object.entries(COMPACT_HINT_GROUPS).map(([group, fields]) => [
        group,
        Object.fromEntries(fields.map((field, index) => [
          field,
          compact.renderHints[group as keyof CompactPhotoAnalysisV2["renderHints"]][index],
        ])),
      ]),
    ) as GemmaNamedPhotoAnalysis["renderHints"],
  };
}

type MetricSchema = {
  properties?: Record<string, MetricSchema>;
  required?: readonly string[];
  enum?: readonly unknown[];
  items?: MetricSchema;
};

function metrics(schema: MetricSchema) {
  let properties = 0;
  let required = 0;
  let enumDeclarations = 0;
  let enumValues = 0;
  let maxDepth = 0;
  function visit(node: MetricSchema, depth: number): void {
    maxDepth = Math.max(maxDepth, depth);
    properties += Object.keys(node.properties ?? {}).length;
    required += node.required?.length ?? 0;
    if (node.enum) {
      enumDeclarations++;
      enumValues += node.enum.length;
    }
    Object.values(node.properties ?? {}).forEach((child) => visit(child, depth + 1));
    if (node.items) visit(node.items, depth + 1);
  }
  visit(schema, 1);
  return {
    serializedBytes: new TextEncoder().encode(JSON.stringify(schema)).byteLength,
    properties,
    required,
    enumDeclarations,
    enumValues,
    maxDepth,
  };
}

describe("Gemma named PhotoAnalysis provider DTO", () => {
  const compact = wireFixture(semanticFixture("plain"));
  const context = { imageCount: 1 };

  it("maps hair accessory semantics by field name", () => {
    const named = namedFixture(compact);
    named.renderHints.hairAccessory = {
      hairAccessory: "flower",
      hairAccessoryScale: "medium",
      hairAccessorySide: "right",
    };
    named.renderHints.hairAccessoryColor = { hairAccessoryColor: "red" };
    const adapted = adaptGemmaNamedPhotoAnalysis(named);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.compact.renderHints.hairAccessory).toEqual(["flower", "medium", "right"]);
    expect(adapted.compact.renderHints.hairAccessoryColor).toEqual(["red"]);
  });

  it("round-trips every named render-hint value without loss or invention", () => {
    let checked = 0;
    for (const [group, fields] of Object.entries(COMPACT_HINT_GROUPS)) {
      fields.forEach((field, index) => {
        const fieldSchema = PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties[field];
        for (const token of fieldSchema.enum) {
          const candidate = namedFixture(compact);
          candidate.renderHints[group as keyof GemmaNamedPhotoAnalysis["renderHints"]][field] = token;
          const adapted = adaptGemmaNamedPhotoAnalysis(candidate);
          expect(adapted.ok, `${group}.${field}:${token}`).toBe(true);
          if (!adapted.ok) continue;
          expect(adapted.compact.renderHints[group as keyof CompactPhotoAnalysisV2["renderHints"]][index]).toBe(token);
          const normalized = normalizeCompactPhotoAnalysisV3(adapted.compact, context);
          expect(normalized.ok, `${group}.${field}:${token}`).toBe(true);
          if (normalized.ok) expect(normalized.analysis.renderHints[field]).toBe(token);
          checked++;
        }
      });
    }
    expect(checked).toBeGreaterThan(100);
    const adapted = adaptGemmaNamedPhotoAnalysis(namedFixture(compact));
    expect(adapted).toEqual({ ok: true, compact });
  });

  it("rejects scale/side swaps, missing fields, and malformed enums before adaptation", () => {
    const wrongScale = namedFixture(compact);
    wrongScale.renderHints.hairAccessory.hairAccessoryScale = "right";
    expect(validateGemmaNamedPhotoAnalysis(wrongScale)).toContain(
      "gemma.renderHints.hairAccessory.hairAccessoryScale:enum",
    );
    expect(adaptGemmaNamedPhotoAnalysis(wrongScale).ok).toBe(false);

    const wrongSide = namedFixture(compact);
    wrongSide.renderHints.hairAccessory.hairAccessorySide = "medium";
    expect(validateGemmaNamedPhotoAnalysis(wrongSide)).toContain(
      "gemma.renderHints.hairAccessory.hairAccessorySide:enum",
    );

    const missing = namedFixture(compact) as GemmaNamedPhotoAnalysis & {
      renderHints: { hairAccessory: Partial<GemmaNamedPhotoAnalysis["renderHints"]["hairAccessory"]> };
    };
    delete missing.renderHints.hairAccessory.hairAccessorySide;
    expect(validateGemmaNamedPhotoAnalysis(missing)).toContain(
      "gemma.renderHints.hairAccessory.hairAccessorySide:required",
    );

    const malformed = namedFixture(compact);
    malformed.renderHints.hairAccessory.hairAccessory = "invented";
    expect(validateGemmaNamedPhotoAnalysis(malformed)).toContain(
      "gemma.renderHints.hairAccessory.hairAccessory:enum",
    );
  });

  it("uses named objects for all 15 groups and records schema complexity", () => {
    const renderHints = GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA.properties!.renderHints;
    expect(Object.keys(renderHints.properties!)).toEqual(Object.keys(COMPACT_HINT_GROUPS));
    for (const [group, fields] of Object.entries(COMPACT_HINT_GROUPS)) {
      const groupSchema = renderHints.properties![group];
      expect(groupSchema.type).toBe("object");
      expect(groupSchema.required).toEqual(fields);
      expect(Object.keys(groupSchema.properties!)).toEqual(fields);
      fields.forEach((field) => {
        expect(groupSchema.properties![field].enum)
          .toEqual(PHOTO_ANALYSIS_SCHEMA.properties.renderHints.properties[field].enum);
      });
    }
    expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT).toContain("GEMMA NAMED RENDERHINTS WIRE OVERRIDE");
    expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT).toContain("hairAccessoryScale: small | medium | large");
    expect(metrics(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA)).toEqual({
      serializedBytes: 11430,
      properties: 143,
      required: 122,
      enumDeclarations: 60,
      enumValues: 273,
      maxDepth: 5,
    });
  });
});
