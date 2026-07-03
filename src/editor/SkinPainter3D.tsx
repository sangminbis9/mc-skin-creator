/**
 * 3D 픽셀 페인터: 모델 표면을 터치/드래그해 스킨 텍스처를 직접 칠한다.
 * raycast로 얻은 uv를 atlas 픽셀 좌표로 변환해 SkinDocument에 반영한다.
 */

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { ATLAS_SIZE, type PartGroup } from "../lib/skinAtlas";
import type { SkinDocument, Tool } from "./editorState";
import { createSkinScene, type SkinScene } from "./skinScene";

interface SkinPainter3DProps {
  doc: SkinDocument;
  tool: Tool;
  color: string;
  group: PartGroup;
  /** true면 한 손가락 드래그가 회전, false면 그리기 */
  rotateMode: boolean;
  onPickColor: (color: string) => void;
  height?: number;
}

export function SkinPainter3D({
  doc,
  tool,
  color,
  group,
  rotateMode,
  onPickColor,
  height = 300,
}: SkinPainter3DProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SkinScene | null>(null);

  // 최신 props를 이벤트 핸들러에서 참조하기 위한 ref
  const stateRef = useRef({ tool, color, group, rotateMode, onPickColor });
  stateRef.current = { tool, color, group, rotateMode, onPickColor };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const scene = createSkinScene(container, doc.canvas);
    sceneRef.current = scene;

    const unsubscribe = doc.subscribe(() => {
      scene.model.refresh();
      scene.render();
    });

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let painting = false;

    const pickAtlasPixel = (
      event: PointerEvent,
    ): { x: number; y: number } | null => {
      const rect = scene.renderer.domElement.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, scene.camera);
      const hits = raycaster.intersectObjects(
        scene.model.meshes.filter((m) => m.visible),
        false,
      );
      for (const hit of hits) {
        if (!hit.uv) {
          continue;
        }
        const x = Math.min(ATLAS_SIZE - 1, Math.floor(hit.uv.x * ATLAS_SIZE));
        const y = Math.min(ATLAS_SIZE - 1, Math.floor(hit.uv.y * ATLAS_SIZE));
        // 오버레이의 투명 픽셀은 통과시켜 안쪽(베이스)을 잡는다
        // (보이는 표면을 편집한다 — 오버레이 자체 편집은 2D 템플릿에서)
        if (
          scene.model.isOverlayMesh(hit.object as THREE.Mesh) &&
          doc.alphaAt(x, y) === 0
        ) {
          continue;
        }
        return { x, y };
      }
      return null;
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
      if (stateRef.current.rotateMode || !event.isPrimary) {
        return;
      }
      const px = pickAtlasPixel(event);
      if (!px) {
        return;
      }
      painting = true;
      scene.renderer.domElement.setPointerCapture(event.pointerId);
      doc.beginStroke();
      applyTool(px);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!painting || stateRef.current.tool === "picker") {
        return;
      }
      const px = pickAtlasPixel(event);
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

    const dom = scene.renderer.domElement;
    dom.addEventListener("pointerdown", onPointerDown);
    dom.addEventListener("pointermove", onPointerMove);
    dom.addEventListener("pointerup", endStroke);
    dom.addEventListener("pointercancel", endStroke);

    return () => {
      dom.removeEventListener("pointerdown", onPointerDown);
      dom.removeEventListener("pointermove", onPointerMove);
      dom.removeEventListener("pointerup", endStroke);
      dom.removeEventListener("pointercancel", endStroke);
      unsubscribe();
      sceneRef.current = null;
      scene.dispose();
    };
     
  }, [doc]);

  // 회전 모드 전환
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) {
      scene.controls.enabled = rotateMode;
    }
  }, [rotateMode]);

  // 부위 필터
  useEffect(() => {
    const scene = sceneRef.current;
    if (scene) {
      scene.model.setVisibleGroup(group);
      scene.render();
    }
  }, [group]);

  return (
    <div
      ref={containerRef}
      style={{ height, position: "relative" }}
      aria-label="3D 스킨 편집기"
    />
  );
}
