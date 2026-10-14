/**
 * 사진 업로드 화면: CTA + 개인정보 안내/동의 + quota 상태.
 */

import { fetchAlbumPhotos } from "@apps-in-toss/web-framework";
import { useEffect, useRef, useState } from "react";
import { StudioIcon } from "../components/StudioIcon";
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
  onShowSample: () => Promise<void>;
  onPhotoSelected: (photos: PreparedPhotoUpload[]) => void;
  onQuotaClosed: (quota: QuotaStatus | null) => void;
}

export function UploadPage({
  onPhotoSelected,
  onShowSample,
  onQuotaClosed,
}: UploadPageProps) {
  const [agreed, setAgreed] = useState(false);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [albumSupported, setAlbumSupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sampleBusy, setSampleBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchQuotaStatus().then(setQuota);
    // 토스 앱 안에서만 앨범 권한 API가 동작한다 — 실패하면 파일 선택만 노출
    // Bridge methods can throw synchronously outside the Toss WebView.
    Promise.resolve()
      .then(() => fetchAlbumPhotos.getPermission())
      .then(() => setAlbumSupported(true))
      .catch(() => setAlbumSupported(false));
  }, []);

  const closed = quota?.level === "closed";

  const handleSample = async () => {
    setSampleBusy(true);
    try {
      await onShowSample();
    } catch {
      setError(
        "샘플을 불러오지 못했어요. 화면을 새로 열고 다시 시도해 주세요.",
      );
    } finally {
      setSampleBusy(false);
    }
  };

  const handlePhotos = async (sources: Array<string | File>) => {
    if (closed) {
      onQuotaClosed(quota);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const prepared = await Promise.all(
        sources.slice(0, 5).map(preparePhotoForUpload),
      );
      onPhotoSelected(prepared);
    } catch {
      setError(
        "사진을 읽지 못했어요. JPG, PNG 또는 WebP 사진을 다시 선택해 주세요.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).slice(0, 5);
    event.target.value = "";
    if (files.length > 0) {
      void handlePhotos(files);
    }
  };

  const handleAlbumPick = async () => {
    try {
      const photos = await fetchAlbumPhotos({
        maxCount: 5,
        maxWidth: 1024,
        base64: true,
      });
      if (photos.length > 0) {
        await handlePhotos(
          photos.map((photo) => `data:image/jpeg;base64,${photo.dataUri}`),
        );
      }
    } catch {
      // 권한 거부 등 — 파일 선택으로 폴백
      fileInputRef.current?.click();
    }
  };

  return (
    <div className="px-screen upload-layout">
      <div className="upload-intro">
        <h1 className="px-title">
          현실의 나를,
          <br />
          블록 속으로.
        </h1>
        <p className="px-subtitle">
          사진 한 장에서 시작하는
          <br />
          나만의 마인크래프트 스킨
        </p>
      </div>
      <div className="upload-showcase">
        <figure className="studio-art">
          <img
            src="/studio-characters.webp"
            width="960"
            height="640"
            alt="초록 재킷과 크림색 옷을 입은 블록 캐릭터 일러스트"
            fetchPriority="high"
          />
          <figcaption>
            스타일 일러스트 · 실제 생성 결과는 사진에 따라 달라져요
          </figcaption>
        </figure>
        <PixelButton
          variant="ghost"
          disabled={sampleBusy}
          onClick={() => void handleSample()}
        >
          <StudioIcon name="image" />{" "}
          {sampleBusy ? "스킨 불러오는 중…" : "예시 스킨 둘러보기"}{" "}
          <StudioIcon name="arrow" size={16} style={{ marginLeft: "auto" }} />
        </PixelButton>
      </div>
      <div className="upload-controls">
        <div className="upload-instructions">
          <h2>당신의 다음 캐릭터는, 당신.</h2>
          <p className="px-subtitle">
            얼굴이 잘 보이는 사진을 골라주세요.
            <br />
            서로 다른 각도의 사진을 함께 올리면
            <br />
            머리와 옷의 특징을 더 잘 전달할 수 있어요.
          </p>
        </div>
        <PixelPanel className="upload-privacy">
          <PixelCheckbox checked={agreed} onChange={setAgreed}>
            사진 처리 및 AI 생성에 동의해요.
          </PixelCheckbox>
          <p>
            사진은 AI 스킨 생성에만 사용하며,
            <br />
            생성 완료 후 서버에 저장하지 않아요.
            <br />
            <a href="#/privacy">개인정보 처리 안내</a>
          </p>
        </PixelPanel>
        {error && (
          <p
            role="alert"
            className="px-caption"
            style={{ color: "var(--px-danger)", margin: 0 }}
          >
            {error}
          </p>
        )}
        {closed ? (
          <>
            <PixelPanel>
              <p className="px-subtitle">
                오늘의 무료 생성 한도를 모두 사용했어요.
              </p>
              {quota && (
                <p className="px-caption">
                  다음 오픈: {formatResetTime(quota.resetAtIso)}
                </p>
              )}
            </PixelPanel>
            <PixelButton variant="stone" onClick={() => onQuotaClosed(quota)}>
              생성 가능 시간 확인
            </PixelButton>
          </>
        ) : (
          <>
            <PixelButton
              disabled={!agreed || busy}
              onClick={() => fileInputRef.current?.click()}
            >
              <StudioIcon name="upload" />{" "}
              {busy ? "사진 준비 중…" : "사진 선택하기"}
            </PixelButton>
            <p className="upload-note">
              {!agreed ? "사진 처리에 동의하면 시작할 수 있어요 · " : ""}
              얼굴·전신 사진 최대 5장
            </p>
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
          multiple
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
      </div>
    </div>
  );
}
