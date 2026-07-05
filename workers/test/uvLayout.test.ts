import { describe, expect, it } from "vitest";
import {
  ALL_PARTS,
  ATLAS_SIZE,
  CLASSIC_LAYOUT,
  buildZoneMap,
} from "../src/uvLayout";
import { CLASSIC_LAYOUT as CLIENT_LAYOUT } from "../../src/lib/skinAtlas";

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
});
