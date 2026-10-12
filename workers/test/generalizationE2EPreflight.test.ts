// Offline-only approval and source-identity checks. Never imports the remote runner.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { decode as decodeJpeg } from "jpeg-js";
import { decodePng } from "../src/png";
import { expect, it } from "vitest";
import { E2E_EXPECTED_WIDTHS } from "./audit/currentDefaultE2E";

type ApprovedCase = { caseId: string; photoId: string; sourcePath?: string; sourceMime?: "image/png" | "image/jpeg"; sourceBytes: number; sourceSha256: string;
  sourceWidth: number; sourceHeight: number; analysisWidth: number; generationWidth: number; artifactRoot: string };
const approved = JSON.parse(fs.readFileSync("test/audit/approvedGeneralizationE2E.json", "utf8")) as Record<string, ApprovedCase>;
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

it("pins separately approved real sources and fresh single-use E2E roots without starting a remote runner", async () => {
  expect(Object.keys(approved)).toEqual([
    "approved-detail-real-app-formal-suit-001-20261012-001",
    "approved-detail-reference-gray-hoodie-001-20261012-002",
    "approved-detail-reference-pastel-cardigan-001-20261012-003",
    "approved-detail-reference-floral-001-20261012-004",
    "approved-detail-reference-braided-ribbon-001-20261012-005",
    "approved-detail-reference-short-black-sweatshirt-001-20261012-006",
    "approved-detail-reference-teal-hat-hoodie-001-20261012-007",
    "approved-detail-reference-pastel-patch-001-20261012-008",
    "approved-detail-reference-neck-scarf-001-20261012-009",
    "approved-detail-real-app-formal-suit-001-20261012-010",
    "approved-detail-reference-gray-hoodie-001-20261012-011",
    "approved-detail-reference-pastel-cardigan-001-20261012-012",
    "approved-detail-reference-floral-001-20261012-013",
    "approved-detail-reference-braided-ribbon-001-20261012-014",
    "approved-detail-reference-short-black-sweatshirt-001-20261012-015",
    "approved-detail-reference-teal-hat-hoodie-001-20261012-016",
    "approved-detail-reference-pastel-patch-001-20261012-017",
    "approved-detail-reference-short-black-sweatshirt-001-20261012-018",
    "approved-detail-real-app-formal-suit-001-20261012-019",
    "approved-detail-reference-teal-hat-hoodie-001-20261012-020",
    "approved-reference-gray-hoodie-001-20261011-016",
    "approved-reference-gray-hoodie-001-20261011-015",
    "approved-reference-gray-hoodie-001-20261011-014",
    "approved-reference-gray-hoodie-001-20261011-013",
    "approved-reference-gray-hoodie-001-20261011-012",
    "approved-reference-pastel-cardigan-001-20261011-004",
    "approved-reference-pastel-cardigan-001-20261011-003",
    "approved-reference-pastel-cardigan-001-20261011-002",
    "approved-reference-pastel-patch-001-20261011-003",
    "approved-reference-pastel-patch-001-20261011-002",
    "approved-reference-pastel-patch-001-20261011-001",
    "approved-reference-gray-hoodie-001-20261011-011",
    "approved-reference-gray-hoodie-001-20261011-010",
    "approved-reference-gray-hoodie-001-20261011-009",
    "approved-reference-gray-hoodie-001-20261011-008",
    "approved-reference-gray-hoodie-001-20261011-007",
    "approved-reference-gray-hoodie-001-20261011-006",
    "approved-reference-gray-hoodie-001-20261011-005",
    "approved-reference-gray-hoodie-001-20261011-004",
    "approved-reference-gray-hoodie-001-20261011-003",
    "approved-reference-gray-hoodie-001-20261011-002",
    "approved-reference-teal-hat-hoodie-001-20261011-021",
    "approved-reference-teal-hat-hoodie-001-20261011-020",
    "approved-reference-teal-hat-hoodie-001-20261011-019",
    "approved-reference-teal-hat-hoodie-001-20261011-018",
    "approved-reference-teal-hat-hoodie-001-20261011-017",
    "approved-reference-teal-hat-hoodie-001-20261011-016",
    "approved-reference-teal-hat-hoodie-001-20261011-015",
    "approved-reference-teal-hat-hoodie-001-20261011-014",
    "approved-reference-teal-hat-hoodie-001-20261011-013",
    "approved-reference-teal-hat-hoodie-001-20261011-012",
    "approved-reference-teal-hat-hoodie-001-20261011-011",
    "approved-reference-teal-hat-hoodie-001-20261010-010",
    "approved-reference-teal-hat-hoodie-001-20261010-009",
    "approved-reference-teal-hat-hoodie-001-20261010-008",
    "approved-reference-teal-hat-hoodie-001-20261010-007",
    "approved-reference-teal-hat-hoodie-001-20261010-006",
    "approved-reference-teal-hat-hoodie-001-20261010-005",
    "approved-reference-teal-hat-hoodie-001-20261010-004",
    "approved-reference-teal-hat-hoodie-001-20261010-003",
    "approved-reference-teal-hat-hoodie-001-20261010-002",
    "approved-reference-teal-hat-hoodie-001-20261010-001",
    "approved-reference-gray-hoodie-001-20261010-001",
    "approved-reference-short-black-sweatshirt-001-20261010-003",
    "approved-reference-short-black-sweatshirt-001-20261010-002",
    "approved-reference-short-black-sweatshirt-001-20261010-001",
    "approved-reference-neck-scarf-001-20261010-004",
    "approved-reference-neck-scarf-001-20261010-003",
    "approved-reference-neck-scarf-001-20261010-002",
    "approved-reference-neck-scarf-001-20261010-001",
    "approved-reference-braided-ribbon-001-20261010-008",
    "approved-reference-braided-ribbon-001-20261010-007",
    "approved-reference-braided-ribbon-001-20261010-006",
    "approved-reference-pastel-cardigan-001-20261010-001",
    "approved-reference-braided-ribbon-001-20261010-005",
    "approved-reference-braided-ribbon-001-20261010-004",
    "approved-reference-braided-ribbon-001-20261010-003",
    "approved-reference-braided-ribbon-001-20261010-002",
    "approved-reference-braided-ribbon-001-20261010-001",
    "approved-reference-floral-001-20261008-005",
    "approved-reference-floral-001-20261008-004",
    "approved-reference-floral-001-20261008-003",
    "approved-reference-floral-001-20261008-002",
    "approved-reference-floral-001-20261008-001",
    "approved-generalization-full-body-layered-20261008-002",
    "approved-real-app-formal-suit-001-20261008-010",
    "approved-real-app-formal-suit-001-20261008-009",
    "approved-real-app-formal-suit-001-20261008-008",
    "approved-real-app-formal-suit-001-20261008-007",
    "approved-real-app-formal-suit-001-20261008-006",
    "approved-real-app-formal-suit-001-20261008-005",
    "approved-real-app-formal-suit-001-20261007-004",
    "approved-real-app-formal-suit-001-20261007-003",
    "approved-real-app-formal-suit-001-20261007-002",
    "approved-real-app-formal-suit-001-20261006-001",
    "approved-generalization-wavy-open-blazer-20260928-001",
    "approved-generalization-full-body-layered-20260928-001",
    "approved-generalization-striped-open-shirt-20260928-001",
  ]);
  const roots = new Set<string>();
  const sourceIdentities = new Map<string, Omit<ApprovedCase, "artifactRoot">>();
  const decodedDimensions = new Map<string, { width: number; height: number }>();
  for (const [selector, sample] of Object.entries(approved)) {
    expect(selector).toContain(sample.caseId);
    const source = fs.readFileSync(sample.sourcePath ?? path.resolve(`evaluation-artifacts/generalization-20260905/sources/${sample.photoId}.jpg`));
    expect([source.length, sha(source)]).toEqual([sample.sourceBytes, sample.sourceSha256]);
    expect([...source.subarray(0, 3)]).toEqual(sample.sourceMime === "image/png" ? [0x89, 0x50, 0x4e] : [0xff, 0xd8, 0xff]);
    // Each selector still verifies its actual bytes and hash. Repeated fresh
    // run IDs for the exact same source need only one deterministic JPEG decode.
    let decoded = decodedDimensions.get(sample.sourceSha256);
    if (!decoded) {
      const image = sample.sourceMime === "image/png" ? await decodePng(source) : decodeJpeg(source, { useTArray: true, maxMemoryUsageInMB: 256 });
      decoded = { width: image.width, height: image.height };
      decodedDimensions.set(sample.sourceSha256, decoded);
    }
    expect([decoded.width, decoded.height]).toEqual([sample.sourceWidth, sample.sourceHeight]);
    expect(Math.round(sample.sourceWidth * Math.min(1, 896 / Math.max(decoded.width, decoded.height))))
      .toBe(sample.analysisWidth);
    expect(Math.round(sample.sourceWidth * Math.min(1, 448 / Math.max(decoded.width, decoded.height))))
      .toBe(sample.generationWidth);
    expect(E2E_EXPECTED_WIDTHS[sample.caseId]).toEqual([sample.analysisWidth, sample.generationWidth]);
    const root = path.resolve(sample.artifactRoot);
    expect(root).toContain(path.resolve("evaluation-artifacts") + path.sep);
    // A completed earlier source remains immutable. Only the selected next
    // execution must still have a fresh root; the live runner repeats this gate.
    if (process.env.RUN_CURRENT_DEFAULT_V3_E2E === selector)
      expect(fs.existsSync(root), `fresh root required: ${sample.caseId}`).toBe(false);
    expect(roots.has(root)).toBe(false); roots.add(root);
    // A separately approved fresh measurement may reuse an exact source, never
    // a consumed root. Its provenance and preprocessing dimensions must match.
    const { artifactRoot: _root, ...identity } = sample;
    void _root;
    const previous = sourceIdentities.get(sample.sourceSha256);
    if (previous) expect(identity).toEqual(previous);
    else sourceIdentities.set(sample.sourceSha256, identity);
  }
});
