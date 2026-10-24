// Reproducible PNG export of our code-native Minecraft texture (Node 22.18+).
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { createCuratedLacePixels } from '../src/lib/curatedLaceSkin.ts';
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i=0;i<8;i++) crc = (crc>>>1) ^ ((crc&1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([name,data])));
  return Buffer.concat([size,name,data,crc]);
}
const pixels = createCuratedLacePixels();
const rows = Buffer.alloc(64*(64*4+1));
for(let y=0;y<64;y++) rows.set(pixels.subarray(y*256,(y+1)*256),y*257+1);
const header=Buffer.alloc(13);
header.writeUInt32BE(64);header.writeUInt32BE(64,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
const target=new URL('../public/images/woman-lace-skin-v3.png',import.meta.url);
writeFileSync(target,png);
console.log('Exported 64×64 classic Minecraft skin:',target.pathname);
