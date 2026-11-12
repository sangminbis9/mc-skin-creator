# 마크 스킨 뚝딱 — App Store용 iOS 앱

스토어 이름: **마크 스킨 뚝딱 - 사진 한장으로 나만의 스킨 만들기**
홈 화면 이름: **마크 스킨 뚝딱**

React 편집기를 앱에 번들한 Capacitor 8 / iOS 15+ 프로젝트입니다. 이 폴더만 별도 GitHub 저장소에 복사해도 설치·빌드할 수 있습니다. 상위 `web/`, `src/`, 토스 SDK에 의존하지 않습니다. AI 생성 서버는 외부 서비스로 계속 필요합니다.

## 포함된 기능

- 사진 최대 5장과 Cloudflare Workers AI 처리에 대한 명시적 동의
- 실제 64×64 스킨, 3D 미리보기, 2D/3D 픽셀 편집, 의상 조합
- 기기 내 보관함: 최대 40개 저장·재열기·개별 삭제
- Java Classic/Slim 및 Bedrock PNG 내보내기
- 실제 PNG 파일을 iOS 공유 메뉴에 전달: ‘파일에 저장’ 또는 앱 공유
- 인터넷 없이 샘플 편집 및 저장된 스킨 편집 가능
- 안전 영역 레이아웃, 앱 아이콘, 시작 화면, Privacy Manifest
- macOS GitHub Actions의 서명 없는 시뮬레이터 빌드

## Windows에서 확인

Node.js 22.18 이상을 설치한 뒤 이 디렉터리에서 실행합니다.

```sh
npm ci
npm test
npm run build
npm run dev
```

브라우저에서는 다운로드로, iOS에서는 네이티브 공유 메뉴로 내보냅니다. 브라우저 테스트는 iPhone 실기기 검증을 대체하지 않습니다.

기본 API 주소는 `vite.config.ts`에 설정돼 있습니다. 변경할 때 `.env.example`을 `.env.local`로 복사하세요. **AI 키는 앱에 넣지 않습니다.** API 주소는 공개 HTTPS origin이어야 하며, 해당 API에서 `capacitor://localhost` Origin의 CORS preflight와 POST를 허용해야 합니다. 현재 엔진의 CORS 설정은 이를 허용합니다. `web/`의 동일 출처 전용 gateway 주소는 사용하지 마세요.

## Mac에서 iPhone 앱 실행

[Capacitor 8 요구사항](https://capacitorjs.com/docs/getting-started/environment-setup)에 맞는 Xcode 26 이상과 macOS가 필요합니다.

```sh
npm ci
npm run ios:sync
npm run ios:open
```

1. Xcode에서 `App` target → Signing & Capabilities → 본인의 Team을 선택합니다.
2. 기본 Bundle ID는 `com.sangminbis9.skinstudio`입니다. 실제 Developer 계정에서 등록 가능 여부를 확인하세요. 변경 시 `capacitor.config.ts`, Xcode의 Debug/Release Bundle Identifier, `store.config.json`을 함께 수정합니다. `cap sync`만으로 기존 Xcode Bundle ID가 바뀌지는 않습니다.
3. iPhone 또는 시뮬레이터를 선택하고 Run을 실행합니다.
4. 웹 소스가 변경될 때마다 `npm run ios:sync`로 다시 번들합니다. 원격 웹사이트를 로딩하는 `server.url` 설정은 사용하지 않습니다.

Swift Package Manager를 사용하므로 CocoaPods 설치는 필요하지 않습니다. 웹 번들과 플러그인 설정은 `ios:sync`로 생성하며 Git에서 제외합니다. Xcode 프로젝트와 Swift 소스는 포함돼 있습니다.

## GitHub

현재 저장소에서는 루트의 `.github/workflows/app-store-ios.yml`이 `app-store/`를 빌드합니다. **이 폴더만 새 저장소에 복사하면** 내부 `.github/workflows/ios.yml`이 저장소 루트를 자동 인식합니다. 두 파일은 같은 내용입니다.

Actions는 테스트 → 웹 빌드 → Capacitor sync → Apple plist 검사 → 서명 없는 iOS 시뮬레이터 빌드를 실행합니다. `skin-studio-ios-simulator` 아티팩트는 **시뮬레이터용 `.app`**이며 iPhone 설치용 IPA나 App Store 업로드가 아닙니다. 개인/조직의 GitHub macOS 러너 사용량 정책이 적용됩니다. Xcode 26이 없는 runner에서는 명확히 실패하므로 실행 시 runner 이미지를 확인하세요.

## TestFlight와 App Store 제출

Windows에서는 `main` 푸시로 iPhone용 빌드를 서명하고 내부 TestFlight에 업로드할 수 있습니다. Apple 앱 등록, Windows에서 인증서 만들기, GitHub Secrets 입력은 [Windows TestFlight 설정 안내](docs/TESTFLIGHT-WINDOWS.md)를 따르세요. 공개 출시 전 점검은 아래 절차를 사용합니다.

[출시 체크리스트](docs/RELEASE.md)와 [스토어 설명·심사 메모](docs/STORE-METADATA.md)를 따라 진행합니다. [공개 정책·지원 페이지 초안](docs/PUBLIC-PAGES.md)에 실제 운영자·문의처를 채운 뒤 공개 HTTPS 페이지로 게시해야 합니다.

```sh
npm run ios:sync
npm run release:check
```

`release:check`는 아직 입력하지 않은 지원 URL, 정책 URL, 저작권자, Apple Team ID와 실기기·개인정보·자산 확인 여부를 실패로 표시합니다. 현재 누락을 숨기기 위해 임의 값을 넣지 않았습니다. `store.config.json`은 출시 준비 기록이며 Xcode 설정이나 공개 페이지를 자동 수정하지 않습니다.

준비가 끝나면 Xcode에서 실제 iOS 대상 → Product → Archive → Organizer → Distribute App → App Store Connect로 업로드합니다. TestFlight 검증 후 App Store Connect에서 설명·스크린샷·연령 등급·개인정보를 입력하고 심사를 제출합니다. 인증서/프로비저닝, `.p8`, `.p12`, AI 키는 Git에 넣지 마세요.

## 현재 한계와 출처

- [GitHub Actions에서 iOS 시뮬레이터 컴파일을 검증했습니다](https://github.com/sangminbis9/mc-skin-creator/actions/runs/43155311724). TestFlight 서명과 업로드에는 운영자의 Apple 설정이 필요합니다.
- AI는 기존 Cloudflare 엔진의 공유 무료 예산을 사용합니다. 공개 출시 전 용량, 운영 모니터링 및 남용 대응을 확인하세요. 샘플 편집기는 한도와 무관하게 동작합니다.
- 소스는 기존 `web/`의 스냅샷입니다. 이후 편집기 업데이트는 명시적으로 반영해야 합니다. 원본 사진/샘플 자산의 배포 권리도 출시 전에 확인해야 합니다.
- 핵심 진입·보관함·내보내기·개인정보 안내는 한국어이며, 기존 고급 편집기와 가이드 일부는 영어입니다. 전체 한국어 현지화 완료를 주장하지 않습니다.
- 앱 아이콘/시작 화면은 이 프로젝트에서 만든 픽셀 그림입니다. `node scripts/create-assets.mjs`로 재생성합니다.
- Minecraft 공식 제품이 아니며 Mojang/Microsoft의 승인·제휴가 없습니다.

검증 일자: 2026-11-10 (Asia/Seoul).
