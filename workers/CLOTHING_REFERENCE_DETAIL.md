# Reference cloth detail — 2026-10-14

## Reference evidence

Inspected user-supplied D/E/G skins plus the previously downloaded NameMC [pink outfit](https://ko.namemc.com/skin/215a16a5df1506c8) and [dark outfit](https://ko.namemc.com/skin/c807a1e71f2eaeb1). Each was expanded into torso, both arms and both legs, four vertical faces and base/outer/composite layers. Local hashes and panels: `evaluation-artifacts/reference-cloth-inspection-lMxrsO/`. No source image was modified or copied into production.

Observed design principles: short connected compression folds near sleeve ends, waist and hems; broad quiet cloth planes; small selective outer trim; source-specific graphics kept distinct from cloth shading. Not all reference pixels are folds: stripes, printed motifs, skin and accessories must not become generic texture.

## Implementation

- `referenceGarmentFinish.ts`: optional `articulated_cloth_v1` uses connected three-tone shoulder/hem clusters and bounded elbow/knee folds. Strength follows existing garment category; it does not claim to measure fabric. Dark cloth uses a bounded neutral reflection; pale cloth retains shadow headroom.
- Open jackets with only known center/opening panels may receive restrained folds in outside columns 1/6. Shirt panels, ties and center columns remain untouched. Other color blocks remain excluded.
- Pattern placement and part scopes protect printed cloth, including wrapped sleeve patterns and independent chest graphics. Short sleeves, crop boundaries, skirts, legwear, shoes and skin remain outside fold intervals.
- Entire clusters are rejected when any member collides with non-matching source material. Physical seams and all outer occupancy stay unchanged. Existing collar/cuff/hem/accessory construction runs afterward and retains priority.
- `referenceStyleTemplates.ts` enables a separate cloth policy, independent of the hair policy. Absent policy retains historical boolean behavior.
- `referenceStyleRenderer.ts` and `referenceOutfitRetention.ts` use the same versioned policy for rendering and independent expected-material reconstruction. Validation thresholds and ownership rules were not relaxed.
- `test/referenceClothDetail.test.ts`: offline palette, connectedness, collision, print/sleeve/opening boundary, unchanged head/seam/alpha and same-analysis replay checks, including corrupted-output rejection.

## Verification and limits

Final focused run: 110 tests passed across cloth detail, garment finish, outfit retention, gradient cloth and block/graphic composition. Optional reference inspection passed separately. Additional regression run: 149 passed, 1 failed (overlapping suites; do not sum these figures). TypeScript, targeted ESLint, Worker bundle and `git diff --check` passed.

Known pre-existing failure: `observedCroppedHem.test.ts:98` expects the current default renderer to reproduce an older H PNG byte-for-byte. It also fails with this turn's garment policy disabled (temporary offline module mock). The historical PNG/test was not overwritten, relaxed or skipped; the temporary isolation harness was removed after diagnosis. This turn does not claim the entire repository suite is green.

Latest authored same-analysis comparison: `evaluation-artifacts/reference-cloth-detail-6KbT9w/comparison.png`. Each row: before front/right/back, then after front/right/back. Rows: pastel knit, dark hoodie/jeans, formal suit, striped control. Changed pixels: 132 / 196 / 188 / 0; complete head pixels remain identical. These are synthetic rendering fixtures, not new live-photo results; aesthetic parity with hand-authored skins is not proven.

No AI/provider calls, paid API usage, new persistence, model/prompt changes, commit, push or deployment. UI/editor/download paths are unchanged. Fine embroidery, lace, exact logos and photo observation errors remain limited by the existing 64×64 representation and analysis accuracy.
