import { describe, expect, it } from "vitest";
import { inspectGeminiResponseSchema } from "../src/geminiStructuredSchema";
import { IDENTITY_GEOMETRY_COMPACT_SCHEMA, IDENTITY_GEOMETRY_SCHEMA, IDENTITY_GEOMETRY_WIRE_SCHEMA } from "../src/identityGeometry";

describe("Gemini structured-output schema preflight", () => {
  it("accepts the identity geometry schema and reports deterministic shape metrics", () => {
    const internalReport = inspectGeminiResponseSchema(IDENTITY_GEOMETRY_SCHEMA);
    const report = inspectGeminiResponseSchema(IDENTITY_GEOMETRY_WIRE_SCHEMA);
    const compactReport = inspectGeminiResponseSchema(IDENTITY_GEOMETRY_COMPACT_SCHEMA);
    expect(internalReport).toMatchObject({
      valid: true,
      depth: 5,
      propertyCount: 169,
      requiredCount: 169,
      enumValueCount: 49,
      serializedBytes: 12_985,
      descriptionChars: 0,
    });
    expect(report).toMatchObject({
      valid: true,
      depth: 5,
      propertyCount: 119,
      requiredCount: 119,
      enumValueCount: 35,
      serializedBytes: 9_146,
      descriptionChars: 0,
    });
    expect(compactReport).toMatchObject({
      valid: true,
      depth: 5,
      propertyCount: 96,
      requiredCount: 96,
      enumValueCount: 32,
      serializedBytes: 7_687,
      descriptionChars: 0,
    });
    expect(report.valid).toBe(true);
    expect(report.jsonSerializable).toBe(true);
    expect(report.unsupportedConstructs).toEqual([]);
    expect(report.missingRequiredProperties).toEqual([]);
    expect(report.propertyCount).toBeLessThan(internalReport.propertyCount);
    expect(report.serializedBytes!).toBeLessThan(internalReport.serializedBytes!);
    expect(compactReport.propertyCount).toBeLessThan(report.propertyCount);
    expect(compactReport.serializedBytes!).toBeLessThan(report.serializedBytes!);
  });

  it("rejects unsupported constructs and required fields absent from properties", () => {
    const report = inspectGeminiResponseSchema({
      type: "object",
      properties: { value: { type: "number", pattern: "bad" } },
      required: ["missing"],
    });
    expect(report.valid).toBe(false);
    expect(report.unsupportedConstructs).toContain("pattern");
    expect(report.missingRequiredProperties).toContain("$schema.missing");
  });

  it("rejects undefined and non-finite values before request serialization", () => {
    const report = inspectGeminiResponseSchema({
      type: "object",
      properties: {
        missing: undefined,
        nan: { type: "number", maximum: Number.NaN },
        infinite: { type: "number", maximum: Number.POSITIVE_INFINITY },
      },
    });
    expect(report.valid).toBe(false);
    expect(report.undefinedPaths).toContain("$schema.properties.missing");
    expect(report.nonFiniteNumberPaths).toEqual(expect.arrayContaining([
      "$schema.properties.nan.maximum",
      "$schema.properties.infinite.maximum",
    ]));
  });
});
