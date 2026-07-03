/**
 * 마인크래프트 플레이어 3D 모델 (three.js).
 * 6개 부위 x (베이스 + 오버레이) 박스에 64x64 스킨 텍스처를 UV 매핑한다.
 * 뷰어와 페인터가 공유하며, 페인터는 raycast의 uv로 atlas 픽셀을 얻는다.
 */

import * as THREE from "three";
import {
  ALL_PARTS,
  ATLAS_SIZE,
  CLASSIC_LAYOUT,
  PART_GROUPS,
  type BodyPart,
  type BoxUV,
  type PartGroup,
  type Rect,
} from "../lib/skinAtlas";

/** BoxGeometry 면 순서: +x(right), -x(left), +y(top), -y(bottom), +z(front), -z(back) */
const FACE_ORDER: (keyof BoxUV)[] = [
  "right",
  "left",
  "top",
  "bottom",
  "front",
  "back",
];

/**
 * 면 UV 설정. 텍스처 flipY=false 기준으로 v = y / 64.
 * BoxGeometry의 면당 uv 버퍼 순서: [좌상, 우상, 좌하, 우하]
 */
function setFaceUV(
  geometry: THREE.BoxGeometry,
  faceIndex: number,
  rect: Rect,
  mirrorX = false,
): void {
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  let u1 = rect.x / ATLAS_SIZE;
  let u2 = (rect.x + rect.w) / ATLAS_SIZE;
  const v1 = rect.y / ATLAS_SIZE;
  const v2 = (rect.y + rect.h) / ATLAS_SIZE;
  if (mirrorX) {
    [u1, u2] = [u2, u1];
  }
  const o = faceIndex * 4;
  uv.setXY(o + 0, u1, v1);
  uv.setXY(o + 1, u2, v1);
  uv.setXY(o + 2, u1, v2);
  uv.setXY(o + 3, u2, v2);
  uv.needsUpdate = true;
}

function buildPartGeometry(uvMap: BoxUV, w: number, h: number, d: number) {
  const geometry = new THREE.BoxGeometry(w, h, d);
  FACE_ORDER.forEach((face, i) => {
    setFaceUV(geometry, i, uvMap[face], face === "bottom");
  });
  return geometry;
}

/** 부위별 박스 중심 좌표 (MC 픽셀 단위, 발바닥 y=0) */
const PART_POSITIONS: Record<BodyPart, [number, number, number]> = {
  head: [0, 28, 0],
  body: [0, 18, 0],
  rightArm: [6, 18, 0],
  leftArm: [-6, 18, 0],
  rightLeg: [2, 6, 0],
  leftLeg: [-2, 6, 0],
};

/** 오버레이 인플레이트: 머리 +0.5/side, 나머지 +0.25/side */
function overlayInflate(part: BodyPart): number {
  return part === "head" ? 1.0 : 0.5;
}

export class SkinModel {
  readonly group: THREE.Group;
  readonly texture: THREE.CanvasTexture;
  /** raycast 대상 (overlay 먼저 검사되도록 순서 무관 — 거리순 정렬됨) */
  readonly meshes: THREE.Mesh[] = [];
  private overlayMeshes = new Set<THREE.Mesh>();
  private partMeshes = new Map<BodyPart, THREE.Mesh[]>();

  constructor(skinCanvas: HTMLCanvasElement) {
    this.texture = new THREE.CanvasTexture(skinCanvas);
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.flipY = false;
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.group = new THREE.Group();

    for (const part of ALL_PARTS) {
      const layout = CLASSIC_LAYOUT[part];
      const { w, h, d } = layout.size;
      const [px, py, pz] = PART_POSITIONS[part];
      const list: THREE.Mesh[] = [];

      // 베이스 (스킨 셰이딩이 텍스처에 구워져 있으므로 조명 불필요)
      const baseMaterial = new THREE.MeshBasicMaterial({
        map: this.texture,
      });
      const base = new THREE.Mesh(
        buildPartGeometry(layout.base, w, h, d),
        baseMaterial,
      );
      base.position.set(px, py, pz);
      this.group.add(base);
      this.meshes.push(base);
      list.push(base);

      // 오버레이 (투명 픽셀 있는 겉 레이어)
      const inflate = overlayInflate(part);
      const overlayMaterial = new THREE.MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        alphaTest: 0.4,
        side: THREE.DoubleSide,
      });
      const overlay = new THREE.Mesh(
        buildPartGeometry(layout.overlay, w + inflate, h + inflate, d + inflate),
        overlayMaterial,
      );
      overlay.position.set(px, py, pz);
      this.group.add(overlay);
      this.meshes.push(overlay);
      this.overlayMeshes.add(overlay);
      list.push(overlay);

      this.partMeshes.set(part, list);
    }

    // 모델 중심을 원점 근처로 (y 16 = 몸 중심)
    this.group.position.y = -16;
  }

  isOverlayMesh(mesh: THREE.Mesh): boolean {
    return this.overlayMeshes.has(mesh);
  }

  /** 스킨 캔버스가 바뀌었을 때 호출 */
  refresh(): void {
    this.texture.needsUpdate = true;
  }

  /** 부위 그룹만 표시 (편집기 부위 선택) */
  setVisibleGroup(group: PartGroup): void {
    const visible = new Set(PART_GROUPS[group]);
    for (const part of ALL_PARTS) {
      const show = visible.has(part);
      for (const mesh of this.partMeshes.get(part) ?? []) {
        mesh.visible = show;
      }
    }
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    this.texture.dispose();
  }
}
