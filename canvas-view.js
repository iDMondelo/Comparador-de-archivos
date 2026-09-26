// ============================================================================
// canvas-view.js — sistema de vista del visor principal: zoom/pan por CSS
// transform, lupa de inspección por píxel, y sincronía del canvas de
// recuadros de zonas (Objetivo 4) con el canvas de imagen.
// No pertenece al motor de comparación: solo consume ImageData ya calculado.
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

const viewState={
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
      }else if(currentTab==='imgB'){
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
