import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { createCuratedLacePixels } from '../src/lib/curatedLaceSkin.ts';
import { CLASSIC_LAYOUT, getBoxUvSeams } from '../shared/skinLayout.ts';

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
test('soft lips are centered above a shaded narrow chin',()=>{
  const p=createCuratedLacePixels();
  const rgb=(x:number,y:number)=>Array.from(p.slice((y*64+x)*4,(y*64+x)*4+3));
  for(const x of [11,12])assert.deepEqual(rgb(x,14),[215,157,145]);
  for(const x of [10,13])assert.deepEqual(rgb(x,14),[244,209,188]);
  for(let x=8;x<12;x++)for(const y of [14,15])assert.deepEqual(rgb(x,y),rgb(23-x,y));
  for(const x of [11,12])assert.deepEqual(rgb(x,15),[244,209,188]);
  for(const x of [10,13])assert.deepEqual(rgb(x,15),[229,187,165]);
});
test('chin wraps into skin on the underside without a dark front seam',()=>{
  const p=createCuratedLacePixels();
  const rgba=(x:number,y:number)=>Array.from(p.slice((y*64+x)*4,(y*64+x)*4+4));
  // Minecraft's bottom face is mirrored relative to the front face.
  for(let x=0;x<8;x++)assert.deepEqual(rgba(8+x,15),rgba(23-x,0));
  for(let x=18;x<=21;x++)for(let y=1;y<=5;y++){
    assert.deepEqual(rgba(x,y),y<=2?[229,187,165,255]:[215,173,152,255]);
  }
  for(let y=0;y<8;y++)for(let x=48;x<56;x++)assert.equal(rgba(x,y)[3],0);
});
test('crown steps inward on both sides without making the base head transparent',()=>{
  const p=createCuratedLacePixels(),alpha=(x:number,y:number)=>p[(y*64+x)*4+3];
  const {base,overlay}=CLASSIC_LAYOUT.head;
  for(const r of Object.values(base))for(let y=0;y<r.h;y++)for(let x=0;x<r.w;x++)assert.equal(alpha(r.x+x,r.y+y),255);
  for(let y=0;y<8;y++)for(const x of [0,7])assert.equal(alpha(overlay.top.x+x,overlay.top.y+y),0);
  for(let y=0;y<7;y++)for(let x=1;x<7;x++)assert.equal(alpha(overlay.top.x+x,overlay.top.y+y),255);
  for(const r of [overlay.left,overlay.right])for(let x=0;x<8;x++){
    assert.equal(alpha(r.x+x,r.y),0);
    assert.equal(alpha(r.x+x,r.y+1),255,'side volume must return below the inset crown');
  }
});
test('crown alpha and colors agree across all four top-face seams',()=>{
  const p=createCuratedLacePixels();
  const rgba=(x:number,y:number)=>Array.from(p.slice((y*64+x)*4,(y*64+x)*4+4));
  for(const seam of getBoxUvSeams(CLASSIC_LAYOUT.head.overlay).horizontal.slice(0,4)){
    seam.primary.forEach((a,i)=>{const b=seam.adjacent[i];assert.deepEqual(rgba(a.x,a.y),rgba(b.x,b.y));});
  }
});
test('exported PNG matches the live pixel source byte for byte',()=>{
  const png=readFileSync(new URL('../public/images/woman-lace-skin-v3.png',import.meta.url));
  assert.equal(png.readUInt32BE(16),64);assert.equal(png.readUInt32BE(20),64);
  const blocks:Buffer[]=[];
  for(let pos=8;pos<png.length;){const n=png.readUInt32BE(pos);if(png.toString('ascii',pos+4,pos+8)==='IDAT')blocks.push(png.subarray(pos+8,pos+8+n));pos+=n+12;}
  const raw=inflateSync(Buffer.concat(blocks)),p=createCuratedLacePixels();
  for(let y=0;y<64;y++){assert.equal(raw[y*257],0);assert.deepEqual(raw.subarray(y*257+1,(y+1)*257),Buffer.from(p.subarray(y*256,(y+1)*256)));}
});
