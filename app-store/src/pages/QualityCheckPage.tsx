/**
 * 사진 품질 체크 결과 화면: PASS / WARN / FAIL.
 */

import { useEffect, useState } from "react";
import { useLanguage } from "../i18n/LanguageProvider";
import { JumpBlocks } from "../components/pixel/JumpBlocks";
import { PixelBadge } from "../components/pixel/PixelBadge";
import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";
import {
  checkImageQuality,
  type QualityCheckResult,
} from "../lib/imageQuality";

interface QualityCheckPageProps {
  photoDataUrl: string;
  onContinue: () => void;
  onReselect: () => void;
}

export function QualityCheckPage({
  photoDataUrl,
  onContinue,
  onReselect,
}: QualityCheckPageProps) {
  const { t } = useLanguage();
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
        <p className="px-subtitle">{t("quality.checking")}</p>
      </div>
    );
  }

  const badge =
    result.verdict === "pass" ? (
      <PixelBadge tone="green">{t("quality.ready")}</PixelBadge>
    ) : result.verdict === "warn" ? (
      <PixelBadge tone="gold">{t("quality.check")}</PixelBadge>
    ) : (
      <PixelBadge tone="red">{t("quality.unsuitable")}</PixelBadge>
    );

  return (
    <div className="px-screen">
      <h1 className="px-title">{t("quality.title")}</h1>
      <p className="px-subtitle">
        {t("quality.subtitle")}
      </p>

      <div style={{ textAlign: "center" }}>
        <img src={photoDataUrl} alt={t("quality.selected")} className="quality-photo" />
      </div>

      <div style={{ textAlign: "center" }}>{badge}</div>

      <PixelPanel>
        {result.messages.map((message) => (
          <p
            key={t(message)}
            style={{ margin: "4px 0", fontSize: 13, lineHeight: 1.7 }}
          >
            {result.verdict === "pass"
              ? "✅"
              : result.verdict === "warn"
                ? "⚠️"
                : "❌"}{" "}
            {t(message)}
          </p>
        ))}
      </PixelPanel>

      <div className="px-spacer" />

      {result.verdict !== "fail" && (
        <PixelButton onClick={onContinue}>
          {result.verdict === "warn" ? t("quality.anyway") : t("quality.generate")}
        </PixelButton>
      )}
      <PixelButton variant="ghost" onClick={onReselect}>
        {t("common.anotherPhoto")}
      </PixelButton>
    </div>
  );
}
