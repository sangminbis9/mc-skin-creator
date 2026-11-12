import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { pngPayload } from './pngPayload';
import { transferPng } from './nativeFileTransfer';

export const PUBLIC_STUDIO_URL = 'https://mc-skin-studio-web.mc-skin-creator-server.workers.dev/';
let exporting = false;

export async function exportPng(dataUrl: string, fileName: string): Promise<void> {
  const data = pngPayload(dataUrl);
  if (!/^[a-zA-Z0-9_-]+\.png$/.test(fileName)) throw new Error('Invalid export filename.');
  if (exporting) throw new Error('다른 내보내기가 진행 중입니다.');
  if (!Capacitor.isNativePlatform()) {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }
  exporting = true;
  const path = `skin-exports/${crypto.randomUUID()}/${fileName}`;
  try {
    await transferPng({
      write: async (path, data) => (await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true })).uri,
      share: async uri => { await Share.share({ title: '마크 스킨 뚝딱', files: [uri], dialogTitle: 'PNG 저장 또는 공유' }); },
      remove: path => Filesystem.rmdir({ path, directory: Directory.Cache, recursive: true }),
    }, path, data);
  } finally {
    exporting = false;
  }
}

export async function sharePublicLink(): Promise<boolean> {
  try {
    if (Capacitor.isNativePlatform()) {
      await Share.share({ title: '마크 스킨 뚝딱', url: PUBLIC_STUDIO_URL });
    } else if (navigator.share) {
      await navigator.share({ title: '마크 스킨 뚝딱', url: PUBLIC_STUDIO_URL });
    } else {
      await navigator.clipboard.writeText(PUBLIC_STUDIO_URL);
    }
    return true;
  } catch { return false; }
}
