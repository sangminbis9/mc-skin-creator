# 실제 마인크래프트 예시 스킨 v3

연출 이미지 방향은 폐기하고 실제 Minecraft 64×64 classic UV atlas를 코드 기반 픽셀 아트로 제작했다. 추가 메시, 곡면, 규격 밖 픽셀 없이 베이스와 외곽 레이어만 사용한다. 사진의 갈색 긴 머리, 아이보리 레이스 상의/롱스커트, 분홍 카디건, 밝은 신발을 제한된 해상도 안에서 표현한다.

- 원본: `src/lib/curatedLaceSkin.ts`
- 실제 PNG: `public/images/woman-lace-skin-v3.png` (Classic)
- 재생성: `node --experimental-strip-types scripts/export-lace-skin.mjs`
- 첫 화면: 실제 텍스처를 Slim 모델로 변환해 Three.js로 표시
- 샘플 편집: 같은 픽셀 원본으로 `SkinDocument` 구성, Slim 기본 선택. 내보내기에서 Classic/Slim을 선택할 수 있음
- 테스트: RGBA 규격, 외곽 레이어의 눈 가림 방지, 얼굴 색상 변화, 생성 PNG와 런타임 픽셀의 완전 일치

실시간 AI 생성 엔진을 개선한 결과라고 표시하지 않는다. 수작업으로 구성한 예시이며 실제 사진 생성 결과는 다를 수 있다. 정면/뒷면을 브라우저에서 검토했으며 빌드와 12개 자동 테스트를 실행했다.
