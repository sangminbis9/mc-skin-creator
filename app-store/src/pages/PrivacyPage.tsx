import { useState } from 'react';
import { clearGenerationCache } from '../lib/cloudflareAI';

export function PrivacyPage() {
  const [message, setMessage] = useState('');
  return <article className="web-document">
    <a href="#/">← 스튜디오로 돌아가기</a><h1>내 사진은<br />내 선택으로.</h1>
    <p className="web-lead">마크 스킨 뚝딱 · 사진 및 기기 저장 안내</p>
    <h2>전송되는 정보와 목적</h2><p>동의 후 직접 선택하여 생성을 요청한 사진만 전송합니다(최대 5장). 앱에서 축소·압축한 이미지를 Cloudflare의 스킨 생성 서버와 Cloudflare Workers AI에 보내 외형 특징을 분석하고 스킨을 만듭니다. 원본 EXIF 정보는 캔버스 재인코딩 과정에서 전달하지 않습니다. 사용 권한이 있는 사진만 선택해 주세요.</p>
    <h2>AI 처리</h2><p>연결된 생성 API는 Cloudflare Workers AI로 보이는 특징을 분석하고 렌더러로 텍스처를 만듭니다. 보이지 않는 옷이나 각도는 추정하므로 실제와 다를 수 있습니다. 신원 확인 서비스가 아닙니다. 사진을 보내지 않아도 샘플 편집, 보관함 및 PNG 내보내기를 이용할 수 있습니다.</p>
    <h2>서버와 서비스 제공자</h2><p>앱 서버는 업로드 사진이나 생성 스킨을 의도적으로 영구 저장하지 않고 요청 처리 중 메모리에서 사용합니다. 사용량 집계와 오류 진단은 보관될 수 있으며 Cloudflare는 인프라 운영에 필요한 요청 메타데이터를 처리합니다. 서비스 제공자의 처리는 해당 정책을 따릅니다.</p>
    <p><a href="https://www.cloudflare.com/privacypolicy/" target="_blank" rel="noreferrer">Cloudflare 개인정보 정책</a> · <a href="https://developers.cloudflare.com/workers-ai/platform/data-usage/" target="_blank" rel="noreferrer">Workers AI 데이터 사용 안내</a></p>
    <h2>기기에 저장되는 정보</h2><p>중복 생성을 줄이기 위해 완료된 스킨, 편집용 특징, 입력 이미지 해시를 최대 24시간 재사용합니다. 원본 사진은 이 캐시에 포함하지 않습니다. 만료된 항목은 다음 생성 요청 때 정리되며, 정확히 24시간 뒤에 기기에서 자동 삭제되는 것은 아닙니다.</p>
    <button className="px-btn px-btn--ghost" onClick={() => {
      try { clearGenerationCache(); setMessage('생성 캐시를 지웠습니다. 보관함에 직접 저장한 스킨은 유지됩니다.'); }
      catch { setMessage('기기 저장소에 접근할 수 없습니다. 앱 설정을 확인해 주세요.'); }
    }}>생성 캐시 지우기</button>
    {message && <p role="status">{message}</p>}
    <h2>내 스킨 보관함</h2><p>직접 저장한 스킨은 이 기기의 앱 저장소에 삭제할 때까지 보관합니다(최대 40개). 사진은 저장하지 않습니다. 각 스킨은 보관함에서 삭제할 수 있습니다. 앱 삭제나 기기 초기화 시 사라질 수 있으므로 중요한 스킨은 PNG로 내보내세요.</p>
    <h2>공유와 광고</h2><p>광고·추적 SDK나 계정 로그인이 없습니다. 내보내기를 선택하면 임시 PNG 파일을 iOS 공유 메뉴에 전달하고 메뉴가 닫힌 뒤 임시 파일을 삭제합니다. 공유 대상 앱과 저장 위치는 직접 선택합니다. 스튜디오 링크는 공개 웹 서비스로 연결되며 개인 사진이나 스킨을 공개하지 않습니다.</p>
    <a href="#/library">내 스킨 보관함 →</a>
  </article>;
}
