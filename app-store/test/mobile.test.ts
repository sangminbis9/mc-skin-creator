import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { saveSkin, readSkins, deleteSkin, LIBRARY_KEY, LIBRARY_LIMIT } from '../src/lib/skinLibrary.ts';
import { pngPayload } from '../src/lib/pngPayload.ts';
import { transferPng } from '../src/lib/nativeFileTransfer.ts';

const png = 'data:image/png;base64,' + readFileSync(new URL('../public/images/woman-lace-skin-64.png', import.meta.url)).toString('base64');
function memory() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
test('library persists the exact canonical atlas and arm choice, then deletes only the chosen skin', () => {
  const store = memory();
  const first = saveSkin(png, 'slim', store);
  const second = saveSkin(png, 'classic', store);
  assert.deepEqual(readSkins(store).find(s => s.id === first.id), first);
  deleteSkin(second.id, store);
  assert.deepEqual(readSkins(store), [first]);
});
test('a full library never evicts an existing skin', () => {
  const store = memory();
  for (let i = 0; i < LIBRARY_LIMIT; i++) saveSkin(png, 'classic', store);
  const before = store.getItem(LIBRARY_KEY);
  assert.throws(() => saveSkin(png, 'slim', store));
  assert.equal(store.getItem(LIBRARY_KEY), before);
});
test('corrupt data and storage failures do not report a successful save', () => {
  const store = memory();
  store.setItem(LIBRARY_KEY, 'corrupt');
  assert.throws(() => saveSkin(png, 'classic', store));
  assert.equal(store.getItem(LIBRARY_KEY), 'corrupt');
  assert.throws(() => saveSkin(png, 'classic', { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } }));
});
test('native payload validation rejects non-PNG, malformed and wrong-size skins', () => {
  assert.equal(pngPayload(png, true), png.split(',')[1]);
  assert.throws(() => pngPayload('data:text/html;base64,PHNjcmlwdD4='));
  assert.throws(() => pngPayload('data:image/png;base64,aGVsbG8='));
  const wrong = Buffer.from(png.split(',')[1], 'base64');
  wrong.writeUInt32BE(32, 16);
  assert.throws(() => pngPayload('data:image/png;base64,' + wrong.toString('base64'), true));
});
test('native export shares the file URI and retains bytes until the sheet closes', async () => {
  const events: string[] = [];
  await transferPng({
    write: async (path, data) => { assert.equal(data, png.split(',')[1]); events.push('write'); return 'file:///cache/' + path; },
    share: async uri => { assert.equal(uri, 'file:///cache/exports/1/skin.png'); assert.deepEqual(events, ['write']); events.push('share'); },
    remove: async dir => { assert.equal(dir, 'exports/1'); events.push('remove'); },
  }, 'exports/1/skin.png', png.split(',')[1]);
  assert.deepEqual(events, ['write', 'share', 'remove']);
});
test('cancelled export cleans up without masking the original error', async () => {
  let cleaned = false;
  await assert.rejects(transferPng({
    write: async () => 'file:///skin.png',
    share: async () => { throw new Error('cancelled'); },
    remove: async () => { cleaned = true; throw new Error('cleanup failed'); },
  }, 'exports/1/skin.png', 'base64'), /cancelled/);
  assert.equal(cleaned, true);
});
