import { expect, it } from "vitest";
import { normalizeAnalysisForRendering } from "../src/generate";
import { makeAnalysis } from "./helpers";

function part(hair: string) {
  const a = makeAnalysis();
  a.observed.hair = hair; a.identityPrompt = "";
  a.inferred.hairBack = { value: "", rationale: "" };
  a.renderHints.hairPart = "center";
  return normalizeAnalysisForRendering(a).renderHints.hairPart;
}

it.each([
  "hair is parted near the center; viewer-left side has a small purple bow",
  "hair is parted near the center; viewer-right side has a small purple bow",
  "part near center, viewer-left ribbon",
  "viewer-right bow; hair is parted near the center",
  "hair is parted near center with a bow on viewer-left",
  "hair is parted near center with a bow on viewer-right",
  "parted hair with viewer-left flower",
  "viewer-left flower in parted hair",
])("does not borrow an accessory side as a part position: %s", hair => {
  expect(part(hair)).toBe("center");
});

it.each([
  ["viewer-left part", "left"],
  ["viewer-right parting", "right"],
  ["hair parted on the viewer's left", "left"],
  ["hair part is on viewer-right", "right"],
  ["hair parted slightly to the viewer-left", "left"],
  ["parting at viewer-right", "right"],
  ["hair part on viewer-left; bow on viewer-right", "left"],
])("keeps directly attached root-part directions: %s", (hair, expected) => {
  expect(part(hair)).toBe(expected);
});

it("retains A001's actual structured center part without changing its observation", () => {
  const a = makeAnalysis(); a.identityPrompt = "";
  const hair = "long, dark brown, wavy hair with thick bangs that have a center-ish opening and long face-framing locks extending to the jawline; hair is parted near the center; viewer-left side has a small purple bow; hair ends reach the chest level.";
  a.observed.hair = hair; a.renderHints.hairPart = "center";
  const normalized = normalizeAnalysisForRendering(a);
  expect(normalized.renderHints.hairPart).toBe("center");
  expect(normalized.observed.hair).toBe(hair);
});
