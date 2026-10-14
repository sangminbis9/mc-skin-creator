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
        <p className="px-subtitle">사진을 확인하고 있어요…</p>
      </div>
    );
  }

  const badge =
    result.verdict === "pass" ? (
      <PixelBadge tone="green">사용 가능</PixelBadge>
    ) : result.verdict === "warn" ? (
      <PixelBadge tone="gold">주의</PixelBadge>
    ) : (
      <PixelBadge tone="red">사용 불가</PixelBadge>
    );

  return (
    <div className="px-screen">
      <h1 className="px-title">이 사진으로 시작할까요?</h1>
      <p className="px-subtitle">
        얼굴과 머리, 옷차림을 바탕으로 스킨을 만들어요.
      </p>

      <div style={{ textAlign: "center" }}>
        <img src={photoDataUrl} alt="업로드한 사진" className="quality-photo" />
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

      <div className="px-spacer" />

      {result.verdict !== "fail" && (
        <PixelButton onClick={onContinue}>
          {result.verdict === "warn" ? "그래도 계속하기" : "스킨 만들기 시작"}
        </PixelButton>
      )}
      <PixelButton variant="ghost" onClick={onReselect}>
        다른 사진 올리기
      </PixelButton>
    </div>
  );
}
