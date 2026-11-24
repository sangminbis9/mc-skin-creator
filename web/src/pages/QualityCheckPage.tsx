/**
 * 사진 품질 체크 결과 화면: PASS / WARN / FAIL.
 */

import { useEffect, useState } from "react";
import { JumpBlocks } from "../components/pixel/JumpBlocks";
import { PixelBadge } from "../components/pixel/PixelBadge";
import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";
import {
  checkImageQuality,
  type QualityCheckResult,
} from "../lib/imageQuality";
import { SKIN_PRESENTATIONS, type SkinPresentation } from "../lib/skinPresentation";

interface QualityCheckPageProps {
  photoDataUrl: string;
  presentation: SkinPresentation;
  onPresentationChange: (value: SkinPresentation) => void;
  onContinue: () => void;
  onReselect: () => void;
}

export function QualityCheckPage({
  photoDataUrl,
  presentation,
  onPresentationChange,
  onContinue,
  onReselect,
}: QualityCheckPageProps) {
  const [result, setResult] = useState<QualityCheckResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkImageQuality(photoDataUrl).then((r) => {
      if (!cancelled) {
        setResult(r);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [photoDataUrl]);

  if (!result) {
    return (
      <div
        className="px-screen px-screen--center"
        style={{ alignItems: "center" }}
      >
        <JumpBlocks />
        <p className="px-subtitle">Checking your photo…</p>
      </div>
    );
  }

  const badge =
    result.verdict === "pass" ? (
      <PixelBadge tone="green">Ready</PixelBadge>
    ) : result.verdict === "warn" ? (
      <PixelBadge tone="gold">Check photo</PixelBadge>
    ) : (
      <PixelBadge tone="red">Not suitable</PixelBadge>
    );

  return (
    <div className="px-screen">
      <h1 className="px-title">Ready to make it yours?</h1>
      <p className="px-subtitle">
        Your face, hair and outfit guide the skin. Unseen details are inferred.
      </p>

      <div style={{ textAlign: "center" }}>
        <img src={photoDataUrl} alt="Your selected photo" className="quality-photo" />
      </div>

      <div style={{ textAlign: "center" }}>{badge}</div>

      <PixelPanel>
        {result.messages.map((message) => (
          <p
            key={message}
            style={{ margin: "4px 0", fontSize: 13, lineHeight: 1.7 }}
          >
            {result.verdict === "pass"
              ? "✅"
              : result.verdict === "warn"
                ? "⚠️"
                : "❌"}{" "}
            {message}
          </p>
        ))}
      </PixelPanel>

      {result.verdict !== "fail" && (
        <fieldset className="skin-presentation" aria-describedby="skin-presentation-note">
          <legend>Avatar finish</legend>
          <div className="skin-presentation-options">
            {SKIN_PRESENTATIONS.map(({ value, label }) => (
              <label key={value}>
                <input type="radio" name="skin-presentation" value={value}
                  checked={presentation === value} onChange={() => onPresentationChange(value)} />
                {label}
              </label>
            ))}
          </div>
          <p id="skin-presentation-note">Style changes hair volume and shading. Your part, length, and eye placement stay the same.</p>
        </fieldset>
      )}

      <div className="px-spacer" />

      {result.verdict !== "fail" && (
        <PixelButton onClick={onContinue}>
          {result.verdict === "warn" ? "Generate anyway" : "Generate my skin"}
        </PixelButton>
      )}
      <PixelButton variant="ghost" onClick={onReselect}>
        Choose another photo
      </PixelButton>
    </div>
  );
}
