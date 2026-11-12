import type { Language } from '../i18n/messages';
import { exportPng } from './nativeExport';
export { sharePublicLink as shareStudioLink } from './nativeExport';
export async function sharePreviewImage(dataUrl: string, language: Language): Promise<boolean> {
  try { await exportPng(dataUrl, 'skin-preview.png', language); return true; }
  catch { return false; }
}
