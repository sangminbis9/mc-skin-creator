import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYSIS_PROMPT,
  classifyPortraitLocalization,
  runPhotoAnalysis,
  validatePhotoAnalysis,
} from "../src/analysis";
import { COMPACT_PHOTO_ANALYSIS_V2_PROMPT } from "../src/compactPhotoAnalysis";
import { COMPACT_PHOTO_ANALYSIS_V3_PROMPT } from "../src/compactPhotoAnalysisV3";
import {
  adaptGemmaNamedPhotoAnalysis,
  GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT,
  GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA,
  GEMMA_VISION_MODEL,
} from "../src/gemmaPhotoAnalysis";
import type { Env } from "../src/types";
import { namedGemmaFixture, wireFixture } from "./compactV3Support";
import { makeAnalysis } from "./helpers";

const photo = "data:image/jpeg;base64,/9j/";
const coordinates = "0.08,0.04,0.62,0.98,0.16,0.08,0.52,0.5,0.21,0.17,0.47,0.44,0.91";
const referenceSuffix = "\n\nREFERENCE SET: 1 image(s) of the same person are attached in order. Image 0 is primary; use the others to resolve stable identity cues and side/back evidence.";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function stubGemmaResponse(evidence: string) {
  const source = makeAnalysis();
  source.sourceSelection.portraitEvidence = evidence;
  const named = namedGemmaFixture(wireFixture(source));
  const run = vi.fn(async () => ({
    choices: [{ message: { content: JSON.stringify(named) } }],
  }));
  const env = {
    GEMINI_API_KEY: "local-test-key",
    WORKERS_VISION_MODEL: GEMMA_VISION_MODEL,
    AI: { run },
    MCSKIN_KV: {},
  } as unknown as Env;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    error: { status: "FAILED_PRECONDITION", message: "Local synthetic fallback trigger" },
  }, { status: 400 })));
  return { source, named, run, env };
}

describe("portrait REGION MISSING path: offline-only contract review", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the localization contract through the actual single-image Gemma request builder", async () => {
    const { env, run } = stubGemmaResponse(`Synthetic portrait | REGION:[${coordinates}]`);
    const result = await runPhotoAnalysis(env, photo);
    expect(result.ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    const [model, input] = run.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(model).toBe(GEMMA_VISION_MODEL);
    const message = (input.messages as Array<{ role: string; content: Array<{ type: string; text?: string }> }>)[0];
    expect(message.role).toBe("user");
    expect(message.content.map(part => part.type)).toEqual(["image_url", "text"]);
    const finalText = message.content[1].text;
    expect(finalText).toBe(`${GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT}${referenceSuffix}`);
    expect(finalText).toContain('Append to portraitEvidence exactly " | REGION:[subject L,T,R,B,head L,T,R,B,face L,T,R,B,confidence]"');
    expect(finalText).toContain('or " | REGION:null" when bounds cannot be measured');
    expect(finalText).toContain("All coordinates are normalized 0..1 within that selected source image");
    expect(finalText).toContain("Image 0 is primary");
    expect(sha256(finalText!)).toBe(sha256(`${GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT}${referenceSuffix}`));
    expect(COMPACT_PHOTO_ANALYSIS_V2_PROMPT).toContain(ANALYSIS_PROMPT);
    expect(COMPACT_PHOTO_ANALYSIS_V3_PROMPT).toContain(ANALYSIS_PROMPT);
    expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT).toContain(ANALYSIS_PROMPT);
    expect(GEMMA_NAMED_PHOTO_ANALYSIS_PROMPT).toContain("Keep every other Compact v3 field and meaning exactly as instructed above.");
    const responseFormat = input.response_format as { json_schema: { schema: typeof GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA } };
    const carrierSchema = responseFormat.json_schema.schema.properties!.sourceSelection.properties!.portraitEvidence;
    expect(carrierSchema).toEqual({ type: "string" });
    expect(responseFormat.json_schema.schema).toEqual(GEMMA_NAMED_PHOTO_ANALYSIS_SCHEMA);
  });

  it.each([
    [`Synthetic portrait | REGION:[${coordinates}]`, "VALID", true],
    ["Synthetic portrait with no localization suffix", "MISSING", false],
    [`${"Synthetic portrait evidence. ".repeat(200)} | REGION:[${coordinates}]`, "VALID", true],
  ] as const)("preserves provider carrier through named adapter and pre-normalization trace (%s)", async (evidence, status, hasRegion) => {
    const { env, named, run } = stubGemmaResponse(evidence);
    const adapted = adaptGemmaNamedPhotoAnalysis(named);
    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.compact.sourceSelection).toEqual(named.sourceSelection);
    expect(adapted.compact.sourceSelection.portraitEvidence).toBe(evidence);
    expect(classifyPortraitLocalization(adapted.compact.sourceSelection.portraitEvidence).status).toBe(status);
    const result = await runPhotoAnalysis(env, photo);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.localizationTrace?.status).toBe(status);
    expect(result.localizationTrace?.markerPresent).toBe(hasRegion);
    expect(result.analysis.sourceSelection.portraitRegion !== null).toBe(hasRegion);
    expect(result.analysis.sourceSelection.portraitEvidence).toBe(hasRegion
      ? evidence.replace(/\s*\|\s*REGION\s*:\s*\[[^\]]*\]\s*$/i, "")
      : evidence);
    expect(validatePhotoAnalysis(result.analysis).ok).toBe(true);
  });

  it("distinguishes contract-valid, absent, malformed, invalid, and whitespace forms", () => {
    expect(classifyPortraitLocalization(`Evidence | REGION:[${coordinates}]`).status).toBe("VALID");
    expect(classifyPortraitLocalization("Evidence | REGION:null").status).toBe("EXPLICIT_NULL");
    expect(classifyPortraitLocalization("Evidence without a marker").status).toBe("MISSING");
    expect(classifyPortraitLocalization(`Evidence | REGION:[${coordinates}] trailing`).status).toBe("MALFORMED");
    expect(classifyPortraitLocalization(`Evidence | REGION:[${coordinates.split(",").slice(0, 12).join(",")}]`).status).toBe("MALFORMED");
    expect(classifyPortraitLocalization(`Evidence | REGION:[bad,${coordinates.split(",").slice(1).join(",")}]`).status).toBe("MALFORMED");
    expect(classifyPortraitLocalization(`Evidence | REGION:[${coordinates.replace(/0\.91$/, "1.2")}]`).status).toBe("INVALID_REGION");
    const spaced = `Evidence |\n REGION : [ ${coordinates.split(",").join(" , ")} ]\n`;
    expect(classifyPortraitLocalization(spaced)).toMatchObject({ status: "VALID", markerPresent: true, numericCount: 13 });
    expect(classifyPortraitLocalization("Evidence | ＲＥＧＩＯＮ：null").status).toBe("MISSING");
    expect(classifyPortraitLocalization(`Evidence | REGION:[,${coordinates.split(",").slice(1).join(",")}]`).status).toBe("MALFORMED");
  });
});
