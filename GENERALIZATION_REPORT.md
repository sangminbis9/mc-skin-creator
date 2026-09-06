# Real-photo generalization iteration — 2026-09-05

12명 고정 suite에서 두 종류의 evidence ownership 오류를 수정했다. **제한된 자동 진단은 critical 5→3, major 5→0으로 개선됐지만, 실제 production craft 승인 수는 9/12→9/12다.** 따라서 출시 단계는 demo다. 아래 수치는 production AI 분석 성공이나 전체 likeness 정확도가 아니다.

## 1. 시작 상태

- 최초 preflight HEAD: `3edb47944f1a33e50cb18535d2c3d1598ece68cb`, branch `main`, 기존 head/outfit 관련 dirty 변경 존재.
- 이어서 작업할 때 확인한 HEAD: `20205de379b8a39e41b985e09ce3c4f9acd2dabf`, branch `main`. 이 작업에서 commit하지 않았다. 기존 변경 일부가 이 HEAD에 반영된 상태를 확인하고 보존했다.
- 이번 production 변경은 `identityQuantization.ts`, `outfitIdentity.ts`, `outfitRenderer.ts`. 테스트/로컬 보고서 추가. 기존 변경을 reset/revert하지 않았다.
- Goal 생성, commit, push, deploy 없음. API transport, evaluator, thresholds, CandidateAdmissibility, P5 gate 동결.

## 2. Generalization suite / public dataset acquisition

기존 5명 + 신규 Pexels 7명 = 서로 다른 실제 촬영 인물 12명. 동일 사진 변형을 추가 인물로 세지 않았다. 픽셀 해시 중복 검사와 사진별 육안 확인을 수행했다. 이는 생체 신원 검증이 아니라 fixture 중복 방지다.

| Case | Framing | Pose | Hair | Clothing | Accessory | Lower visible | Lighting |
| --- | --- | --- | --- | --- | --- | --- | --- |
| short-hair-red-shirt | face/shoulder | slight turn | short swept | red top | shoulder detail | no | daylight |
| glasses-monochrome | tight face | frontal | clipped textured | not visible | round glasses | no | monochrome |
| curly-hair | upper body | tilted | jaw curls | gray knit | none | no | warm daylight |
| headscarf-color-blocks | clipped face | frontal | covered | edge only | head covering | no | mixed indoor |
| long-straight-hair | face | slight turn | long/side part | not visible | drop earrings | no | warm daylight |
| buzz-striped | upper body | tilted three-quarter | buzz | collared stripes | none | no | soft indoor |
| bun-check | upper body | head down | high bun | checks/ruffles | bracelet | no | warm studio |
| warm-white-tee | three-quarter | three-quarter | swept waves | tee/check trousers | belt/watch | partial | hard warm sun |
| full-body-layered | full body | frontal | high bun | jacket/inner/shorts/stockings | sunglasses | yes + feet | outdoor shade |
| wavy-open-blazer | upper body | frontal | long waves | blazer/inner | necklace | no | warm low contrast |
| striped-open-shirt | three-quarter | slight turn | very short | striped outer/inner | strap | partial | hard daylight |
| sleeveless-bag-skirt | three-quarter | three-quarter | shoulder waves | sleeveless/skirt | shoulder bag | partial | warm daylight |

신규 Pexels count 7, Wikimedia count 0. 기존 Wikimedia fixture 5. Raw photos/contact sheets tracked in Git: **0**. 원본과 얼굴 포함 artifact는 모두 gitignored local evaluation assets로 제한했다.

로컬 경로: `workers/evaluation-artifacts/generalization-20260905/`. `frozen-manifest.json`에 source URL, author(신규), license, retrieval date, source pixel hash, annotation/adapter hash, tracked=false 저장. `license-supplement.json`에 기존 5개 Commons 파일의 저자·라이선스·출처·표시 의무를 보완했다. 원본 및 crop/resize/diagnostic 변환은 internal development/testing 전용이며 endorsement를 의미하지 않는다. [Pexels License](https://www.pexels.com/license/) 기준으로 사용 범위를 확인했다.

**출처 제한:** 기존 headscarf 파일 페이지의 저자/CC BY-SA 4.0 metadata는 확인했지만, inherited local crop의 어두운 덮개와 파일명의 blue/pink가 달라 원본과 crop의 직접 대응은 독립 검증되지 않았다. 사진을 바꾸거나 제외하지 않았으며, 외부 재배포 금지를 supplement에 명시했다. 이를 완전한 12/12 provenance 검증으로 주장하지 않는다. 신규 7개에는 이 제한이 없다.

## 3. 기존 benchmark 편향

기존 5개는 얼굴/상체 crop 중심, 하의·신발이 전부 보이지 않고 복잡한 layering과 묶은 머리가 부족했다. 신규 suite로 buzz, bun, waves, open layers, 수평/수직/check 패턴, full body, 관찰 가능한 하의, 비대칭 strap, three-quarter, 까다로운 조명을 추가했다. Coily/locks, ponytail, 다인 사진, 극단적 occlusion, 작은 얼굴의 자동 검출은 여전히 충분히 검증하지 못했다.

새 7개는 **manual visible annotation → deterministic adapter**다. 기존 5개만 저장된 calibrated geometry를 추가 사용했다. 새 geometry 측정이나 provider analysis가 성공한 것으로 가장하지 않았다. 자동 crop/localization 및 AI 분석 성능은 analysis coverage limitation이다. 수동 crop은 시각 검토용이고 production 자동 crop 성공 증거가 아니다.

## 4. Before failure distribution

코드 수정 전에 12명 전원과 입력/analysis hash를 freeze하고 baseline 및 `before/ranking.md`를 저장했다. 아래는 사전에 검사한 제한된 자동 항목이다.

| Failure class | critical | major | minor | affected cases |
| --- | ---: | ---: | ---: | ---: |
| PLAN_GENERICIZATION | 2 | 3 | 0 | 3 |
| UNSEEN_COMPLETION | 0 | 2 | 0 | 2 |
| QUANTIZATION_COLLAPSE | 2 | 0 | 0 | 2 |
| RENDERER_LOSS / craft reject | 1 | 0 | 0 | 1 |
| 합계 | 5 | 5 | 0 | 8 distinct |

위 표에는 눈·입·머리 likeness 수동 결함을 전부 포함하지 않는다. SOURCE_LIMITATION은 의복 미관찰 같은 조건으로 기록했으며 그 자체를 generation 오류로 세지 않았다. CROP_FAILURE/MEASUREMENT_FAILURE는 새 실사진 자동 경로가 미실행이므로 0건 검증 완료라고 하지 않는다. UV_CONTINUITY, PALETTE_READABILITY, OWNERSHIP_COLLISION은 별도 수동/수치 진단으로 다룬다.

## 5. Worst cases

1. `wavy-open-blazer`: 입과 관계없는 broad hair 때문에 face candidate 전부 탈락, planner 예외.
2. `sleeveless-bag-skirt`: large bag 때문에 동일 planner 예외.
3. `striped-open-shirt`: outer 긴소매가 inner tank의 sleeveless로 바뀌고, 수직 줄무늬가 수평이 되며 plain 하의까지 줄무늬 생성.

수동 baseline 검토에서도 head covering, round glasses, bun 표현 손실을 기록했다. 자동 subset 순위만으로 머리 품질이 좋다고 결론내리지 않았다.

## 6. Top failure #1

- 증상: 다른 옷의 색/패턴/소매 수식어가 현재 옷에 적용됨.
- Root stage: **plan**. 관찰 clothing prose를 전체 의상 문자열로 읽고 소유 garment/layer를 구분하지 못함.
- Frequency: 5명에서 7개 항목; critical 2 + major 5.
- 영향: 밝은 회색 스웨터 색 손실, 외투 소매 삭제, inner graphic의 outer 귀속, 보이지 않는 하의 패턴 발명.

## 7. 수정 #1

`outfitIdentity.ts`에서 garment/layer별 evidence 범위를 먼저 정한 뒤 color modifier·sleeve·pattern을 해석한다. 하의가 숨겨진 경우 상의 문자열을 재사용하지 않고 명시된 inferred lower evidence를 읽는다. `light gray`, `vertically`, 기존 footwear 어휘를 보존한다. 사례 ID/URL/특정 색 조건 없음.

`outfitRenderer.ts`는 기존 cuff 점유 픽셀의 안쪽/가장자리 명암만 보완했다. 허구의 체크 하의를 제거했을 때 발생했던 craft regression을 물리적 cuff shading으로 해소했고, threshold를 바꾸거나 새 motif를 넣지 않았다. 기존 shoelace 테스트는 다른 소재인 바지 cuff가 아닌 실제 shoe 색 대비를 검사하도록 바로잡았다.

## 8. Top failure #2

- 증상: mouth layout이 폭 2인데 무관한 P5 wide/broad/large 때문에 render contract 최소 폭 4; 후보가 전부 사라짐.
- Root stage: **quantization**.
- Frequency: 독립 신규 2명, critical.
- 원인: 머리/가방/눈 수식어를 입 너비의 근거로 사용한 cross-region leakage.

## 9. 수정 #2

`identityQuantization.ts`에서 priority=5, category=face이고 wide/broad/large가 mouth/smile/grin/lips를 직접 수식할 때만 입 너비 최소값에 적용한다. 실제 wide-mouth 근거는 fallback layout에도 같은 규칙으로 전달한다. P5 hard gate 자체는 그대로이며, 실제 입 너비 보호 회귀 테스트도 유지한다.

Planner 예외는 2→0. 그러나 두 사례 모두 다음 craft 단계에서 머리 seam 오류 20/19로 거부된다. **예외 해소 ≠ 최종 생성 성공**이다.

## 10. Before/after failure distribution

| 제한된 자동 검사 결과 | Before | After |
| --- | ---: | ---: |
| critical | 5 | 3 |
| major | 5 | 0 |
| planner 예외 | 2 | 0 |
| 실제 승인 output | 9/12 | 9/12 |
| inspectable atlas (거부된 진단 포함) | 10/12 | 12/12 |

고친 subset 항목: curly, buzz, bun, full-body-layered, striped-open-shirt 5명. 다음 실패 단계가 드러난 사례 2명. subset 결과 유지 5명. 자동 subset 회귀 0. 전체 source likeness까지 비회귀라고 주장하지 않는다.

별도 after 수동 검토에는 **critical 5, major 21개 남은 시각적 결함**이 있다. 같은 실패를 다른 층위에서 보는 경우가 있어 자동 결과와 합쳐 단일 overall score로 만들지 않았다. 수동 after 결함 수를 사전 자동 before 수와 비교하는 것도 금지한다.

## 11. Cue retention

동결한 60개 annotation cue를 대상으로 보수적으로 수동 판정했다. 복합 cue의 일부만 읽히면 완전 보존으로 세지 않는다. 이 표는 통계적으로 calibrated된 likeness 지표가 아니다.

| Case | Observable | Visible before | Visible after | Usable before→after | Invented hidden pattern before→after |
| --- | ---: | ---: | ---: | --- | --- |
| short-hair-red-shirt | 5 | 3 | 3* | 0→0 | 0→0 |
| glasses-monochrome | 2 | 0 | 0 | 0→0 | 0→0 |
| curly-hair | 5 | 1 | 2 | 1→2 | 0→0 |
| headscarf-color-blocks | 3 | 1 | 1 | 1→1 | 0→0 |
| long-straight-hair | 4 | 3 | 3 | 3→3 | 0→0 |
| buzz-striped | 5 | 4 | 4 | 4→4 | 1→0 |
| bun-check | 5 | 2 | 2 | 2→2 | 1→0 |
| warm-white-tee | 5 | 3 | 3 | 3→3 | 0→0 |
| full-body-layered | 8 | 4 | 4 | 4→4 | 0→0 |
| wavy-open-blazer | 6 | 0 | 3* | 0→0 | N/A→0 |
| striped-open-shirt | 7 | 3 | 5 | 3→5 | 0→0 |
| sleeveless-bag-skirt | 5 | 0 | 3* | 0→0 | N/A→0 |

`*` craft 거부된 pre-gate 진단. short는 before도 거부. Usable은 승인되지 않은 스킨을 0으로 계산한다. 진단상 24→33/60, 실제 승인 출력의 보존 cue는 21→24/60이다. 별도 자동 공통 10명 31항목은 24/31→31/31이지만, 여기에는 hidden-lower inference 검사와 plan-only 소매/패턴 검사가 포함된다. 따라서 31/31을 실제 머리·얼굴·의상 완전 보존율로 사용하면 안 된다.

## 12. Generic convergence

공통 inspectable 10명, 동일 45쌍을 비교했다. Atlas RGBA hash만 비교하지 않고 색 독립적인 pixel partition과 coarse semantic plan tuple을 분리했다.

| Diagnostic / equal pairs | Before | After |
| --- | ---: | ---: |
| semantic face | 2/45 | 2/45 |
| semantic hair | 1/45 | 1/45 |
| semantic head | 0/45 | 0/45 |
| semantic body | 1/45 | 1/45 |
| semantic whole | 0/45 | 0/45 |
| actual head/body/whole pixel-partition near pairs, 각각 | 0/45 | 0/45 |

Semantic tuple은 얼굴 배치/헤어 템플릿·기하/안경 topology/소매/옷 종류·패턴·layer를 포함하고 color·ID·evidence prose는 제외한다. Pixel-partition near는 label 위치 차이 5% 이하라는 diagnostic-only 정의다. 어느 결과도 unique=닮음 증거가 아니다. 새로 inspectable해진 두 실패 사례를 after 분모에 추가해 convergence 개선으로 과장하지 않았다.

## 13. Existing strong cases

기존 5명 **얼굴 전용 stored fixture regression replay PASS**. 원래 face identity signature 및 보호 픽셀/readability assertions를 유지했다. 출력은 `existing-face-regression/`에 분리해 기존 evidence를 덮어쓰지 않았다.

다만 이번 manual adapter 통합 경로에서는 before부터 craft 승인 4/5였고 after도 4/5다. Head UV 바이트 동일 3/5. Curly/headscarf의 입 폭은 무관한 수식어 제거로 변경되었으며, 수동 검토만으로 정확한 표정의 완전한 비회귀까지 증명하지 못했다. 기존 단일 subsystem 강점이 통합 스킨에서 자동 보장되는 것은 아니다.

## 14. Unseen completion

공통 10명 OutfitPlan provenance 60개 field record: observed 32(53.3%), strongly_implied 2(3.3%), conservative/minimum-inference 26(43.3%), 전후 동일. 이는 plan field 비율이지 관찰된 body pixel 비율이 아니다.

보이지 않는 하의 stripe/check 발명 2→0. 없는 하의의 정확한 색/종류를 맞히지 못한 것은 실패로 세지 않았다. 목/소매/몸통 back/side의 관찰되지 않은 부분은 inferred임을 유지했다. 기존 preppy completion 분기는 이번 suite에서 활성화되지 않았으므로 전체 inference hallucination 해결을 주장하지 않는다. Inner graphic와 stockings 손실 같은 under-completion은 남아 있다.

## 15. Visual contact sheet conclusion

`review.html`: case ID, source/head crop, BEFORE/AFTER, 승인/거부 상태, six views 및 base/outer/seam/diff 링크. `after/head-contact-sheet.png`, `after/full-body-contact-sheet.png`: 열 SOURCE | BEFORE | AFTER, 행 위 표 순서. 원본은 `sources/` 또는 기존 ignored source 경로. 얼굴 포함 자료는 Git 비추적.

가시적 개선: gray sweater가 light gray로 복원, hidden check/stripe trousers 제거, outer shirt 긴소매·수직 줄무늬·plain beige trousers 복원. 남은 문제: 번→짧은 cap, 덮개/둥근 안경 손실, curl/wave→길게 분절된 직선 lock, inner graphic/stocking/붉은 stripe 손실.

Striped-open-shirt raw front-side seam similarity 0.817→0.085, side-back 0.826→0.093. 기존 함수는 seam 양쪽 RGB 유사도이며 줄무늬 주기를 해석하지 않는다. 새 수직 패턴의 교대 색은 이 수치를 낮춘다. 실제 oblique/back에서 의상 면은 이어지지만, 이를 모든 UV/패턴 연속성이 완벽하다는 증거로 사용하지 않는다. Bun-check도 0.463/0.473로 낮게 유지된다.

품질 floor: 사용 가능한 cue 기준 worst는 출력 거부 3명 및 glasses 0/2. 중간 수준 예시 curly/bun 2/5. 이 좁은 annotation 기준 best는 buzz 4/5이지만 beard 형태는 여전히 부정확하다. 평균만 보고 release를 판단하지 않았다.

## 16. Performance

공통 10명, case당 warmup 1 + 측정 3회. 아래는 case별 median의 중앙값. Node process CPU는 Windows 해상도 및 런타임 스레드의 영향을 받으므로 Workers edge CPU benchmark가 아니다.

| 비용 | Before | After |
| --- | ---: | ---: |
| production deterministic wall | 22.18 ms | 17.76 ms |
| process CPU | 31 ms | 31 ms |
| body render only | 0.298 ms | 0.246 ms |
| artifact render/encoding/I/O | 362.27 ms | 308.19 ms |
| max bounded candidates | 3 | 3 |

의도적인 random diversity/variant explosion 없음. 각 production 경로는 atlas render 1회. 반복은 offline 성능 측정용이다. Source JPEG 표시용 decoder 256MB는 artifact 처리에만 적용했고 production memory limit은 변경하지 않았다. 사진 decode/crop 비용은 이 production plan/render 시간에 포함되지 않는다.

## 17. API usage

Gemini geometry 0 / absolute evaluator 0 / pairwise evaluator 0 / Interactions 0. Replay의 fetch spy 호출도 0. 테스트 출력의 quota/provider 메시지는 mock 응답이며 실제 호출이 아니다. Pexels/Commons 라이선스 문서 조회는 이미지 출처 확인용 웹 요청이다.

## 18. Tests/build

| 검증 | 결과 |
| --- | --- |
| Workers production TypeScript (`npm run typecheck`) | PASS |
| app/node TypeScript (`npx tsc -b`) | PASS |
| 전체 Workers (`vitest run --maxWorkers=2`) | 622 passed, 32 skipped, 43 files passed / 14 opt-in skipped |
| generalization unit + 12명 artifact + comparison opt-in | 27 passed |
| 기존 5명 얼굴 stored-artifact replay | PASS (1 suite, 5 sentinels) |
| face/short/curly/glasses/headscarf/long/OutfitPlan/base-outer/P5/craft/multi-photo | full Workers 및 별도 replay에 포함, PASS |
| manifest/unique source/annotation/schema/taxonomy/severity/signatures/inference/over-invention/under-completion/candidate cap | 새 unit tests 및 frozen replay, PASS |
| source+analysis freeze | hash/manifest 동일성 PASS, baseline overwrite 사전 차단 |
| ESLint | PASS |
| secret scan | 변경 파일 및 local JSON/MD/HTML secret/inline-image 후보 0 |
| raw source/contact sheet tracked | 0 |
| git diff --check | PASS (LF→CRLF 안내만 있음) |
| production build | PASS; 500KB 초과 chunk 및 upstream shell deprecation warning 존재 |
| Wrangler 4.120.0 dry-run | PASS; 실제 deploy 없음 |

**추가 strict test-source TypeScript 검사 제한:** 정규 Workers tsconfig는 src만 포함한다. 테스트 4개까지 별도로 strict tsc를 적용했을 때 새 파일의 타입 오류는 고쳤으나, 이미 HEAD에 존재하던 `test/helpers.ts:22`의 잘못된 PhotoAnalysis coordinateSpaces와 `:187` geometry 필수 coordinateSpaces 누락, 총 2개 오류가 남는다. 전체 TypeScript가 무조건 모두 통과했다고 보고하지 않는다. 이 공용 helper의 런타임 fixture를 바꾸면 frozen analysis가 달라지므로 이번 비교 중 변경하지 않았다.

Workers best-practices 및 Wrangler skill은 기존 runtime/binding/gate를 유지하는 범위의 검사와 로컬 dry-run에 적용했다. 새 binding/API/config 변경은 없다.

## 19. 현재 출시 준비도

**Demo.** 25%가 craft 승인 output을 내지 못하고, 승인된 경우에도 identity-critical 덮개/안경/번 손실이 있다. 12명은 유용한 실패 탐지 표본이지 실사용 분포에 대한 충분한 통계적 보증이 아니다. Beta/RC로 판정하지 않는다.

## 20. 다음 실제 generation bottleneck

하나만 선택: **HeadIdentityPlan 통합 경로**. 저장된 face/head 단독 fixture는 통과하지만 통합 atlas에서는 accessory/covering 손실 및 두 새 long/wavy 머리 seam 거부가 발생한다. 수동 categorical bun evidence도 short_cap plan으로 줄어든다. 다음 iteration은 source/plan/atlas의 head 소유권 전달을 추적해야 하며 API/evaluator/threshold 변경을 다음 병목으로 선택하지 않는다.

## Q1–Q8

1. 기존 5개가 놓친 축: 묶은 머리, 복합 layering/pattern, 관찰 가능한 하의/신발, full body, strap, three-quarter, 어려운 조명.
2. 사전 자동 진단에서 가장 반복된 failure: 의상 간 evidence leakage, 5명/7항목. 수동 검토의 head/P5 손실도 별도 미해결이다.
3. 주 loss stage: **plan**. 두 번째 독립 failure는 quantization.
4. 제한된 자동 critical 5→3, major 5→0. 실제 승인 9/12→9/12. 전체 critical/major가 0이라는 주장은 하지 않는다.
5. 기존 5명 얼굴 단독 regression은 PASS. 통합에서는 4/5 승인 유지, head byte동일 3/5이므로 전체 외관 완전 비회귀 증명은 아니다.
6. 현재 worst: long/wavy와 가방 사례의 head seam craft reject 및 단순 red top craft reject; 큰 둥근 안경은 승인돼도 source cue 보존이 매우 약하다.
7. Demo.
8. HeadIdentityPlan 통합 경로.

## Reproduce (offline, no baseline overwrite)

로컬 source/manifest가 있는 환경에서 workers 디렉터리 기준:

```powershell
$env:RUN_GENERALIZATION='1'
$env:GENERALIZATION_PHASE='after'
npx vitest run test/generalizationArtifacts.test.ts
$env:RUN_GENERALIZATION_COMPARE='1'
npx vitest run test/generalizationComparison.test.ts
```

`before`는 이미 동결되어 재실행을 거부한다. 먼저 새로운 iteration 디렉터리/새 suite를 명시적으로 구성해야 새 baseline을 만들 수 있다. 일반 unit test는 raw 사진 없이 실행할 수 있다. 로컬 사진 부재는 opt-in replay 한계이며 test 다운로드나 API 호출로 자동 대체하지 않는다.
