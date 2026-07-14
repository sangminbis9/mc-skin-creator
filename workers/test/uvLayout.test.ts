import { describe, expect, it } from "vitest";
import {
  ALL_PARTS,
  ATLAS_SIZE,
  CLASSIC_LAYOUT,
  buildZoneMap,
  getBoxUvSeams,
} from "../src/uvLayout";
import {
  CLASSIC_LAYOUT as CLIENT_LAYOUT,
  MINECRAFT_BOX_FACE_ORDER,
} from "../../src/lib/skinAtlas";

describe("uvLayout", () => {
  it("클라이언트 skinAtlas.ts와 좌표가 완전히 일치한다", () => {
    for (const part of ALL_PARTS) {
      expect(CLASSIC_LAYOUT[part].base).toEqual(CLIENT_LAYOUT[part].base);
      expect(CLASSIC_LAYOUT[part].overlay).toEqual(CLIENT_LAYOUT[part].overlay);
    }
  });

  it("zone map에서 base/overlay가 겹치지 않고 영역 밖이 존재한다", () => {
    const zones = buildZoneMap();
    expect(zones.length).toBe(ATLAS_SIZE * ATLAS_SIZE);
    const counts = { base: 0, overlay: 0, outside: 0 };
    for (const zone of zones) {
      counts[zone]++;
    }
    // 6개 부위 base 면적 합 = head 384 + body 352 + 팔다리 4 * 224 = 1632
    expect(counts.base).toBe(1632);
    expect(counts.overlay).toBe(1632);
    expect(counts.outside).toBe(ATLAS_SIZE * ATLAS_SIZE - 3264);
  });

  it("maps all 12 physical cuboid edges with the renderer orientation", () => {
    expect(MINECRAFT_BOX_FACE_ORDER).toEqual([
      "left",
      "right",
      "top",
      "bottom",
      "front",
      "back",
    ]);
    const box = CLASSIC_LAYOUT.head.overlay;
    const seams = getBoxUvSeams(box);

    expect(seams.vertical).toHaveLength(4);
    expect(seams.horizontal).toHaveLength(8);
    for (const seam of [...seams.vertical, ...seams.horizontal]) {
      expect(seam.primary).toHaveLength(seam.adjacent.length);
    }

    // Screen-left is the character's anatomical right in a front view.
    expect(seams.vertical[0].primary[0]).toEqual({
      x: box.front.x,
      y: box.front.y,
    });
    expect(seams.vertical[0].adjacent[0]).toEqual({
      x: box.right.x + box.right.w - 1,
      y: box.right.y,
    });

    // The front hairline meets the front-most row of the top face.
    expect(seams.horizontal[0].adjacent[0]).toEqual({
      x: box.top.x,
      y: box.top.y + box.top.h - 1,
    });
    // SkinModel mirrors the bottom face, so its front edge runs right-to-left.
    expect(seams.horizontal[4].adjacent[0]).toEqual({
      x: box.bottom.x + box.bottom.w - 1,
      y: box.bottom.y,
    });
  });
});
