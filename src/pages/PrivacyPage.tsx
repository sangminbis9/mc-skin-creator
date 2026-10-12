/**
 * 개인정보 처리 안내 페이지 (#/privacy).
 */

import { PixelPanel } from "../components/pixel/PixelPanel";

export function PrivacyPage() {
  return (
    <div className="px-screen">
      <h1 className="px-title">개인정보 처리 안내</h1>

      <PixelPanel>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>수집·이용하는 정보</h2>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.8 }}>
          업로드한 얼굴/전신 사진 최대 5장 (AI 스킨 생성 목적으로만 사용)
        </p>
      </PixelPanel>

      <PixelPanel>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>처리 방식</h2>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.9 }}>
          <li>사진은 기기에서 축소·압축된 뒤 AI 분석 서버로 전송돼요.</li>
          <li>Cloudflare Workers AI에서 사진 특징을 분석하고 서버가 스킨을 만들어요.</li>
          <li>원본 사진과 생성 결과물은 서버에 저장되지 않아요.</li>
          <li>완성된 스킨은 내 기기에서 미리보기·편집·다운로드할 수 있어요.</li>
          <li>서버에는 개인을 식별할 수 없는 사용량 카운터만 남아요.</li>
        </ul>
      </PixelPanel>

      <PixelPanel>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>보관 기간</h2>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.8 }}>
          사진은 요청 처리 동안 메모리에서 사용하고 처리 완료 후 참조를 해제해요.
          서버에 사진·생성 스킨·사진 분석 내용은 저장하지 않아요.
        </p>
      </PixelPanel>

      <PixelPanel>
        <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>동의 거부 시</h2>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.8 }}>
          사진 처리에 동의하지 않으면 AI 스킨 생성 기능을 사용할 수 없어요.
        </p>
      </PixelPanel>

      <a href="#/" className="px-btn px-btn--stone" style={{ textDecoration: "none" }}>
        돌아가기
      </a>
    </div>
  );
}
