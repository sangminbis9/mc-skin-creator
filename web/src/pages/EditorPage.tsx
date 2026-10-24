/**
 * 편집기 화면: 3D 직접 칠하기 + 2D texture 편집 (동기화).
 * 상단: Back to preview / Undo / Redo
 * 도구: Pen / Eraser / Eyedropper / 팔레트 / 부위 선택 / (3D) Rotate mode
 */

import { useEffect, useState } from "react";
import { StudioIcon } from "../components/StudioIcon";
import { PixelButton } from "../components/pixel/PixelButton";
import type { SkinDocument, Tool } from "../editor/editorState";
import { SkinPainter3D } from "../editor/SkinPainter3D";
import { SkinTemplate2DEditor } from "../editor/SkinTemplate2DEditor";
import type { PartGroup } from "../lib/skinAtlas";
import type { SkinGeometry } from "../lib/skinAtlas";

interface EditorPageProps {
  doc: SkinDocument;
  onDone: () => void;
  geometry: SkinGeometry;
}

const PALETTE = [
  "#3a2e22",
  "#7a5230",
  "#e8b98f",
  "#f0c8a0",
  "#2f2118",
  "#8a5a2b",
  "#f5f5f0",
  "#b8b8b0",
  "#5b5b55",
  "#22201e",
  "#e25b4a",
  "#e8734a",
  "#ffc83d",
  "#6dbe45",
  "#2e8b57",
  "#4d9de0",
  "#3b5a80",
  "#8862d0",
  "#f291b7",
  "#ffffff",
];

const PART_OPTIONS: { key: PartGroup; label: string }[] = [
  { key: "all", label: "All" },
  { key: "head", label: "Head" },
  { key: "body", label: "Body" },
  { key: "arms", label: "Arms" },
  { key: "legs", label: "Legs" },
];

export function EditorPage({ doc, onDone, geometry }: EditorPageProps) {
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
        <button
          type="button"
          className="px-tool"
          aria-label="Back to preview"
          onClick={onDone}
        >
          <StudioIcon name="back" />
        </button>
        <span style={{ fontWeight: 700, fontSize: 15 }}>Edit skin</span>
        <div className="px-spacer" />
        <button
          type="button"
          className="px-tool"
          aria-label="Undo"
          disabled={!doc.canUndo}
          onClick={() => doc.undo()}
        >
          <StudioIcon name="undo" />
        </button>
        <button
          type="button"
          className="px-tool"
          aria-label="Redo"
          disabled={!doc.canRedo}
          onClick={() => doc.redo()}
        >
          <StudioIcon name="redo" />
        </button>
      </div>

      {/* 3D / 2D 탭 */}
      <div className="px-row">
        <button
          type="button"
          className={`px-btn px-btn--small ${mode === "3d" ? "" : "px-btn--ghost"}`}
          style={{ flex: 1 }}
          aria-pressed={mode === "3d"}
          onClick={() => setMode("3d")}
        >
          3D model
        </button>
        <button
          type="button"
          className={`px-btn px-btn--small ${mode === "2d" ? "" : "px-btn--ghost"}`}
          style={{ flex: 1 }}
          aria-pressed={mode === "2d"}
          onClick={() => setMode("2d")}
        >
          2D texture
        </button>
      </div>

      {/* 편집 영역 */}
      <div className="editor-canvas">
        {mode === "3d" ? (
          <>
            <SkinPainter3D
              doc={doc}
              geometry={geometry}
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
            <p
              className="px-caption"
              style={{ textAlign: "center", margin: "4px 0 0" }}
            >
              {rotateMode
                ? "Drag to rotate the model"
                : "Click or touch the model to paint"}
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
          aria-label="Pen"
          aria-pressed={tool === "pen" && !rotateMode}
          onClick={() => {
            setTool("pen");
            setRotateMode(false);
          }}
        >
          <StudioIcon name="edit" />
        </button>
        <button
          type="button"
          className={`px-tool ${tool === "eraser" && !rotateMode ? "px-tool--active" : ""}`}
          aria-label="Eraser"
          aria-pressed={tool === "eraser" && !rotateMode}
          onClick={() => {
            setTool("eraser");
            setRotateMode(false);
          }}
        >
          <StudioIcon name="eraser" />
        </button>
        <button
          type="button"
          className={`px-tool ${tool === "picker" && !rotateMode ? "px-tool--active" : ""}`}
          aria-label="Eyedropper"
          aria-pressed={tool === "picker" && !rotateMode}
          onClick={() => {
            setTool("picker");
            setRotateMode(false);
          }}
        >
          <StudioIcon name="picker" />
        </button>
        {mode === "3d" && (
          <button
            type="button"
            className={`px-tool ${rotateMode ? "px-tool--active" : ""}`}
            aria-label="Rotate mode"
            aria-pressed={rotateMode}
            onClick={() => setRotateMode((r) => !r)}
          >
            <StudioIcon name="refresh" />
          </button>
        )}
        <label
          className="px-tool"
          aria-label="Pick a custom color"
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

      {/* Color 팔레트 */}
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
            aria-label={`Color ${c}`}
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
            aria-pressed={group === key}
            onClick={() => setGroup(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <PixelButton onClick={onDone}>Done editing</PixelButton>
    </div>
  );
}
