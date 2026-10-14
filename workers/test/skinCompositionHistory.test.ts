import { afterEach, expect, it, vi } from "vitest";
import { SkinDocument } from "../../src/editor/editorState";

// Minimal in-memory Canvas2D for document transactions, without a browser dependency.
function canvas() {
  let bytes = new Uint8ClampedArray(64 * 64 * 4);
  return {
    width: 64,
    height: 64,
    getContext: () => ({
      drawImage(source: ReturnType<typeof canvas>) {
        bytes = new Uint8ClampedArray(source.getContext().getImageData().data);
      },
      getImageData: () => ({
        width: 64,
        height: 64,
        data: new Uint8ClampedArray(bytes),
      }),
      createImageData: () => ({
        width: 64,
        height: 64,
        data: new Uint8ClampedArray(bytes.length),
      }),
      putImageData(image: { data: Uint8ClampedArray }) {
        bytes = new Uint8ClampedArray(image.data);
      },
    }),
  };
}
function setup() {
  vi.stubGlobal("document", { createElement: canvas });
  const source = canvas();
  source
    .getContext()
    .putImageData({ data: new Uint8ClampedArray(64 * 64 * 4).fill(90) });
  return new SkinDocument(source as unknown as HTMLCanvasElement);
}
afterEach(() => vi.unstubAllGlobals());

it("commits the selected composition to the export canvas and supports one-step undo/redo", () => {
  const doc = setup();
  const before = doc.getPixels();
  const selected = new Uint8ClampedArray(before).fill(42, 500, 800);
  const notify = vi.fn();
  doc.subscribe(notify);
  doc.applyComposition(selected);
  expect(doc.canvas.getContext("2d")!.getImageData(0, 0, 64, 64).data).toEqual(
    selected,
  );
  expect(doc.canUndo).toBe(true);
  expect(notify).toHaveBeenCalledTimes(1);
  doc.undo();
  expect(doc.getPixels()).toEqual(before);
  expect(doc.canUndo).toBe(false);
  doc.redo();
  expect(doc.getPixels()).toEqual(selected);
  expect(doc.getOriginalPixels()).toEqual(before);
});
it("does not alias original/draft bytes or add history for unchanged selections", () => {
  const doc = setup();
  const baseline = doc.getOriginalPixels();
  baseline.fill(0);
  expect(doc.getOriginalPixels()[0]).toBe(90);
  doc.applyComposition(doc.getPixels());
  expect(doc.canUndo).toBe(false);
  const draft = doc.getPixels();
  draft[0] = 100;
  doc.applyComposition(draft);
  draft[0] = 0;
  expect(doc.getPixels()[0]).toBe(100);
  doc.undo();
  doc.applyComposition(new Uint8ClampedArray(draft).fill(80));
  expect(doc.canRedo).toBe(false);
});
it("validates dimensions before changing the document", () => {
  const doc = setup();
  expect(() => doc.applyComposition(new Uint8ClampedArray(4))).toThrow();
  expect(doc.canUndo).toBe(false);
  expect(doc.getPixels()).toEqual(doc.getOriginalPixels());
});
