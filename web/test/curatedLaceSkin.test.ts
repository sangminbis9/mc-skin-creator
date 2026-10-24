import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createCuratedLacePixels } from '../src/lib/curatedLaceSkin.ts';

test('lace sample is deterministic RGBA with only opaque or transparent pixels',()=>{
  const p=createCuratedLacePixels();
  assert.equal(p.length,64*64*4);
  assert.deepEqual(p,createCuratedLacePixels());
  for(let i=3;i<p.length;i+=4)assert.ok(p[i]===0||p[i]===255);
});
test('face stays opaque and hair outer layer leaves the eyes clear',()=>{
  const p=createCuratedLacePixels(),alpha=(x:number,y:number)=>p[(y*64+x)*4+3];
  for(let y=8;y<16;y++)for(let x=8;x<16;x++)assert.equal(alpha(x,y),255);
  for(let y=12;y<16;y++)for(let x=41;x<47;x++)assert.equal(alpha(x,y),0);
  assert.equal(alpha(41,8),255);
  const colors=new Set();
  for(let y=11;y<16;y++)for(let x=9;x<15;x++)colors.add(p.slice((y*64+x)*4,(y*64+x)*4+3).join(','));
  assert.ok(colors.size>=5,'face must have eyes, skin shading, blush and lip tones');
});
test('side locks narrow the face without masking the eyes',()=>{
  const p=createCuratedLacePixels();
  const rgb=(x:number,y:number)=>Array.from(p.slice((y*64+x)*4,(y*64+x)*4+3));
  for(let y=11;y<16;y++) for(const x of [8,15]) assert.deepEqual(rgb(x,y),[70,49,42]);
  for(const x of [10,13]) for(const y of [12,13]) {
    assert.deepEqual(rgb(x,y),[69,48,44]);
    assert.equal(p[(y*64+x+32)*4+3],0);
  }
  assert.deepEqual(rgb(9,15),[70,49,42]);
  assert.deepEqual(rgb(14,15),[70,49,42]);
});
test('exported PNG matches the live pixel source byte for byte',()=>{
  const png=readFileSync(new URL('../public/images/woman-lace-skin-v3.png',import.meta.url));
  assert.equal(png.readUInt32BE(16),64);assert.equal(png.readUInt32BE(20),64);
  const blocks:Buffer[]=[];
  for(let pos=8;pos<png.length;){const n=png.readUInt32BE(pos);if(png.toString('ascii',pos+4,pos+8)==='IDAT')blocks.push(png.subarray(pos+8,pos+8+n));pos+=n+12;}
  const raw=inflateSync(Buffer.concat(blocks)),p=createCuratedLacePixels();
  for(let y=0;y<64;y++){assert.equal(raw[y*257],0);assert.deepEqual(raw.subarray(y*257+1,(y+1)*257),Buffer.from(p.subarray(y*256,(y+1)*256)));}
});
