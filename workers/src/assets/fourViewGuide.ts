/**
 * Composition guide for the four-view character-sheet generation strategy.
 * The four figures lock left-to-right order and relative scale while leaving
 * all identity, hair, clothing and pixel-art decisions to the image model.
 */

import { encodePng, type RawImage } from "../png";

const WIDTH = 448;
const HEIGHT = 224;

type View = "front" | "back" | "left" | "right";

function fill(
  image: RawImage,
  x0: number,
  y0: number,
  width: number,
  height: number,
  color: [number, number, number],
): void {
  for (let y = y0; y < y0 + height; y++) {
    for (let x = x0; x < x0 + width; x++) {
      const offset = (y * image.width + x) * 4;
      image.rgba.set([...color, 255], offset);
    }
  }
}

function drawFigure(image: RawImage, centerX: number, view: View): void {
  const outline: [number, number, number] = [45, 48, 56];
  const skin: [number, number, number] = [218, 178, 150];
  const hair: [number, number, number] = [58, 48, 45];
  const top: [number, number, number] = [78, 125, 177];
  const pants: [number, number, number] = [48, 58, 84];
  const profile = view === "left" || view === "right";
  const headWidth = profile ? 32 : 44;
  const torsoWidth = profile ? 34 : 60;
  const headX = centerX - Math.floor(headWidth / 2);
  const torsoX = centerX - Math.floor(torsoWidth / 2);

  fill(image, headX - 3, 16, headWidth + 6, 66, outline);
  fill(image, headX, 19, headWidth, 60, view === "back" ? hair : skin);
  fill(image, torsoX - 3, 86, torsoWidth + 6, 62, outline);
  fill(image, torsoX, 89, torsoWidth, 56, top);
  fill(image, centerX - 25, 152, 50, 58, outline);
  fill(image, centerX - 22, 152, 20, 55, pants);
  fill(image, centerX + 2, 152, 20, 55, pants);

  if (!profile) {
    fill(image, torsoX - 14, 89, 11, 56, top);
    fill(image, torsoX + torsoWidth + 3, 89, 11, 56, top);
  }
  if (view === "front") {
    fill(image, headX, 19, headWidth, 18, hair);
    fill(image, centerX - 10, 53, 5, 5, [52, 43, 37]);
    fill(image, centerX + 5, 53, 5, 5, [52, 43, 37]);
  } else if (view === "back") {
    fill(image, headX, 19, headWidth, 60, hair);
  } else {
    const faceX = view === "left" ? headX : headX + headWidth - 8;
    fill(image, faceX, 43, 8, 20, skin);
    const eyeX = view === "left" ? faceX + 1 : faceX + 4;
    fill(image, eyeX, 51, 3, 4, [52, 43, 37]);
  }
}

export async function buildFourViewGuidePng(): Promise<Uint8Array> {
  const image: RawImage = {
    width: WIDTH,
    height: HEIGHT,
    rgba: new Uint8Array(WIDTH * HEIGHT * 4),
  };
  fill(image, 0, 0, WIDTH, HEIGHT, [238, 239, 242]);
  drawFigure(image, 56, "front");
  drawFigure(image, 168, "back");
  drawFigure(image, 280, "left");
  drawFigure(image, 392, "right");
  return encodePng(image);
}
