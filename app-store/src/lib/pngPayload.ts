/** Validate PNG input before allowing it to cross the native file bridge. */
export function pngPayload(dataUrl: string, skinOnly = false): string {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[1].length > 12_000_000) throw new Error('유효한 PNG 이미지가 아닙니다.');
  const raw = atob(match[1]);
  const bytes = Uint8Array.from(raw.slice(0, 33), c => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a
    || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452
    || (skinOnly && (view.getUint32(16) !== 64 || view.getUint32(20) !== 64))) {
    throw new Error('유효한 PNG 이미지가 아닙니다.');
  }
  return match[1];
}
