/**
 * 편집기 화면: 3D 직접 칠하기 + 2D 템플릿 편집 (동기화).
 * 상단: 미리보기로 돌아가기 / 되돌리기 / 다시 실행
 * 도구: 펜 / 지우개 / 스포이드 / 팔레트 / 부위 선택 / (3D) 회전 모드
 */

import { useEffect, useState } from "react";
import { PixelButton } from "../components/pixel/PixelButton";
import type { SkinDocument, Tool } from "../editor/editorState";
import { SkinPainter3D } from "../editor/SkinPainter3D";
import { SkinTemplate2DEditor } from "../editor/SkinTemplate2DEditor";
import type { PartGroup } from "../lib/skinAtlas";

interface EditorPageProps {
  doc: SkinDocument;
  onDone: () => void;
}

const PALETTE = [
  "#3a2e22", "#7a5230", "#e8b98f", "#f0c8a0", "#2f2118", "#8a5a2b",
  "#f5f5f0", "#b8b8b0", "#5b5b55", "#22201e", "#e25b4a", "#e8734a",
  "#ffc83d", "#6dbe45", "#2e8b57", "#4d9de0", "#3b5a80", "#8862d0",
  "#f291b7", "#ffffff",
];

const PART_OPTIONS: { key: PartGroup; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "head", label: "머리" },
  { key: "body", label: "몸통" },
  { key: "arms", label: "팔" },
  { key: "legs", label: "다리" },
];

export function EditorPage({ doc, onDone }: EditorPageProps) {
  const [mode, setMode] = useState<"3d" | "2d">("3d");
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#3a2e22");
  const [group, setGroup] = useState<PartGroup>("all");
  const [rotateMode, setRotateMode] = useState(false);
  const [, setVersion] = useState(0);

  // undo/redo 버튼 상태 갱신용
  useEffect(() => doc.subscribe(() => setVersion((v) => v + 1)), [doc]);

  return (
    <div className="px-screen" style={{ gap: 10 }}>
      {/* 상단 바 */}
      <div className="px-row">
        <button type="button" className="px-tool" aria-label="미리보기로 돌아가기" onClick={onDone}>
          ←
        </button>
        <span style={{ fontWeight: 700, fontSize: 15 }}>스킨 편집</span>
        <div className="px-spacer" />
        <button
          type="button"
          className="px-tool"
          aria-label="되돌리기"
          disabled={!doc.canUndo}
          onClick={() => doc.undo()}
        >
          ↩
        </button>
        <button
          type="button"
          className="px-tool"
          aria-label="다시 실행"
          disabled={!doc.canRedo}
          onClick={() => doc.redo()}
        >
          ↪
        </button>
      </div>

      {/* 3D / 2D 탭 */}
      <div className="px-row">
        <button
          type="button"
          className={`px-btn px-btn--small ${mode === "3d" ? "" : "px-btn--ghost"}`}
          style={{ flex: 1 }}
          onClick={() => setMode("3d")}
        >
          3D 모델
        </button>
        <button
          type="button"
          className={`px-btn px-btn--small ${mode === "2d" ? "" : "px-btn--ghost"}`}
          style={{ flex: 1 }}
          onClick={() => setMode("2d")}
        >
          2D 템플릿
        </button>
      </div>

      {/* 편집 영역 */}
      <div
        style={{
          background: "var(--px-paper)",
          border: "3px solid var(--px-ink)",
          borderRadius: 2,
          padding: 8,
        }}
      >
        {mode === "3d" ? (
          <>
            <SkinPainter3D
              doc={doc}
              tool={tool}
              color={color}
              group={group}
              rotateMode={rotateMode}
              onPickColor={(picked) => {
                setColor(picked);
                setTool("pen");
              }}
              height={280}
            />
            <p className="px-caption" style={{ textAlign: "center", margin: "4px 0 0" }}>
              {rotateMode
                ? "드래그로 모델을 돌려보세요"
                : "모델을 터치해서 직접 칠해보세요"}
            </p>
          </>
        ) : (
          <SkinTemplate2DEditor
            doc={doc}
            tool={tool}
            color={color}
            group={group}
            onPickColor={(picked) => {
              setColor(picked);
              setTool("pen");
            }}
          />
        )}
      </div>

      {/* 도구 바 */}
      <div className="px-row" style={{ justifyContent: "center" }}>
        <button
          type="button"
          className={`px-tool ${tool === "pen" && !rotateMode ? "px-tool--active" : ""}`}
          aria-label="펜"
          onClick={() => {
            setTool("pen");
            setRotateMode(false);
          }}
        >
          ✏️
        </button>
        <button
          type="button"
          className={`px-tool ${tool === "eraser" && !rotateMode ? "px-tool--active" : ""}`}
          aria-label="지우개"
          onClick={() => {
            setTool("eraser");
            setRotateMode(false);
          }}
        >
          🧽
        </button>
        <button
          type="button"
          className={`px-tool ${tool === "picker" && !rotateMode ? "px-tool--active" : ""}`}
          aria-label="스포이드"
          onClick={() => {
            setTool("picker");
            setRotateMode(false);
          }}
        >
          💉
        </button>
        {mode === "3d" && (
          <button
            type="button"
            className={`px-tool ${rotateMode ? "px-tool--active" : ""}`}
            aria-label="회전 모드"
            onClick={() => setRotateMode((r) => !r)}
          >
            🔄
          </button>
        )}
        <label
          className="px-tool"
          aria-label="색상 직접 선택"
          style={{ background: color, position: "relative" }}
        >
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            style={{
              position: "absolute",
              inset: 0,
              opacity: 0,
              width: "100%",
              height: "100%",
              cursor: "pointer",
            }}
          />
        </label>
      </div>

      {/* 색상 팔레트 */}
      <div
        className="px-row"
        style={{ flexWrap: "wrap", gap: 6, justifyContent: "center" }}
      >
        {PALETTE.map((c) => (
          <button
            key={c}
            type="button"
            className={`px-swatch ${color === c ? "px-swatch--active" : ""}`}
            style={{ background: c }}
            aria-label={`색상 ${c}`}
            onClick={() => {
              setColor(c);
              if (tool === "picker") {
                setTool("pen");
              }
            }}
          />
        ))}
      </div>

      {/* 부위 선택 */}
      <div className="px-row" style={{ justifyContent: "center", gap: 6 }}>
        {PART_OPTIONS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`px-btn px-btn--small ${group === key ? "px-btn--gold" : "px-btn--ghost"}`}
            onClick={() => setGroup(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <PixelButton onClick={onDone}>수정 완료</PixelButton>
    </div>
  );
}
