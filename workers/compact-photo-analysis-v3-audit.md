# Compact v3 offline candidate audit — 2026-09-10

Starting HEAD: `c26dcb0de86f1afc688099b1a75feb83b7718fc3`, branch `main`.
All pre-existing source bytes and dirty/untracked work were preserved. The only
new source is an inactive candidate module, plus offline tests/support and this report.
No commit, push, deploy, credentials read, or provider call was performed.

## Decision and limits

Select **Candidate C (hybrid)**. Preserve v2's named fields and 15 renderHints groups,
retain six small evidence/quality enums, move the other enums and nested required,
array length and numeric bounds to strict runtime validation. No model, API stage,
planner or renderer changes. No active caller imports this candidate.

This reduces constructs implicated by the full/partition acceptance evidence;
it does **not** establish a Gemini limit or demonstrate v3 provider acceptance.
The 5 KB target is met; the properties <=80 aspiration is not met (98 unchanged).
Keeping named cache fields and stable group structure avoids another positional
encoding or open object while preserving all existing semantic values.

## Measured comparison

Prompt bytes below are project prompt constants, without the identical reference suffix.

| Metric | Rich | Compact v1 | Compact v2 | Compact v3 |
|---|---:|---:|---:|---:|
| Schema bytes | 11653 | 6339 | 7919 | 4539 |
| Properties | 140 | 83 | 98 | 98 |
| Required | 139 | 62 | 77 | 13 |
| Depth | 6 | 5 | 5 | 5 |
| Enum declarations | 74 | 16 | 30 | 6 |
| Enum values | 309 | 196 | 250 | 23 |
| Largest enum | 12 | 121 | 16 | 6 |
| Prompt bytes | 28225 | 32762 | 33112 | 34667 |

v2 -> v3: -3380 schema bytes (-42.7%), 0 properties, -64 provider required
entries (-83.1%), -24 enum declarations (-80%), -227 enum values (-90.8%).
Prompt +1555 bytes (+4.7%). Observation/measurement instructions are unchanged;
only the compact output section/version and categorical validation instructions differ.

| Candidate | Schema bytes | Required | Enum declarations/values | Prompt bytes | New code mappings |
|---|---:|---:|---:|---:|---:|
| A: runtime vocabulary | 4258 | 13 | 0 / 0 | 34667 | 0 |
| B: field-local short codes | 5769 | 13 | 30 / 250 | 37066 | 250 |
| C: hybrid | 4539 | 13 | 6 / 23 | 34667 | 0 |

All candidates use the same structural relaxation when compared. B is an offline
prototype: deterministic `c0`, `c1`, ... codes follow each schema-path enum's
existing order; the codebooks are collision-free within each path. Decode is tested
before strict semantic validation; no code reaches the rich contract.

A is 281 bytes smaller than C, but removes provider quality/provenance checks too.
B preserves enum combinations and adds codebook translation/prompt ambiguity.
C preserves human-readable output and evidence enums at a small size cost over A.
All three round-trip the eight semantic fixtures. Model output discipline/error rates
are **not measured** offline; no synthetic invalid-input rate is presented as a model rate.

## Complexity contributors

Subtree metrics exclude root wrapper/parent property key bytes and use local depth.
Every nested subtree (including item schemas) is audited in
`evaluation-artifacts/compact-v3-offline-20260910/complexity.json`, with enum counts,
objects, arrays, nullable unions, additionalProperties usage, semantic importance
and constraints movable to runtime.

| Largest v2 subtree | Bytes | Properties | Required | Enum values |
|---|---:|---:|---:|---:|
| renderHints | 2729 | 15 | 15 | 175 |
| inferred | 1559 | 22 | 22 | 36 |
| fallbackFeatures | 641 | 19 | 0 | 0 |
| identityFeatures | 537 | 6 | 6 | 9 |
| sourceSelection | 497 | 6 | 6 | 0 |
| faceMeasurements | 473 | 3 | 3 | 19 |

renderHints' 175 enum values are 70% of v2's total. The cache's 19 properties
carry optional unique palette choices and remain named and unchanged. Nullable
inference blocks preserve the distinction between observed and unobserved regions.

## Contract boundary

`COMPACT_PHOTO_ANALYSIS_V3_SCHEMA` -> provider shape validation ->
`validateCompactPhotoAnalysisV3(raw, context)` ->
`normalizeCompactPhotoAnalysisV3(raw, context)` -> rich PhotoAnalysis -> existing plans.

- Provider schema retains types, named objects/groups and root required fields.
  Small enums retained: quality, failReason, framing, measurement provenance,
  identity feature category and confidence.
- Strict validation reuses the **unchanged v2 schema and slot validator**, so every
  removed enum, nested required, min/maxItems, and numeric bound is still enforced.
- Unknown keys at every object level, malformed types, sparse holes and non-finite
  numbers are rejected before legacy defaults can hide them.
- Every present renderHints group must have the exact slot count and each slot's
  original rich vocabulary. Every present measurement block has eight cues with
  cue-local vocabulary and provenance/confidence checked.
- Unknown evidence must be `unknown/unknown/0`; non-unknown evidence must be visible
  with confidence >=0.75 and <=1. Invalid combinations are rejected rather than silently
  converted. Existing low-confidence/hidden observation semantics are preserved.
- Caller-owned context supplies actual imageCount (1..5). All selected image indices
  must exist. An optional already-fixed portrait index must match. Measurement ownership
  derives only from that portrait selection; a second model-supplied owner is rejected.
- Existing optional fallback cache strings and optional legacy measurement absence
  are preserved as in v2. No new token vocabulary is invented for the existing free-form
  palette cache. New output instructions still request every face measurement cue.
- Legacy rich validation remains the final acceptance check. No coercion, invented
  observation, or fabricated continuous geometry is added by v3.

## Equivalence and honest coverage

Eight existing semantic fixtures (face, glasses, covering, curly, bun, layered,
plain, full-body): rich-normalized == v2-normalized == v3-normalized; source semantic
loss relative to this rich baseline 0; FacePixelPlan/HairPlan/HeadIdentityPlan/
OutfitPlan/SkinPlan and atlas differences 0. Candidate B's decoded values are exact.
This is fixture equivalence, not measured live source accuracy.

Frozen 12: existing v2 plan and atlas hashes all unchanged, calibrated five render
regressions 0, production procedural craft 12/12.

**Coverage limitation:** five frozen manual adapters already violate v2's minimum
four identityFeatures: glasses-monochrome, curly-hair, headscarf-color-blocks,
long-straight-hair, buzz-striped. Both v2 and v3 reject these inputs unchanged.
No features were padded or invented. Full v2/v3 normalization comparison passes for
the remaining 7/12. Frozen twelve hash regression uses the existing trusted internal
renderHints replay, exactly as the previous v2 test did; it must not be described as
full v3 normalization for 12/12. Additional valid boundary fixtures for these five
are still needed to close that particular coverage requirement.

Craft is tested with the actual procedural caller's arguments:
`validateAtlasCraft(atlas, style, undefined, undefined, skinPlan)` -> 12/12.
An additional explicit face/hair-plan check yields 11/12 (long-straight-hair readable
eyes), unchanged before/after; it is a different contract invocation and is recorded
separately. The existing caller and validator were not changed.

## Validation results

- Focused v3 offline tests: 6 passed; fetch guard verifies provider calls 0.
- 24 targeted malformed-output cases rejected.
- 194 systematic mutations rejected: 114 required omissions, 80 vocabulary mutations.
- 198 valid render-hint token/slot combinations retained; unknown B code rejected.
- Full Workers: 61 test files passed, 20 skipped; 709 tests passed, 52 skipped.
- Workers production-source TypeScript: PASS. Root referenced-project `tsc -b`: PASS.
- ESLint and production AIT build: PASS. Existing build chunk-size warning persists.
- Extra check including new tests: no new type errors after correction; it exposes
  two pre-existing `test/helpers.ts` errors (lines 22 and 187, coordinateSpaces typing).
  Those existing fixture/type issues were left unchanged.
- Existing source byte hashes verified in `source-preservation.json`.
- No live acceptance claim; Gemini, Geometry, Interactions and evaluator calls all 0.

## Next bounded live iteration (proposal only)

1. Full v3 text-only canary: provider schema acceptance + structured JSON/shape.
   Without an image this cannot prove source-reference or measurement correctness.
2. Only after (1) passes, same full v3 schema/prompt with one licensed public photo;
   require provider shape, strict runtime validation with actual imageCount=1,
   and rich normalization all PASS. Stop on any failure; no retry or extra stage.

Production remains inactive pending explicit live validation. The five manual
fixture coverage gaps should also be closed with valid stored inputs, without
weakening required identity semantics.
