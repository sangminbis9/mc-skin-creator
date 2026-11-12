import { useMemo, useState } from 'react';
import type { SkinDocument } from '../editor/editorState';
import type { SkinGeometry } from '../lib/skinAtlas';
import { EXPORT_FILENAMES, exportSkinPng, type ExportFormat } from '../lib/javaBedrockExport';
import { exportPng } from '../lib/nativeExport';

export function DownloadPage({ doc, onBack, onApplyGuide, preferredGeometry }: {
  doc: SkinDocument; onBack: () => void; onApplyGuide: () => void; preferredGeometry: SkinGeometry;
}) {
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const exports = useMemo(() => Object.fromEntries(
    (['java-classic', 'java-slim', 'bedrock'] as const).map(format => [format, exportSkinPng(doc.canvas, format)]),
  ) as Record<ExportFormat, string>, [doc]);
  const preferred: ExportFormat = preferredGeometry === 'slim' ? 'java-slim' : 'java-classic';
  async function save(format: ExportFormat) {
    setBusy(true); setMessage('');
    try {
      await exportPng(exports[format], EXPORT_FILENAMES[format]);
      setMessage('내보내기 메뉴를 닫았습니다. 선택한 위치에서 파일을 확인해 주세요.');
    } catch { setMessage('내보내기를 취소했거나 완료하지 못했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }
  return <div className="px-screen">
    <button className="studio-text-btn" onClick={onBack}>← 스킨으로 돌아가기</button>
    <h1 className="px-title">내 세상으로 가져가세요.</h1>
    <p className="px-subtitle">실제 게임에 적용할 수 있는 64×64 PNG 스킨입니다.</p>
    <figure className="web-export-preview"><img src={exports[preferred]} alt="내보낼 64×64 스킨 텍스처" width="128" height="128" /><figcaption>현재 모델: {preferredGeometry}</figcaption></figure>
    <div className="px-panel"><p>iPhone에서는 내보내기 메뉴에서 <b>파일에 저장</b>을 선택하세요. PNG 텍스처를 원본 그대로 보관할 수 있습니다.</p></div>
    <button className="px-btn" disabled={busy} onClick={() => void save(preferred)}>현재 모델 PNG 내보내기 · {preferredGeometry}</button>
    <button className="px-btn px-btn--ghost" disabled={busy} onClick={() => void save(preferredGeometry === 'slim' ? 'java-classic' : 'java-slim')}>다른 팔 모델로 내보내기 · {preferredGeometry === 'slim' ? 'classic' : 'slim'}</button>
    <button className="px-btn px-btn--ghost" disabled={busy} onClick={() => void save('bedrock')}>Bedrock PNG 내보내기 · Classic</button>
    {message && <p role="status">{message}</p>}
    <p className="px-caption">Java와 지원되는 Windows·모바일 Bedrock에서 사용자 PNG를 가져올 수 있습니다. 콘솔 설치나 Marketplace 등록 기능은 제공하지 않습니다.</p>
    <button className="studio-text-btn" onClick={onApplyGuide}>스킨 적용 방법 →</button>
  </div>;
}
