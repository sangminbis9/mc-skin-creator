/** Hand-authored pixel art in Minecraft's real classic 64×64 UV layout. */
export function createCuratedLacePixels(): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(64*64*4);
  type Rect = {x:number;y:number;w:number;h:number};
  type Face = "front"|"back"|"left"|"right"|"top"|"bottom";
  const box=(u:number,v:number,w:number,h:number,d:number):Record<Face,Rect>=>({
    right:{x:u,y:v+d,w:d,h},front:{x:u+d,y:v+d,w,h},left:{x:u+d+w,y:v+d,w:d,h},
    back:{x:u+2*d+w,y:v+d,w,h},top:{x:u+d,y:v,w,h:d},bottom:{x:u+d+w,y:v,w,h:d},
  });
  const parts={head:[box(0,0,8,8,8),box(32,0,8,8,8)],body:[box(16,16,8,12,4),box(16,32,8,12,4)],
    rightArm:[box(40,16,4,12,4),box(40,32,4,12,4)],leftArm:[box(32,48,4,12,4),box(48,48,4,12,4)],
    rightLeg:[box(0,16,4,12,4),box(0,32,4,12,4)],leftLeg:[box(16,48,4,12,4),box(0,48,4,12,4)]};
  const p:Record<string,string>={H:"#30221f",h:"#46312a",a:"#5b4034",b:"#75513f",S:"#f4d1bc",s:"#e5bba5",p:"#e5aaa0",D:"#45302c",w:"#fff1df",m:"#c8837b"};
  const set=(r:Rect,x:number,y:number,color:string)=>{const n=parseInt(color.slice(1),16),i=((r.y+y)*64+r.x+x)*4;pixels.set([n>>16,(n>>8)&255,n&255,255],i);};
  const paint=(r:Rect,color:(x:number,y:number)=>string|null)=>{for(let y=0;y<r.h;y++)for(let x=0;x<r.w;x++){const c=color(x,y);if(c)set(r,x,y,c);}};
  const hair=(x:number,y:number,side=false)=>(side?[p.H,p.h,p.a,p.h,p.H]:[p.h,p.a,p.b,p.a,p.h])[(x+Math.floor(y/3)%2)%5];
  const cream=["#e3d8c7","#eee6d7","#f9f2e6","#e8ddca","#f5eddf","#e5d9c8","#eee5d4","#f7efdf"];
  const lace=(x:number,y:number)=>(x+y)%3===0?"#fff9ef":"#e9dfcf";
  for(const [name,[base]] of Object.entries(parts))for(const [face,r] of Object.entries(base))paint(r,(x,y)=>{
    if(name==="head")return hair(x,y,face!=="front"&&face!=="top");
    if(name==="body"){
      if(face==="front"&&y<3&&x>1&&x<6)return y===2?"#e5b9a2":p.S;
      if(face==="top")return x>1&&x<6?p.s:"#f8efdf";
      return cream[(x+(face==="back"?2:0))%8];
    }
    if(name.includes("Arm")){
      if(y<3||y>9)return x===0?p.s:p.S;
      return ["#cba9a1","#e7c9bd","#f3dcd0","#dbc0b5"][(x+Math.floor(y/3)%2)%4];
    }
    if(face==="bottom")return "#b8a594";
    if(y===11)return x===0||x===3?"#d4c4b0":"#f6ead8";
    if(y===10)return x===0||x===3?"#f7eddf":p.s;
    return cream[(x+(name==="leftLeg"?4:0))%8];
  });
  // Frame the cheeks with one hair pixel per side (six exposed columns,
  // tapering to four at the chin). Keep the original eye positions unchanged.
  ["HHhaahHH","HhaasahH","haSSSSah","hbSSSSbh","hwDSSDwh","hpDSSDph","hsSmSSsh","hhsssshh"].forEach((row,y)=>[...row].forEach((c,x)=>set(parts.head[0].front,x,y,p[c])));
  [".ha..ah.","ha....ah","a......a","h......h","h......h","a......h","h......a"].forEach((row,y)=>[...row].forEach((c,x)=>{if(c!==".")set(parts.head[1].front,x,y,p[c]);}));
  for(const face of ["top","back","left","right"] as const)paint(parts.head[1][face],(x,y)=>{
    if(face==="top")return ((x===0||x===7)&&(y===0||y===7))?null:hair(x,y);
    if(y===0&&(x===0||x===7))return null;
    if(face!=="back"&&y>3&&x===0)return null;
    if(y===7&&(x+y)%3===0)return null;
    return hair(x,y,face!=="back");
  });
  const bodice=parts.body[0].front,outer=parts.body[1].front;
  for(let x=1;x<7;x++)set(bodice,x,x===1||x===6?2:3,"#fff6e8");
  paint(outer,(x,y)=>{
    if(y===3&&x>0&&x<7)return x%2?"#fffaf0":"#dfd0b7";
    if((y===5||y===8)&&(x===3||x===4))return "#fffaf1";
    if(y===6&&x===4)return "#dccab3";
    if(y===10||(y===11&&x%2===0))return lace(x,y);
    if(y>3&&y<10&&(x+y*2)%7===0)return "#fff9eb";
    return null;
  });
  // Long strands continue beyond the head onto the torso.
  for(const layer of [0,1]){
    paint(parts.body[layer].back,(x,y)=>y<8+x%3?hair(x,y+8):layer===0?cream[x]:null);
    for(const f of ["left","right"] as const)paint(parts.body[layer][f],(x,y)=>y<6+x%2?hair(x,y+8,true):layer===0?cream[x+2]:null);
  }
  for(let y=0;y<9;y++){
    const x=y<5?0:1;set(bodice,x,y,hair(x,y));set(outer,x,y,hair(x+1,y));
    if(y<5)set(outer,1,y,hair(2,y));if(y<6)set(outer,7,y,hair(4,y));
  }
  for(const name of ["rightArm","leftArm"] as const)for(const f of ["front","back","left","right"] as const)paint(parts[name][1][f],(x,y)=>{
    if(y===3)return x%2===0?"#f6e1d5":"#dfbfb4";
    if(y===9)return x%2?"#ead0c3":"#cda99d";
    if(y>3&&y<9&&(x+(y>>1))%4===1)return "#f1d8cb";return null;
  });
  // Equal tier heights wrap around both legs for a continuous skirt pattern.
  for(const name of ["rightLeg","leftLeg"] as const)for(const f of ["front","back","left","right"] as const){
    const offset=name==="leftLeg"?4:0;
    paint(parts[name][1][f],(x,y)=>{
      if(y===1||y===5||y===8)return lace(x+offset,y);
      if(y===2||y===6)return (x+offset)%3===0?"#fdf5e6":null;
      if(y===9)return (x+offset)%2===0?"#fff8e8":null;
      if(y===10&&f==="front")return "#e5d6c1";return null;
    });
  }
  return pixels;
}
