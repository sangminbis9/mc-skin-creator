# mc-skin-creator

**사진으로 나만의 마인크래프트 스킨을 생성해보세요!**

얼굴/전신 사진을 올리면 AI가 인물 특징(피부톤·머리스타일·안경·옷차림 등)을 분석해
닮은 마인크래프트 스킨을 만들어주는 **앱인토스 미니앱**입니다.
생성된 스킨은 3D로 미리보고, 3D 모델 위에서 직접 픽셀 편집하거나 2D 템플릿에서 수정한 뒤,
Java(Classic/Slim) / Bedrock용 PNG로 다운로드할 수 있습니다.

## 아키텍처

```
[앱인토스 웹뷰 (React + TS + Vite)]
  ├─ 사진 리사이즈/압축 (기기에서, 긴 변 448px)
  ├─ 품질 체크 휴리스틱 (해상도/밝기/선명도)
  │
  ├─ POST /api/generate ──▶ [Cloudflare Worker]
  │                           ├─ KV 기반 앱 사용량 확인
  │                           ├─ ① Gemini 멀티모달 분석 + 확대 인물 재검사 (analysis.ts)
  │                           │    canonical identity + observed/inferred + 렌더 힌트
  │                           ├─ ② body/face/layer별 결정적 스킨 계획 (skinPlan.ts)
  │                           ├─ ③ Gemini 이미지 생성 → Workers AI 복구 (skinProvider.ts)
  │                           │    사진+고정 포즈 가이드로 정면/후면/측면 뷰 생성
  │                           ├─ ④ 결정적 pack + UV/레이어 검증 (skinPack.ts, skinPost.ts)
  │                           │    얼굴 identity 보존 + 보이지 않는 면의 일관된 완성
  │                           ├─ ⑤ 6시점 소프트웨어 렌더 + 구조 검사 (skinRender.ts)
  │                           ├─ ⑥ Gemini 닮음 비평 → 부위 한정 1회 수정
  │                           │    (skinCritique.ts, skinCorrection.ts)
  │                           ├─ 이미지 생성 불가 시 동일 분석으로 절차적 atlas 생성
  │                           │    → 같은 6시점 비평 후 관찰 근거만 강화해 1회 재렌더
  │                           │    (사진은 요청 처리 후 즉시 폐기, 저장 안 함)
  │                           └─ KV 운영 지표 카운트
  │
  ├─ 응답의 skinPngBase64 → 64x64 캔버스 (skinDecode.ts)
  │   └─ 구버전 응답에 PNG가 없을 때만 클라이언트 절차적 생성 폴백
  ├─ three.js 3D 미리보기/페인터 + 2D 캔버스 에디터 (동기화)
  └─ Java Classic/Slim, Bedrock PNG export → 기기 저장
```

핵심 설계: **관찰(observed)과 추론(inferred)을 구분합니다.** 분석 단계가 사진에
보이는 특징과 보이지 않아 추론한 부분을 분리해 반환하고, framing별 정책(얼굴만 /
상반신 / 전신)에 따라 보이는 의상은 보존하고 안 보이는 부분만 조화롭게 완성합니다.
이미지 생성 모델은 UV atlas 배치를 직접 책임지지 않고 캐릭터 뷰만 생성합니다.
**UV 배치는 서버 코드가 결정적으로 보장**합니다.
생성이 두 번 실패하면 기존 절차적 생성기로 자동 fallback합니다.

한 사람의 사진을 최대 5장까지 넣을 수 있습니다. 첫 사진은 주 구도/의상 근거이고,
나머지는 같은 사람의 얼굴·머리·측면 단서를 보완합니다. 분석 결과는 3~8개의
`mustPreserve` 특징과 중요도 1~5의 salience 목록을 만들고, 생성·비평·수정 단계가
모두 그 우선순위를 공유합니다. 다섯 장 모두 최종 6면 비평에도 전달되며, 한 보조
사진이 기본 사진과 나머지 사진의 안정적인 신원 단서에 명백히 어긋나면 그 사진의
충돌 특징을 섞지 않고 기본 사진과 다수 일치 단서를 우선합니다.

Java Slim 다운로드는 네 개의 팔 UV 영역을 Mojang 3픽셀 팔 배치로 변환합니다.
변환 외 영역의 픽셀 보존, 미사용 셀 투명화, 실제 3픽셀 3D 형상 렌더링을 자동
테스트로 검증합니다.

- feature flag: `workers/wrangler.jsonc` — `IMAGE_GENERATION_ENABLED`("true"/"false"),
  `IMAGE_GEN_STRATEGY`("front_view" / "four_view", 현재 기본은 `four_view`)
- 이미지 모델: `GEMINI_IMAGE_MODEL`, `GEMINI_IMAGE_QUALITY_MODEL`. 기본 모델의 할당량이 닫혔거나 모델을 사용할 수 없으면 `GEMINI_IMAGE_FALLBACK_MODEL`을 사용합니다.
  `IMAGE_MODEL_TIER`로 사용할 모델을 선택합니다.

## 디렉터리 구조

```
src/
  pages/       화면 (업로드, 품질체크, 생성중, 미리보기, 편집, 다운로드, 공유,
               적용 가이드, 마감 안내, /admin 현황판, 개인정보 안내)
  components/  픽셀 UI 컴포넌트 (PixelButton 등) + AdLoadingPanel
  editor/      SkinModel(three.js), SkinViewer3D, SkinPainter3D,
               SkinTemplate2DEditor, editorState(undo/redo, 2D/3D 동기화)
  lib/         skinAtlas, skinFromFeatures, skinFeatures, skinDecode,
               javaBedrockExport, imageQuality, cloudflareAI(API 클라이언트),
               shareSkin, download
  styles/      pixel.css (픽셀 게임 디자인 시스템)
workers/
  src/         index(라우팅), analysis(사진 분석), skinPrompt(프롬프트),
               gemini(Gemini REST API), skinProvider(이미지 생성), skinPack(캐릭터 뷰→atlas),
               skinPost(축소/마스크/검증), png(PNG/JPEG 코덱), uvLayout,
               generate(오케스트레이션), quota, analytics
  scripts/     build-assets.mjs (UV 가이드 자산 생성)
  test/        vitest 단위 테스트 (실제 AI 호출 없음 — CI 안전)
```

## 실행 방법

### 1. 프론트엔드 (앱인토스 미니앱)

```bash
npm install
cp .env.example .env.local   # VITE_API_BASE_URL을 Worker 주소로 수정
npm run dev                   # granite dev — 샌드박스 앱에서 QR로 접속 가능
```

브라우저에서도 대부분의 기능(업로드/생성/편집/다운로드)이 동작합니다.
광고·앨범·기기 저장·토스 공유는 토스 앱/샌드박스에서만 동작하고 브라우저에서는 폴백됩니다.

### 2. Cloudflare Worker

```bash
cd workers
npm install
npx wrangler login
npx wrangler kv namespace create MCSKIN_KV   # 발급된 id를 wrangler.jsonc에 기입
npx wrangler secret put GEMINI_API_KEY         # Gemini 키를 운영 secret으로 등록
npm run dev                                   # 로컬: http://localhost:8787
npm test                                      # 단위 테스트 (AI 호출 없음)
npm run deploy                                # 배포
```

배포 후 나온 Worker URL을 프론트의 `.env.local`(`VITE_API_BASE_URL`)에 넣으세요.

### 3. 빌드 / 앱인토스 배포

```bash
npm run build     # ait build
npm run deploy    # ait deploy (앱인토스 콘솔 연동 필요)
```

## 환경변수

| 변수 | 설명 |
| --- | --- |
| `VITE_API_BASE_URL` | Cloudflare Worker API 주소 (예: `https://mc-skin-creator-api.xxx.workers.dev`) |
| `GEMINI_API_KEY` | Worker 전용 Gemini API 키. 로컬은 `workers/.dev.vars`, 운영은 Wrangler secret 사용 |
| `WORKERS_VISION_MODEL` | Gemini가 Cloudflare 실행 위치 또는 Gateway 인증을 거부할 때 사용하는 계정 내부 멀티모달 분석 모델 (기본 `@cf/meta/llama-4-scout-17b-16e-instruct`) |
| `VISION_MODEL` | 사진 분석 모델 (기본 `gemini-3.6-flash`) |
| `GEMINI_IMAGE_MODEL` | 이미지 생성 모델 (기본 `gemini-3.1-flash-image`, 이미지 quota/결제 필요) |
| `GEMINI_IMAGE_FALLBACK_MODEL` | 기본 이미지 모델의 할당량이 닫혔거나 모델을 사용할 수 없을 때만 시도하는 폴백 (기본 `gemini-3.1-flash-lite-image`) |
| `WORKERS_IMAGE_MODEL` | Gemini 이미지 생성 실패 시 사용하는 Cloudflare 이미지 편집 모델 (기본 `@cf/black-forest-labs/flux-2-klein-4b`) |
| `WORKERS_IMAGE_QUALITY_MODEL` | 첫 Cloudflare 복구 시 사용하는 고품질 모델 (기본 `@cf/black-forest-labs/flux-2-klein-9b`) |
| `WORKERS_IMAGE_FALLBACK_ENABLED` | `false`일 때만 Workers AI 이미지 복구를 끔 (기본 활성) |

프런트는 `.env.example`, Worker secret 형식은 `workers/.dev.vars.example`을 참고하세요.
`GEMINI_API_KEY`를 `VITE_` 변수나 `wrangler.jsonc`에 넣으면 클라이언트/저장소에 노출될 수 있습니다.

## 사용량 정책

- KV 사용량 게이지는 앱 내부의 보수적 예상치이며 Gemini 결제/쿼터 화면을 대체하지 않습니다.
- Gemini의 실제 가격·요청 한도는 선택한 모델과 Google AI 프로젝트 설정을 따릅니다.
- Gemini 이미지 quota가 닫히거나 생성 호출이 실패하면 Workers AI FLUX.2 klein 4B로 한 번 더 생성하고, 두 공급자가 모두 실패해도 검증된 절차적 스킨 fallback은 계속 동작합니다.
- Gemini가 실행 위치나 Gateway 인증을 거부하면 구조화 사진 분석·비평도 Workers AI로 전환됩니다.
- 일시적인 rate limit은 일일 소진과 구분하며 앱 전체 quota를 닫지 않습니다.
- 일일 quota 차단은 Workers AI 무료 할당량 정책에 맞춰 **UTC 자정**에 리셋됩니다.
- 실제 Gemini 한도와 비용은 Google AI Studio 또는 Google Cloud 콘솔에서 확인하세요.
- 재생성 기능 없음 — 1회 생성 후 편집기로 수정

## 개인정보

- 원본 사진은 기기에서 축소(긴 변 448px) 후 전송, Worker는 분석·생성 요청 처리
  동안만 메모리에 유지하고 즉시 폐기 (저장 없음)
- 생성 결과물도 서버 미저장 — 모든 스킨은 클라이언트에서 생성/보관
- 업로드 전 동의 체크박스 + `#/privacy` 안내 페이지 제공

## 운영 현황판

`{앱 URL}#/admin` — 인증 없는 공개 조회 전용. 생성 시도/성공/실패, 성공률,
광고 노출, 공유 클릭/링크 생성, 다운로드 수, quota 사용률/남은 횟수/리셋 시간을
보여줍니다. **조작 기능은 없습니다.**

## 출시 전 체크리스트

### 콘솔 설정 (TODO)
- [ ] 앱인토스 콘솔에서 `mc-skin-creator` 앱 등록 (appName 일치 확인)
- [ ] `granite.config.ts` — `brand.icon` 앱 아이콘 URL 채우기
- [ ] `src/components/AdLoadingPanel.tsx` — 실제 광고그룹 ID로 교체
- [ ] `src/lib/shareSkin.ts` — 공유 스킴/OG 이미지 URL 확인
- [ ] `workers/wrangler.jsonc` — KV namespace id 교체
- [ ] Worker 배포 후 `.env.local` / 배포 환경변수에 `VITE_API_BASE_URL` 설정

### 기능 테스트 (기기)
- [ ] 샘플 팝업 표시/닫기, "사진 올리고 시작하기"
- [ ] 사진 업로드 (파일 선택 + 앨범 가져오기), 동의 체크 없이는 버튼 비활성
- [ ] 품질 체크 PASS/WARN/FAIL 각각 (작은 사진, 흐린 사진으로)
- [ ] 생성 중 화면: 진행도/단계 메시지, 광고 노출(토스 앱)
- [ ] quota 소진 상태에서 마감 안내 노출 (KV 값 수동 조작으로 테스트 가능)
- [ ] 3D 미리보기: 회전/줌/앞뒤좌우 버튼
- [ ] 3D 페인트/지우개/스포이드, 회전 모드 전환, 부위 필터
- [ ] 2D 템플릿 편집 + 3D와 동기화, 되돌리기/다시 실행
- [ ] Java Classic/Slim/Bedrock/전체 다운로드 → 실제 게임에서 적용 확인
- [ ] 공유: 이미지 공유, 토스 링크 생성/진입
- [ ] 적용 가이드 Java/Bedrock 탭
- [ ] `#/admin` 현황판, `#/privacy` 안내
- [ ] 네트워크 끊김 상태에서 실패 화면 + 다시 시도

### 정책 확인
- [ ] 광고는 생성 중 화면에서만 노출되는지
- [ ] 서버에 사진/결과물이 저장되지 않는지 (Worker 코드 리뷰)
- [ ] 닮음 점수/특징 분석 결과가 사용자에게 노출되지 않는지
- [ ] Minecraft 상표/공식 리소스 미사용 (자체 픽셀 스타일)

## 라이선스 참고

- 픽셀 한글 폰트: [Galmuri](https://galmuri.quiple.dev) (SIL OFL 1.1) — `src/assets/fonts/`
- 본 서비스는 Mojang/Microsoft와 무관한 팬 도구이며, Minecraft 상표·공식 리소스를 사용하지 않습니다.
