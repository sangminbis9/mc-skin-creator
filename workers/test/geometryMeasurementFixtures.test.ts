import { describe, expect, it } from "vitest";
import { parseIdentityGeometry } from "../src/identityGeometry";
import { buildIdentityPixelPlans } from "../src/identityPlans";
import { makeAnalysis, makeIdentityGeometry } from "./helpers";

function measured(overrides: Parameters<typeof makeIdentityGeometry>[0] = {}) {
  return parseIdentityGeometry(makeIdentityGeometry(overrides))!;
}

describe("offline source-specific geometry fixtures", () => {
  it("A: short side-swept keeps two major peaks, sweep, and asymmetric temples", () => {
    const base = makeIdentityGeometry();
    const geometry = measured({
      fringe: {
        ...base.fringe,
        peaks: [
          { x: 0.22, depthY: 0.72, prominence: 0.46 },
          { x: 0.78, depthY: 0.68, prominence: 0.31 },
        ],
        direction: "right_swept",
      },
      temple: { ...base.temple, leftRecession: 0.18, rightRecession: 0.72, asymmetry: -0.54 },
    });
    const plan = buildIdentityPixelPlans(makeAnalysis({ identityGeometry: geometry }));
    expect(plan.facePixelPlan.layout.fringePeaks).toHaveLength(2);
    expect(plan.facePixelPlan.layout.fringeDirection).toBe("right_swept");
    expect(plan.facePixelPlan.layout.templeGeometry.leftRecession).not.toBe(plan.facePixelPlan.layout.templeGeometry.rightRecession);
    expect(plan.hairPlan.structure.fringe.tipPoints).toHaveLength(2);
  });

  it("B: symmetric short does not invent measured asymmetry", () => {
    const base = makeIdentityGeometry();
    const symmetricContour = [0.24, 0.16, 0.13, 0.12, 0.13, 0.16, 0.2, 0.28] as typeof base.headSilhouette.leftContourByRow;
    const geometry = measured({
      temple: { ...base.temple, leftRecession: 0.32, rightRecession: 0.32, leftStartY: 0.36, rightStartY: 0.36, asymmetry: 0 },
      crown: { ...base.crown, leftY: 0.08, centerY: 0.04, rightY: 0.08, leftWidth: 0.56, rightWidth: 0.56, apexX: 0.5, asymmetry: 0 },
      headSilhouette: {
        ...base.headSilhouette,
        leftContourByRow: symmetricContour,
        rightContourByRow: symmetricContour.map((value) => 1 - value) as typeof base.headSilhouette.rightContourByRow,
        sideVolumeLeft: 0.52,
        sideVolumeRight: 0.52,
        hairEndpointLeftY: 0.62,
        hairEndpointRightY: 0.62,
      },
    });
    const analysis = makeAnalysis({
      identityGeometry: geometry,
      renderHints: { ...makeAnalysis().renderHints, sideHairAsymmetry: "left" },
    });
    const layout = buildIdentityPixelPlans(analysis).facePixelPlan.layout;
    expect(layout.templeGeometry.leftRecession).toBe(layout.templeGeometry.rightRecession);
    expect(layout.crownGeometry.leftRow).toBe(layout.crownGeometry.rightRow);
    expect(layout.crownGeometry.leftWidth).toBe(layout.crownGeometry.rightWidth);
  });

  it("C: asymmetric curly produces different measured left/right volume pixels", () => {
    const base = makeIdentityGeometry();
    const geometry = measured({
      headSilhouette: { ...base.headSilhouette, sideVolumeLeft: 0.92, sideVolumeRight: 0.48, hairEndpointLeftY: 0.9, hairEndpointRightY: 0.72 },
      majorVolumePeaks: [
        { region: "crown_left", protrusion: 0.9, verticalCenter: 0.16, verticalExtent: 0.24, evidence: "observed", confidence: 0.9 },
        { region: "side_left", protrusion: 0.92, verticalCenter: 0.48, verticalExtent: 0.5, evidence: "observed", confidence: 0.92 },
        { region: "lower_left", protrusion: 0.88, verticalCenter: 0.78, verticalExtent: 0.3, evidence: "observed", confidence: 0.88 },
        { region: "side_right", protrusion: 0.46, verticalCenter: 0.43, verticalExtent: 0.32, evidence: "observed", confidence: 0.86 },
      ],
    });
    const baseAnalysis = makeAnalysis();
    const plans = buildIdentityPixelPlans(makeAnalysis({
      identityGeometry: geometry,
      renderHints: { ...baseAnalysis.renderHints, hairTexture: "curly", hairVolume: "full", overallHairLength: "jaw", sideHairLength: "jaw" },
    }));
    const lobes = plans.hairPlan.structure.groups.filter((group) => group.kind === "curl_lobe");
    expect(lobes.map((group) => group.id)).toEqual(expect.arrayContaining(["curl-lobe-side-left", "curl-lobe-lower-left", "curl-lobe-side-right"]));
    expect(plans.hairPlan.headMask.widthByRow.left).not.toEqual(plans.hairPlan.headMask.widthByRow.right);
    expect(plans.headIdentityPlan.geometryProvenance.majorVolumePeaks).toBe("observed_geometry");
  });

  it("D: source-clipped crown cannot remain high-confidence observed", () => {
    const base = makeIdentityGeometry();
    const geometry = measured({ visibility: { ...base.visibility, sourceCrownClipped: true } });
    expect(geometry.crown.centerEvidence).not.toBe("observed");
    expect(geometry.crown.centerConfidence).toBeLessThanOrEqual(0.45);
    expect(geometry.diagnostics.completeness.crownObservedFraction).toBe(0);
  });

  it("E: headscarf contour remains covering rather than hair crown", () => {
    const base = makeIdentityGeometry();
    const geometry = measured({
      headSilhouette: { ...base.headSilhouette, covering: { leftContourByRow: base.headSilhouette.leftContourByRow, rightContourByRow: base.headSilhouette.rightContourByRow } },
    });
    const plans = buildIdentityPixelPlans(makeAnalysis({ identityGeometry: geometry }));
    expect(plans.hairPlan.headMask.faces.top.some((point) => point.role === "covering")).toBe(true);
    expect(plans.facePixelPlan.layout.geometryProvenance["crown.center"]).toBe("semantic_fallback");
  });

  it("F: one-side occlusion preserves the visible side and falls back only for the hidden side", () => {
    const base = makeIdentityGeometry();
    const geometry = measured({ visibility: { ...base.visibility, rightHairOccluded: true, rightEarOccluded: true } });
    const layout = buildIdentityPixelPlans(makeAnalysis({ identityGeometry: geometry })).facePixelPlan.layout;
    expect(layout.geometryProvenance["temple.left"]).toBe("observed_geometry");
    expect(layout.geometryProvenance["temple.right"]).toBe("semantic_fallback");
    expect(layout.geometryProvenance["faceWindow.left"]).toBe("observed_geometry");
    expect(layout.geometryProvenance["faceWindow.right"]).toBe("semantic_fallback");
  });
});
