/**
 * 3D 미리보기 화면: 회전/줌/방향 버튼 + 결과 액션 버튼.
 */

import { useLanguage } from "../i18n/LanguageProvider";
import { useRef, useState } from "react";
import { SkinVariationPicker } from "../components/SkinVariationPicker";
import { pixelsToSkinCanvas } from "../lib/skinAtlas";
import { PixelButton } from "../components/pixel/PixelButton";
import { StudioIcon } from "../components/StudioIcon";
import type { SkinDocument } from "../editor/editorState";
import { SkinViewer3D } from "../editor/SkinViewer3D";
import type { SkinScene } from "../editor/skinScene";
import type { SkinGeometry } from "../lib/skinAtlas";
import type { MessageKey } from "../i18n/messages";
import { LibraryFullError, saveSkin } from "../lib/skinLibrary";

interface PreviewPageProps {
  isSample?: boolean;
  generatedOnDevice?: boolean;
  doc: SkinDocument;
  skinVersion: number;
  onEdit: () => void;
  onDownload: () => void;
  onShare: (previewImageDataUrl: string | null) => void;
  onApplyGuide: () => void;
  onCreateAnother: () => void;
  geometry: SkinGeometry;
  onGeometryChange: (geometry: SkinGeometry) => void;
}

export function PreviewPage({
  isSample = false,
  generatedOnDevice = false,
  doc,
  skinVersion,
  onEdit,
  onDownload,
  onShare,
  onApplyGuide,
  onCreateAnother,
  geometry,
  onGeometryChange,
}: PreviewPageProps) {
  const { t } = useLanguage();
  const sceneRef = useRef<SkinScene | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [mixing, setMixing] = useState(false);
  const [draft, setDraft] = useState<HTMLCanvasElement | null>(null);
  const draftRef = useRef<HTMLCanvasElement | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [compositionNotice, setCompositionNotice] = useState<MessageKey | "">("");
  const [saveNotice, setSaveNotice] = useState<MessageKey | ''>('');
  const mixButtonRef = useRef<HTMLButtonElement | null>(null);

  const handleShare = () => {
    let capture: string | null = null;
    const scene = sceneRef.current;
    if (scene) {
      try {
        scene.render();
        capture = scene.renderer.domElement.toDataURL("image/png");
      } catch {
        capture = null;
      }
    }
    onShare(capture);
  };

  return (
    <div
      className={`px-screen preview-layout${mixing ? " preview-layout--mixing" : ""}`}
    >
      {!mixing && (
        <>
          <h1 className="px-title">
            {mixing ? t("preview.mixTitle") : isSample ? t("preview.sample") : t("preview.title")}
          </h1>
          <p className="px-subtitle">
            {isSample
              ? t("preview.sampleIntro")
              : generatedOnDevice
                ? t("preview.localIntro")
                : t("preview.intro")}
          </p>
        </>
      )}
      <div
        ref={stageRef}
        className={`studio-stage${mixing ? " studio-stage--mixing" : ""}`}
      >
        {!mixing && (
          <div
            className="studio-segment studio-geometry"
            aria-label={t("preview.armLayout")}
          >
            {(["classic", "slim"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={geometry === value}
                onClick={() => onGeometryChange(value)}
              >
                {value === "classic" ? t("model.classicSize") : t("model.slimSize")}
              </button>
            ))}
          </div>
        )}
        <SkinViewer3D
          skinCanvas={draft ?? doc.canvas}
          version={skinVersion + draftVersion}
          height={mixing ? 190 : 320}
          compact={mixing}
          geometry={geometry}
          onReady={(scene) => {
            sceneRef.current = scene;
          }}
        />
      </div>
      {mixing ? (
        <SkinVariationPicker
          doc={doc}
          onPreview={(canvas) => {
            const target = draftRef.current!;
            const ctx = target.getContext("2d")!;
            ctx.clearRect(0, 0, 64, 64);
            ctx.drawImage(canvas, 0, 0);
            setDraftVersion((v) => v + 1);
          }}
          onClose={(applied) => {
            setMixing(false);
            setDraft(null);
            setDraftVersion((v) => v + 1);
            draftRef.current = null;
            setCompositionNotice(
              applied
                ? "preview.applied"
                : "preview.cancelled",
            );
            requestAnimationFrame(() => mixButtonRef.current?.focus());
          }}
        />
      ) : (
        <div className="variation-entry">
          <h2>{t("wardrobe.title")}</h2>
          <button
            ref={mixButtonRef}
            type="button"
            className="px-btn px-btn--ghost"
            onClick={() => {
              draftRef.current = pixelsToSkinCanvas(doc.getPixels());
              setDraft(draftRef.current);
              setMixing(true);
              setCompositionNotice("");
              requestAnimationFrame(() =>
                stageRef.current?.scrollIntoView({
                  block: "start",
                  behavior: "instant",
                }),
              );
            }}
          >
            {t("wardrobe.open")} <StudioIcon name="arrow" size={16} />
          </button>
        </div>
      )}
      <p className="variation-selection" role="status">
        {compositionNotice && t(compositionNotice)}
      </p>
      {!mixing && (
        <>
          <div className="studio-actions">
            <PixelButton variant="ghost" onClick={() => {
              try { saveSkin(doc.canvas.toDataURL('image/png'), geometry); setSaveNotice('preview.saved'); }
              catch (error) { setSaveNotice(error instanceof LibraryFullError ? 'library.full' : 'preview.saveError'); }
            }}>{t("preview.save")}</PixelButton>
            <PixelButton className="studio-primary" onClick={onDownload}>
              <StudioIcon name="download" />
              {t("common.export")}
            </PixelButton>
            <PixelButton variant="ghost" onClick={onEdit}>
              <StudioIcon name="edit" />
              {t("preview.edit")}
            </PixelButton>
            <PixelButton variant="ghost" onClick={handleShare}>
              <StudioIcon name="share" />
              {t("preview.share")}
            </PixelButton>
            <PixelButton
              variant="ghost"
              className="studio-wide"
              onClick={onApplyGuide}
            >
              <StudioIcon name="game" />
              {t("preview.use")}
              <StudioIcon name="arrow" size={16} />
            </PixelButton>
          </div>
          {saveNotice && <p role="status">{t(saveNotice)}</p>}
          <button
            className="studio-text-btn"
            type="button"
            onClick={onCreateAnother}
          >
            <StudioIcon name="refresh" size={16} />
            {isSample ? t("preview.fromPhoto") : t("preview.newPhoto")}
          </button>
        </>
      )}
    </div>
  );
}
