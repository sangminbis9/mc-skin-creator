/**
 * 2D 스킨 템플릿 에디터: 64x64 atlas를 확대해 픽셀 단위로 편집한다.
 * SkinDocument를 3D 페인터와 공유하므로 편집 내용이 즉시 동기화된다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ATLAS_SIZE,
  isInGroup,
  rectsOfGroup,
  type PartGroup,
} from "../lib/skinAtlas";
import type { SkinDocument, Tool } from "./editorState";

interface SkinTemplate2DEditorProps {
  doc: SkinDocument;
  tool: Tool;
  color: string;
  group: PartGroup;
  onPickColor: (color: string) => void;
}

const MIN_ZOOM = 4;
const MAX_ZOOM = 14;

export function SkinTemplate2DEditor({
  doc,
  tool,
  color,
  group,
  onPickColor,
}: SkinTemplate2DEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(6);

  const stateRef = useRef({ tool, color, group, onPickColor });
  stateRef.current = { tool, color, group, onPickColor };

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) {
      return;
    }
    const size = ATLAS_SIZE * zoom;
    ctx.clearRect(0, 0, size, size);

    // 투명 체커보드
    for (let y = 0; y < ATLAS_SIZE; y++) {
      for (let x = 0; x < ATLAS_SIZE; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#eae4d4" : "#f6f1e3";
        ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
      }
    }

    // 스킨 픽셀
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(doc.canvas, 0, 0, size, size);

    // 선택된 부위 밖은 어둡게
    if (group !== "all") {
      ctx.fillStyle = "rgba(58, 46, 34, 0.45)";
      for (let y = 0; y < ATLAS_SIZE; y++) {
        for (let x = 0; x < ATLAS_SIZE; x++) {
          if (!isInGroup(group, x, y)) {
            ctx.fillRect(x * zoom, y * zoom, zoom, zoom);
          }
        }
      }
    }

    // 격자
    if (zoom >= 6) {
      ctx.strokeStyle = "rgba(58, 46, 34, 0.12)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= ATLAS_SIZE; i++) {
        ctx.beginPath();
        ctx.moveTo(i * zoom + 0.5, 0);
        ctx.lineTo(i * zoom + 0.5, size);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * zoom + 0.5);
        ctx.lineTo(size, i * zoom + 0.5);
        ctx.stroke();
      }
    }

    // 부위 영역 외곽선
    ctx.strokeStyle = "rgba(77, 157, 224, 0.8)";
    ctx.lineWidth = 2;
    for (const rect of rectsOfGroup(group)) {
      ctx.strokeRect(rect.x * zoom, rect.y * zoom, rect.w * zoom, rect.h * zoom);
    }
  }, [doc, zoom, group]);

  useEffect(() => {
    redraw();
    return doc.subscribe(redraw);
  }, [doc, redraw]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    let painting = false;

    const atlasPixel = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = Math.floor(((event.clientX - rect.left) / rect.width) * ATLAS_SIZE);
      const y = Math.floor(((event.clientY - rect.top) / rect.height) * ATLAS_SIZE);
      if (x < 0 || y < 0 || x >= ATLAS_SIZE || y >= ATLAS_SIZE) {
        return null;
      }
      return { x, y };
    };

    const applyTool = (px: { x: number; y: number }) => {
      const { tool: t, color: c, group: g, onPickColor: pick } =
        stateRef.current;
      if (t === "pen") {
        doc.paint(px.x, px.y, c, g);
      } else if (t === "eraser") {
        doc.erase(px.x, px.y, g);
      } else {
        const picked = doc.pickColor(px.x, px.y);
        if (picked) {
          pick(picked);
        }
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!event.isPrimary) {
        return;
      }
      const px = atlasPixel(event);
      if (!px) {
        return;
      }
      event.preventDefault();
      painting = true;
      canvas.setPointerCapture(event.pointerId);
      doc.beginStroke();
      applyTool(px);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!painting || stateRef.current.tool === "picker") {
        return;
      }
      const px = atlasPixel(event);
      if (px) {
        applyTool(px);
      }
    };

    const endStroke = () => {
      if (painting) {
        painting = false;
        doc.endStroke();
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", endStroke);
    canvas.addEventListener("pointercancel", endStroke);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endStroke);
      canvas.removeEventListener("pointercancel", endStroke);
    };
  }, [doc]);

  const size = ATLAS_SIZE * zoom;

  return (
    <div className="px-col" style={{ gap: 8 }}>
      <div
        style={{
          overflow: "auto",
          maxHeight: 340,
          border: "3px solid var(--px-ink)",
          borderRadius: 2,
          background: "#f6f1e3",
          WebkitOverflowScrolling: "touch",
        }}
      >
        <canvas
          ref={canvasRef}
          width={size}
          height={size}
          className="px-pixelated"
          style={{ width: size, height: size, touchAction: "none", display: "block" }}
          aria-label="2D 스킨 템플릿 편집기"
        />
      </div>
      <div className="px-row" style={{ justifyContent: "center" }}>
        <button
          type="button"
          className="px-tool"
          aria-label="축소"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z - 2))}
        >
          −
        </button>
        <span className="px-caption">{Math.round((zoom / 6) * 100)}%</span>
        <button
          type="button"
          className="px-tool"
          aria-label="확대"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z + 2))}
        >
          +
        </button>
      </div>
    </div>
  );
}
