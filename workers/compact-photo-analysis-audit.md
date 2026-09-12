# Compact primary PhotoAnalysis boundary

Starting revision: `c26dcb0de86f1afc688099b1a75feb83b7718fc3`, branch `main`.
Existing four untracked diagnostic test files are preserved. No commit, push or deployment is part of this iteration.

## Field-use audit

Categories: A = required for production decisions/plans; B = deterministic reconstruction;
C = generation prompt/display; D = compatibility; E = unused. Categories can overlap.

| Rich field | Actual consumers / purpose | Class | Wire decision |
|---|---|---|---|
| quality / failReason | analysis.ts validation and generate.ts rejection of unusable photos | A | Preserve |
| framing | analysis.ts validation, generation framing and outfit completion | A | Preserve |
| visibleRegions | skinPlan.ts:157–187 confidence; outfitIdentity.ts:390–418 observed vs inferred garment ownership | A | Preserve all five booleans; cannot derive union visibility from framing in a multi-photo set |
| sourceSelection | generate.ts:433–467 source indices and adaptive crop localization | A | Preserve indices and all evidence, including REGION protocol; derive only measurement reference index from portrait selection |
| observed | skinPlan.ts:155–194; outfitIdentity.ts:239,387; generate.ts:2748 onwards; identityGeometry.ts prompt evidence | A/C | Preserve face, hair, accessories, clothing and palette verbatim |
| inferred | skinPlan.ts:130–187 and outfitIdentity.ts:239–428 completion, rationale and lower-body grammar | A | Preserve all values/rationales and lowerBodyDesign. Similar lower-body hints can have different observed/inferred ownership; not safe to deduplicate |
| canonicalIdentity | skinPlan.ts:143 identity assignments; faceIdentitySalience.ts:54; outfitIdentity.ts:372 | A/C | Preserve impression, mustPreserve and every feature. Lift features to wire root to remove one nesting level; restore on normalization |
| renderHints | generate.ts:1931–1983 face/hair style; identityPlans.ts and outfitIdentity.ts deterministic grammar | A | Preserve all 45 values in a fixed-order vector, shared enum grammar; validate each position against its original field vocabulary |
| faceMeasurementEvidence | faceMeasurementEvidence.ts:80–106, identityQuantization.ts categorical priority | A | Eight ordered cue records share one value/provenance/confidence schema. Restore keys and portrait reference. Missing whole optional block remains absent; existing parser handles uncertain/hidden cues as unknown |
| identityPrompt | analysis.ts:1793,1925 validation/cache reconstruction; generate.ts:2749–2760 and image prompts | A/C | Preserve. Not equivalent to observed.face/hair because downstream code reads all of them |
| outfitPrompt | skinPlan.ts:151–174 and outfitIdentity.ts:239,387 | A/C | Preserve. Includes complete visible/inferred outfit and additional construction cues |
| negativePrompt | skinPrompt.ts:115–116 generation restrictions; generate.ts:4173 explicit no-glasses rule; headStructure.ts:545 and identityPlans.ts:592 ownership | A/C | Preserve person-specific prohibitions; cannot reconstruct arbitrary negatives without loss |
| fallbackFeatures | generate.ts:1915+ palettes/features, faceMeasurementEvidence.ts:90 glasses constraint, outfitIdentity.ts:247,393–398 | A/B/D | Optional typed 19-key cache. Preserve explicit overrides; only omitted keys use the existing analysis.ts:1899–2111 reconstruction. No global claim of lossless omission |
| identityGeometry | identityQuantization.ts calibrated precedence, identityPlans.ts high-resolution geometry | A/D | Already absent from primary provider schema; keep stored/internal geometry unchanged. Never fabricate in compact normalization |

No top-level field was classified as safely unused (E). In particular, prompt strings are not debug-only. No source observation was replaced by a deterministic guess.

## Representation and equivalence boundary

`CompactPhotoAnalysis → schema + per-slot validation → structural reconstruction → validatePhotoAnalysis → existing PhotoAnalysis`

Repeated enum symbols and repeated cue object grammar account for the main reduction. The measurement block's repeated reference index is reconstructed from the authoritative portrait index. All 45 render choices and all eight measurement cues remain expressible. The code preserves enum identity per field instead of merging meanings; membership in the shared wire enum alone is insufficient and is checked again per position.

The original primary prompt remains intact; an output-format addendum declares vector order and moved fields. The two renderHints descriptions move into that addendum. No inferred/observed conversion or confidence generation is introduced. Optional cache fields and optional evidence are accepted under the existing unknown/fallback behavior; unknown is never calibrated geometry.

| Metric | Rich | Compact v1 |
|---|---:|---:|
| Schema bytes | 11653 | 6339 |
| Properties | 140 | 83 |
| Required entries | 139 | 62 |
| Max depth | 6 | 5 |
| Enum values (including repetitions) | 309 | 196 |
| Description chars | 526 | 0 |

This is a schema-size reduction, not a claim of reduced observation complexity or measured photo accuracy. Ordered vectors require the provider to follow the prompt. Per-slot enum validation catches wrong vocabulary and length; a same-vocabulary positional mistake remains a measurement-quality risk to test in subsequent real-photo coverage work.

Offline equivalence compares the same complete semantic inputs through both rich validation and compact normalization, then complete SkinPlan (face/hair/head/outfit), candidate FacePixelPlans, and final atlas. Synthetic cases cover face-only, glasses, covering, curly, bun, layered/plain outfit and full body. Separate frozen replay verifies all 12 stored analyses and atlases against their baseline, including five calibrated cases; annotations remain evaluation-only.

## Provider gate

Only two one-shot canaries are authorized: text then JPEG if text succeeds. The harness writes an exclusive checkpoint before dispatch and stores hashes, metrics and status booleans only. No provider request, response, prompt body, credential or image is persisted. Production selection is conditional on both schema validations, image normalization and offline regression passing. Existing retry/fallback policies and non-primary calls are outside the compact change.

## Measured result and activation decision

Text canary 1: HTTP 400, code 400, status INVALID_ARGUMENT, sanitized message `Request contains an invalid argument.` No structured JSON was returned. JPEG canary 2 was not attempted. Total provider calls: 1; retry/fallback/geometry/Interactions/evaluator: 0.

The compact candidate meets all numeric budgets but is not provider-accepted. Numeric metrics are not an acceptance guarantee, and this response does not identify a field or isolate vector grammar from cumulative interaction. The production caller, schema, prompt, model and retry policy remain unchanged; the new module is an unactivated candidate. Do not claim the production blocker resolved.

Next proposed experiment, requiring a separate authorization: a text-only wrapper containing the exact compact renderHints vector schema, with all other canary wire fields fixed. This would test whether the new shared-vector grammar is independently accepted. No further schema edits or calls are made in this iteration.

## Verification

- Full offline Workers suite: 50 files passed, 687 tests passed, 20 files / 43 tests skipped (live and opt-in suites).
- Focused compact tests after stronger atlas assertions and exhaustive vocabulary test: 13 passed. All eight semantic cases have non-null, identical atlases.
- Separate frozen replay: passed; 12/12 accepted and all baseline hashes unchanged, including five calibrated cases. Network is blocked by the replay's fetch mock.
- Frontend and Workers TypeScript: passed. Whole-repository ESLint and git diff --check: passed.
- AIT/Vite production build: passed; existing large-chunk and dependency deprecation warnings remain. Temporary local build shim removed.
- Wrangler 4.120.0 deploy --dry-run: passed; no deployment. The candidate is not imported by production, and upload size remains unchanged.
- The automatic approval review initially rejected the combined replay/full-suite command over possible live-test activation. Read-only inspection established distinct opt-in flags and a rejecting fetch mock; a file-scoped replay and default full suite were subsequently approved and passed. No user action remains blocked.
