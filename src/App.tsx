/**
 * 앱 진입점: 해시 라우팅(#/admin, #/privacy) + 메인 플로우 상태 머신.
 * 업로드 → 품질 체크 → 생성 중 → 3D 미리보기 → 편집/다운로드/공유/가이드
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { JumpBlocks } from "./components/pixel/JumpBlocks";
import { StudioIcon } from "./components/StudioIcon";
import { SkinDocument } from "./editor/editorState";
import { decodeSkinPng } from "./lib/skinDecode";
import type { PreparedPhotoUpload } from "./lib/imageQuality";
import type { SkinGeometry } from "./lib/skinAtlas";
import type { QuotaStatus } from "./lib/skinFeatures";
import { AdminDashboard } from "./pages/AdminDashboard";
import { ApplyGuidePage } from "./pages/ApplyGuidePage";
import { DownloadPage } from "./pages/DownloadPage";
import { FailurePage } from "./pages/FailurePage";
import { GeneratingPage, type GenerationFailure } from "./pages/GeneratingPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { QualityCheckPage } from "./pages/QualityCheckPage";
import { QuotaClosedPage } from "./pages/QuotaClosedPage";
import { SharePage } from "./pages/SharePage";
import { UploadPage } from "./pages/UploadPage";

// three.js가 포함된 화면은 첫 진입 로딩을 늦추지 않도록 lazy 로딩
const PreviewPage = lazy(() =>
  import("./pages/PreviewPage").then((m) => ({ default: m.PreviewPage })),
);
const EditorPage = lazy(() =>
  import("./pages/EditorPage").then((m) => ({ default: m.EditorPage })),
);

type Step =
  | "upload"
  | "quality"
  | "generating"
  | "preview"
  | "editor"
  | "download"
  | "share"
  | "guide"
  | "failed"
  | "closed";

function useHashRoute(): string {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

function App() {
  const hash = useHashRoute();

  const [step, setStep] = useState<Step>("upload");
  const [photos, setPhotos] = useState<PreparedPhotoUpload[]>([]);
  const photo = photos[0] ?? null;
  const [doc, setDoc] = useState<SkinDocument | null>(null);
  const [skinVersion, setSkinVersion] = useState(0);
  const [failure, setFailure] = useState<GenerationFailure | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [skinGeometry, setSkinGeometry] = useState<SkinGeometry>("classic");

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [step, hash]);

  // 편집 내용 → 미리보기 텍스처 갱신
  useEffect(() => {
    if (!doc) {
      return;
    }
    return doc.subscribe(() => setSkinVersion((v) => v + 1));
  }, [doc]);

  if (hash.startsWith("#/admin")) {
    return (
      <Shell>
        <AdminDashboard />
      </Shell>
    );
  }
  if (hash.startsWith("#/privacy")) {
    return (
      <Shell>
        <PrivacyPage />
      </Shell>
    );
  }

  const resetToUpload = () => {
    setPhotos([]);
    setDoc(null);
    setFailure(null);
    setRetryCount(0);
    setCapturedImage(null);
    setSkinGeometry("classic");
    setStep("upload");
  };

  return (
    <Shell step={step}>
      {step === "upload" && (
        <>
          <UploadPage
            onPhotoSelected={(preparedPhotos) => {
              setPhotos(preparedPhotos);
              setStep("quality");
            }}
            onQuotaClosed={(q) => {
              setQuota(q);
              setStep("closed");
            }}
          />
        </>
      )}

      {step === "quality" && photo && (
        <QualityCheckPage
          photoDataUrl={photo.analysisDataUrl}
          onContinue={() => setStep("generating")}
          onReselect={resetToUpload}
        />
      )}

      {step === "generating" && photo && (
        <GeneratingPage
          photoDataUrl={photo.generationDataUrl}
          analysisPhotoDataUrl={photo.analysisDataUrl}
          referencePhotoDataUrls={photos
            .slice(1)
            .map((reference) => reference.analysisDataUrl)}
          onDone={async (result) => {
            setPhotos([]);
            // AI가 직접 생성한 스킨 우선, 실패하면 특징 기반 절차 생성으로 fallback
            const decoded = result.skinPngBase64
              ? await decodeSkinPng(result.skinPngBase64)
              : null;
            if (!decoded) {
              setFailure({
                kind: "ai",
                message: "스킨 PNG를 읽지 못했어요.",
                retryable: false,
              });
              setStep("failed");
              return;
            }
            setDoc(new SkinDocument(decoded, result.features));
            setSkinVersion(0);
            setStep("preview");
          }}
          onFail={(f) => {
            setFailure(f);
            setStep("failed");
          }}
          onQuotaClosed={(q) => {
            setQuota(q);
            setStep("closed");
          }}
        />
      )}

      {step === "failed" && failure && (
        <FailurePage
          failure={failure}
          canRetry={
            retryCount < 2 &&
            failure.retryable !== false &&
            failure.kind !== "photo"
          }
          onRetry={() => {
            if (retryCount < 2 && failure.retryable !== false) {
              setRetryCount(retryCount + 1);
              setStep("generating");
            }
          }}
          onReselect={resetToUpload}
        />
      )}

      {step === "closed" && (
        <QuotaClosedPage quota={quota} onBack={resetToUpload} />
      )}

      {step === "preview" && doc && (
        <Suspense fallback={<LoadingScreen />}>
          <PreviewPage
            doc={doc}
            skinVersion={skinVersion}
            onEdit={() => setStep("editor")}
            onDownload={() => setStep("download")}
            onShare={(capture) => {
              setCapturedImage(capture);
              setStep("share");
            }}
            onApplyGuide={() => setStep("guide")}
            onCreateAnother={resetToUpload}
            geometry={skinGeometry}
            onGeometryChange={setSkinGeometry}
          />
        </Suspense>
      )}

      {step === "editor" && doc && (
        <Suspense fallback={<LoadingScreen />}>
          <EditorPage
            doc={doc}
            geometry={skinGeometry}
            onDone={() => setStep("preview")}
          />
        </Suspense>
      )}

      {step === "download" && doc && (
        <DownloadPage
          doc={doc}
          onBack={() => setStep("preview")}
          onApplyGuide={() => setStep("guide")}
          preferredGeometry={skinGeometry}
        />
      )}

      {step === "share" && doc && (
        <SharePage
          doc={doc}
          capturedImage={capturedImage}
          onBack={() => setStep("preview")}
        />
      )}

      {step === "guide" && (
        <ApplyGuidePage
          onBack={() => setStep(doc ? "preview" : "upload")}
          onDownload={() => setStep(doc ? "download" : "upload")}
        />
      )}
    </Shell>
  );
}

function LoadingScreen() {
  return (
    <div
      className="px-screen px-screen--center"
      style={{ alignItems: "center" }}
    >
      <JumpBlocks />
    </div>
  );
}

function Shell({ children, step }: { children: React.ReactNode; step?: Step }) {
  const active =
    step === "upload" || step === "quality"
      ? 0
      : step === "generating" || step === "failed" || step === "closed"
        ? 1
        : 2;
  return (
    <div className="studio-shell">
      <header className="studio-header">
        <div className="studio-brand">
          <StudioIcon name="cube" />
          마크 스킨 스튜디오
        </div>
      </header>
      {step && (
        <ol className="studio-steps" aria-label="스킨 만들기 진행 단계">
          {["사진 선택", "스킨 생성", "완성"].map((label, i) => (
            <li key={label} aria-current={active === i ? "step" : undefined}>
              <span>{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      )}
      <main>{children}</main>
      <footer className="studio-footer">
        <span>Minecraft 비공식 스킨 제작 도구</span>
        <a href="#/privacy">개인정보 처리 안내</a>
      </footer>
    </div>
  );
}

export default App;
