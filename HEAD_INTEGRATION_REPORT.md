# Head identity integration — 2026-09-06

## 1. 시작 상태

- HEAD: `20205de379b8a39e41b985e09ce3c4f9acd2dabf`
- branch: `main`
- 기존 dirty: `identityQuantization.ts`, `outfitIdentity.ts`, `outfitRenderer.ts`, `inferredLowerDetails.test.ts`; untracked generalization report/tests/support. 모두 보존했다.
- 별도 Goal 없음. commit/push/deploy 없음.
- 이전 `generalization-20260905`는 수정하지 않았다. 새 `head-integration-20260906/before`의 atlas가 이전 after와 12/12 byte-identical임을 확인한 다음 production head 동작을 수정했다.

## 2. 실제 head integration architecture

```text
frozen annotations + stored PhotoAnalysis (+ stored identityGeometry for 5 cases)
→ normalizeAnalysisForRendering / refineFeatureColorsFromAnalysis / buildFaceStyle [generate.ts]
→ buildSkinPlan [skinPlan.ts]
→ buildIdentityPixelPlans [identityPlans.ts]
  → buildFacePixelPlanVariants → buildQuantizedLayoutVariants [identityQuantization.ts]
  → hairPlan → buildHairIdentitySaliencePlan [hairIdentitySalience.ts]
  → buildHeadMaskPlan → buildHairStructurePlan [headStructure.ts]
  → HeadIdentityPlan: face, glasses, group IDs, protected cells, existing IdentityRenderContract
  → resolveHeadOwnership [headOwnership.ts]: owner cells + continuity groups
→ buildProceduralFallbackAtlas → buildProceduralFrontView [generate.ts]
→ packFrontViewToAtlas [skinPack.ts]
  legacy material construction: composeHair / composeHat / composeGlassesOverlay
  → applyShading → reconcileBaseHorizontalSeams → reconcileOverlaySeams → jewelry/readability
  → final applyHeadIdentityPlan: execute resolved cells + existing face/glasses grammar
→ applyUvMask → validateFinalAtlas → validateAtlasCraft [skinPost.ts]
```

Head ownership is resolved before rendering, then executed after legacy cleanup, so a later generic hair pass cannot replace it. This is **not a complete replacement of all legacy grammars**: complex ornaments, locs, unmeasured curls/coils and plain short-straight hair retain `preserve_existing_grammar`. Their existing strong contracts were not reopened. Such cases have explicitly labeled legacy-projection diagnostics, not falsely authoritative owner measurements.

## 3. Loss-stage audit

| cue | source | intermediate | old HeadIdentityPlan | old atlas | new result / boundary |
|---|---|---|---|---|---|
| bun-check high bun | explicit manual hair annotation | short_cap; straight grammar | no tied mass | generic cap | **hair_plan → head_plan**; tied_bun + attached mass now present |
| full-body-layered high bun | explicit manual hair annotation | short_cap | no tied mass | generic cap | same rule, no case-specific condition |
| round glasses | present | round_heavy with openings/bridge/frame | present | frame already present, surrounding generic fill weakens reading | **ownership/context**, not deletion of the entire frame; preserved topology, reserved window |
| covering | present; source linkage uncertain | covering mask exists with stored geometry | no explicit covering owner | covering shell present; final fringe could reintroduce hair | **ownership/postprocess**; covering owner, no final hair-fringe repaint in covered path |
| wavy groups, both rejected cases | explicit waves | semantic_analysis / wavy_bands groups | group IDs present | `applyHairStructurePlan` skipped semantic_analysis; generic completion remained | **renderer**, plus invalid bottom outer UV continuation |
| short-red craft | short hair/smile present | present | present | atlas exists, rejected | **craft**, separate connected-face/shading cause |

The round-glasses topology was not absent. Claiming that all frame pixels had been erased would contradict the frozen atlas. Preview fidelity remains weaker than the source's large circular lenses.

## 4. Ownership changes

`HeadIdentityPlan.ownership` declares base/outer cell owners (`face`, `hair_base`, `hair_outer`, `glasses`, `covering`, `tied_hair`, `other_p5`, `clear`), group IDs, evidence provenance and UV continuity groups. Transparent face/lens windows are explicit reservations. Observed covering and tied mass win over generic completion in their own regions; glasses win in their footprint, not as a global P5 priority. Existing cloth accents and hair foundation material ramps are reused without color-proximity ownership guessing.

Hair taxonomy/texture parsing is scoped to hair evidence. Glasses modifiers are scoped to eyewear clauses; round necklaces, body bags, blazer adjectives and outfit loc/bun text cannot reclassify head grammar. Unknown detailed ornament grammars use a labeled compatibility path rather than erasing their strong existing output.

## 5. Bun / tied hair

Both real-photo sentinels now use `tied_bun`, with `tiedMass.position=high_back`, `attachmentRegion=crown_back`, depth 1. Each has **32 outer tied-mass cells** across top/back, attached to opaque base foundation. Width/depth derive from the 8-cell cuboid, not case IDs or source URLs. Shared top/back edge belongs to a common continuation group. Neither case uses a full outer cube or a few texture dots.

The two cases retain all 64 tied cells through final UV masking. Top/back depth is inspectable, but the fixed cube's shallow expansion still gives only a weak high-bun reading from the front. **Structural transport is fixed; high-bun photographic likeness is not declared solved.**

## 6. Glasses

The existing `buildGlassesStructurePlan` topology, two lens openings, bridge, rims and eye anchors were retained. Eyewear clauses were narrowed, not topology redesigned. In the frozen round-glasses case the frame survives in both before and after; the improvement is removal of conflicting generic outer fill in the planned glasses window. Sunglasses retain intentionally opaque lenses. Existing oversized/ornament/loc contracts pass regression.

Preview: the round frame is more separated from nearby hair, but still visually heavier/less circular than the source. This is partial readability, not full source fidelity.

## 7. Covering

Covering is a separate material/owner, not a hair template in final execution. Covered base cells use covering material; the existing cloth accents survive in the outer layer; the final facial pass omits conflicting hair-fringe instructions. Face windows and glasses remain protected. All 314 counted covering cells survive after resolved execution.

`headscarf-color-blocks` is **ownership/covering-contract only**. Its uncertain photograph-to-geometry linkage excludes it from any source-color or source-silhouette fidelity success claim.

## 8. Long/wavy seam root cause

Both failures were genuine outer **alpha/coverage** discontinuities, not valid RGB shading being mistaken for failure. The validator's “crown and side” wording was misleading: every issue was a bottom seam.

| outer physical pair | wavy-open-blazer before | sleeveless-bag-skirt before | after, each |
|---|---:|---:|---:|
| front ↔ bottom | 4 | 4 | 0 |
| back ↔ bottom | 4 | 4 | 0 |
| left ↔ bottom | 6 | 5 | 0 |
| right ↔ bottom | 6 | 6 | 0 |
| top ↔ front/back/sides | 0 | 0 | 0 |
| front ↔ sides / sides ↔ back | 0 | 0 | 0 |
| base alpha mismatches | 0 | 0 | 0 |
| total | **20** | **19** | **0** |

The old semantic groups never executed, so these are not honestly attributable to an executed `wavy_bands-*` group. They originated in **unowned generic composeHair completion**. `seam-provenance.json` records each actual UV pair, opacity, unresolved legacy author and separately the projected plan groups. The existing mask taxonomy omitted bottom; bottom continuation had been left to late style/color heuristics.

## 9. Structural seam fix

`resolveHeadOwnership` uses the existing `getBoxUvSeams` cuboid mapping, including mirrored bottom and three-face corners. Union-find resolves bounded seam equivalence classes once. Missing adjacent occupancy is added as the same logical hair/covering/tied mass; no random atlas patch, no identity mass removal to force passing. Explicit face/lens/jewelry boundaries are not replaced with hair. Shared edge groups carry a consistent material ramp; unrelated internal face shading is preserved.

No changes to `skinPost.ts`, craft thresholds, P5 gates, evaluator, API schema, prompts or CandidateAdmissibility. Existing long-straight retains 4 allowed bottom mismatches at protected boundaries; short-red retains its prior 1. “All suite seams are zero” is therefore not claimed.

## 10. Short-red reject

Not the same cause. It still reports exactly:

```text
rich style misses connected faces (8)
rich style lacks face shading (7)
```

Its plain short-straight compatibility path keeps the old output and avoids introducing a new palette regression. No unrelated craft/whole-body redesign was attempted.

## 11. Plan → atlas retention

Only the **8 resolved-execution cases** are aggregated here. Counts compare planned opaque cells and exact RGBA at `after_authoritative_head` with final atlas after UV masking. This establishes post-execution retention, not an independent photographic likeness score or a proof that every upstream measurement was right.

| resolved group | expected | retained | overwritten | missing |
|---|---:|---:|---:|---:|
| face | 98 | 98 | 0 | 0 |
| hair base | 1508 | 1508 | 0 | 0 |
| hair outer | 1189 | 1189 | 0 | 0 |
| tied mass | 64 | 64 | 0 | 0 |
| glasses | 38 | 38 | 0 | 0 |
| covering | 314 | 314 | 0 | 0 |
| existing ear/accessory pixels | 12 | 12 | 0 | 0 |

Legacy projections can show missing projected hair-group cells (e.g. 19 for clipped buzz cases); those groups were never asserted as the legacy renderer's exact contract. They are explicitly excluded from the above retention total. Owner diffs record exact changed pixels at instrumented stages, without pretending RGB alone identifies a final semantic owner.

## 12. Craft approval

**9/12 → 11/12**, same gate. Zero planner exceptions. All previously accepted cases remain accepted. Only short-red remains rejected. The two former long/wavy seam rejects now pass with 0 head alpha seam mismatches. The prior “3 head seam rejects” assumption was incorrect: there were two seam rejects and one unrelated rich-style reject.

## 13. Head cue retention and visual review

Every row uses the same frozen source and analysis. “Present” means the stated cue/contract exists, not a likeness score.

| case | source cue | plan/atlas after | preview before → after |
|---|---|---|---|
| short-hair-red-shirt | short dark hair; smile | unchanged legacy | similar; coarse face remains |
| glasses-monochrome | round glasses | round topology/window/frame present | weak → partial, better separated; not source-sized circles |
| curly-hair | curly volume | stored measured masses preserved | partial → partial; segmented look still possible |
| headscarf-color-blocks | covering contract only | explicit covering owner/window | no source-fidelity scoring |
| long-straight-hair | long straight side hair | length and planned groups present | recognizable length maintained |
| buzz-striped | very short hair | existing buzz grammar preserved | exact buzz likeness remains weak |
| bun-check | high bun | absent tied contract → 32 tied cells | cap → attached top/back mass; front still weak |
| warm-white-tee | short upward hair | existing short grammar preserved | similar; quiff specificity limited |
| full-body-layered | high bun + sunglasses | 32 tied cells + opaque glasses lenses | bun partial; sunglasses maintained |
| wavy-open-blazer | long waves | semantic wavy groups execute; valid UV | partial waves; seams fixed, not proof of full waviness |
| striped-open-shirt | cropped short hair | existing short grammar preserved | similar, genericization remains |
| sleeveless-bag-skirt | long waves | semantic wavy groups execute; valid UV | partial waves; seams fixed |

For the explicit six integration contracts (two tied masses, round glasses, sunglasses, two executed wavy group grammars), upstream plan presence improves **4/6 → 6/6** and explicit atlas execution support **2/6 → 6/6**. This is a narrowly defined contract metric, not a six-photo likeness result. Fully clear preview support is conservatively only **1/6** (sunglasses); the other five remain partial. Covering is a separate contract-only sentinel. No overall high likeness percentage is asserted.

Contact sheet: `workers/evaluation-artifacts/head-integration-20260906/head-comparison.png`. Per person: source crop, frozen before/after plan, owner map, base/outer/combined UV, binary occupancy, numbered seam map + provenance JSON, nine 3D angles including top, base/outer isolated 3D, pixel diff, trace and metrics. In the contact sheet each triplet is source | before | after, row-major in the table's case order.

## 14. Existing subsystem regressions

Full Workers regression passes. Existing face, short/curly/long, glasses, covering, P5, outfit, multi-photo, base/outer and craft tests remain enabled. The separate stored five-face fixture replay passes. All 12 atlases have **byte-identical non-head pixels**, preserving the previous outfit fixes. This is strong non-head regression evidence, not proof that the old outfit was already photographically ideal.

## 15. Strict helper TypeScript

Production Worker and app typechecks pass. Strict checking the added tests reaches exactly the two pre-existing helper issues: extraneous `PhotoAnalysis.coordinateSpaces` at helpers.ts:22 and missing required geometry coordinateSpaces at helpers.ts:187. Helpers were not modified; frozen runtime data and hashes were not changed or cast to hide the issue.

## 16. API usage

Gemini geometry 0; absolute evaluator 0; pairwise evaluator 0; Interactions 0. Generalization/head replay blocks fetch. Other unit tests use existing mocks. No credentials were read or added. No live image/vision calls, retries, fallback probes or evaluator calls were used.

## 17. Tests/build

- Workers production TypeScript: PASS.
- App TypeScript: PASS.
- Full Workers: **633 PASS / 34 opt-in SKIP**, 44 passing files. Final command: `npx vitest run --maxWorkers=2 --testTimeout=15000`. Default 5-second runs hit one timeout in the existing pairwise-evidence rendering test (roughly 110,000 per-pixel assertions); no assertion failure was reported. The CLI deadline was expanded for this verification only; no test/config/product threshold was edited. The earlier 631-test run had passed with the default deadline.
- Dedicated head baseline + after replay: PASS; old baseline 12/12 byte identical.
- Comparison: PASS; 12 source hashes + analysis hashes + non-head byte equality.
- Stored five-face regression: PASS.
- ESLint: PASS.
- Secret scan: final changed/untracked source + diagnostic JSON **188 files, zero matching real-token/private-key patterns**. The earlier 166-file diagnostic scan also found zero inline image data URLs.
- `git diff --check`: PASS; Git warns only about Windows LF→CRLF normalization.
- Production `ait build`: PASS; existing large-chunk warning and child-process deprecation warning. Its local artifact log prints a deploymentId, but **no deploy command was run**.
- Wrangler 4.120.0 `deploy --dry-run`: PASS; no deployment. Final bundle 1065.33 KiB / 230.09 KiB gzip.
- Used workers-best-practices and wrangler skills for bounded per-request computation, no new global/request secret state, and dry-run verification. No platform config or binding changes.

## 18. Readiness

**demo**, not beta/release candidate. Valid output coverage improved, but worst-case face genericization, weak front-view bun specificity, incomplete round-glasses likeness and uncertain headscarf linkage remain. 11/12 craft PASS alone does not justify a beta claim.

## 19. Next generation bottleneck

**tied-hair renderer** — only this one next subsystem. Evidence now reaches final pixels, but the cube-constrained rear/top patch does not yet give a reliably high-bun reading from common front views. No next API/evaluator work is proposed.

## Q1–Q9

1. Bun loss was `hairPlan()` taxonomy selection, then absence of a tied-mass HeadIdentityPlan contract.
2. Round frames already existed; generic surrounding fill weakened reading. Covering lacked explicit ownership and was exposed to final fringe repaint. Neither is honestly described as total source-evidence loss.
3. The 19/20 invalid pairs came from unresolved generic long/wavy completion at bottom UV edges, not an executed semantic wavy group; the renderer had skipped those groups.
4. Yes: actual paired UV occupancy/ownership was resolved. Validator/gates/thresholds unchanged.
5. 11/12, with the original short-red rich-style reject remaining.
6. Plan/atlas contract retention improved. Full preview readability has not been proven to improve equivalently.
7. Existing automated subsystem tests and 12/12 non-head byte equality pass. Human likeness is not implied by those tests.
8. Still demo, due to visible worst-case identity limitations.
9. Tied-hair renderer.
