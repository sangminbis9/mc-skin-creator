// Original pixel artwork, generated reproducibly without third-party brand assets.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const palette = { bg: [238, 237, 232], frame: [52, 86, 42], light: [120, 151, 88], hair: [87, 66, 51], skin: [231, 179, 141], shade: [197, 138, 105], eye: [43, 49, 40], shirt: [92, 121, 78], shine: [255, 222, 123] };
function pixel(x, y) {
  let c = palette.bg;
  if (x >= 4 && x < 28 && y >= 4 && y < 28) c = palette.frame;
  if (x >= 5 && x < 27 && y >= 5 && y < 27) c = palette.light;
  if (x >= 9 && x < 23 && y >= 10 && y < 23) c = palette.skin;
  if (x >= 20 && x < 23 && y >= 12 && y < 23) c = palette.shade;
  if (x >= 8 && x < 24 && y >= 7 && y < 12 || x >= 8 && x < 11 && y >= 10 && y < 17) c = palette.hair;
  if (y >= 16 && y < 18 && (x >= 12 && x < 14 || x >= 19 && x < 21)) c = palette.eye;
  if (x >= 14 && x < 19 && y === 21) c = palette.shade;
  if (x >= 10 && x < 22 && y >= 23 && y < 27) c = palette.shirt;
  if ((x === 25 && y >= 1 && y <= 7) || (y === 4 && x >= 22 && x <= 28)) c = palette.shine;
  return c;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const payload = Buffer.concat([Buffer.from(type), data]);
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([size, payload, crc]);
}
function png(size, splash = false) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = splash ? Math.floor((x - size / 2) / 16 + 16) : Math.floor(x * 32 / size);
    const py = splash ? Math.floor((y - size / 2) / 16 + 16) : Math.floor(y * 32 / size);
    const color = px >= 0 && px < 32 && py >= 0 && py < 32 ? pixel(px, py) : palette.bg;
    raw.set(color, y * (size * 3 + 1) + 1 + x * 3);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
writeFileSync(resolve(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), png(1024));
for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  writeFileSync(resolve(root, 'ios/App/App/Assets.xcassets/Splash.imageset', name), png(2732, true));
}
console.log('Generated opaque RGB app icon and launch assets.');
