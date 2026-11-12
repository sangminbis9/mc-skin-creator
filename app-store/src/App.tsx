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
import { LibraryPage } from "./pages/LibraryPage";
import { demoHints, loadDemoSkin } from "./lib/demoSkin";
import { ApplyGuidePage } from "./pages/ApplyGuidePage";
import { DownloadPage } from "./pages/DownloadPage";
import { FailurePage } from "./pages/FailurePage";
import { GeneratingPage, type GenerationFailure } from "./pages/GeneratingPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { QualityCheckPage } from "./pages/QualityCheckPage";
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
  | "failed";

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
  const [capturedImage, setCapturedImage] = useState<string | null>(null);
  const [skinGeometry, setSkinGeometry] = useState<SkinGeometry>("classic");
  const [isSample, setIsSample] = useState(false);
  const [generatedOnDevice, setGeneratedOnDevice] = useState(false);

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

  if (hash.startsWith("#/library")) {
    return (
      <Shell>
        <LibraryPage onOpen={async (skin) => {
          const canvas = await decodeSkinPng(skin.png.split(',')[1]);
          if (!canvas) throw new Error('스킨을 읽을 수 없습니다.');
          setDoc(new SkinDocument(canvas));
          setSkinGeometry(skin.geometry);
          setSkinVersion(0);
          setIsSample(false);
          setGeneratedOnDevice(false);
          setPhotos([]);
          setCapturedImage(null);
          setStep('preview');
          location.hash = '#/';
        }} />
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
    setIsSample(false);
    setGeneratedOnDevice(false);
    setPhotos([]);
    setDoc(null);
    setFailure(null);
    setRetryCount(0);
    setCapturedImage(null);
    setSkinGeometry("classic");
    setStep("upload");
  };

  return (
    <Shell step={step} onHome={resetToUpload}>
      {step === "upload" && (
        <>
          <UploadPage
            onDemo={async () => {
              setDoc(new SkinDocument(await loadDemoSkin(), demoHints));
              setIsSample(true);
              setGeneratedOnDevice(false);
              setSkinGeometry("slim");
              setSkinVersion(0);
              setStep("preview");
            }}
            onPhotoSelected={(preparedPhotos) => {
              setIsSample(false);
              setPhotos(preparedPhotos);
              setStep("quality");
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
          onDone={(result) => {
            setDoc(new SkinDocument(result.canvas, result.features));
            setPhotos([]);
            setGeneratedOnDevice(result.onDevice);
            setSkinVersion(0);
            setStep("preview");
          }}
          onFail={(f) => {
            setFailure(f);
            setStep("failed");
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

      {step === "preview" && doc && (
        <Suspense fallback={<LoadingScreen />}>
          <PreviewPage
            isSample={isSample}
            generatedOnDevice={generatedOnDevice}
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

function Shell({ children, step, onHome }: { children: React.ReactNode; step?: Step; onHome?: () => void }) {
  const active =
    step === "upload" || step === "quality"
      ? 0
      : step === "generating" || step === "failed"
        ? 1
        : 2;
  return (
    <div className="studio-shell web-shell">
      <a className="web-skip" href="#main-content">Skip to content</a>
      <header className="studio-header">
        <a href="#/" className="studio-brand" onClick={onHome}>
          <StudioIcon name="cube" />
          마크 스킨 뚝딱<span className="web-wordmark-dot">.</span>
        </a>
        <nav aria-label="메인 메뉴"><a href="#/" onClick={onHome}>만들기</a><a href="#/library">보관함</a></nav>
      </header>
      {step && step !== "upload" && (
        <ol className="studio-steps" aria-label="Creation progress">
          {["Your photo", "Generate", "Make it yours"].map((label, i) => (
            <li key={label} aria-current={active === i ? "step" : undefined}>
              <span>{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      )}
      <main id="main-content" tabIndex={-1}>{children}</main>
      <footer className="studio-footer">
        <div><strong>마크 스킨 뚝딱</strong><p>마인크래프트 공식 제품이 아닙니다.<br />Mojang 또는 Microsoft의 승인이나 제휴를 받지 않은 독립 도구입니다.</p></div>
        <div className="web-footer-links"><a href="#/library">내 스킨 보관함</a><a href="#/privacy">개인정보 안내</a><span>광고 없는 스킨 편집기</span></div>
      </footer>
    </div>
  );
}

export default App;
