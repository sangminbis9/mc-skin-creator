/**
 * FLUX front_view용 구조 가이드.
 *
 * 텍스트만으로 두 인물의 크기·간격·정면/뒷면 방향을 동시에 고정하기 어렵기 때문에
 * 단순한 블록 실루엣을 두 번째 입력 이미지로 제공한다. 캐릭터 색/정체성 참고가
 * 아니라 레이아웃 참고이며, 요청마다 외부 저장소를 읽지 않도록 코드로 생성한다.
 */

import { encodePng, type RawImage } from "../png";

const WIDTH = 256;
const HEIGHT = 128;

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
      const d = (y * image.width + x) * 4;
      image.rgba[d] = color[0];
      image.rgba[d + 1] = color[1];
      image.rgba[d + 2] = color[2];
      image.rgba[d + 3] = 255;
    }
  }
}

function drawFigure(image: RawImage, centerX: number, back: boolean): void {
  const outline: [number, number, number] = [45, 48, 56];
  const head: [number, number, number] = back ? [87, 94, 112] : [218, 178, 150];
  const top: [number, number, number] = back ? [66, 99, 142] : [78, 125, 177];
  const pants: [number, number, number] = [48, 58, 84];

  fill(image, centerX - 22, 8, 44, 38, outline);
  fill(image, centerX - 19, 11, 38, 32, head);
  fill(image, centerX - 30, 48, 60, 38, outline);
  fill(image, centerX - 17, 51, 34, 32, top);
  fill(image, centerX - 27, 51, 9, 32, top);
  fill(image, centerX + 18, 51, 9, 32, top);
  fill(image, centerX - 18, 88, 36, 34, outline);
  fill(image, centerX - 15, 88, 14, 31, pants);
  fill(image, centerX + 1, 88, 14, 31, pants);

  if (back) {
    fill(image, centerX - 19, 11, 38, 13, [38, 35, 38]);
  } else {
    fill(image, centerX - 19, 11, 38, 10, [38, 35, 38]);
    fill(image, centerX - 10, 28, 4, 4, [52, 43, 37]);
    fill(image, centerX + 6, 28, 4, 4, [52, 43, 37]);
  }
}

export async function buildFrontBackGuidePng(): Promise<Uint8Array> {
  const image: RawImage = {
    width: WIDTH,
    height: HEIGHT,
    rgba: new Uint8Array(WIDTH * HEIGHT * 4),
  };
  fill(image, 0, 0, WIDTH, HEIGHT, [238, 239, 242]);
  drawFigure(image, 68, false);
  drawFigure(image, 188, true);
  return encodePng(image);
}

