import { describe, expect, it } from "vitest";
import { buildFrontBackGuidePng } from "../src/assets/frontBackGuide";
import { decodePng } from "../src/png";

describe("front/back structure guide", () => {
  it("두 개의 분리된 블록 실루엣을 담은 256x128 PNG를 만든다", async () => {
    const decoded = await decodePng(await buildFrontBackGuidePng());
    expect(decoded.width).toBe(256);
    expect(decoded.height).toBe(128);

    const background = decoded.rgba[0];
    let leftInk = 0;
    let gapInk = 0;
    let rightInk = 0;
    for (let y = 0; y < decoded.height; y++) {
      for (let x = 0; x < decoded.width; x++) {
        const d = (y * decoded.width + x) * 4;
        const ink = Math.abs(decoded.rgba[d] - background) > 20;
        if (!ink) continue;
        if (x < 118) leftInk++;
        else if (x < 138) gapInk++;
        else rightInk++;
      }
    }
    expect(leftInk).toBeGreaterThan(1_000);
    expect(rightInk).toBeGreaterThan(1_000);
    expect(gapInk).toBe(0);
  });
});

