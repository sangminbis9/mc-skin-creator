# mc-skin-creator

**사진으로 나만의 마인크래프트 스킨을 생성해보세요!**

얼굴/전신 사진을 올리면 AI가 인물 특징(피부톤·머리스타일·안경·옷차림 등)을 분석해
닮은 마인크래프트 스킨을 만들어주는 **앱인토스 미니앱**입니다.
생성된 스킨은 3D로 미리보고, 3D 모델 위에서 직접 픽셀 편집하거나 2D 템플릿에서 수정한 뒤,
Java(Classic/Slim) / Bedrock용 PNG로 다운로드할 수 있습니다.

## 아키텍처

```
[앱인토스 웹뷰 (React + TS + Vite)]
  ├─ 사진 리사이즈/압축 (기기에서, 긴 변 448px — FLUX 입력 제한 512 미만)
  ├─ 품질 체크 휴리스틱 (해상도/밝기/선명도)
  │
  ├─ POST /api/generate ──▶ [Cloudflare Worker]
  │                           ├─ KV quota 확인 (Neurons/day 자체 제한)
  │                           ├─ ① llama-4-scout 사진 분석 (analysis.ts)
  │                           │    quality 게이트 + framing(face/upper_body/…)
  │                           │    + observed/inferred 구분 + 생성 프롬프트
  │                           ├─ ② FLUX.2 [klein] 4B 이미지 생성 (skinProvider.ts)
  │                           │    사진을 직접 참조해 정면 픽셀 캐릭터 생성
  │                           ├─ ③ 결정적 pack (skinPack.ts)
  │                           │    배경 분리 → 부위 슬라이스 → 64x64 UV atlas 조립
  │                           ├─ ④ UV 검증 (skinPost.ts) — 실패 시 seed 바꿔 1회 재시도
  │                           │    (사진은 요청 처리 후 즉시 폐기, 저장 안 함)
  │                           └─ KV 운영 지표 카운트
  │
  ├─ 응답의 skinPngBase64 → 64x64 캔버스 (skinDecode.ts)
  │   └─ 이미지 생성 실패 시: 특징 JSON → 절차적 생성 fallback (skinFromFeatures.ts)
  ├─ three.js 3D 미리보기/페인터 + 2D 캔버스 에디터 (동기화)
  └─ Java Classic/Slim, Bedrock PNG export → 기기 저장
```

핵심 설계: **관찰(observed)과 추론(inferred)을 구분합니다.** 분석 단계가 사진에
보이는 특징과 보이지 않아 추론한 부분을 분리해 반환하고, framing별 정책(얼굴만 /
상반신 / 전신)에 따라 보이는 의상은 보존하고 안 보이는 부분만 조화롭게 완성합니다.
이미지 생성 모델은 UV atlas 배치를 지키지 못하므로(실측), FLUX에는 정면 캐릭터
1장만 시키고 **UV 배치는 서버 코드가 결정적으로 보장**합니다(front_pack 전략).
생성이 두 번 실패하면 기존 절차적 생성기로 자동 fallback합니다.

- feature flag: `workers/wrangler.jsonc` — `IMAGE_GENERATION_ENABLED`("true"/"false"),
  `IMAGE_GEN_STRATEGY`("front_view" 기본 / "direct_atlas" 실험용)
- 스타일 참고 스킨(선택): 로컬은 `workers/.dev.vars`의 `STYLE_REF_B64`,
  운영은 KV `asset:style-ref-448` — 사용 권리가 확인된 이미지만 사용할 것.
  없으면 참고 없이 동작합니다 (front_view 전략은 참고 이미지를 쓰지 않음).

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
               skinProvider(FLUX 호출), skinPack(정면 뷰→atlas),
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

`.env.example` 참고. Worker 쪽은 별도 시크릿 없이 바인딩(AI, KV)만 사용합니다.

## quota 정책

- Cloudflare 무료 10,000 Neurons/day 중 `DAILY_BUDGET_RATIO`(기본 0.5 = 5,000)만 사용
- 단계별 예상 비용 (`workers/src/quota.ts`, 공식 단가 기준 환산):
  - 사진 분석 (llama-4-scout): ~170 Neurons
  - 이미지 생성 (FLUX, 입력 1타일 + 출력 512x512 1타일): ~33 Neurons
  - 정상 1회 합계 ~203 Neurons → 하루 약 24회 (재시도 발생 시 +33)
- 리셋: 00:00 UTC = **매일 오전 9시 KST** (Cloudflare 무료 리셋과 동일)
- 소진 시 AI 호출 전에 차단, 사용자에게는 "생성 가능/거의 마감/오늘 마감"으로만 노출
- 실제 발생한 AI 비용은 성공/실패와 무관하게 집계 (무료 한도 보호가 목적)
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
