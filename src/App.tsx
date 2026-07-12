/**
 * 앱 진입점: 해시 라우팅(#/admin, #/privacy) + 메인 플로우 상태 머신.
 * 업로드 → 품질 체크 → 생성 중 → 3D 미리보기 → 편집/다운로드/공유/가이드
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { JumpBlocks } from "./components/pixel/JumpBlocks";
import { SkinDocument } from "./editor/editorState";
import { decodeSkinPng } from "./lib/skinDecode";
import { generateSkinFromFeatures } from "./lib/skinFromFeatures";
import type { PreparedPhotoUpload } from "./lib/imageQuality";
import { normalizeFeatures, type QuotaStatus } from "./lib/skinFeatures";
import { AdminDashboard } from "./pages/AdminDashboard";
import { ApplyGuidePage } from "./pages/ApplyGuidePage";
import { DownloadPage } from "./pages/DownloadPage";
import { FailurePage } from "./pages/FailurePage";
import {
  GeneratingPage,
  type GenerationFailure,
} from "./pages/GeneratingPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { QualityCheckPage } from "./pages/QualityCheckPage";
import { QuotaClosedPage } from "./pages/QuotaClosedPage";
import { SamplePopup } from "./pages/SamplePopup";
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

const SAMPLE_SEEN_KEY = "mcsc_sample_seen";

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
  const [photo, setPhoto] = useState<PreparedPhotoUpload | null>(null);
  const [doc, setDoc] = useState<SkinDocument | null>(null);
  const [skinVersion, setSkinVersion] = useState(0);
  const [failure, setFailure] = useState<GenerationFailure | null>(null);
  const [quota, setQuota] = useState<QuotaStatus | null>(null);
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [showSample, setShowSample] = useState(
    () => sessionStorage.getItem(SAMPLE_SEEN_KEY) === null,
  );

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

  const dismissSample = () => {
    sessionStorage.setItem(SAMPLE_SEEN_KEY, "1");
    setShowSample(false);
  };

  const resetToUpload = () => {
    setPhoto(null);
    setDoc(null);
    setFailure(null);
    setCapturedImage(null);
    setStep("upload");
  };

  return (
    <Shell>
      {step === "upload" && (
        <>
          <UploadPage
            onPhotoSelected={(preparedPhoto) => {
              setPhoto(preparedPhoto);
              setStep("quality");
            }}
            onQuotaClosed={(q) => {
              setQuota(q);
              setStep("closed");
            }}
          />
          <SamplePopup
            open={showSample}
            onStart={dismissSample}
            onClose={dismissSample}
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
          onDone={async (result) => {
            // AI가 직접 생성한 스킨 우선, 실패하면 특징 기반 절차 생성으로 fallback
            const decoded = result.skinPngBase64
              ? await decodeSkinPng(result.skinPngBase64)
              : null;
            const canvas =
              decoded ??
              generateSkinFromFeatures(normalizeFeatures(result.features));
            setDoc(new SkinDocument(canvas));
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
          onRetry={() => setStep("generating")}
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
          />
        </Suspense>
      )}

      {step === "editor" && doc && (
        <Suspense fallback={<LoadingScreen />}>
          <EditorPage doc={doc} onDone={() => setStep("preview")} />
        </Suspense>
      )}

      {step === "download" && doc && (
        <DownloadPage
          doc={doc}
          onBack={() => setStep("preview")}
          onApplyGuide={() => setStep("guide")}
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
    <div className="px-screen px-screen--center" style={{ alignItems: "center" }}>
      <JumpBlocks />
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="px-grass-strip" aria-hidden="true" />
      {children}
    </>
  );
}

export default App;
