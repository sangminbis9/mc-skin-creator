import { useEffect, useState } from 'react';
import { deleteSkin, readSkins, type SavedSkin } from '../lib/skinLibrary';
import { exportPng } from '../lib/nativeExport';
import { decodeSkinPng } from '../lib/skinDecode';
import { exportSkinPng, EXPORT_FILENAMES } from '../lib/javaBedrockExport';

export function LibraryPage({ onOpen }: { onOpen: (skin: SavedSkin) => Promise<void> }) {
  const [skins, setSkins] = useState<SavedSkin[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  useEffect(() => { try { setSkins(readSkins()); } catch { setError('보관함을 읽을 수 없습니다. 저장 공간과 앱 설정을 확인해 주세요.'); } }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch { setError('작업을 완료하지 못했거나 취소했습니다. 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }
  return <section className="px-screen">
    <h1 className="px-title">내 스킨 보관함</h1>
    <p className="px-subtitle">이 기기에 최대 40개 저장됩니다. 앱을 삭제하면 사라질 수 있으니 중요한 스킨은 PNG로 내보내세요.</p>
    {error && <p role="alert">{error}</p>}
    {!skins.length && <p>아직 저장한 스킨이 없어요. 샘플을 열거나 사진으로 만든 다음 ‘보관함에 저장’을 눌러 주세요.</p>}
    <div className="skin-library">{skins.map(skin => <article className="px-panel" key={skin.id}>
      <img src={skin.png} alt={skin.name} width="128" height="128" className="px-pixelated" />
      <h2>{skin.name}</h2><p>{skin.geometry === 'slim' ? '슬림 · 3px' : '클래식 · 4px'}</p>
      <button className="px-btn" disabled={busy} onClick={() => void run(() => onOpen(skin))}>열어서 편집</button>
      <button className="px-btn px-btn--ghost" disabled={busy} onClick={() => void run(async () => {
        const canvas = await decodeSkinPng(skin.png.split(',')[1]);
        if (!canvas) throw new Error('스킨을 읽을 수 없습니다.');
        const format = skin.geometry === 'slim' ? 'java-slim' : 'java-classic';
        await exportPng(exportSkinPng(canvas, format), EXPORT_FILENAMES[format]);
      })}>PNG 내보내기</button>
      {pendingDelete === skin.id ? <div role="group" aria-label="삭제 확인"><p>이 스킨을 보관함에서 삭제할까요?</p><button disabled={busy} onClick={() => {
        try { deleteSkin(skin.id); setSkins(readSkins()); setPendingDelete(null); } catch { setError('삭제할 수 없습니다. 다시 시도해 주세요.'); }
      }}>삭제하기</button> <button onClick={() => setPendingDelete(null)}>취소</button></div>
        : <button className="studio-text-btn" disabled={busy} onClick={() => setPendingDelete(skin.id)}>삭제</button>}
    </article>)}</div>
    <a href="#/">스튜디오로 돌아가기</a>
  </section>;
}
