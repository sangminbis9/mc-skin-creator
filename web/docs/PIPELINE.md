# Skin Studio Web 파이프라인 아키텍처

기준: 2026-10-24의 로컬 `web/` 구현. 미래 제안이 아니라 현재 코드의 실행 구조를 설명한다. 기존 생성 서버의 내부 구현은 `workers/src/`를 읽어 외부 의존성으로 확인했다. 해당 서버 소스는 `web/`에 포함되지 않는다.

- [인터랙티브 설계도](./pipeline-architecture.html)
- [수정 가능한 Archify 원본](./pipeline.architecture.json)
- [자동 브라우저 검증 기록](./pipeline-architecture.visual-check.json)
- [제작·검증 영수증](./architecture-receipt.json)

설명은 한국어이며, Archify 고정 뷰어 UI와 HTML 언어 속성은 영어 기본값을 사용한다. HTML은 외부 라이브러리 설치 없이 파일 자체로 열 수 있다.

## 1. 실행 및 배포 경계

| 경계 | 구성 요소 | 책임 |
|---|---|---|
| 사용자 브라우저 | React, Three.js, Canvas, localStorage | 사진 축소, 품질 확인, API 호출, 응답 검증, 편집, PNG 내보내기 |
| 웹 전용 Worker | `mc-skin-studio-web` | `dist` 정적 파일 제공, 허용된 API 경로만 중계 |
| 기존 생성 Worker | `mc-skin-creator-api` | 입력 검사, AI 분석·스킨 생성, 결과 검증, 예산 제어 |
| 기존 Cloudflare 자원 | Workers AI, `NEURON_BUDGET` | 모델 실행과 원자적 사용량 예약·정산 |

`npm run build`는 TypeScript 검사 후 Vite로 `dist/`를 생성한다. `npm run deploy`는 빌드 후 Wrangler로 웹 Worker와 정적 자산을 배포한다. `/api/*`는 Worker가 먼저 처리하고 나머지는 `ASSETS` 및 SPA fallback으로 제공한다.

개발·preview에서는 Vite가 `/api`를 기존 공개 API 주소로 프록시한다. 운영에서는 `SKIN_API` 서비스 바인딩으로 같은 계정의 기존 Worker를 호출한다. 웹 전용 AI 모델이나 별도 생성 큐를 새로 만든 구조가 아니다.

## 2. 사진 → 편집 가능한 스킨

1. **동의와 입력:** 사용자가 사진 처리에 동의한 후 JPEG/PNG/WebP를 최대 5장 선택한다. 파일당 20MB를 초과하면 브라우저에서 거절한다. 홈 진입 시 `GET /api/quota`를 조회한다.
2. **브라우저 전처리:** 사진을 JPEG로 압축한다. 주 사진은 최대 변 896px의 분석본과 최대 변 448px의 생성본을 준비하며, 작은 사진은 재사용한다. 각 데이터 URL은 1,500,000자 이내로 제한한다. 품질 확인 후 사용자가 생성을 시작한다.
3. **중복과 재사용:** 사진 문자열의 SHA-256을 조합해 요청 키를 만든다. 유효한 완료 캐시가 있으면 API를 호출하지 않고 재사용한다. 진행 중인 동일 요청은 Promise를 공유한다.
4. **동기 생성 요청:** `POST /api/generate`에 `image`, 선택적 `analysisImage`, 최대 4개의 `referenceImages`를 JSON으로 보낸다. 클라이언트 전체 대기 한도는 150초다. 작업 ID를 폴링하는 비동기 작업 큐 방식이 아니다.
5. **웹 게이트웨이:** 경로, HTTP 메서드, 요청 출처, JSON 형식, 선언된 크기를 검사한다. 실제 입력 내용과 본문 제한은 기존 엔진에서도 검증한다. API 응답은 `no-store`이며, 광범위 CORS 헤더는 제거한다.
6. **기존 생성 엔진:** `generateFreeSkin`이 무료 정책과 입력을 확인한다. Workers AI 호출 전에 `NEURON_BUDGET`에 예약하고, 보고된 사용량이 있으면 정산한다. 모델 호출·스킨 합성·검증은 기존 서버 책임이다. 분석 원문 대신 허용된 PNG·공개 특징·상태 필드만 반환한다.
7. **응답 검증:** 클라이언트가 성공 여부와 PNG 헤더/64×64 크기를 검사한다. 완료 캐시는 여기서 저장된다. 이후 `App.tsx`에서 PNG를 실제 디코딩하고 `SkinDocument`를 구성한다. 디코딩 실패는 성공 화면으로 넘기지 않는다.
8. **사용자 완성:** 3D에서 회전 확인, 머리·상의·하의 조합, 2D/3D 픽셀 편집을 수행한다. 이 편집 흐름은 브라우저에서 처리한다.
9. **출력:** 현재 문서를 Classic/Slim/Bedrock 대상 PNG로 내보낸다. 브라우저 다운로드와 공유를 제공하며, Xbox 콘솔 설치나 Marketplace 업로드를 대신 수행하지 않는다.

설계도의 `생성 엔진 → 응답 검증` 선은 논리적 결과 전달이다. 실제 HTTP 응답은 웹 게이트웨이를 되돌아 거쳐 클라이언트에 도착하며, 브라우저가 서비스 바인딩에 직접 접속하지 않는다. 캐시 선 역시 별도 서버 저장을 뜻하지 않는다.

## 3. 분기와 오류 처리

- **샘플:** `loadDemoSkin()` → `SkinDocument` → 미리보기. AI 생성 요청이나 예산을 소비하지 않는다.
- **캐시:** 최대 24시간·8건. 입력 해시, 생성 PNG, 편집 특징, 생성 모드를 저장하며 사진과 분석 원문은 저장하지 않는다. 실시간 quota는 캐시 결과에 고정하지 않는다.
- **한도 초과:** `quota_exceeded`는 생성 마감 화면으로 이동한다. 웹과 토스 앱은 기존 프로젝트 예산을 공유한다.
- **사진 거절:** `photo_rejected`는 사진 교체가 필요한 실패로 표시한다.
- **네트워크·AI 실패:** 실패 화면에서 사용자가 재시도한다. `App.tsx`는 재시도 가능 여부와 횟수(최대 2회)를 제한한다. 클라이언트 중단이 이미 시작된 서버 AI 연산까지 취소한다고 보장하지 않는다.
- **게이트웨이 장애:** 상위 서비스 호출 예외는 503으로 응답한다. 알 수 없는 API 경로는 404, 잘못된 메서드는 405로 거절한다.

## 4. 보안·데이터와 현재 제약

웹에 광고 SDK나 로그인 서비스는 없다. 원본 사진은 정적 배포 자산으로 복사되지 않고 선택한 사진의 축소본만 생성 API로 전달된다. 사용자가 승인한 공개 데모는 인증 없이 접근할 수 있다. 출처 검사와 CORS는 사용자 인증이나 비용 공격 방어를 대체하지 않는다.

`web/`만으로 UI·샘플·편집·빌드는 가능하지만 사진 생성은 외부 API가 필요하다. API 자격 증명은 브라우저에 넣지 않는다. 큰 외부 시연 전에 접근 통제 또는 Turnstile, 데모 전용 예산, 트래픽 제한을 별도로 검토해야 한다. 이 항목들은 **현재 구현된 것으로 표시하지 않은 후속 검토 사항**이다.

## 5. 구현 근거

아래 경로는 저장소 기준이며, 표의 앞부분은 `web/` 내부 경로다.

| 구현 파일 | 확인한 책임 |
|---|---|
| `web/src/pages/UploadPage.tsx` | 동의, 업로드 제한, quota 사전 조회, 샘플 선택 |
| `web/src/lib/imageQuality.ts` | 448/896px 전처리, JPEG 용량 제한 |
| `web/src/lib/cloudflareAI.ts` | 요청 계약, 150초 제한, 해시, 캐시, PNG 헤더 검증 |
| `web/src/pages/GeneratingPage.tsx` | 생성과 실패/한도 초과 분기 |
| `web/src/App.tsx` | 화면 상태, PNG 디코딩, SkinDocument, 사용자 재시도 |
| `web/src/pages/PreviewPage.tsx` | 3D 미리보기, 옷장 진입, 편집 흐름 |
| `web/src/pages/DownloadPage.tsx` | 현재 스킨의 실제 PNG 링크 |
| `web/src/lib/javaBedrockExport.ts` | 대상별 스킨 PNG 변환 |
| `web/server/index.ts` | 경로 허용 목록, 출처 검사, 서비스 중계 |
| `web/wrangler.jsonc` | ASSETS, SKIN_API, 배포 Worker |
| `web/vite.config.ts`, `web/package.json` | 독립 빌드 및 로컬 프록시 |
| `workers/src/engineService.ts` (외부 서비스) | 무료 생성 서비스 경계, AI 호출과 예산 예약 |
| `workers/src/freeBudget.ts` (외부 서비스) | 프로젝트 예산과 모델 상수 |
| `workers/src/generate.ts` (외부 서비스) | 분석 및 스킨 렌더링 파이프라인 |

이 문서와 설계도는 `web/docs/`의 로컬 문서이며 `public/` 또는 `dist/`에 추가하지 않았다. 따라서 기존 웹 배포에 자동 공개되지 않는다.
