// ============================================================================
// canvas-view.js — sistema de vista del visor principal: zoom/pan por CSS
// transform, lupa de inspección por píxel, sincronía del canvas de recuadros
// de zonas (Objetivo 4) con el canvas de imagen y dibujo de la vista
// «Marcado» (imagen lavada + áreas a color con recuadro; ver más abajo).
// No pertenece al motor de comparación: solo consume ImageData ya calculado
// y las áreas que decide marked-panel.js (con diff-areas.js).
// ============================================================================

const mainCanvas=document.getElementById('mainCanvas');
const ctx=mainCanvas.getContext('2d');
const maskCanvas=document.getElementById('maskCanvas');
const mctx=maskCanvas.getContext('2d');
const regionsCanvas=document.getElementById('regionsCanvas');
const rctx=regionsCanvas.getContext('2d');
const canvasWrap=document.getElementById('canvasWrap');
const zoomBox=document.getElementById('zoomBox');
const zoomCanvas=document.getElementById('zoomCanvas');
const zctx=zoomCanvas.getContext('2d');
const markedCanvas=document.getElementById('markedCanvas');
const kctx=markedCanvas.getContext('2d');

const viewState={
  marcado:{zoom:1,panX:0,panY:0},
  overlay:{zoom:1,panX:0,panY:0},
  imgA:{zoom:1,panX:0,panY:0},
  imgB:{zoom:1,panX:0,panY:0},
  heatmap:{zoom:1,panX:0,panY:0}
};
const ZOOM_MIN=1,ZOOM_MAX=20;
let isDragging=false;

function resetViewState(){
  Object.keys(viewState).forEach(k=>{viewState[k].zoom=1;viewState[k].panX=0;viewState[k].panY=0;});
}

function fitScale(){
  if(!cW||!cH)return 1;
  const r=canvasWrap.getBoundingClientRect();
  return Math.min(r.width/cW,r.height/cH);
}

function applyCanvasTransform(){
  if(!cW||!cH)return;
  const st=viewState[currentTab]||viewState.overlay;
  const base=fitScale();
  const w=(cW*base*st.zoom)+'px',h=(cH*base*st.zoom)+'px';
  const t=`translate(${st.panX}px, ${st.panY}px)`;
  [mainCanvas,maskCanvas,regionsCanvas].forEach(c=>{
    c.style.width=w;c.style.height=h;c.style.transform=t;
  });
  if(typeof drawRegionsOverlay==='function')drawRegionsOverlay();
  drawMarkedOverlay();
}

// Centra y amplía el visor sobre un punto en espacio del canvas comparado
// (cW×cH). Reutilizado por: zoom con rueda de ratón (más abajo), saltar a
// una diferencia de texto (Objetivo 3) y centrar una zona del panel
// (Objetivo 4).
function centerViewOn(cx,cy,zoom,tab){
  if(!cW||!cH)return;
  if(tab&&tab!==currentTab){
    const tabBtn=document.querySelector(`.tab[data-tab="${tab}"]`);
    if(tabBtn)tabBtn.click();
  }
  const st=viewState[currentTab]||viewState.overlay;
  const r=canvasWrap.getBoundingClientRect();
  const base=fitScale();
  st.zoom=Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,zoom||6));
  const scale=base*st.zoom;
  st.panX=-(cx*scale-r.width/2);
  st.panY=-(cy*scale-r.height/2);
  applyCanvasTransform();
}

window.addEventListener('resize',()=>{
  applyCanvasTransform();
  if(typeof sourceA!=='undefined'&&sourceA)applyAlignTransform('A');
  if(typeof sourceB!=='undefined'&&sourceB)applyAlignTransform('B');
});

canvasWrap.onmousemove=e=>{
  if(!pixelDEmap||isDragging)return;
  const rect=mainCanvas.getBoundingClientRect();
  const scaleX=cW/mainCanvas.offsetWidth;
  const scaleY=cH/mainCanvas.offsetHeight;
  const px=Math.floor((e.clientX-rect.left)*scaleX);
  const py=Math.floor((e.clientY-rect.top)*scaleY);
  if(px<0||py<0||px>=cW||py>=cH)return;

  const idx=py*cW+px;
  const de=pixelDEmap[idx];
  const o=idx*4;
  const dA=imgAData.data,dB=imgBData.data;

  zoomBox.style.display='block';
  let lx=e.clientX+18,ly=e.clientY-80;
  if(lx+160>window.innerWidth)lx=e.clientX-170;
  if(ly<0)ly=e.clientY+10;
  zoomBox.style.left=lx+'px';
  zoomBox.style.top=ly+'px';

  zctx.clearRect(0,0,120,120);
  const ox=Math.max(0,Math.min(px-5,cW-10));
  const oy=Math.max(0,Math.min(py-5,cH-10));
  const slice=new ImageData(10,10);
  for(let dy=0;dy<10;dy++){
    for(let dx=0;dx<10;dx++){
      const si=((oy+dy)*cW+(ox+dx))*4;
      const di=(dy*10+dx)*4;
      if(currentTab==='overlay'){
        slice.data[di]=overlayData.data[si];
        slice.data[di+1]=overlayData.data[si+1];
        slice.data[di+2]=overlayData.data[si+2];
        slice.data[di+3]=255;
      }else if(currentTab==='imgA'){
        slice.data[di]=imgAData.data[si];slice.data[di+1]=imgAData.data[si+1];slice.data[di+2]=imgAData.data[si+2];slice.data[di+3]=255;
      }else if(currentTab==='imgB'||currentTab==='marcado'){
        slice.data[di]=imgBData.data[si];slice.data[di+1]=imgBData.data[si+1];slice.data[di+2]=imgBData.data[si+2];slice.data[di+3]=255;
      }else{
        slice.data[di]=heatmapData.data[si];slice.data[di+1]=heatmapData.data[si+1];slice.data[di+2]=heatmapData.data[si+2];slice.data[di+3]=255;
      }
    }
  }
  const tmp=document.createElement('canvas');tmp.width=10;tmp.height=10;
  tmp.getContext('2d').putImageData(slice,0,0);
  zctx.imageSmoothingEnabled=false;
  zctx.drawImage(tmp,0,0,120,120);
  zctx.strokeStyle='rgba(255,255,255,0.7)';
  zctx.strokeRect(54,54,12,12);

  document.getElementById('zoomInfo').innerHTML=
    `ΔE: <b>${formatDE(de,2)}</b><br>`+
    `A: rgb(${dA[o]},${dA[o+1]},${dA[o+2]})<br>`+
    `B: rgb(${dB[o]},${dB[o+1]},${dB[o+2]})<br>`+
    `px: ${px},${py}`;
};

canvasWrap.onmouseleave=()=>{zoomBox.style.display='none';};

canvasWrap.addEventListener('wheel',e=>{
  if(!cW||!cH)return;
  e.preventDefault();
  const st=viewState[currentTab]||viewState.overlay;
  const r=canvasWrap.getBoundingClientRect();
  const base=fitScale();
  const oldScale=base*st.zoom;
  const mx=e.clientX-r.left,my=e.clientY-r.top;
  const canvasLeft=r.width/2-(cW*oldScale)/2+st.panX;
  const canvasTop=r.height/2-(cH*oldScale)/2+st.panY;
  const srcX=(mx-canvasLeft)/oldScale,srcY=(my-canvasTop)/oldScale;
  const factor=e.deltaY<0?1.15:1/1.15;
  const newZoom=Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,st.zoom*factor));
  const newScale=base*newZoom;
  st.panX=mx-srcX*newScale-(r.width/2-(cW*newScale)/2);
  st.panY=my-srcY*newScale-(r.height/2-(cH*newScale)/2);
  st.zoom=newZoom;
  applyCanvasTransform();
},{passive:false});

let dragStart=null;
canvasWrap.addEventListener('mousedown',e=>{
  if(!cW||!cH)return;
  isDragging=true;
  const st=viewState[currentTab]||viewState.overlay;
  dragStart={x:e.clientX,y:e.clientY,panX:st.panX,panY:st.panY};
  canvasWrap.classList.add('dragging');
  zoomBox.style.display='none';
});
window.addEventListener('mousemove',e=>{
  if(!dragStart)return;
  const st=viewState[currentTab]||viewState.overlay;
  st.panX=dragStart.panX+(e.clientX-dragStart.x);
  st.panY=dragStart.panY+(e.clientY-dragStart.y);
  applyCanvasTransform();
});
window.addEventListener('mouseup',()=>{
  if(dragStart){dragStart=null;isDragging=false;canvasWrap.classList.remove('dragging');}
});
canvasWrap.addEventListener('dblclick',()=>{
  if(!cW||!cH)return;
  const st=viewState[currentTab]||viewState.overlay;
  st.zoom=1;st.panX=0;st.panY=0;
  applyCanvasTransform();
});

// ---- vista «Marcado» ---------------------------------------------------------
// Dos capas:
//  · mainCanvas (nativo, escalado por CSS como el resto de vistas): B lavada
//    en gris claro (washedData, calculada una vez por comparación).
//  · markedCanvas (a tamaño de pantalla, sin transformar): por cada área, un
//    recuadro redondeado con halo y, dentro, B a color con los píxeles que
//    superan el umbral teñidos (--diff-tint). Ese contenido sale de un lienzo
//    pequeño propio de cada área (markedPatches), nunca de mainCanvas.
// Radio, margen, borde y sombra se dan en píxeles de PANTALLA, así que el
// recuadro se ve igual con cualquier zoom, y cada fotograma solo cuesta en
// proporción a las áreas. No se hace drawImage desde un lienzo del tamaño de
// la imagen ni se añade otra capa de ese tamaño: en Chrome cada una cuesta
// copias completas en la GPU (medido a 600 ppp: +0,5–1 GB). Lo único grande
// que añade la vista es washedData, un buffer RGBA.

// Mezcla de la luma de B hacia blanco (0 = gris puro, 1 = blanco): 0,6 deja
// un gris claro en el que el diseño se reconoce sin competir con las áreas.
const MARKED_WASH=0.6;

let washedData=null;
let markedPatches=[];     // [{id,x,y,w,h,k,m,canvas}]: caja del parche en px de imagen, lienzo a 1/k
let markedScreenRects=[]; // [{id,x,y,w,h}] en px CSS relativos al visor (último dibujo)
let markedStyle=null;

function cssToken(name){
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function parseHexColor(str){
  let h=(str||'').replace('#','');
  if(h.length===3)h=h.split('').map(c=>c+c).join('');
  if(!/^[0-9a-f]{6}$/i.test(h))return null;
  return[parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];
}
// «color x y blur» de un box-shadow (formato de --elevation-2). El blur de
// CSS y el shadowBlur de canvas usan la misma sigma (valor/2): pasa tal cual.
function parseBoxShadow(str){
  const m=/(rgba?\([^)]*\)|#[0-9a-f]{3,8})\s+(-?[\d.]+)(?:px)?\s+(-?[\d.]+)(?:px)?\s+([\d.]+)(?:px)?/i.exec(str||'');
  return m?{color:m[1],x:parseFloat(m[2]),y:parseFloat(m[3]),blur:parseFloat(m[4])}:null;
}
// Tokens de DESIGN.md para la vista, leídos una vez del CSS.
function getMarkedStyle(){
  if(markedStyle)return markedStyle;
  markedStyle={
    tint:parseHexColor(cssToken('--diff-tint')),
    tintAlpha:parseFloat(cssToken('--diff-tint-alpha')),
    margin:parseFloat(cssToken('--space-4')),
    radius:parseFloat(cssToken('--radius-md')),
    border:cssToken('--canvas'),
    selected:cssToken('--primary'),
    shadow:parseBoxShadow(cssToken('--elevation-2'))
  };
  return markedStyle;
}

// B → compuesta sobre blanco según su alfa → luma Rec. 709 → mezcla hacia
// blanco. Se calcula la primera vez que se entra en Marcado tras comparar y
// se guarda hasta el siguiente resultado; renderTab la pone en mainCanvas.
function getWashedData(){
  if(washedData||!imgBData)return washedData;
  washedData=new ImageData(cW,cH);
  const src=imgBData.data,d=washedData.data,k=MARKED_WASH;
  for(let o=0,len=d.length;o<len;o+=4){
    const a=src[o+3]/255,bg=255*(1-a);
    const lum=0.2126*(src[o]*a+bg)+0.7152*(src[o+1]*a+bg)+0.0722*(src[o+2]*a+bg);
    d[o]=d[o+1]=d[o+2]=lum+(255-lum)*k;d[o+3]=255;
  }
  return washedData;
}

function releaseWashedCache(){washedData=null;markedMip=null;}

// Parche de un área: B a color en su caja ampliada con el margen que se ve
// al zoom actual y, si `highlight`, el tinte en los píxeles >= t de la caja
// (respetando la máscara de cobertura). Se construye a la resolución a la que
// se va a ver: con k = ⌊1/(escala·DPR)⌋ se promedian bloques de k×k píxeles
// (en encaje, a 600 ppp, k≈16), así que el lienzo resultante es del orden de
// lo que ocupa en pantalla y no de la imagen (subir 3 Mpx por paso del
// umbral bloqueaba ~150 ms por fotograma).
let markedPatchScale=0;   // escala (px CSS por px de imagen) con que se construyeron
let markedPatchTimer=null;

function markedPatchParams(s){
  const dpr=window.devicePixelRatio||1;
  return{k:Math.max(1,Math.floor(1/(s*dpr))),m:Math.ceil(getMarkedStyle().margin/s)+2};
}

function currentMarkedScale(){
  const w=mainCanvas.getBoundingClientRect().width;
  return cW&&w?w/cW:0;
}

// Nivel reducido de B (media de bloques k×k alineados a la rejilla global)
// para k >= MARKED_MIP_MIN_K: el anillo de margen de cada parche es B sin
// teñir, así que sale recortado de aquí en vez de recorrer a resolución
// completa, en cada paso del umbral, cientos de miles de píxeles que no
// cambian. Uno solo a la vez (el del zoom actual): 0,5 MB en encaje a 600
// ppp, 8,7 MB con k=4; con k<4 el margen en píxeles de imagen ya es pequeño y
// el parche se promedia directamente.
const MARKED_MIP_MIN_K=4;
let markedMip=null; // {k,w,h,data}

function getMarkedMip(k){
  if(markedMip&&markedMip.k===k)return markedMip;
  const mw=Math.ceil(cW/k),mh=Math.ceil(cH/k),src=imgBData.data;
  const out=new Uint8ClampedArray(mw*mh*4),acc=new Uint32Array(mw*4),cnt=new Uint32Array(mw);
  for(let by=0;by<mh;by++){
    acc.fill(0);cnt.fill(0);
    for(let y=by*k,ye=Math.min(cH,y+k);y<ye;y++){
      let q=y*cW*4;
      for(let bx=0;bx<mw;bx++){
        let r=0,g=0,b=0,al=0;const n=Math.min(cW,(bx+1)*k)-bx*k;
        for(let j=0;j<n;j++,q+=4){r+=src[q];g+=src[q+1];b+=src[q+2];al+=src[q+3];}
        const o=bx*4;acc[o]+=r;acc[o+1]+=g;acc[o+2]+=b;acc[o+3]+=al;cnt[bx]+=n;
      }
    }
    for(let bx=0,o=by*mw*4;bx<mw;bx++,o+=4){
      const n=cnt[bx];out[o]=acc[bx*4]/n;out[o+1]=acc[bx*4+1]/n;out[o+2]=acc[bx*4+2]/n;out[o+3]=acc[bx*4+3]/n;
    }
  }
  markedMip={k,w:mw,h:mh,data:out};
  return markedMip;
}

// Lienzos de parche reutilizados entre pasos del umbral (crear uno nuevo en
// cada paso obliga al navegador a reservar memoria de GPU cada vez).
const markedPatchPool=[];

function buildMarkedPatches(areas,t,highlight){
  markedPatches=[];
  const s=currentMarkedScale();
  if(!s||!imgBData)return;
  markedPatchScale=s;
  const{k,m}=markedPatchParams(s);
  if(markedMip&&markedMip.k!==k)markedMip=null;
  const st=getMarkedStyle();
  const tint=highlight?st.tint:null,al=st.tintAlpha,ia=1-al;
  const src=imgBData.data,mask=compareMaskGlobal;
  const[tr,tg,tb]=tint||[0,0,0];
  for(const ar of areas){
    // caja del parche alineada a bloques de k píxeles
    const gx0=Math.floor(Math.max(0,ar.x-m)/k),gy0=Math.floor(Math.max(0,ar.y-m)/k);
    const gx1=Math.ceil(Math.min(cW,ar.x+ar.w+m)/k),gy1=Math.ceil(Math.min(cH,ar.y+ar.h+m)/k);
    const pw=gx1-gx0,ph=gy1-gy0,x0=gx0*k,y0=gy0*k;
    const w=Math.min(cW,gx1*k)-x0,h=Math.min(cH,gy1*k)-y0;
    const img=new ImageData(pw,ph),d=img.data;
    if(k===1){
      for(let y=0;y<h;y++){const s0=((y0+y)*cW+x0)*4;d.set(src.subarray(s0,s0+w*4),y*w*4);}
    }else if(k>=MARKED_MIP_MIN_K){
      const mip=getMarkedMip(k);
      for(let y=0;y<ph;y++){const s0=((gy0+y)*mip.w+gx0)*4;d.set(mip.data.subarray(s0,s0+pw*4),y*pw*4);}
    }else{
      // 2 <= k < 4: media directa de los bloques del parche
      const acc=new Uint32Array(pw*4),cnt=new Uint32Array(pw);
      for(let by=0;by<ph;by++){
        acc.fill(0);cnt.fill(0);
        for(let y=y0+by*k,ye=Math.min(y0+h,y+k);y<ye;y++){
          let q=(y*cW+x0)*4;
          for(let bx=0;bx<pw;bx++){
            const n=Math.min(w,(bx+1)*k)-bx*k;const o=bx*4;
            for(let j=0;j<n;j++,q+=4){acc[o]+=src[q];acc[o+1]+=src[q+1];acc[o+2]+=src[q+2];acc[o+3]+=src[q+3];}
            cnt[bx]+=n;
          }
        }
        for(let bx=0,o=by*pw*4;bx<pw;bx++,o+=4){const n=cnt[bx];d[o]=acc[bx*4]/n;d[o+1]=acc[bx*4+1]/n;d[o+2]=acc[bx*4+2]/n;d[o+3]=acc[bx*4+3]/n;}
      }
    }
    // Tinte: solo los píxeles de la caja del área. Con k>1, cada píxel teñido
    // suma a su bloque la diferencia (teñido − original)/n, de modo que el
    // bloque queda exactamente como la media de sus píxeles ya teñidos.
    if(tint){
      const corr=k>1?new Float32Array(pw*ph*4):null;
      for(let y=ar.y;y<ar.y+ar.h;y++){
        for(let x=ar.x,i=y*cW+ar.x;x<ar.x+ar.w;x++,i++){
          if(!(pixelDEmap[i]>=t)||(mask&&!mask[i]))continue;
          const q=i*4;
          const r=src[q]*ia+tr*al,g=src[q+1]*ia+tg*al,b=src[q+2]*ia+tb*al;
          if(k===1){
            const o=((y-y0)*pw+(x-x0))*4;d[o]=r;d[o+1]=g;d[o+2]=b;d[o+3]=255;
          }else{
            const bx=((x-x0)/k)|0,by=((y-y0)/k)|0,o=(by*pw+bx)*4;
            const n=(Math.min(w,(bx+1)*k)-bx*k)*(Math.min(h,(by+1)*k)-by*k);
            corr[o]+=(r-src[q])/n;corr[o+1]+=(g-src[q+1])/n;corr[o+2]+=(b-src[q+2])/n;corr[o+3]+=(255-src[q+3])/n;
          }
        }
      }
      if(corr){
        const bx0=((ar.x-x0)/k)|0,bx1=Math.min(pw,Math.ceil((ar.x+ar.w-x0)/k));
        const by0=((ar.y-y0)/k)|0,by1=Math.min(ph,Math.ceil((ar.y+ar.h-y0)/k));
        for(let by=by0;by<by1;by++)for(let bx=bx0,o=(by*pw+bx0)*4;bx<bx1;bx++,o+=4){
          if(corr[o]||corr[o+1]||corr[o+2]||corr[o+3]){d[o]+=corr[o];d[o+1]+=corr[o+1];d[o+2]+=corr[o+2];d[o+3]+=corr[o+3];}
        }
      }
    }
    const idx=markedPatches.length;
    const c=markedPatchPool[idx]||(markedPatchPool[idx]=document.createElement('canvas'));
    if(c.width!==pw||c.height!==ph){c.width=pw;c.height=ph;}
    c.getContext('2d').putImageData(img,0,0);
    markedPatches.push({id:ar.id,x:x0,y:y0,w,h,k,m,canvas:c});
  }
  // los lienzos que sobran del paso anterior se vacían
  for(let i=markedPatches.length;i<markedPatchPool.length;i++){markedPatchPool[i].width=0;markedPatchPool[i].height=0;}
}

// Tras un cambio de zoom, los parches se rehacen si ya no bastan (hace falta
// más resolución o más margen) o sobran de largo; no en cada fotograma del
// gesto, sino 120 ms después del último. Desplazar no cambia la escala.
function markedPatchesFitScale(s){
  if(!markedPatches.length||!s||Math.abs(s-markedPatchScale)<1e-9)return true;
  const{k,m}=markedPatchParams(s);
  const p=markedPatches[0];
  return k>=p.k&&k<=p.k*2&&m<=p.m;
}
function checkMarkedPatchScale(s){
  if(markedPatchesFitScale(s))return;
  clearTimeout(markedPatchTimer);
  markedPatchTimer=setTimeout(()=>{
    if(currentTab!=='marcado'||typeof rebuildMarkedPatches!=='function')return;
    rebuildMarkedPatches();
    drawMarkedOverlay();
  },120);
}
// Para saltos de zoom programados (ir a un área desde la lista o el teclado):
// sin esperar, para que el área se vea nítida desde el primer fotograma.
function syncMarkedPatchScale(){
  if(markedPatchesFitScale(currentMarkedScale())||typeof rebuildMarkedPatches!=='function')return;
  clearTimeout(markedPatchTimer);
  rebuildMarkedPatches();
  drawMarkedOverlay();
}

function releaseMarkedPatches(){
  for(const c of markedPatchPool){c.width=0;c.height=0;}
  markedPatchPool.length=0;
  markedPatches=[];
}

function markedRoundRect(c,x,y,w,h,r){
  r=Math.max(0,Math.min(r,w/2,h/2));
  c.beginPath();
  if(c.roundRect){c.roundRect(x,y,w,h,r);return;}
  c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);
  c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();
}

// Se llama en cada applyCanvasTransform (zoom, desplazamiento, redimensión) y
// tras cada cambio de áreas o de tinte. La geometría sale del rectángulo en
// pantalla de mainCanvas: la misma transformación CSS que ya usa la vista.
function drawMarkedOverlay(){
  const r=canvasWrap.getBoundingClientRect();
  const dpr=window.devicePixelRatio||1;
  const bw=Math.max(1,Math.round(r.width*dpr)),bh=Math.max(1,Math.round(r.height*dpr));
  if(markedCanvas.width!==bw||markedCanvas.height!==bh){markedCanvas.width=bw;markedCanvas.height=bh;}
  kctx.setTransform(1,0,0,1,0,0);
  kctx.clearRect(0,0,bw,bh);
  markedScreenRects=[];
  const areas=typeof markedAreas!=='undefined'?markedAreas:[];
  if(currentTab==='marcado'&&cW&&cH&&areas.length){
    const st=getMarkedStyle();
    const cr=mainCanvas.getBoundingClientRect();
    const s=cr.width/cW;                        // px CSS por px de imagen
    const ox=cr.left-r.left,oy=cr.top-r.top;    // esquina de la imagen en el visor
    const ix1=ox+cW*s,iy1=oy+cH*s,M=st.margin;
    for(const a of areas){
      const x0=Math.max(ox,ox+a.x*s-M),y0=Math.max(oy,oy+a.y*s-M);
      const x1=Math.min(ix1,ox+(a.x+a.w)*s+M),y1=Math.min(iy1,oy+(a.y+a.h)*s+M);
      markedScreenRects.push({id:a.id,x:x0,y:y0,w:x1-x0,h:y1-y0});
    }
    checkMarkedPatchScale(s);
    const shown=markedScreenRects.filter(q=>q.x+q.w>0&&q.y+q.h>0&&q.x<r.width&&q.y<r.height);
    const sel=typeof markedSelectedId!=='undefined'?markedSelectedId:null;
    kctx.setTransform(dpr,0,0,dpr,0,0);
    // 1. halo: la sombra de un relleno con la forma del recuadro
    if(st.shadow){
      kctx.save();
      kctx.shadowColor=st.shadow.color;
      kctx.shadowOffsetX=st.shadow.x*dpr;kctx.shadowOffsetY=st.shadow.y*dpr;
      kctx.shadowBlur=st.shadow.blur*dpr; // la sombra no sigue la transformación
      kctx.fillStyle=st.border;
      for(const q of shown){markedRoundRect(kctx,q.x,q.y,q.w,q.h,st.radius);kctx.fill();}
      kctx.restore();
    }
    // 2. dentro del recuadro, B a color con su tinte, desde el parche del área
    kctx.imageSmoothingEnabled=true;kctx.imageSmoothingQuality='high';
    for(const q of shown){
      const p=markedPatches.find(p=>p.id===q.id);
      if(!p)continue;
      const ix=(q.x-ox)/s,iy=(q.y-oy)/s;
      const sx0=Math.max(ix,p.x),sy0=Math.max(iy,p.y);
      const sx1=Math.min(ix+q.w/s,p.x+p.w),sy1=Math.min(iy+q.h/s,p.y+p.h);
      if(sx1<=sx0||sy1<=sy0)continue;
      kctx.save();
      markedRoundRect(kctx,q.x,q.y,q.w,q.h,st.radius);kctx.clip();
      kctx.drawImage(p.canvas,(sx0-p.x)/p.k,(sy0-p.y)/p.k,(sx1-sx0)/p.k,(sy1-sy0)/p.k,ox+sx0*s,oy+sy0*s,(sx1-sx0)*s,(sy1-sy0)*s);
      kctx.restore();
    }
    // 3. borde claro fino; el área seleccionada, en el color de acción
    for(const q of shown){
      const on=q.id===sel;
      kctx.lineWidth=on?2:1.5;
      kctx.strokeStyle=on?st.selected:st.border;
      markedRoundRect(kctx,q.x,q.y,q.w,q.h,st.radius);kctx.stroke();
    }
  }
  if(typeof onMarkedOverlayDrawn==='function')onMarkedOverlayDrawn();
}
