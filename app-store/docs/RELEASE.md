# App Store 제출 체크리스트

## 개발자 설정

- [ ] Apple Developer Program 계정 및 App Store Connect 앱 레코드 준비
- [ ] Bundle ID 등록 및 Xcode Team 지정, 버전/빌드 번호 확인
- [ ] 실제 운영자 이름, 지원 이메일, 공개 지원 URL, 개인정보처리방침 URL 확정
- [ ] `store.config.json` 입력 및 `npm run release:check` 통과
- [ ] 현재 Apple 업로드 SDK 요건 확인: [Upcoming requirements](https://developer.apple.com/news/upcoming-requirements/)

## 필수 실기기 점검

- [ ] iPhone에서 첫 실행, 노치/홈 인디케이터, 가로 회전, 백그라운드 복귀
- [ ] iPad에서도 회전·3D 편집·공유 팝오버 확인 (현재 universal target)
- [ ] 동의 전 사진 선택 버튼 비활성, 샘플 편집은 가능
- [ ] 사진 선택 취소, 권한 거절, iCloud 사진, HEIC 사진 선택 시 JPEG 변환/안내
- [ ] 1장/5장 사진으로 실제 AI 생성, 네트워크 끊김·타임아웃·사용량 마감 처리
- [ ] 샘플 → 3D/2D 편집 → undo/redo → 저장 → 앱 재시작 → 보관함 재열기
- [ ] 보관함 삭제 확인/취소, 저장 공간 부족 시 기존 스킨 보존
- [ ] Classic/Slim/Bedrock PNG를 ‘파일에 저장’하고 64×64·투명 영역·실제 게임 적용 확인
- [ ] 보관함의 Slim 스킨 내보내기도 3px 팔 변환 확인
- [ ] 공유 취소 후 다시 공유 가능, 임시 파일 정리, 외부 링크 공유에 localhost가 포함되지 않음
- [ ] 비행기 모드의 새 실행에서 샘플 편집 및 기존 보관함 접근
- [ ] 실제 스크린샷 촬영, VoiceOver와 큰 글자 설정 확인

## 개인정보와 정책

Apple [심사 가이드](https://developer.apple.com/app-store/review/guidelines/) 4.2는 웹사이트 이상의 유용한 앱 기능을 요구합니다. 리뷰어에게 로컬 보관함, 번들된 오프라인 편집기, 실제 PNG 내보내기를 설명하세요. 이 기능들이 승인 자체를 보장하지는 않습니다.

5.1.2에 따라 사진이 Cloudflare/Workers AI로 전송된다는 설명과 명시적 동의를 표시했습니다. 서버 공급자나 데이터 처리가 바뀌면 앱 문구와 공개 정책도 함께 수정해야 합니다.

- [ ] 데이터 흐름을 실제 운영 설정과 대조: 사진 → Cloudflare Worker → Workers AI → 기기 결과
- [ ] App Privacy 응답은 사진/영상, 기타 사용자 콘텐츠, 진단·사용 정보와 공급자 보관 정책을 검토해서 작성
- [ ] ‘서버에 사진을 저장하지 않음’만으로 자동으로 ‘데이터 수집 없음’을 선택하지 않음
- [ ] `PrivacyInfo.xcprivacy`를 Xcode Archive에서 확인하고 Privacy Report 검토
- [ ] Filesystem 파일 타임스탬프 `C617.1`, 앱 내부 UserDefaults `CA92.1` 사용 사유 확인
- [ ] HTTPS 및 시스템 암호화만 사용하는 현재 구현에 맞는 수출 규정 응답 확인
- [ ] 기존 샘플 사진·스킨, npm 의존성과 폰트 등 배포 권리/라이선스 확인
- [ ] Minecraft 관련 이름·설명·키워드가 공식 제휴를 암시하지 않는지 확인
- [ ] 연령 등급 질문에 실제 기능 기준으로 응답; Kids Category를 자동 선택하지 않음

개인정보 안내 참고: [Apple App Privacy](https://developer.apple.com/app-store/app-privacy-details/), [Capacitor Filesystem Manifest](https://capacitorjs.com/docs/apis/filesystem), [Cloudflare Workers AI 데이터 사용](https://developers.cloudflare.com/workers-ai/platform/data-usage/).

## 심사와 배포

- [ ] 무료 AI 공유 예산으로 심사 중 생성이 막히지 않도록 운영 용량 확인
- [ ] TestFlight에서 위 실기기 시나리오 완료
- [ ] 공개 지원·정책 URL을 로그아웃 상태와 모바일에서 확인
- [ ] 실제 앱 화면 스크린샷을 App Store Connect가 요구하는 기기 크기로 제출
- [ ] 스토어 설명, 리뷰 연락처, 심사 메모, 연령 등급 입력
- [ ] 유료 기능을 추가한다면 디지털 기능 결제 정책과 StoreKit 구현을 별도 검토 (현재 결제 기능 없음)
- [ ] Archive → Validate → App Store Connect 업로드 → 빌드 선택 → 심사 제출

GitHub 시뮬레이터 빌드 성공과 `release:check`는 이 목록의 실제 완료를 대체하지 않습니다.
