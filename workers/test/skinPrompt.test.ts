import { describe, expect, it } from "vitest";
import { buildFrontViewPrompt, buildSkinPrompt } from "../src/skinPrompt";
import { makeAnalysis } from "./helpers";

describe("buildSkinPrompt framing 정책", () => {
  it("face: 얼굴 보존 + 중성 캐주얼 전신 생성", () => {
    const prompt = buildSkinPrompt(
      makeAnalysis({ framing: "face" }),
      { hasStyleRef: true },
    );
    expect(prompt).toContain("only the face/head");
    expect(prompt).toContain("neutral casual full-body outfit");
  });

  it("upper_body: 보이는 상의 보존 + 하의/신발 생성", () => {
    const prompt = buildSkinPrompt(makeAnalysis({ framing: "upper_body" }), {
      hasStyleRef: true,
    });
    expect(prompt).toContain("preserve the visible top garment");
    expect(prompt).toContain("matching lower-body clothing and shoes");
  });

  it("full_body: 실제 의상 우선, 안 보이는 면만 추론", () => {
    const prompt = buildSkinPrompt(makeAnalysis({ framing: "full_body" }), {
      hasStyleRef: true,
    });
    expect(prompt).toContain("Preserve the actual outfit and shoes");
    expect(prompt).toContain("unseen side and back");
  });

  it("스타일 참고 유무에 따라 이미지 인덱스가 달라진다", () => {
    const withRef = buildSkinPrompt(makeAnalysis(), { hasStyleRef: true });
    expect(withRef).toContain("Image 0 shows what a finished skin atlas");
    expect(withRef).toContain("subject of Image 1");
    expect(withRef).toContain("Repaint Image 2");

    const withoutRef = buildSkinPrompt(makeAnalysis(), { hasStyleRef: false });
    expect(withoutRef).toContain("subject of Image 0");
    expect(withoutRef).toContain("Repaint Image 1");
    expect(withoutRef).not.toContain("Image 2");
  });

  it("front_view 프롬프트는 정면+뒷면 두 뷰를 요구하고 인물 특징을 담는다", () => {
    const prompt = buildFrontViewPrompt(makeAnalysis());
    expect(prompt).toContain("FRONT view");
    expect(prompt).toContain("BACK view");
    expect(prompt).toContain("image 1 strictly as the composition and pose guide");
    expect(prompt).toContain("silver glasses"); // identityPrompt 반영
    expect(prompt).toContain("knit garment texture");
    expect(prompt).toContain("side hair");
    expect(prompt).toContain("lower-body accent");
    expect(prompt).toContain("evidence-based completions");
    expect(prompt).toContain("more than two figures"); // 회피 목록
  });

  it("서로 다른 두 사람은 서로 다른 프롬프트를 얻는다 (프리셋 수렴 방지)", () => {
    const personA = makeAnalysis();
    const personB = makeAnalysis({
      identityPrompt:
        "A person with a long oval face, shoulder-length wavy auburn hair, green eyes and small gold hoop earrings.",
      outfitPrompt:
        "Olive green utility jacket over a black tee, black jeans, brown boots.",
      negativePrompt: "no glasses",
    });
    const promptA = buildSkinPrompt(personA, { hasStyleRef: true });
    const promptB = buildSkinPrompt(personB, { hasStyleRef: true });
    expect(promptA).not.toBe(promptB);
    expect(promptA).toContain("silver glasses");
    expect(promptB).toContain("auburn hair");
  });

  it("negativePrompt가 회피 목록에 합쳐진다", () => {
    const prompt = buildSkinPrompt(makeAnalysis(), { hasStyleRef: true });
    expect(prompt).toContain("no hat, no beard");
    expect(prompt).toContain("photorealism");
  });
});
