/**
 * 스킨 편집 문서: 3D 페인터와 2D 템플릿 에디터가 공유하는 단일 소스.
 * 64x64 캔버스 + undo/redo + 변경 알림(구독)으로 두 편집기를 동기화한다.
 */

import {
  ATLAS_SIZE,
  CLASSIC_LAYOUT,
  createSkinCanvas,
  isInGroup,
  partAt,
  type PartGroup,
} from "../lib/skinAtlas";

const BASE_RECTS = Object.values(CLASSIC_LAYOUT).flatMap((layout) =>
  Object.values(layout.base),
);

export type Tool = "pen" | "eraser" | "picker";

const MAX_HISTORY = 60;

export class SkinDocument {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** AI 생성 원본 — 지우개는 base 레이어를 원본으로 되돌린다 */
  private original: ImageData;
  private undoStack: ImageData[] = [];
  private redoStack: ImageData[] = [];
  private listeners = new Set<() => void>();
  private strokeSnapshot: ImageData | null = null;
  private strokeChanged = false;

  constructor(source: HTMLCanvasElement) {
    this.canvas = createSkinCanvas();
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("2D context unavailable");
    }
    this.ctx = ctx;
    ctx.drawImage(source, 0, 0);
    this.original = ctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  private snapshot(): ImageData {
    return this.ctx.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  }

  // ---------- 스트로크 단위 히스토리 ----------

  beginStroke(): void {
    this.strokeSnapshot = this.snapshot();
    this.strokeChanged = false;
  }

  endStroke(): void {
    if (this.strokeSnapshot && this.strokeChanged) {
      this.undoStack.push(this.strokeSnapshot);
      if (this.undoStack.length > MAX_HISTORY) {
        this.undoStack.shift();
      }
      this.redoStack = [];
      // undo/redo 버튼 상태 갱신
      this.notify();
    }
    this.strokeSnapshot = null;
    this.strokeChanged = false;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) {
      return;
    }
    this.redoStack.push(this.snapshot());
    this.ctx.putImageData(prev, 0, 0);
    this.notify();
  }

  redo(): void {
    const next = this.redoStack.pop();
    if (!next) {
      return;
    }
    this.undoStack.push(this.snapshot());
    this.ctx.putImageData(next, 0, 0);
    this.notify();
  }

  // ---------- 픽셀 조작 ----------

  /** 펜: 선택된 부위 그룹 + 유효한 스킨 영역에만 칠해진다 */
  paint(x: number, y: number, hex: string, group: PartGroup): void {
    if (!this.inBounds(x, y) || !isInGroup(group, x, y)) {
      return;
    }
    this.ctx.fillStyle = hex;
    this.ctx.clearRect(x, y, 1, 1);
    this.ctx.fillRect(x, y, 1, 1);
    this.strokeChanged = true;
    this.notify();
  }

  /**
   * 지우개:
   * - 오버레이 영역 → 투명하게 (액세서리 제거)
   * - 베이스 영역 → AI 생성 원본 픽셀로 복원 (구멍 방지)
   */
  erase(x: number, y: number, group: PartGroup): void {
    if (!this.inBounds(x, y) || !isInGroup(group, x, y)) {
      return;
    }
    if (this.isOverlayPixel(x, y)) {
      this.ctx.clearRect(x, y, 1, 1);
    } else {
      const i = (y * ATLAS_SIZE + x) * 4;
      const d = this.original.data;
      this.ctx.clearRect(x, y, 1, 1);
      if (d[i + 3] > 0) {
        this.ctx.fillStyle = `rgba(${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3] / 255})`;
        this.ctx.fillRect(x, y, 1, 1);
      }
    }
    this.strokeChanged = true;
    this.notify();
  }

  /** 스포이드: 해당 좌표 색 (투명이면 null) */
  pickColor(x: number, y: number): string | null {
    if (!this.inBounds(x, y)) {
      return null;
    }
    const d = this.ctx.getImageData(x, y, 1, 1).data;
    if (d[3] === 0) {
      return null;
    }
    return `#${((d[0] << 16) | (d[1] << 8) | d[2]).toString(16).padStart(6, "0")}`;
  }

  alphaAt(x: number, y: number): number {
    if (!this.inBounds(x, y)) {
      return 0;
    }
    return this.ctx.getImageData(x, y, 1, 1).data[3];
  }

  private inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < ATLAS_SIZE && y < ATLAS_SIZE;
  }

  private isOverlayPixel(x: number, y: number): boolean {
    const part = partAt(x, y);
    if (!part) {
      return false;
    }
    // 오버레이 영역 판정: 베이스 rect 목록에 없으면 오버레이
    return !this.isBasePixel(x, y);
  }

  private isBasePixel(x: number, y: number): boolean {
    // CLASSIC_LAYOUT의 base 영역 안이면 true
    // (skinAtlas의 partAt은 base+overlay 모두 포함하므로 별도 판정)
    return BASE_RECTS.some(
      (r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h,
    );
  }
}
