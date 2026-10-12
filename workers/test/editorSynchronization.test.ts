import { afterEach, expect, it, vi } from "vitest";
import { SkinDocument } from "../../src/editor/editorState";
import { SkinModel } from "../../src/editor/SkinModel";
import { CLASSIC_LAYOUT } from "../../shared/skinLayout";
afterEach(() => vi.unstubAllGlobals());
function canvas() {
  const data = new Uint8ClampedArray(16384);
  const ctx = { fillStyle: "#000000", drawImage: (source: { data: Uint8ClampedArray }) => data.set(source.data),
    getImageData: (x=0,y=0,w=64,h=64) => {
      const pixels = new Uint8ClampedArray(w*h*4);
      for(let row=0;row<h;row++) pixels.set(data.subarray(((y+row)*64+x)*4,((y+row)*64+x+w)*4),row*w*4);
      return { data:pixels, width:w, height:h };
    },
    putImageData: (image: ImageData) => data.set(image.data),
    clearRect: (x:number,y:number) => data.fill(0,(y*64+x)*4,(y*64+x)*4+4),
    fillRect: (x:number,y:number) => {
      const color=ctx.fillStyle.startsWith("rgba(") ? ctx.fillStyle.slice(5,-1).split(",").map(Number)
        : [1,3,5].map(i=>parseInt(ctx.fillStyle.slice(i,i+2),16)).concat(1);
      data.set([color[0],color[1],color[2],Math.round(color[3]*255)],(y*64+x)*4);
    },
  };
  return { width:64, height:64, data, getContext: () => ctx };
}
it("shares 2D/3D paint, erase, undo and redo through one skin document", () => {
  vi.stubGlobal("document", { createElement: () => canvas() });
  const source=canvas(); source.data.fill(255);
  const doc = new SkinDocument(source as unknown as HTMLCanvasElement);
  const model = new SkinModel(doc.canvas);
  const notify=vi.fn(()=>model.refresh()), unsub=doc.subscribe(notify);
  const {x,y}=CLASSIC_LAYOUT.rightArm.base.front;
  try {
    doc.beginStroke(); doc.paint(x,y,"#12ab34","all"); doc.endStroke();
    expect(doc.pickColor(x,y)).toBe("#12ab34");
    expect(model.texture.image).toBe(doc.canvas); expect(notify).toHaveBeenCalled();
    doc.undo(); expect(doc.canRedo).toBe(true); doc.redo(); expect(doc.canUndo).toBe(true);
    doc.beginStroke(); doc.erase(x,y,"all"); doc.endStroke();
    expect(doc.pickColor(x,y)).toBe("#ffffff");
  } finally { unsub(); model.dispose(); }
});
