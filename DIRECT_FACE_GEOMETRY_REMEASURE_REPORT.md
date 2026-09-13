# Corrected direct lower-face geometry remeasurement

Date: 2026-09-13 (Asia/Seoul)

## 1. Start state

- HEAD: `f3c0732388c78bfe5796ba9b94c1c9dc7e897a3e`
- Branch: `main` tracking `origin/main`
- Working tree: existing direct-face implementation was dirty/untracked and was preserved.
- Commit/push/deploy: none.
- Production flag: absent/off; activation remained false.

## 2. `jaw <= cheek` hard-rule audit

The old parser rejected every lower row wider than its upper neighbor. That is not a physical invariant: cheek, jaw, and chin are independent slices at different Y rows, and a square/broad jaw can be equal to or slightly wider than the cheek slice. The old rule also rejected the first live long-hair result for a 0.01 width difference.

Hard rejection remains for non-finite/out-of-range coordinates, `left >= right`, boundaries outside the provider's visible-face box, non-increasing row order, and the unchanged `unknown => null/null/null + confidence 0` contract.

## 3. Bounded semantic plausibility rule

Cross-row expansion is now checked in normalized face space. For adjacent upper/lower rows:

`outward displacement per side = (lowerWidth - upperWidth) / (2 * visibleFaceWidth)`

must not exceed:

`normalized row displacement = (lowerY - upperY) / visibleFaceHeight`.

This is a 1:1 contour-slope envelope derived from the measured rows and visible face bounds. It permits equal/slightly wider lower rows, rejects an extreme outward discontinuity, and never clamps or repairs provider values.

## 4. Corrected prompt hash

- Previous coordinate-only corrected hash: `5b0c119bc58f5d85649fb2502eb402775cc4cce11ae2cb66dac1f7a93aba535f`
- Live-tested current hash: `980d8b2121ec2d2b8263c7cd43f3f89477c384ccdc38f0ae52e6469904d948a9`
- Schema hash unchanged: `a39f13800df56ddaec1ce2ab44b671b6851773633626ba465ba17fade564a0dc`

The current prompt adds only the explicit unknown/null/zero instruction and the non-monotonic-row clarification required by the audited validator.

## 5. Image-coordinate contract

- Base prompt: Image 0 = tight face; Image 1 = wide head.
- Direct-lower-face extension: no numbered-image sentence.
- Lower face: existing tight-face coordinate space only.
- Conflicting image-number statements: 0.

One selected public fixture later exposed an evidence-fixture limitation: its face/head files had the same SHA-256. This is now included as a separate crop-role audit in the diagnostic gate and prevents a future smoke from passing on identical role inputs.

## 6. Selected sources and measurability

Selection was not branched on fixture ID. It first required visible face, non-clipped known chin, no lower-face hand/object/glasses/covering evidence, frontal or slight-turn pose, both visible sides, chin-containing crop, and a minimum 256px short edge. It then maximized stored face-aspect diversity.

| Source | Pose | Face crop | Aspect | Face/head role hashes |
| --- | --- | ---: | ---: | --- |
| short-hair-red-shirt | slight turn | 512×416 | 1.231 | distinct |
| long-straight-hair | slight turn | 313×329 | 0.951 | distinct |
| wavy-open-blazer | frontal | 486×635 | 0.765 | identical (fixture limitation) |

## 7. Live direct measurements

All values below are the provider's structured numeric fields; no value was repaired, clamped, or synthesized.

| Source | Cheek `(L,R,Y,W,evidence,confidence)` | Jaw `(L,R,Y,W,evidence,confidence)` | Chin `(L,R,Y,W,evidence,confidence)` |
| --- | --- | --- | --- |
| short | `(0.28,0.82,0.62,0.54,observed,0.90)` | `(0.32,0.78,0.78,0.46,observed,0.85)` | `(0.41,0.65,0.95,0.24,observed,0.70)` |
| long | `(0.25,0.75,0.55,0.50,observed,0.85)` | `(0.22,0.78,0.65,0.56,observed,0.75)` | `(0.40,0.60,0.75,0.20,observed,0.70)` |
| wavy | `(0.36,0.64,0.45,0.28,observed,0.90)` | `(0.38,0.62,0.46,0.24,observed,0.80)` | `(0.45,0.55,0.48,0.10,observed,0.85)` |

## 8. Provider-contract result

- Native Gemma calls: exactly 3.
- Structured object/provider schema shape: 3/3.
- Gemini calls: 0.
- Retry/fallback/evaluator: 0.
- Full enrichment accepted: 1/3.

## 9. Semantic validation

| Source | Result | Exact first boundary |
| --- | --- | --- |
| short | rejected | `geometry.directLowerFaceContour.cheek.boundary:outside_visible_face` |
| long | rejected after direct contour parsing | `geometry:semantic_validation` in the remaining full geometry contract |
| wavy | accepted | none |

For rejected responses the diagnostic intentionally retained only the direct contour, not the rest of the raw provider response. Consequently the provider's failed full `face.visibleLeft/right` values and visible-face width are unavailable and were not guessed. Accepted wavy visible-face width was `0.36`.

## 10. Jaw/cheek ratios

- short: `0.8519`
- long: `1.1200`
- wavy: `0.8571`

The new plausibility rule did not reject long merely because its jaw was wider; its direct contour passed that local check and the later full-geometry semantic chain failed. Only the wavy ratio reached production quantization.

## 11. Chin/jaw ratios

- short: `0.5217`
- long: `0.3571`
- wavy: `0.4167`

## 12. Direct versus legacy 0.88

The raw provider ratios did not all converge to `0.88`, but only one case reached a usable plan. The accepted wavy plan compared:

- legacy quantized cheek/jaw: `4 / 4`, derived ratio source `0.88`
- direct quantized cheek/jaw/chin: `2 / 2 / 2`

Raw diversity alone therefore did not meet the quality gate.

## 13. Provenance

All three raw contour groups declared observed evidence. Only wavy completed rich normalization and recorded:

- `directLowerFaceContour.cheek = observed_geometry`
- `directLowerFaceContour.jaw = observed_geometry`
- `directLowerFaceContour.chin = observed_geometry`

No semantic face-shape value was converted into a direct width.

## 14. Quantized lower-face topology

Only wavy reached `FaceLayoutPlan`/`FacePixelPlan`:

- face-boundary budget: 6
- direct layout widths: cheek 2, jaw 2, chin 2
- final direct contour cells: two `chin_contour` cells at `(2,7)` and `(5,7)`
- legacy comparison cells: two cheek plus two jaw contour cells

Cheek/jaw direct cells were omitted by existing protected ownership/collision logic, not added by force.

## 15. Distinct topology count

- Accepted topology cases: 1
- Distinct topology hashes: 1
- Required minimum: 2
- Result: FAIL

## 16. Latency

- short: 24,455ms
- long: 16,704ms
- wavy: 22,020ms

All returned within the unchanged 25s cap. One response was within 545ms of the deadline. The specified “2 valid calls >=23s” alert was not triggered because only one call was fully valid and it took 22,020ms; nevertheless the short call shows material tail-latency risk.

## 17. Fail-open regression

Focused mocks cover valid geometry, provider failure, malformed schema, and timeout. All return HTTP 200, a decodable 64×64 PNG, and a valid final atlas; failure modes retain the original primary identityGeometry state. Focused suite: 20 passed, 2 live/smoke tests skipped when opt-in flags are absent.

## 18. Generation smoke

Not executed. Automatic gate was 1/3 full contract valid, 1 usable cheek+jaw, 1 usable chin, and 1 distinct topology. The source-role audit also found one identical face/head fixture pair. The task explicitly prohibited smoke unless the 3-case quality gate passed.

## 19. Smoke provider sequence

Not attempted. Gemini 0, primary Gemma fallback 0, geometry Gemma 0 for smoke.

## 20. HTTP / PNG / final atlas

Not attempted because the smoke gate failed. There is no smoke HTTP or PNG claim.

## 21. Existing topology and regression results

- Eye/brow/mouth/nose/hair signatures for the accepted direct-vs-legacy case: all equal.
- Strict boundary: 12/12; fabrication 0.
- Craft: 12/12.
- Calibrated five atlas diffs: 0.
- Workers TypeScript: PASS.
- ESLint: PASS.
- `git diff --check`: PASS (line-ending warnings only).
- Secret scan: 0 matches across six task-sensitive files.
- Wrangler 4.120.0 dry-run: PASS; no deploy.
- Full Workers suite: 792 passed, 62 skipped; one existing 5s `skinRender` performance timeout under the full parallel load. The same file passed 6/6 in 3.34s when rerun alone.
- Frontend `ait build`: blocked by existing `apps-in-toss.config` missing `appName`.
- Frontend app TypeScript: existing out-of-scope `granite.config.ts(6,5)` `displayName` type error; relevant config files have no diff.

## 22. Production activation

Not eligible. The provider produced varied raw ratios, but only one case survived the full contract and only one distinct Minecraft lower-face topology was demonstrated. Production config and the opt-in flag remain unchanged/off.

BLOCKED: corrected direct geometry가 3개 source 중 1개만 full semantic chain과 quantization을 통과해 2개 이상의 source-specific lower-face topology를 입증하지 못함
