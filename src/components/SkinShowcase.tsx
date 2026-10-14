import { useState } from "react";

/** Floating illustration card, not an actual generated/downloadable skin. */
export function SkinShowcase() {
  const [expanded, setExpanded] = useState(false);

  return (
    <figure className="upload-showcase upload-transformation">
      <div className="skin-showcase">
        <img
          className="skin-showcase-photo"
          src="/images/woman-lace-photo.png"
          width={1024}
          height={1536}
          alt="얼굴을 가리지 않고 머리를 넘기는 여성, 아이보리 레이스 상의와 롱스커트"
          fetchPriority="high"
        />
        <button
          type="button"
          className="skin-showcase-card"
          data-expanded={expanded}
          aria-pressed={expanded}
          aria-label={
            expanded ? "스킨 스타일 예시 축소" : "스킨 스타일 예시 확대"
          }
          onClick={() => setExpanded((value) => !value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setExpanded(false);
          }}
        >
          <img
            src="/images/woman-lace-minecraft-subtle-corners.png"
            width={1024}
            height={1536}
            alt="네모난 머리와 몸통에 긴 머리·레이스 의상을 픽셀로 표현한 마크 스킨 스타일 예시"
          />
          <span>
            스킨 미리보기 <span aria-hidden="true">{expanded ? "−" : "+"}</span>
          </span>
        </button>
      </div>
      <figcaption>AI 스타일 예시 · 실제 생성 스킨과 다를 수 있어요</figcaption>
    </figure>
  );
}
