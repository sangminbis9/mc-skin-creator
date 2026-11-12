import { exportPng } from './nativeExport';
export { sharePublicLink as shareStudioLink } from './nativeExport';
export async function sharePreviewImage(dataUrl: string): Promise<boolean> {
  try { await exportPng(dataUrl, 'skin-preview.png'); return true; }
  catch { return false; }
}
