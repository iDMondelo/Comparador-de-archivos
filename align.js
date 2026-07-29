// ============================================================================
// align.js — alineación manual por punto de referencia. Capa de entrada,
// no forma parte del motor de comparación. Extraído del index.html original
// sin cambios de lógica, salvo adaptarlo a la fuente normalizada
// {drawable, naturalWidth, naturalHeight} que ahora puede ser una imagen
// rasterizada o un canvas renderizado desde PDF/SVG (ver pdf-source.js).
// ============================================================================

const alignSection=document.getElementById('alignSection');
const alignCanvasA=document.getElementById('alignCanvasA'),alignCanvasB=document.getElementById('alignCanvasB');
const refAInfo=document.getElementById('refAInfo'),refBInfo=document.getElementById('refBInfo');
const alignWrapEls={A:document.getElementById('alignWrapA'),B:document.getElementById('alignWrapB')};
const alignCanvasEls={A:alignCanvasA,B:alignCanvasB};
const refMarkerEls={A:document.getElementById('refMarkerA'),B:document.getElementById('refMarkerB')};
const hoverMarkerEls={A:document.getElementById('hoverMarkerA'),B:document.getElementById('hoverMarkerB')};
const alignZoomBox=document.getElementById('alignZoomBox');
const alignZoomCanvas=document.getElementById('alignZoomCanvas');
const azctx=alignZoomCanvas.getContext('2d');
const alignZoomInfo=document.getElementById('alignZoomInfo');
const ALIGN_ZOOM_WIN=28;

let refA=null,refB=null;
const alignViewState={A:{zoom:1,panX:0,panY:0},B:{zoom:1,panX:0,panY:0}};
let alignDrag=null;
const ALIGN_ZOOM_MAX=40;

function alignFitScale(which){
  const canvas=alignCanvasEls[which];
  if(!canvas.width||!canvas.height)return 1;
  const r=alignWrapEls[which].getBoundingClientRect();
  return Math.min(r.width/canvas.width,r.height/canvas.height);
}

function alignOrigin(which){
  const canvas=alignCanvasEls[which];
  const st=alignViewState[which];
  const base=alignFitScale(which);
  const scale=base*st.zoom;
  const r=alignWrapEls[which].getBoundingClientRect();
  return{
    left:r.width/2-(canvas.width*scale)/2+st.panX,
    top:r.height/2-(canvas.height*scale)/2+st.panY,
    scale
  };
}

function applyAlignTransform(which){
  const canvas=alignCanvasEls[which];
  if(!canvas.width||!canvas.height)return;
  const st=alignViewState[which];
  const base=alignFitScale(which);
  canvas.style.width=(canvas.width*base*st.zoom)+'px';
  canvas.style.height=(canvas.height*base*st.zoom)+'px';
  canvas.style.transform=`translate(${st.panX}px, ${st.panY}px)`;
  positionRefMarker(which);
}

function positionRefMarker(which){
  const ref=which==='A'?refA:refB;
  const marker=refMarkerEls[which];
  if(!ref){marker.style.display='none';return;}
  const o=alignOrigin(which);
  marker.style.left=(o.left+ref.x*o.scale)+'px';
  marker.style.top=(o.top+ref.y*o.scale)+'px';
  marker.style.display='block';
}

// `source` es el objeto normalizado {drawable, naturalWidth, naturalHeight}
function initAlignCanvas(which,source){
  const canvas=alignCanvasEls[which];
  canvas.width=source.naturalWidth;canvas.height=source.naturalHeight;
  canvas.getContext('2d').drawImage(source.drawable,0,0);
  alignViewState[which]={zoom:1,panX:0,panY:0};
  applyAlignTransform(which);
}

function updateAlignSection(){
  if(sourceA&&sourceB){
    alignSection.style.display='block';
    initAlignCanvas('A',sourceA);
    initAlignCanvas('B',sourceB);
  }else{
    alignSection.style.display='none';
  }
}

function alignEventToNatural(e,canvas){
  const rect=canvas.getBoundingClientRect();
  const scaleX=canvas.width/rect.width,scaleY=canvas.height/rect.height;
  return{x:Math.round((e.clientX-rect.left)*scaleX),y:Math.round((e.clientY-rect.top)*scaleY)};
}

function positionHoverMarker(which,clientX,clientY){
  const r=alignWrapEls[which].getBoundingClientRect();
  const marker=hoverMarkerEls[which];
  marker.style.left=(clientX-r.left)+'px';
  marker.style.top=(clientY-r.top)+'px';
  marker.style.display='block';
}
function hideHoverMarker(which){
  hoverMarkerEls[which].style.display='none';
}

function setupAlignInteraction(which){
  const wrap=alignWrapEls[which];
  const canvas=alignCanvasEls[which];

  wrap.addEventListener('wheel',e=>{
    if(!canvas.width||!canvas.height)return;
    e.preventDefault();
    const st=alignViewState[which];
    const r=wrap.getBoundingClientRect();
    const base=alignFitScale(which);
    const oldScale=base*st.zoom;
    const mx=e.clientX-r.left,my=e.clientY-r.top;
    const cLeft=r.width/2-(canvas.width*oldScale)/2+st.panX;
    const cTop=r.height/2-(canvas.height*oldScale)/2+st.panY;
    const srcX=(mx-cLeft)/oldScale,srcY=(my-cTop)/oldScale;
    const factor=e.deltaY<0?1.15:1/1.15;
    const newZoom=Math.min(ALIGN_ZOOM_MAX,Math.max(ZOOM_MIN,st.zoom*factor));
    const newScale=base*newZoom;
    st.panX=mx-srcX*newScale-(r.width/2-(canvas.width*newScale)/2);
    st.panY=my-srcY*newScale-(r.height/2-(canvas.height*newScale)/2);
    st.zoom=newZoom;
    applyAlignTransform(which);
  },{passive:false});

  wrap.addEventListener('mousedown',e=>{
    if(!canvas.width||!canvas.height)return;
    alignDrag={which,startX:e.clientX,startY:e.clientY,panX:alignViewState[which].panX,panY:alignViewState[which].panY,moved:false};
  });

  wrap.addEventListener('dblclick',()=>{
    if(!canvas.width||!canvas.height)return;
    alignViewState[which].zoom=1;alignViewState[which].panX=0;alignViewState[which].panY=0;
    applyAlignTransform(which);
  });
}
setupAlignInteraction('A');
setupAlignInteraction('B');

window.addEventListener('mousemove',e=>{
  if(!alignDrag)return;
  const dx=e.clientX-alignDrag.startX,dy=e.clientY-alignDrag.startY;
  if(!alignDrag.moved&&Math.hypot(dx,dy)>4){
    alignDrag.moved=true;
    alignCanvasEls[alignDrag.which].style.cursor='grabbing';
    alignZoomBox.style.display='none';
    hideHoverMarker(alignDrag.which);
  }
  if(alignDrag.moved){
    const st=alignViewState[alignDrag.which];
    st.panX=alignDrag.panX+dx;st.panY=alignDrag.panY+dy;
    applyAlignTransform(alignDrag.which);
  }
});
window.addEventListener('mouseup',e=>{
  if(!alignDrag)return;
  const{which,moved}=alignDrag;
  if(!moved){
    const canvas=alignCanvasEls[which];
    const n=alignEventToNatural(e,canvas);
    if(which==='A'){refA=n;refAInfo.textContent=`Punto A: (${n.x}, ${n.y})`;}
    else{refB=n;refBInfo.textContent=`Punto B: (${n.x}, ${n.y})`;}
    positionRefMarker(which);
  }else{
    alignCanvasEls[which].style.cursor='';
  }
  alignDrag=null;
});

// `getSource` debe devolver el objeto normalizado {drawable, naturalWidth, naturalHeight}
function drawAlignLoupe(source,nx,ny){
  const win=ALIGN_ZOOM_WIN;
  const factor=alignZoomCanvas.width/win;
  nx=Math.max(0,Math.min(nx,source.naturalWidth-1));
  ny=Math.max(0,Math.min(ny,source.naturalHeight-1));
  let sx=Math.round(nx-win/2),sy=Math.round(ny-win/2);
  sx=Math.max(0,Math.min(sx,Math.max(0,source.naturalWidth-win)));
  sy=Math.max(0,Math.min(sy,Math.max(0,source.naturalHeight-win)));
  const cw=Math.min(win,source.naturalWidth),ch=Math.min(win,source.naturalHeight);
  azctx.imageSmoothingEnabled=false;
  azctx.clearRect(0,0,alignZoomCanvas.width,alignZoomCanvas.height);
  azctx.drawImage(source.drawable,sx,sy,cw,ch,0,0,cw*factor,ch*factor);
  const cxp=(nx-sx+0.5)*factor,cyp=(ny-sy+0.5)*factor;
  azctx.strokeStyle='#00e0ff';azctx.lineWidth=1.5;
  azctx.strokeRect(Math.round(cxp-factor/2),Math.round(cyp-factor/2),factor,factor);
  azctx.beginPath();
  azctx.moveTo(cxp-8,cyp);azctx.lineTo(cxp+8,cyp);
  azctx.moveTo(cxp,cyp-8);azctx.lineTo(cxp,cyp+8);
  azctx.stroke();
}

function setupAlignLoupe(which,getSource){
  const canvas=alignCanvasEls[which];
  canvas.onmousemove=e=>{
    if(alignDrag)return;
    const source=getSource();
    if(!source)return;
    const n=alignEventToNatural(e,canvas);
    positionHoverMarker(which,e.clientX,e.clientY);
    alignZoomBox.style.display='block';
    let lx=e.clientX+18,ly=e.clientY-90;
    if(lx+180>window.innerWidth)lx=e.clientX-190;
    if(ly<0)ly=e.clientY+10;
    alignZoomBox.style.left=lx+'px';alignZoomBox.style.top=ly+'px';
    drawAlignLoupe(source,n.x,n.y);
    alignZoomInfo.textContent=`px: ${n.x}, ${n.y}`;
  };
  canvas.onmouseleave=()=>{alignZoomBox.style.display='none';hideHoverMarker(which);};
}
setupAlignLoupe('A',()=>sourceA);
setupAlignLoupe('B',()=>sourceB);

function resetRefPoints(){
  refA=null;refB=null;
  refAInfo.textContent='Sin punto marcado';
  refBInfo.textContent='Sin punto marcado';
  positionRefMarker('A');
  positionRefMarker('B');
}
document.getElementById('btnResetRef').onclick=resetRefPoints;
