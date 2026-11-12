import { pngPayload } from './pngPayload.ts';

export const LIBRARY_KEY = 'skin-studio-ios:library:v1';
export const LIBRARY_LIMIT = 40;
export interface SavedSkin {
  id: string;
  name: string;
  png: string;
  geometry: 'classic' | 'slim';
  savedAt: number;
}
type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function readSkins(store: Store = localStorage): SavedSkin[] {
  const raw = store.getItem(LIBRARY_KEY);
  if (!raw) return [];
  if (raw.length > 6_000_000) throw new Error('보관함 데이터를 읽을 수 없습니다.');
  const entries: unknown = JSON.parse(raw);
  if (!Array.isArray(entries) || entries.length > LIBRARY_LIMIT) throw new Error('보관함 데이터를 읽을 수 없습니다.');
  return entries.map(item => {
    if (!item || typeof item.id !== 'string' || typeof item.name !== 'string' || item.name.length > 60
      || typeof item.png !== 'string' || item.png.length > 100_000
      || !Number.isFinite(item.savedAt) || !['classic', 'slim'].includes(item.geometry)) {
      throw new Error('보관함 데이터가 손상되었습니다. 기존 데이터를 덮어쓰지 않았습니다.');
    }
    pngPayload(item.png, true);
    return item as SavedSkin;
  }).sort((a, b) => b.savedAt - a.savedAt);
}

export function saveSkin(png: string, geometry: SavedSkin['geometry'], store: Store = localStorage): SavedSkin {
  pngPayload(png, true);
  if (png.length > 100_000) throw new Error('스킨 파일이 너무 큽니다.');
  const skins = readSkins(store);
  if (skins.length >= LIBRARY_LIMIT) throw new Error('보관함이 가득 찼습니다. 스킨을 내보내거나 삭제해 주세요.');
  const savedAt = Date.now();
  const skin: SavedSkin = { id: crypto.randomUUID(), name: `스킨 ${new Date(savedAt).toLocaleString('ko-KR')}`, png, geometry, savedAt };
  store.setItem(LIBRARY_KEY, JSON.stringify([skin, ...skins]));
  return skin;
}

export function deleteSkin(id: string, store: Store = localStorage): void {
  store.setItem(LIBRARY_KEY, JSON.stringify(readSkins(store).filter(skin => skin.id !== id)));
}
