/**
 * 사진 → 인물 특징 추출 (Workers AI vision).
 * 원본 사진은 이 요청 처리 동안만 메모리에 존재하며 어디에도 저장하지 않는다.
 */

import type { Env } from "./types";

const VISION_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
/** 업로드 허용 최대 크기 (base64 data URL 문자 수, 약 1.1MB 이미지) */
const MAX_IMAGE_CHARS = 1_500_000;

/**
 * 색상은 hex 샘플링 대신 팔레트 분류로 묻는다.
 * (vision 모델은 정확한 hex 추출에 약하지만 "무슨 색인지" 분류는 잘한다)
 * 팔레트 이름 → hex 변환은 서버에서 수행해 클라이언트 계약(hex)을 유지한다.
 */
const PROMPT = `You are a character designer analyzing a photo to create a Minecraft-style avatar that closely resembles the person.

First, judge photo quality:
- "fail" + failReason "no_face" if no human face is clearly visible
- "fail" + failReason "blurry" if the photo is too blurry to see facial features
- "fail" + failReason "too_small" if the person is too small in the frame
- "warn" if usable but not ideal
- "pass" if good

If multiple people appear, analyze only the most prominent/central person.

Then classify their visual features. For every color field, pick the CLOSEST option from the allowed list for that field — never invent other values. Respond with ONLY a JSON object:

{
  "quality": "pass" | "warn" | "fail",
  "failReason": "no_face" | "blurry" | "too_small" | null,
  "skinTone": "pale" | "light" | "medium" | "tan" | "brown" | "dark",
  "hairColor": "black" | "dark-brown" | "brown" | "light-brown" | "blonde" | "platinum" | "red" | "auburn" | "gray" | "white" | "dyed-blue" | "dyed-pink" | "dyed-purple" | "dyed-green",
  "hairstyle": "bald" | "buzz" | "short" | "medium" | "long" | "ponytail" | "bun" | "twintails" | "curly" | "afro",
  "eyeColor": "black" | "dark-brown" | "brown" | "hazel" | "green" | "blue" | "gray",
  "eyebrowThickness": "thin" | "normal" | "thick",
  "facialHair": "none" | "mustache" | "goatee" | "beard" | "stubble",
  "glasses": "none" | "regular" | "round" | "sunglasses",
  "glassesColor": CLOTHING_COLOR,
  "earrings": true | false,
  "hat": "none" | "cap" | "beanie" | "hood",
  "hatColor": CLOTHING_COLOR,
  "expression": "smile" | "neutral" | "serious",
  "topType": "tshirt" | "shirt" | "hoodie" | "jacket" | "sweater" | "dress" | "tank",
  "topColor": CLOTHING_COLOR (main clothing color; if not visible, pick one matching their vibe),
  "topAccentColor": CLOTHING_COLOR,
  "sleeveLength": "short" | "long",
  "bottomType": "pants" | "jeans" | "shorts" | "skirt",
  "bottomColor": CLOTHING_COLOR (if not visible, pick one that matches the top),
  "shoesColor": CLOTHING_COLOR
}

CLOTHING_COLOR must be one of: "black" | "white" | "gray" | "light-gray" | "red" | "orange" | "yellow" | "green" | "dark-green" | "blue" | "navy" | "sky-blue" | "purple" | "pink" | "brown" | "beige" | "denim" | "khaki"`;

// ---------- 팔레트 → hex (마인크래프트 픽셀아트에 어울리는 보정색) ----------

const SKIN_TONES: Record<string, string> = {
  pale: "#f2d6c0",
  light: "#e8b98f",
  medium: "#d29b6e",
  tan: "#b97f52",
  brown: "#8d5a3a",
  dark: "#5f3a24",
};

const HAIR_COLORS: Record<string, string> = {
  black: "#1b1b1b",
  "dark-brown": "#3b2a1e",
  brown: "#5a3d28",
  "light-brown": "#8a6240",
  blonde: "#d8b569",
  platinum: "#e9dcc0",
  red: "#a53c22",
  auburn: "#7a3b22",
  gray: "#9a9a9a",
  white: "#e8e8e8",
  "dyed-blue": "#4d9de0",
  "dyed-pink": "#e58bb6",
  "dyed-purple": "#8560b0",
  "dyed-green": "#4fa05a",
};

const EYE_COLORS: Record<string, string> = {
  black: "#241f1c",
  "dark-brown": "#4a3728",
  brown: "#6b4a2f",
  hazel: "#8a6a3b",
  green: "#4f7a46",
  blue: "#4a7fae",
  gray: "#7d8a92",
};

const CLOTHING_COLORS: Record<string, string> = {
  black: "#22201e",
  white: "#f2f2f2",
  gray: "#8c8c8c",
  "light-gray": "#c9c9c9",
  red: "#c0392b",
  orange: "#e07b2a",
  yellow: "#e3c14d",
  green: "#4fa05a",
  "dark-green": "#2e5e3a",
  blue: "#4d9de0",
  navy: "#2c3e63",
  "sky-blue": "#7fc3e8",
  purple: "#8560b0",
  pink: "#e58bb6",
  brown: "#7a543a",
  beige: "#d9c4a3",
  denim: "#3b5a80",
  khaki: "#9a8f6a",
};

/** 팔레트 이름 → hex. 모델이 hex를 직접 준 경우도 허용, 그 외엔 fallback. */
function paletteHex(
  value: unknown,
  table: Record<string, string>,
  fallback: string,
): string {
  if (typeof value === "string") {
    const key = value.trim().toLowerCase();
    if (table[key]) {
      return table[key];
    }
    if (/^#[0-9a-f]{6}$/.test(key)) {
      return key;
    }
  }
  return fallback;
}

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
  let responseObject: Record<string, unknown> | null = null;
  try {
    const result = (await env.AI.run(VISION_MODEL as never, {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageDataUrl } },
            { type: "text", text: PROMPT },
          ],
        },
      ],
      max_tokens: 800,
      response_format: { type: "json_object" },
    } as never)) as { response?: string | Record<string, unknown> };
    responseText =
      typeof result.response === "string" ? result.response : "";
    // JSON mode에서는 response가 객체로 올 수 있다
    if (
      result.response &&
      typeof result.response === "object" &&
      !Array.isArray(result.response)
    ) {
      responseObject = result.response as Record<string, unknown>;
    }
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

  const parsed = responseObject ?? extractJson(responseText);
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

  // 팔레트 이름 → hex 변환 (클라이언트는 기존과 동일하게 hex를 받는다)
  const features: Record<string, unknown> = {
    ...parsed,
    skinTone: paletteHex(parsed.skinTone, SKIN_TONES, SKIN_TONES.light),
    hairColor: paletteHex(parsed.hairColor, HAIR_COLORS, HAIR_COLORS["dark-brown"]),
    eyeColor: paletteHex(parsed.eyeColor, EYE_COLORS, EYE_COLORS["dark-brown"]),
    glassesColor: paletteHex(parsed.glassesColor, CLOTHING_COLORS, CLOTHING_COLORS.black),
    hatColor: paletteHex(parsed.hatColor, CLOTHING_COLORS, CLOTHING_COLORS.red),
    topColor: paletteHex(parsed.topColor, CLOTHING_COLORS, CLOTHING_COLORS.blue),
    topAccentColor: paletteHex(parsed.topAccentColor, CLOTHING_COLORS, CLOTHING_COLORS.white),
    bottomColor: paletteHex(parsed.bottomColor, CLOTHING_COLORS, CLOTHING_COLORS.denim),
    shoesColor: paletteHex(parsed.shoesColor, CLOTHING_COLORS, CLOTHING_COLORS.white),
  };
  delete features.quality;
  delete features.failReason;

  return {
    status: 200,
    body: { ok: true, quality, features },
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
