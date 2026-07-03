/**
 * AI가 사진에서 추출하는 인물 특징 스키마.
 * Cloudflare Worker의 vision 모델 출력과 클라이언트 스킨 생성기가 공유한다.
 */

export type Hairstyle =
  | "bald"
  | "buzz"
  | "short"
  | "medium"
  | "long"
  | "ponytail"
  | "bun"
  | "twintails"
  | "curly"
  | "afro";

export type FacialHair = "none" | "mustache" | "goatee" | "beard" | "stubble";
export type Glasses = "none" | "regular" | "round" | "sunglasses";
export type Hat = "none" | "cap" | "beanie" | "hood";
export type Expression = "smile" | "neutral" | "serious";
export type TopType =
  | "tshirt"
  | "shirt"
  | "hoodie"
  | "jacket"
  | "sweater"
  | "dress"
  | "tank";
export type BottomType = "pants" | "jeans" | "shorts" | "skirt";
export type SleeveLength = "short" | "long";

export interface SkinFeatures {
  skinTone: string;
  hairColor: string;
  hairstyle: Hairstyle;
  eyeColor: string;
  eyebrowThickness: "thin" | "normal" | "thick";
  facialHair: FacialHair;
  glasses: Glasses;
  glassesColor: string;
  earrings: boolean;
  hat: Hat;
  hatColor: string;
  expression: Expression;
  topType: TopType;
  topColor: string;
  topAccentColor: string;
  sleeveLength: SleeveLength;
  bottomType: BottomType;
  bottomColor: string;
  shoesColor: string;
}

export type PhotoQuality = "pass" | "warn" | "fail";
export type PhotoFailReason = "no_face" | "blurry" | "too_small" | "unknown";

/** Worker /api/generate 응답 */
export interface GenerateResponse {
  ok: boolean;
  quality?: PhotoQuality;
  failReason?: PhotoFailReason;
  features?: SkinFeatures;
  error?: string;
  errorCode?:
    | "quota_exceeded"
    | "photo_rejected"
    | "ai_failed"
    | "bad_request";
  quota?: QuotaStatus;
}

export type QuotaLevel = "available" | "almost" | "closed";

export interface QuotaStatus {
  level: QuotaLevel;
  /** 예상 남은 생성 가능 수 */
  remainingGenerations: number;
  /** 다음 리셋 시각 (ISO, KST 오전 9시) */
  resetAtIso: string;
  /** 사용률 0~1 */
  usedRatio: number;
}

/** 값 검증 + 기본값 채움: AI 출력이 불완전해도 안전하게 만든다 */
export function normalizeFeatures(raw: Partial<SkinFeatures>): SkinFeatures {
  const hex = (value: unknown, fallback: string): string =>
    typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value.trim())
      ? value.trim().toLowerCase()
      : fallback;

  const oneOf = <T extends string>(
    value: unknown,
    options: readonly T[],
    fallback: T,
  ): T =>
    typeof value === "string" && (options as readonly string[]).includes(value)
      ? (value as T)
      : fallback;

  return {
    skinTone: hex(raw.skinTone, "#e8b98f"),
    hairColor: hex(raw.hairColor, "#2f2118"),
    hairstyle: oneOf(
      raw.hairstyle,
      [
        "bald",
        "buzz",
        "short",
        "medium",
        "long",
        "ponytail",
        "bun",
        "twintails",
        "curly",
        "afro",
      ],
      "short",
    ),
    eyeColor: hex(raw.eyeColor, "#4a3728"),
    eyebrowThickness: oneOf(
      raw.eyebrowThickness,
      ["thin", "normal", "thick"],
      "normal",
    ),
    facialHair: oneOf(
      raw.facialHair,
      ["none", "mustache", "goatee", "beard", "stubble"],
      "none",
    ),
    glasses: oneOf(
      raw.glasses,
      ["none", "regular", "round", "sunglasses"],
      "none",
    ),
    glassesColor: hex(raw.glassesColor, "#22201e"),
    earrings: raw.earrings === true,
    hat: oneOf(raw.hat, ["none", "cap", "beanie", "hood"], "none"),
    hatColor: hex(raw.hatColor, "#d94f3d"),
    expression: oneOf(
      raw.expression,
      ["smile", "neutral", "serious"],
      "smile",
    ),
    topType: oneOf(
      raw.topType,
      ["tshirt", "shirt", "hoodie", "jacket", "sweater", "dress", "tank"],
      "tshirt",
    ),
    topColor: hex(raw.topColor, "#4d9de0"),
    topAccentColor: hex(raw.topAccentColor, "#ffffff"),
    sleeveLength: oneOf(raw.sleeveLength, ["short", "long"], "short"),
    bottomType: oneOf(
      raw.bottomType,
      ["pants", "jeans", "shorts", "skirt"],
      "jeans",
    ),
    bottomColor: hex(raw.bottomColor, "#3b5a80"),
    shoesColor: hex(raw.shoesColor, "#ffffff"),
  };
}
