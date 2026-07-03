/**
 * PNG 다운로드 화면: Java Classic / Java Slim / Bedrock / 전체 다운로드.
 */

import { useState } from "react";
import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";
import type { SkinDocument } from "../editor/editorState";
import { trackEvent } from "../lib/cloudflareAI";
import { savePng } from "../lib/download";
import {
  EXPORT_FILENAMES,
  exportSkinPng,
  type ExportFormat,
} from "../lib/javaBedrockExport";

interface DownloadPageProps {
  doc: SkinDocument;
  onBack: () => void;
  onApplyGuide: () => void;
}

const FORMAT_LABELS: Record<ExportFormat, string> = {
  "java-classic": "Java Classic 다운로드 (기본 팔)",
  "java-slim": "Java Slim 다운로드 (얇은 팔)",
  bedrock: "Bedrock 다운로드",
};

export function DownloadPage({ doc, onBack, onApplyGuide }: DownloadPageProps) {
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const download = async (format: ExportFormat) => {
    const dataUrl = exportSkinPng(doc.canvas, format);
    await savePng(dataUrl, EXPORT_FILENAMES[format]);
    trackEvent("download");
    setSavedMessage(`${EXPORT_FILENAMES[format]} 저장 완료!`);
  };

  const downloadAll = async () => {
    for (const format of ["java-classic", "java-slim", "bedrock"] as const) {
      // 저장 다이얼로그가 겹치지 않도록 순차 실행
       
      await download(format);
    }
    setSavedMessage("3개 파일 모두 저장 완료!");
  };

  return (
    <div className="px-screen">
      <div className="px-row">
        <button type="button" className="px-tool" aria-label="뒤로" onClick={onBack}>
          ←
        </button>
        <h1 className="px-title" style={{ fontSize: 19 }}>
          PNG 다운로드
        </h1>
      </div>

      <PixelPanel>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.8 }}>
          🎮 <b>Java Edition</b>은 팔 두께에 따라 Classic(4px) /
          Slim(3px) 중 골라주세요.
          <br />
          📱 <b>Bedrock Edition</b>(모바일/콘솔)은 Bedrock용 파일을 받으면
          돼요.
        </p>
      </PixelPanel>

      <PixelButton onClick={() => download("java-classic")}>
        {FORMAT_LABELS["java-classic"]}
      </PixelButton>
      <PixelButton onClick={() => download("java-slim")}>
        {FORMAT_LABELS["java-slim"]}
      </PixelButton>
      <PixelButton onClick={() => download("bedrock")}>
        {FORMAT_LABELS.bedrock}
      </PixelButton>
      <PixelButton variant="gold" onClick={downloadAll}>
        전체 다운로드
      </PixelButton>

      {savedMessage && (
        <p
          className="px-caption"
          style={{ textAlign: "center", margin: 0, color: "var(--px-grass-dark)" }}
        >
          ✅ {savedMessage}
        </p>
      )}

      <div className="px-spacer" />

      <PixelButton variant="stone" onClick={onApplyGuide}>
        적용 방법 보기
      </PixelButton>
    </div>
  );
}
