/**
 * 마크 적용 가이드: Java / Bedrock 선택 후 적용 방법 안내.
 * (자동 적용은 제공하지 않음 — PNG 다운로드 후 공식 흐름 안내)
 */

import { useState } from "react";
import { PixelButton } from "../components/pixel/PixelButton";
import { PixelPanel } from "../components/pixel/PixelPanel";

interface ApplyGuidePageProps {
  onBack: () => void;
  onDownload: () => void;
}

type Edition = "java" | "bedrock";

const JAVA_STEPS = [
  "이 앱에서 Java용 PNG(Classic 또는 Slim)를 다운로드해요.",
  "minecraft.net에 로그인한 뒤 프로필(내 계정) 페이지로 이동해요.",
  "‘스킨(Skins)’ 메뉴에서 ‘새 스킨(New skin)’을 선택해요.",
  "다운로드한 PNG 파일을 업로드하고, 팔 모델(Classic/Slim)을 파일과 같게 선택해요.",
  "저장하면 게임에 바로 적용돼요!",
];

const BEDROCK_STEPS = [
  "이 앱에서 Bedrock용 PNG를 다운로드해요.",
  "마인크래프트(모바일/콘솔/윈도우)를 열고 ‘탈의실(Dressing Room)’로 이동해요.",
  "‘의상(캐릭터) 편집’ → ‘클래식 스킨’ 탭에서 ‘새 스킨 가져오기’를 눌러요.",
  "다운로드한 PNG 파일을 선택하고 팔 두께를 골라요.",
  "확인을 누르면 내 캐릭터에 적용돼요!",
];

export function ApplyGuidePage({ onBack, onDownload }: ApplyGuidePageProps) {
  const [edition, setEdition] = useState<Edition>("java");
  const steps = edition === "java" ? JAVA_STEPS : BEDROCK_STEPS;

  return (
    <div className="px-screen">
      <div className="px-row">
        <button type="button" className="px-tool" aria-label="뒤로" onClick={onBack}>
          ←
        </button>
        <h1 className="px-title" style={{ fontSize: 19 }}>
          마크에 적용하기
        </h1>
      </div>

      <div className="px-row">
        <button
          type="button"
          className={`px-btn px-btn--small ${edition === "java" ? "" : "px-btn--ghost"}`}
          style={{ flex: 1 }}
          onClick={() => setEdition("java")}
        >
          🎮 Java Edition
        </button>
        <button
          type="button"
          className={`px-btn px-btn--small ${edition === "bedrock" ? "" : "px-btn--ghost"}`}
          style={{ flex: 1 }}
          onClick={() => setEdition("bedrock")}
        >
          📱 Bedrock Edition
        </button>
      </div>

      <PixelPanel>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 2 }}>
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </PixelPanel>

      {edition === "java" && (
        <p className="px-caption" style={{ margin: 0, textAlign: "center" }}>
          Java Edition 정품 계정이 필요해요.
        </p>
      )}
      {edition === "bedrock" && (
        <p className="px-caption" style={{ margin: 0, textAlign: "center" }}>
          일부 콘솔에서는 커스텀 스킨 가져오기가 제한될 수 있어요.
        </p>
      )}

      <div className="px-spacer" />

      <PixelButton variant="gold" onClick={onDownload}>
        PNG 다운로드하러 가기
      </PixelButton>
    </div>
  );
}
