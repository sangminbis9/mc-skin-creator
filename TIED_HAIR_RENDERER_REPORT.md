# Tied-hair renderer iteration — 2026-09-06

## 1. Starting state

- HEAD: `20205de379b8a39e41b985e09ce3c4f9acd2dabf`
- Branch: `main`
- The pre-existing dirty working tree was retained. No commit, push, deploy, provider call, or evaluator call was made.
- Frozen baseline: `workers/evaluation-artifacts/tied-hair-renderer-20260906/before`

## 2. Readability bottleneck

The previous bun was a fixed 4×4 patch on both the top and back overlay faces. It had 32 connected outer cells, but no tied-owned front cell. At a level front camera the horizontal top face is occluded by the head cube, so the 32 cells projected as the ordinary crown/cap. The base attachment also repeated the full 4px mass width, removing the neck that should visually separate crown, attachment, and mass.

## 3. Render grammar

`tied_bun` evidence is now quantized only after tied-hair detection. The bounded geometry contract records:

- vertical position/prominence: high, mid, or low back;
- center, slight-left, or slight-right bias;
- mass width: 2, 4, or 6 texels;
- attachment width: 2 texels.

A high bun uses a selective rear/top mass, a narrow connected top corridor, a seam-matched two-texel front crest, and a back mass. A mid bun stays top/back; a low bun uses a top/back attachment and lower back mass. Near-symmetric evidence stays centered.

## 4. Attachment

- Maximum attachment width: 4 → 2 texels.
- Base attachment cells: 32 → 10.
- Outer tied component remains one physical component through same-face adjacency and UV continuity groups.
- Biased top coordinates are mirrored on the back UV face, preserving physical seam alignment.

## 5. Base and outer roles

- Base-only keeps the normal hair foundation and paints only the narrow logical attachment.
- Outer-only contains the tied mass plus its narrow outer neck.
- No full top, back, front, or side face is claimed; total tied occupancy remains below one 8×8 face.

## 6–9. Frozen tied cases and pixel evidence

Both frozen high-bun cases have identical geometry metrics:

| Metric | Before | After |
|---|---:|---:|
| tied outer cells | 32 | 34 |
| mass-group outer cells | 32 | 24 |
| attachment-group outer cells | 0 | 10 |
| base attachment cells | 32 | 10 |
| attachment width | 4 | 2 |
| front tied rows | none | 0, 1 |
| front/front-left/front-right top visible row | 14 | 11 |
| preview prominence | 0 | +3 px |

Rendered changed-pixel counts:

| Case | Front | Front-left | Front-right | Top | Back |
|---|---:|---:|---:|---:|---:|
| bun-check | 210 | 150 | 150 | 372 | 708 |
| full-body-layered | 112 | 80 | 80 | 372 | 708 |

The top/back mass width remains 4 texels while the front crest and attachment are 2 texels, so the center rise is separated from the generic 8px crown silhouette. The two extra tied cells are not the basis of the result; the decisive change is redistribution across a narrow connected silhouette path.

## 10. Seams and craft

- Both tied cases: 0 alpha seam mismatches.
- `wavy-open-blazer`: 0 alpha seam mismatches.
- Craft approval: 11/12 before and 11/12 after.
- No previously approved case became rejected.

## 11. Frozen 12-person regression

- Both tied cases remain accepted.
- All ten non-tied final atlas hashes are byte-identical before/after.
- All pixels outside the head base/overlay UV regions are byte-identical for the tied cases.
- The same pre-existing rejected short-hair case remains the only reject.

## 12. API usage

- Gemini geometry: 0
- Absolute evaluator: 0
- Pairwise evaluator: 0
- Interactions API: 0

## 13. Tests and build

- Workers TypeScript: PASS
- App TypeScript: PASS
- Workers tests: 636 passed, 35 skipped
- Tied artifact comparison: PASS
- ESLint: PASS
- Production AIT build: PASS
- Wrangler 4.120.0 `deploy --dry-run`: PASS; no upload/deploy
- Secret scan: no real key found; one intentionally synthetic sanitization fixture matched

## 14. Next generation bottleneck

`facial feature renderer`: the remaining 1/12 craft rejection reports insufficient connected face features and face shading. This subsystem was frozen in this iteration.

Detailed machine-readable evidence is in `workers/evaluation-artifacts/tied-hair-renderer-20260906/comparison.json`.
