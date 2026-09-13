# Face-only geometry enrichment — 2026-09-14

결론: 얼굴 전용 contract는 실제 Gemma **3/3 PASS**로 확인됐다. Cheek+jaw는 3/3 usable이고 jaw/cheek 비율도 세 가지다. 그러나 chin이 전부 unknown이라 **usable chin 0/3**이고, quality gate는 FAIL이다. Production-equivalent smoke와 activation은 실행하지 않았다.

## 1. 실제 시작 상태

- Branch `main`, HEAD `f3c0732388c78bfe5796ba9b94c1c9dc7e897a3e`.
- 시작 시 tracked dirty 9개, untracked 6개. 기존 변경 및 보고서를 보존했다.
- Commit/push/deploy 없음. Production 설정 파일 변경 없음.
- 기존 artifact 5,803개는 전체 경로/내용 digest가 회귀 실행 전후 동일하다: `610eea635d50a7fdef3121500377b3adbdaba4f4e733b3b53ffe1ae0cd3e0f0f`.

## 2. 기존 full geometry의 acceptance 1/3 원인

Short는 direct cheek가 별도 global visible face boundary 밖이라는 이유로 거부됐다. Long은 direct contour 검증 이후 full geometry semantic chain에서 거부됐다. Wavy만 전체 chain을 통과했다. 기존 full schema, prompt, `runIdentityGeometryAnalysis()` 및 `runIdentityGeometryEnrichment()` 파일은 이번 iteration에서 byte-identical하게 유지했다.

## 3. 새 face-only type

`workers/src/faceIdentityGeometry.ts`의 `FaceIdentityGeometryAnalysis`를 `PhotoAnalysis.faceIdentityGeometry?`에 server-internal 상태로 추가했다. Face reference, eyes, brows, nose, mouth, confidence, direct contour만 가진다. Hair/head placeholder 및 가짜 full IdentityGeometryAnalysis를 만들지 않는다. Provider-facing primary PhotoAnalysis schema에는 필드를 추가하지 않았다.

## 4. 새 provider schema

`FACE_IDENTITY_GEOMETRY_SCHEMA`: face / eyes / brows / nose / mouth / confidence / directLowerFaceContour의 7 root properties. Brows tilt도 측정하며 눈 사이 거리와 좌우 눈 높이 차이만 코드에서 결정적으로 유도한다. Glasses는 새 측정 대상에 넣지 않고 기존 실제 full geometry 또는 기존 semantic footprint를 유지한다.

- Schema SHA-256: `3e5e84fd8b52fbd2e06d759306dd097d817d9d8be5379826e8f62a1a31081469`
- Prompt SHA-256: `c1b9f013368b15bc7b92fc6dbc600875e685ee14e9e3ef6a959f7816bf8af68f`
- Provider: `@cf/google/gemma-4-26b-a4b-it`, 기존 native structured transport, 4,096 max output tokens, 25,000ms cap, exactly one binding call.

## 5. Old/new schema metrics

| Schema | Bytes | Properties | Required | Depth | Enum values |
|---|---:|---:|---:|---:|---:|
| 기존 full + direct contour | 10,558 | 138 | 138 | 5 | 44 |
| Face-only | 3,926 | 54 | 54 | 4 | 12 |

Bytes 약 62.8% 감소. Unsupported constructs / undefined / non-finite / malformed required 모두 0.

## 6. Single-image coordinate contract

한 장의 tight-face crop만 전송한다. 모든 좌표는 해당 crop 0..1이며 left/right는 viewer 기준이다. Prompt에 한 번만 이미지 역할을 정의한다. Head crop은 provider 입력에 포함하지 않는다.

`envelopeLeft/envelopeRight`는 전체 보이는 얼굴의 수평 scale reference라고 명시했다. Lower contour를 이 envelope 안에 강제로 가두지 않는다. Wavy의 기존 이름상 face 파일은 실제로 상반신 crop이어서, 시각 검토한 test-only ROI로 메모리 안에서만 tight crop을 생성했다. ROI는 identity measurement나 production primary input으로 주입하지 않았다. 원본 파일은 보존했다.

## 7. Lower-face validation

Finite/range, crop bounds, left<right, cheek→jaw→chin row order, unknown 계약, audited 1:1 outward-displacement/row-displacement envelope를 검사한다. 이 envelope는 보수적인 기하 검증 규칙이며 실증된 해부학적 한계라는 주장은 하지 않는다.

Slope는 새 contract의 crop-normalized 공간에서 검사한다. Jaw>cheek 자체는 허용한다. Unknown 중간 행이 있어도 나머지 known row 순서는 유지해야 한다. Unknown은 null/null/null + confidence=0이어야 하며 자동 변환·clamp·repair·symmetrize는 없다. Confidence가 낮은 boundary는 유효할 수 있지만 usable geometry로 취급하지 않는다.

## 8. Face/head provenance 분리

`resolveFaceGeometry()`가 face-only → 실제 full geometry의 face portion → null 순으로 선택한다. Hair 축은 별도 실제 full geometry만 본다. Full geometry가 없으면 fringe/temple/crown/majorVolume/hairline usage는 false이다.

HairPlan 구성에는 face-only를 제외한 기존 layout을 사용하여 hair occupancy 및 provenance를 보존한다. HeadIdentityPlan은 실제 face/head provenance를 함께 표시한다. Raw face-only geometry를 public analysis summary에 추가하지 않고, FacePixelPlan의 usage/provenance로 내부 적용을 검증한다.

## 9. Quantizer integration

기존 face quantization 계산을 `quantizeResolvedFaceGeometry()`로 공유한다. Eyes/brows/nose/mouth/direct contour만 새 source를 우선 사용한다. 기존 full quantizer API는 wrapper로 유지했다. Eye spacing/footprint/openness, brow gap/slope, mouth anchor/width/corners, nose 위치/strength 및 cheek/jaw/chin grammar를 재사용한다. Candidate max 3, contour max 6px, complexion-relative 색상, ownership 보호는 그대로다.

## 10. Offline tests

Face-only valid/no-head input, hair independence, 동일 cheek/다른 jaw 및 동일 jaw/다른 chin의 topology 차이, plausible wider jaw, extreme jump rejection, unknown null/zero, crop 안의 short-style boundary, invalid finite/range, face 우선순위, full head 공존, no-head hair false, fail-open을 검증했다.

최종 focused 결과: **23 PASS / 2 live·smoke SKIP**. 중간 unknown row ordering 보완 후에도 통과했다. 이 보완은 live의 known cheek/jaw + unknown chin 결과를 바꾸지 않는다.

## 11. Live selected crops

| Source | Sent dimensions | Sent SHA-256 | Selection |
|---|---|---|---|
| short-hair-red-shirt | 512×416 | `bc6567b62d2c379ab13070a3ecf27fd173c4049fc888a2af1f928f95ff8665a6` | slight turn, visible jaw/chin |
| long-straight-hair | 313×329 | `f128c35393cbacab93e51c44bb1484f2c21882c06582898c12a291d47fd153d2` | slight turn, jaw unoccluded |
| wavy-open-blazer | 265×296 | `fd5b83e6dc82952939db8b9045d39fe590f22fe345a5b6791fcb714b37c57f58` | frontal, reviewed tight crop |

선택 코드는 pose/annotation/visibility/resolution/unique crop hash를 검사한다. 검토한 localization은 별도 crop-review data에 있고 production 코드에 source ID 분기는 없다. Head crop hash는 선택 조건이 아니다.

## 12. Live eyes/brows/nose/mouth validity

Provider shape 및 face semantic validation 모두 3/3 PASS. 모든 source에서 eyes/brows/nose/mouth geometryUsage=true.

| Source | Eye centers L / R | Eye openness | Brow gaps L/R; tilt | Nose x/y | Mouth x/y/width |
|---|---|---:|---|---|---|
| short | (.545,.508) / (.732,.498) | .80 | .064/.056; .10 | .655/.640 | .653/.755/.248 |
| long | (.415,.365) / (.685,.325) | .90 | .030/.050; .10 | .580/.500 | .605/.630/.250 |
| wavy | (.395,.365) / (.730,.425) | .85 | .093/.094; .40 | .520/.550 | .505/.695/.220 |

이는 contract validity evidence이다. 눈 openness/코 contrast 등의 시각적 정확도가 calibration까지 완료됐다는 뜻은 아니다.

## 13. Live cheek/jaw/chin

| Source | Cheek L/R/Y; width | Jaw L/R/Y; width | Chin |
|---|---|---|---|
| short | .343/.833/.580; .490 | .370/.780/.820; .410 | unknown, null/null/null, conf 0 |
| long | .210/.830/.450; .620 | .200/.850/.750; .650 | unknown, null/null/null, conf 0 |
| wavy | .215/.805/.560; .590 | .230/.780/.750; .550 | unknown, null/null/null, conf 0 |

Cheek는 모두 observed/confidence .90, jaw는 모두 observed/.80. Chin unknown은 contract-compliant라 전체 face를 reject하지 않았다. 다만 시각 검토에서 chin은 보이므로 이 응답만으로 세 chin을 관찰 불가능하다고 결론낼 수 없다. 값을 채우거나 다시 호출하지 않았다.

## 14. Jaw/cheek ratios

Short **0.836735**, long **1.048387**, wavy **0.932203**. 3개 distinct이며 fixed 0.88이 아니다. Long의 약간 넓은 jaw는 row displacement에 비해 plausible하여 통과했다.

## 15. Chin/jaw ratios

세 case 모두 null/not measurable. Unknown 좌표로 비율을 생성하지 않았다.

## 16. Topology hashes와 실제 pixels

| Source | Final contour cells | Hash |
|---|---|---|
| short | cheek (1,5)/(6,5); jaw (1,7)/(6,7) | `95aae29ea78409a301a5f34b3769670fbde72d1ed6c5899f1f51a2f1f4bcd1d1` |
| long | 없음 | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |
| wavy | 없음 | `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945` |

두 hash가 있지만 그중 하나는 빈 배열이다. 따라서 두 source에서 서로 다른 non-empty contour silhouette을 입증했다고 주장하지 않는다. 기존 ownership/collision grammar가 만든 결과를 그대로 기록했고 renderer를 수정하지 않았다.

추가 한계: short/long의 live quantization에는 stored analysis의 실제 historical full head geometry가 남아 있었다. Face-only parser는 그것을 사용하지 않았으므로 3/3 contract acceptance는 유효하지만, 이 두 topology record는 full head가 없는 production baseline 증거가 아니다. 원본 live artifact를 보존하고 이후 harness에서는 historical full geometry를 제거하도록 수정했다. 추가 provider 호출이나 누락된 live face reference 재구성은 하지 않았다.

## 17. Quality gate

- Contract acceptance 3/3.
- Usable cheek+jaw 3/3.
- Usable chin **0/3**, required ≥2 미달.
- Jaw/cheek distinct ratios 3.
- Topology hashes 2; non-empty contour cases 1.
- HairPlan/OutfitPlan 변경 0/3, 단 위 historical head 조건을 명시한다.
- **Gate FAIL.**

## 18. Latency

| Source | 이전 full | 새 face-only |
|---|---:|---:|
| short | 24.455s | 9.762s |
| long | 16.704s | 10.614s |
| wavy | 22.020s | 11.326s |
| 평균 | 21.060s | 10.567s |

이번 관측 평균은 약 49.8% 짧았다. Provider 상태와 wavy crop도 달라졌으므로 schema 축소만의 인과효과나 안정적인 SLA라고 단정하지 않는다. 실제 billed cost는 측정하지 않았다. 25초 cap은 유지됐다.

## 19. Fail-open

Timeout / unavailable / malformed JSON / schema invalid / face semantic invalid 각각 mock에서 HTTP 200, valid 64×64 PNG, primary-only baseline과 동일한 PNG 및 analysis를 확인했다. 실패당 native binding mock 1회, 재시도 0. 성공 mock은 FacePixelPlan usage로 enrichment 적용을 확인했다. Heavy flags를 켠 mock에서도 새 flag 경로는 heavy chain을 실행하지 않았다.

## 20. Production-equivalent smoke

**미실행.** Usable chin gate가 실패했으므로 조건부 smoke 권한을 사용하지 않았다.

## 21. Smoke provider sequence / API usage

Quality probe Gemma 3회만 실행. Smoke Gemini 0 / primary Gemma 0 / face Gemma 0. Retry, fallback, full geometry, portrait detail, image generation, critique, pairwise, evaluator 모두 0.

## 22. HTTP / PNG / final atlas

Live Gemma는 native binding success이며 binding에서 별도 HTTP status는 노출되지 않아 null로 기록했다. Live `/api/generate` HTTP/PNG 결과는 없다. Mock 생성은 HTTP 200 / 64×64 / validateFinalAtlas PASS. Frozen 12 atlas도 validation PASS.

## 23. Hair geometry false 여부

Full head geometry가 없는 synthetic face-only 테스트와 wavy live에서 hair usage가 false이다. Short/long live에서는 기존 실제 full head geometry로 인해 true였으며 새 face-only가 만든 값이 아니다. Full head 공존과 미존재를 각각 offline 검증했고 HairPlan은 동일했다. 후속 live harness는 historical full geometry를 제거한다.

## 24. Likeness / tests / build

- 시작 시점의 quantizer/plan 코드를 별도 baseline artifact로 고정하고, 12명 전체 plan 및 atlas를 실제 비교: **diff 0**.
- Strict boundary **12/12**, craft **12/12**, fabrication **0**, calibrated five atlas regression **0**.
- 전체 Workers: **815 PASS / 64 SKIP / 0 FAIL**, 74 files passed.
- 이후 최종 focused: **23 PASS / 2 SKIP**. Existing eyes/brows/mouth/nose/contour/part-sweep/hair ownership/P5/Compact 회귀 포함.
- TypeScript PASS. ESLint PASS. `git diff --check` PASS (기존 LF/CRLF 경고만).
- Wrangler 4.120.0 dry-run PASS; deploy 없음.
- App production build는 기존 `apps-in-toss.config appName` 미설정으로 FAIL. 이 설정이나 frontend source는 수정하지 않았다.
- Secret scan: 31개 task 파일/artifact에서 configured secret 일치 0, live artifact 금지 payload 0. Raw provider response, request, prompt, source image, base64를 새 live artifact에 저장하지 않았다.

## 25. Primary reliability core diff

`gemini.ts`, `quota.ts`, `gemmaPhotoAnalysis.ts`, Compact v2/v3 implementation, full geometry 및 기존 full enrichment, `wrangler.jsonc`의 bytes가 시작 시점과 동일하다. `analysis.ts`는 internal optional type import/field만 추가했다. Primary analysis 함수 전체 및 generate의 enrichment 이전 primary path와 이후 heavy chain 문자열도 동일함을 확인했다.

신규 production 코드 범위는 face-only type/validator/runner, 작은 face resolver와 orchestration, optional flag, face/hair provenance 연결이다. Production 모델 목록, primary timeout/quotas/fallback 분류, 이미지 생성/critique/pairwise는 변경하지 않았다. Cloudflare Workers/Wrangler 지침에 따라 기존 [native Workers AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/)을 재사용하고 배포 대신 dry-run으로 검증했다.

## 26. Activation 판단 / 다음 한 가지 작업

Production `FACE_GEOMETRY_ENRICHMENT_ENABLED`는 미설정/OFF. Activation 불가. 다음 작업은 **보이는 chin-side measurement가 3/3 unknown으로 빠지는 측정 정의와 evidence coverage를 offline에서 검토하는 것**이다. Chin을 임의로 채우거나 validator를 완화하지 않고, 이후 별도 승인된 측정에서 chin coverage와 non-empty lower-face topology를 확인해야 한다.

Artifacts: `workers/evaluation-artifacts/face-only-geometry-20260914/` 아래 `live-001/measurements.json`, `preflight-tight.json`, `crop-review.json`, `frozen-regression.json`, `verification.json`. 모든 과거 결과는 별도로 보존했다.

BLOCKED: face-only 응답의 chin이 3/3 unknown이어서 usable chin 0/3이며 activation에 필요한 최소 2개 source의 chin geometry를 확보하지 못함
