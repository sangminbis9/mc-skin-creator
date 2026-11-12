# App Store Connect 입력 초안

이 문서는 입력용 초안이며 실제 등록/제출한 상태가 아닙니다.

| 항목 | 값 |
| --- | --- |
| 이름 | 마크 스킨 뚝딱 - 사진 한장으로 나만의 스킨 만들기 |
| 부제 | 사진에서 스킨까지, 편집하고 저장하세요 |
| 기본 언어 | 한국어 |
| 카테고리 후보 | 그래픽 및 디자인 |
| 키워드 초안 | 스킨,픽셀,캐릭터,편집,사진,3D,꾸미기 |
| 가격 | 현재 구현은 결제 없이 사용; 콘솔에서 운영자가 최종 선택 |
| 지원 URL / 개인정보 URL / 저작권 | 실제 운영자 정보 확정 후 `store.config.json`에 기록 |

## 설명

사진 한 장으로 나만의 스킨 만들기, 마크 스킨 뚝딱.

내 사진을 바탕으로 스킨을 만들고 3D로 돌려 보세요. 의상을 조합하거나 픽셀을 직접 편집해 나만의 캐릭터로 다듬을 수 있습니다.

- 사진 최대 5장을 참고해 스킨 생성
- 3D 미리보기와 2D·3D 픽셀 편집
- 기기에 저장하고 다시 편집하는 내 스킨 보관함
- Classic·Slim 및 Bedrock용 64×64 PNG 내보내기
- 사진을 전송하지 않고 시작할 수 있는 샘플 스킨
- 로그인과 광고 없이 사용

AI 생성에는 인터넷이 필요하며 서비스 사용량에 따라 제한될 수 있습니다. 생성 결과와 보이지 않는 부분은 실제 사진과 다를 수 있습니다. 스킨 보관함은 기기에 저장되므로 중요한 파일은 PNG로 별도 보관해 주세요. 고급 편집 도구와 일부 가이드는 영어로 표시됩니다.

Minecraft 공식 제품이 아닙니다. Mojang 또는 Microsoft의 승인이나 제휴를 받지 않은 독립 제작 도구입니다. 콘솔 설치 또는 Marketplace 등록 기능은 제공하지 않습니다.

## 심사 메모 (영문)

The app bundles its editor, sample texture and rendering assets. It does not load a remote website as its main UI. No account or purchase is required.

To test without submitting a photograph, tap “샘플 스킨으로 시작하기” on the first screen. Rotate the 3D model, use “스킨 편집”, then return and tap “보관함에 저장”. Open “보관함” in the top navigation to reopen or delete the saved skin. The library remains on this device across launches. Editing a bundled sample and a saved skin works without Internet access.

Tap “PNG 내보내기”, choose an arm layout, then use the iOS share sheet's Save to Files action. Exported skins are actual 64×64 PNG textures. The temporary export file is removed after the share sheet closes. A cancelled share is not reported as a confirmed save.

Photo generation is an optional network feature. Before selecting photos, the user must explicitly agree to sending the selected images to Cloudflare and Cloudflare Workers AI for appearance analysis and skin generation. The app does not identify people. The connected backend uses a shared usage budget; please ensure operational capacity before submission. This note is not a request to exempt the photo generation feature from review.

There is no advertising/tracking SDK, account system, in-app purchase, community feed or automatic posting. Sharing a link opens the public web studio; it does not upload a private skin. The app is independent of Mojang and Microsoft.

## 스크린샷 촬영 순서

1. 한국어 첫 화면과 실제 샘플
2. 3D 미리보기 및 모델 선택
3. 픽셀 편집기에서 실제 변경한 모습
4. 저장한 스킨이 보이는 보관함
5. PNG 내보내기 화면

App Store 스크린샷은 최종 iPhone/iPad 빌드에서 촬영합니다. Windows 브라우저의 개발용 QA 캡처를 실기기 캡처라고 제출하지 않습니다.
