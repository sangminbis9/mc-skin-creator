/**
 * 사진 → 인물 특징 추출 (Workers AI vision).
 * 원본 사진은 이 요청 처리 동안만 메모리에 존재하며 어디에도 저장하지 않는다.
 */

import type { Env } from "./types";

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
/** 업로드 허용 최대 크기 (base64 data URL 문자 수, 약 1.1MB 이미지) */
const MAX_IMAGE_CHARS = 1_500_000;

const PROMPT = `You are a character designer analyzing a photo to create a Minecraft-style avatar that closely resembles the person.

First, judge photo quality:
- "fail" + failReason "no_face" if no human face is clearly visible
- "fail" + failReason "blurry" if the photo is too blurry to see facial features
- "fail" + failReason "too_small" if the person is too small in the frame
- "warn" if usable but not ideal
- "pass" if good

If multiple people appear, analyze only the most prominent/central person.

Then extract their visual features. Sample REAL colors from the photo as 6-digit hex codes. Respond with ONLY a JSON object, no other text:

{
  "quality": "pass" | "warn" | "fail",
  "failReason": "no_face" | "blurry" | "too_small" | null,
  "skinTone": "#hex (actual skin color from photo)",
  "hairColor": "#hex (actual hair color)",
  "hairstyle": "bald" | "buzz" | "short" | "medium" | "long" | "ponytail" | "bun" | "twintails" | "curly" | "afro",
  "eyeColor": "#hex",
  "eyebrowThickness": "thin" | "normal" | "thick",
  "facialHair": "none" | "mustache" | "goatee" | "beard" | "stubble",
  "glasses": "none" | "regular" | "round" | "sunglasses",
  "glassesColor": "#hex",
  "earrings": true | false,
  "hat": "none" | "cap" | "beanie" | "hood",
  "hatColor": "#hex",
  "expression": "smile" | "neutral" | "serious",
  "topType": "tshirt" | "shirt" | "hoodie" | "jacket" | "sweater" | "dress" | "tank",
  "topColor": "#hex (main clothing color; if not visible, pick a color matching their vibe)",
  "topAccentColor": "#hex",
  "sleeveLength": "short" | "long",
  "bottomType": "pants" | "jeans" | "shorts" | "skirt",
  "bottomColor": "#hex (if not visible, pick something that matches the top)",
  "shoesColor": "#hex"
}`;

export interface GenerateResult {
  status: number;
  body: {
    ok: boolean;
    quality?: string;
    failReason?: string;
    features?: Record<string, unknown>;
    error?: string;
    errorCode?: string;
  };
  /** true면 quota를 차감한다 (AI 호출이 실제로 성공했을 때만) */
  charge: boolean;
  success: boolean;
}

export async function analyzePhoto(
  env: Env,
  imageDataUrl: string,
): Promise<GenerateResult> {
  if (
    typeof imageDataUrl !== "string" ||
    !imageDataUrl.startsWith("data:image/") ||
    imageDataUrl.length > MAX_IMAGE_CHARS
  ) {
    return {
      status: 400,
      body: {
        ok: false,
        error: "이미지 형식이 올바르지 않아요",
        errorCode: "bad_request",
      },
      charge: false,
      success: false,
    };
  }

  let responseText: string;
  try {
    const result = (await env.AI.run(VISION_MODEL as never, {
      messages: [{ role: "user", content: PROMPT }],
      image: imageDataUrl,
      max_tokens: 800,
    } as never)) as { response?: string };
    responseText = result.response ?? "";
  } catch {
    return {
      status: 502,
      body: {
        ok: false,
        error: "AI가 스킨을 만드는 데 실패했어요",
        errorCode: "ai_failed",
      },
      charge: false,
      success: false,
    };
  }

  const parsed = extractJson(responseText);
  if (!parsed) {
    return {
      status: 502,
      body: {
        ok: false,
        error: "결과 형식이 올바르지 않아요",
        errorCode: "ai_failed",
      },
      // AI 호출 자체는 성공했으므로 비용은 발생했지만,
      // 사용자 실패 요청은 차감하지 않는 정책을 따른다.
      charge: false,
      success: false,
    };
  }

  const quality = typeof parsed.quality === "string" ? parsed.quality : "pass";
  if (quality === "fail") {
    return {
      status: 422,
      body: {
        ok: false,
        quality,
        failReason:
          typeof parsed.failReason === "string" ? parsed.failReason : "unknown",
        error: "사진에서 인물을 인식하지 못했어요",
        errorCode: "photo_rejected",
      },
      charge: false,
      success: false,
    };
  }

  return {
    status: 200,
    body: { ok: true, quality, features: parsed },
    charge: true,
    success: true,
  };
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
