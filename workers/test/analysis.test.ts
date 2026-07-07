import { describe, expect, it } from "vitest";
import { validatePhotoAnalysis } from "../src/analysis";
import { makeAnalysis } from "./helpers";

describe("validatePhotoAnalysis", () => {
  it("유효한 분석은 통과한다", () => {
    const result = validatePhotoAnalysis(makeAnalysis());
    expect(result.ok).toBe(true);
  });

  it("얼굴만 보이는 사진(framing=face)도 품질 실패로 처리되지 않는다", () => {
    const result = validatePhotoAnalysis(
      makeAnalysis({
        framing: "face",
        visibleRegions: {
          face: true,
          hair: true,
          upperBody: false,
          lowerBody: false,
          feet: false,
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.analysis.quality).toBe("pass");
      expect(result.analysis.framing).toBe("face");
    }
  });

  it("quality=fail이면 나머지 필드가 없어도 실패 사유와 함께 통과한다", () => {
    const result = validatePhotoAnalysis({
      quality: "fail",
      failReason: "no_face",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.analysis.quality).toBe("fail");
      expect(result.analysis.failReason).toBe("no_face");
    }
  });

  it("허용되지 않은 framing은 명시적 오류로 반환한다 (조용한 기본값 대체 없음)", () => {
    const result = validatePhotoAnalysis(makeAnalysis({ framing: "selfie" as never }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toContain("framing");
    }
  });

  it("identityPrompt가 비어 있으면 오류다", () => {
    const result = validatePhotoAnalysis(makeAnalysis({ identityPrompt: "" }));
    expect(result.ok).toBe(false);
  });

  it("inferred 항목의 구조가 틀리면 오류를 수집한다", () => {
    const broken = makeAnalysis();
    (broken.inferred as Record<string, unknown>).hairBack = "short";
    const result = validatePhotoAnalysis(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toContain("hairBack");
    }
  });

  it("저해상도 렌더 힌트의 허용값을 검증한다", () => {
    const broken = makeAnalysis();
    broken.renderHints.bangs = "generic" as never;
    broken.renderHints.bangsLength = "forehead" as never;
    broken.renderHints.hairSilhouette = "generic" as never;
    const result = validatePhotoAnalysis(broken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toContain("renderHints.bangs");
      expect(result.errors.join()).toContain("renderHints.bangsLength");
      expect(result.errors.join()).toContain("renderHints.hairSilhouette");
    }
  });

  it("객체가 아닌 응답은 즉시 실패한다", () => {
    expect(validatePhotoAnalysis("json이 아님").ok).toBe(false);
    expect(validatePhotoAnalysis(null).ok).toBe(false);
    expect(validatePhotoAnalysis([1, 2]).ok).toBe(false);
  });
});
