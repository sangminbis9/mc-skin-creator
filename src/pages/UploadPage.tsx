/**
 * 사진 업로드 화면: CTA + 개인정보 안내/동의 + quota 상태.
 */

import { fetchAlbumPhotos } from "@apps-in-toss/web-framework";
import { useEffect, useRef, useState } from "react";
import { PixelBadge } from "../components/pixel/PixelBadge";
import { PixelButton } from "../components/pixel/PixelButton";
import { PixelCheckbox } from "../components/pixel/PixelCheckbox";
import { PixelPanel } from "../components/pixel/PixelPanel";
import { fetchQuotaStatus } from "../lib/cloudflareAI";
import {
  preparePhotoForUpload,
  type PreparedPhotoUpload,
} from "../lib/imageQuality";
import type { QuotaStatus } from "../lib/skinFeatures";
import { formatResetTime } from "../lib/quotaText";

interface UploadPageProps {
  onPhotoSelected: (photo: PreparedPhotoUpload) => void;
  onQuotaClosed: (quota: QuotaStatus | null) => void;
}

export function UploadPage({ onPhotoSelected, onQuotaClosed }: UploadPageProps) {
  const [agreed, setAgreed] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [albumSupported, setAlbumSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchQuotaStatus().then(setQuota);
    // 토스 앱 안에서만 앨범 권한 API가 동작한다 — 실패하면 파일 선택만 노출
    fetchAlbumPhotos
      .getPermission()
      .then(() => setAlbumSupported(true))
      .catch(() => setAlbumSupported(false));
  }, []);

  const closed = quota?.level === "closed";

  const handlePhoto = async (source: string | File) => {
    if (closed) {
      onQuotaClosed(quota);
      return;
    }
    setBusy(true);
    try {
      const prepared = await preparePhotoForUpload(source);
      onPhotoSelected(prepared);
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) {
      void handlePhoto(file);
    }
  };

  const handleAlbumPick = async () => {
    try {
      const photos = await fetchAlbumPhotos({
        maxCount: 1,
        maxWidth: 1024,
        base64: true,
      });
      const photo = photos[0];
      if (photo) {
        await handlePhoto(`data:image/jpeg;base64,${photo.dataUri}`);
      }
    } catch {
      // 권한 거부 등 — 파일 선택으로 폴백
      fileInputRef.current?.click();
    }
  };

  return (
    <div className="px-screen">
      <div style={{ textAlign: "center", marginTop: 12 }}>
        <div className="px-float" style={{ fontSize: 44 }} aria-hidden="true">
          ⛏️
        </div>
        <h1 className="px-title" style={{ marginTop: 8 }}>
          사진으로 나만의
          <br />
          마인크래프트 스킨 만들기
        </h1>
        <p className="px-subtitle" style={{ marginTop: 8 }}>
          얼굴 사진도, 전신 사진도 좋아요.
          <br />
          AI가 나를 닮은 픽셀 캐릭터로 바꿔줘요.
        </p>
      </div>

      <div style={{ textAlign: "center" }}>
        {quota === null ? (
          <PixelBadge tone="gray">생성 가능 여부 확인 중…</PixelBadge>
        ) : quota.level === "closed" ? (
          <PixelBadge tone="red">오늘 생성 마감</PixelBadge>
        ) : quota.level === "almost" ? (
          <PixelBadge tone="gold">
            거의 마감 · 약 {quota.remainingGenerations}회 남음
          </PixelBadge>
        ) : (
          <PixelBadge tone="green">지금 생성 가능</PixelBadge>
        )}
      </div>

      <div className="px-spacer" />

      <PixelPanel>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.7 }}>
          업로드한 사진은 AI 스킨 생성을 위해서만 사용되며,
          <br />
          생성 완료 후 서버에 저장되지 않아요.
        </p>
        <div className="px-divider" />
        <PixelCheckbox checked={agreed} onChange={setAgreed}>
          사진 처리 및 AI 생성에 동의해요.{" "}
          <a href="#/privacy" style={{ color: "var(--px-info)" }}>
            개인정보 처리 안내
          </a>
        </PixelCheckbox>
      </PixelPanel>

      {closed ? (
        <>
          <PixelPanel tone="dirt" style={{ textAlign: "center" }}>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.8 }}>
              오늘의 AI 스킨 생성 수량이 모두 마감됐어요.
              <br />
              무료 생성 한도는 매일 오전 9시에 다시 열려요.
            </p>
            {quota && (
              <p className="px-caption" style={{ marginTop: 6, color: "#ffe9c2" }}>
                다음 오픈: {formatResetTime(quota.resetAtIso)}
              </p>
            )}
          </PixelPanel>
          <PixelButton variant="stone" onClick={() => onQuotaClosed(quota)}>
            자세히 보기
          </PixelButton>
        </>
      ) : (
        <>
          <PixelButton
            disabled={!agreed || busy}
            onClick={() => fileInputRef.current?.click()}
          >
            {busy ? "사진 준비 중…" : "얼굴/전신 사진 올리기"}
          </PixelButton>
          {albumSupported && (
            <PixelButton
              variant="ghost"
              disabled={!agreed || busy}
              onClick={handleAlbumPick}
            >
              앨범에서 최근 사진 가져오기
            </PixelButton>
          )}
        </>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={handleFileChange}
      />
    </div>
  );
}
