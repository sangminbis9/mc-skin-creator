/**
 * 첫 진입 샘플 변환 팝업: Before 사진 → After 마인크래프트 스킨 예시.
 */

import { useMemo } from "react";
import { PixelButton } from "../components/pixel/PixelButton";
import { PixelModal } from "../components/pixel/PixelModal";
import { generateSkinFromFeatures } from "../lib/skinFromFeatures";
import { normalizeFeatures } from "../lib/skinFeatures";
import { portraitDataUrl } from "../lib/skinPortrait";

interface SamplePopupProps {
  open: boolean;
  onStart: () => void;
  onClose: () => void;
}

/** 샘플 인물 특징 (예시용 프리셋) */
const SAMPLE_FEATURES = normalizeFeatures({
  skinTone: "#f0c8a0",
  hairColor: "#3d2b1f",
  hairstyle: "medium",
  eyeColor: "#4a3728",
  glasses: "regular",
  glassesColor: "#2b2b2b",
  expression: "smile",
  topType: "hoodie",
  topColor: "#e8734a",
  topAccentColor: "#fff1dd",
  sleeveLength: "long",
  bottomType: "jeans",
  bottomColor: "#3b5a80",
  shoesColor: "#f5f5f0",
});

export function SamplePopup({ open, onStart, onClose }: SamplePopupProps) {
  const sampleSkin = useMemo(
    () => portraitDataUrl(generateSkinFromFeatures(SAMPLE_FEATURES), 6),
    [],
  );

  return (
    <PixelModal open={open} onClose={onClose}>
      <div className="px-col" style={{ alignItems: "center", gap: 14 }}>
        <h2 className="px-title" style={{ fontSize: 18, textAlign: "center" }}>
          사진 한 장이면
          <br />
          나만의 마크 스킨 완성!
        </h2>

        <div className="px-row" style={{ gap: 14, alignItems: "center" }}>
          <div className="px-col" style={{ alignItems: "center", gap: 6 }}>
            <div
              style={{
                width: 84,
                height: 108,
                background: "var(--px-sky)",
                border: "3px solid var(--px-ink)",
                borderRadius: 2,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 40,
              }}
              aria-label="내 사진 예시"
            >
              🤳
            </div>
            <span className="px-caption">내 사진</span>
          </div>

          <span style={{ fontSize: 22 }} aria-hidden="true">
            ➡️
          </span>

          <div className="px-col" style={{ alignItems: "center", gap: 6 }}>
            <div
              style={{
                width: 84,
                height: 108,
                background: "#dff1ff",
                border: "3px solid var(--px-ink)",
                borderRadius: 2,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <img
                src={sampleSkin}
                alt="변환된 마인크래프트 스킨 예시"
                className="px-pixelated"
                style={{ height: 96 }}
              />
            </div>
            <span className="px-caption">마크 스킨</span>
          </div>
        </div>

        <p className="px-subtitle" style={{ textAlign: "center", fontSize: 13 }}>
          AI가 얼굴 특징, 머리 스타일, 옷차림까지
          <br />
          알아서 픽셀 스킨으로 만들어줘요
        </p>

        <PixelButton onClick={onStart}>사진 올리고 시작하기</PixelButton>
      </div>
    </PixelModal>
  );
}
