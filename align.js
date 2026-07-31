// ============================================================================
// align.js — alineación manual por puntos de referencia. Capa de entrada, no
// forma parte del motor de comparación. Soporta hasta 2 puntos por imagen:
// 0/1 punto mantiene el comportamiento original (solo traslación); con 2
// puntos por lado se calcula además escala y giro (ver similarity.js).
// ============================================================================

const alignSection=document.getElementById('alignSection');
const alignCanvasA=document.getElementById('alignCanvasA'),alignCanvasB=document.getElementById('alignCanvasB');
const refAInfo=document.getElementById('refAInfo'),refBInfo=document.getElementById('refBInfo');
const alignWrapEls={A:document.getElementById('alignWrapA'),B:document.getElementById('alignWrapB')};
const alignCanvasEls={A:alignCanvasA,B:alignCanvasB};
const refMarkersEls={A:document.getElementById('refMarkersA'),B:document.getElementById('refMarkersB')};
const hoverMarkerEls={A:document.getElementById('hoverMarkerA'),B:document.getElementById('hoverMarkerB')};
const alignZoomBox=document.getElementById('alignZoomBox');
const alignZoomCanvas=document.getElementById('alignZoomCanvas');
const azctx=alignZoomCanvas.getContext('2d');
const alignZoomInfo=document.getElementById('alignZoomInfo');
const alignGuideEl=document.getElementById('alignGuideText');
const alignTransformSummaryEl=document.getElementById('alignTransformSummary');
const alignTransformWarnEl=document.getElementById('alignTransformWarn');
const ALIGN_ZOOM_WIN=28;
const ALIGN_ZOOM_MAX=40;
const REF_HIT_RADIUS=14; // px de pantalla, para detectar arrastre sobre una marca ya colocada

// pointsA/pointsB: hasta 2 puntos {x,y} en coordenadas naturales, con huecos
// `null` cuando un punto se borra (para no perder la numeración 1/2).
let pointsA=[null,null],pointsB=[null,null];
// Alias que consume app.js: refA/refB (punto 1, modo 0/1 punto sin tocar) y
// refA2/refB2 (punto 2, solo presentes en modo similitud completa).
let refA=null,refB=null,refA2=null,refB2=null;

const markerEls={A:[null,null],B:[null,null]};
const alignViewState={A:{zoom:1,panX:0,panY:0},B:{zoom:1,panX:0,panY:0}};
let alignDrag=null;
let pointDrag=null;

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
  positionAllMarkers(which);
}

// ---- marcas de puntos: creación/posición/borrado --------------------------

function createMarkerEl(which,idx){
  const el=document.createElement('div');
  el.className='ref-marker';
  el.innerHTML=`<div class="rm-line rm-h"></div><div class="rm-line rm-v"></div><div class="rm-circle"></div><div class="rm-badge">${idx+1}</div><button type="button" class="rm-delete" aria-label="Borrar punto ${idx+1}">&times;</button>`;
  const btn=el.querySelector('.rm-delete');
  btn.addEventListener('mousedown',e=>e.stopPropagation());
  btn.addEventListener('click',e=>{e.stopPropagation();deletePoint(which,idx);});
  return el;
}

function ensureMarkerEl(which,idx){
  if(markerEls[which][idx])return markerEls[which][idx];
  const el=createMarkerEl(which,idx);
  refMarkersEls[which].appendChild(el);
  markerEls[which][idx]=el;
  return el;
}

function removeMarkerEl(which,idx){
  const el=markerEls[which][idx];
  if(el){el.remove();markerEls[which][idx]=null;}
}

function positionMarkerEl(which,idx){
  const pts=which==='A'?pointsA:pointsB;
  const p=pts[idx];
  if(!p){removeMarkerEl(which,idx);return;}
  const el=ensureMarkerEl(which,idx);
  const o=alignOrigin(which);
  el.style.left=(o.left+p.x*o.scale)+'px';
  el.style.top=(o.top+p.y*o.scale)+'px';
}

function positionAllMarkers(which){
  positionMarkerEl(which,0);
  positionMarkerEl(which,1);
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

function clampToSource(n,source){
  if(!source)return n;
  return{
    x:Math.max(0,Math.min(n.x,source.naturalWidth-1)),
    y:Math.max(0,Math.min(n.y,source.naturalHeight-1))
  };
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

// ---- texto guía, info de puntos y resumen de transformación ---------------

function formatPointsInfo(pts){
  const parts=[];
  if(pts[0])parts.push(`Punto 1: (${pts[0].x}, ${pts[0].y})`);
  if(pts[1])parts.push(`Punto 2: (${pts[1].x}, ${pts[1].y})`);
  return parts.length?parts.join(' · '):'Sin puntos marcados';
}

function updateRefInfo(which){
  const el=which==='A'?refAInfo:refBInfo;
  const pts=which==='A'?pointsA:pointsB;
  el.textContent=formatPointsInfo(pts);
}

function updateAlignGuide(){
  let msg;
  if(!pointsA[0])msg='Si vas a alinear: punto 1 en la imagen A';
  else if(!pointsB[0])msg='Siguiente: punto 1 en la imagen B';
  else if(!pointsA[1])msg='Siguiente: punto 2 en la imagen A — opcional; con 1 punto ya se corrige el desplazamiento, el segundo añade escala y giro';
  else if(!pointsB[1])msg='Siguiente: punto 2 en la imagen B';
  else msg='Alineación completa — escala, giro y desplazamiento corregidos';
  alignGuideEl.textContent=msg;
}

function formatEs(n,decimals){
  return n.toFixed(decimals).replace('.',',');
}

function updateTransformSummary(){
  if(pointsA[0]&&pointsA[1]&&pointsB[0]&&pointsB[1]){
    const t=computeSimilarityTransform(pointsA[0],pointsA[1],pointsB[0],pointsB[1]);
    alignTransformSummaryEl.textContent=`Escala: ${formatEs(t.scale,3)}× · Giro: ${formatEs(t.thetaDeg,1)}° · Desplazamiento: ${t.offset.dx}, ${t.offset.dy} px`;
    alignTransformSummaryEl.style.display='block';
    const warns=transformWarnings(t.scale,t.thetaDeg,null);
    if(warns.length){
      alignTransformWarnEl.textContent='Aviso: '+warns.join(' ');
      alignTransformWarnEl.style.display='block';
    }else{
      alignTransformWarnEl.style.display='none';
    }
  }else{
    alignTransformSummaryEl.style.display='none';
    alignTransformWarnEl.style.display='none';
  }
}

function syncRefGlobals(){
  refA=pointsA[0]||null;
  refB=pointsB[0]||null;
  refA2=pointsA[1]||null;
  refB2=pointsB[1]||null;
}

function refreshAfterPointsChange(which){
  updateRefInfo(which);
  syncRefGlobals();
  updateAlignGuide();
  updateTransformSummary();
  if(typeof checkAlignmentSuggestion==='function')checkAlignmentSuggestion(!!(pointsA[0]&&pointsA[1]&&pointsB[0]&&pointsB[1]));
}

function placeNextPoint(which,n){
  const pts=which==='A'?pointsA:pointsB;
  const idx=pts.findIndex(p=>!p);
  if(idx===-1)return; // los 2 puntos de este lado ya están colocados
  pts[idx]=n;
  positionMarkerEl(which,idx);
  refreshAfterPointsChange(which);
}

function deletePoint(which,idx){
  const pts=which==='A'?pointsA:pointsB;
  pts[idx]=null;
  removeMarkerEl(which,idx);
  refreshAfterPointsChange(which);
}

// ---- interacción: clic para marcar, arrastrar marca, panear, zoom ---------

function pointScreenPos(which,idx){
  const pts=which==='A'?pointsA:pointsB;
  const p=pts[idx];
  if(!p)return null;
  const o=alignOrigin(which);
  const wrapRect=alignWrapEls[which].getBoundingClientRect();
  return{x:wrapRect.left+o.left+p.x*o.scale,y:wrapRect.top+o.top+p.y*o.scale};
}

function hitTestMarker(which,clientX,clientY){
  const pts=which==='A'?pointsA:pointsB;
  for(let idx=0;idx<pts.length;idx++){
    if(!pts[idx])continue;
    const s=pointScreenPos(which,idx);
    if(Math.hypot(clientX-s.x,clientY-s.y)<=REF_HIT_RADIUS)return idx;
  }
  return -1;
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
    const hitIdx=hitTestMarker(which,e.clientX,e.clientY);
    if(hitIdx>=0){
      pointDrag={which,idx:hitIdx};
      e.preventDefault();
      return;
    }
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
  if(pointDrag){
    const{which,idx}=pointDrag;
    const canvas=alignCanvasEls[which];
    const source=which==='A'?sourceA:sourceB;
    const n=clampToSource(alignEventToNatural(e,canvas),source);
    const pts=which==='A'?pointsA:pointsB;
    pts[idx]=n;
    positionMarkerEl(which,idx);
    refreshAfterPointsChange(which);
    if(source){
      positionHoverMarker(which,e.clientX,e.clientY);
      alignZoomBox.style.display='block';
      let lx=e.clientX+18,ly=e.clientY-90;
      if(lx+180>window.innerWidth)lx=e.clientX-190;
      if(ly<0)ly=e.clientY+10;
      alignZoomBox.style.left=lx+'px';alignZoomBox.style.top=ly+'px';
      drawAlignLoupe(source,n.x,n.y);
      alignZoomInfo.textContent=`px: ${n.x}, ${n.y}`;
    }
    return;
  }
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
  if(pointDrag){
    hideHoverMarker(pointDrag.which);
    alignZoomBox.style.display='none';
    pointDrag=null;
    return;
  }
  if(!alignDrag)return;
  const{which,moved}=alignDrag;
  if(!moved){
    const canvas=alignCanvasEls[which];
    const n=alignEventToNatural(e,canvas);
    placeNextPoint(which,n);
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
    if(alignDrag||pointDrag)return;
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
  canvas.onmouseleave=()=>{if(!pointDrag){alignZoomBox.style.display='none';hideHoverMarker(which);}};
}
setupAlignLoupe('A',()=>sourceA);
setupAlignLoupe('B',()=>sourceB);

function resetRefPoints(){
  pointsA=[null,null];pointsB=[null,null];
  removeMarkerEl('A',0);removeMarkerEl('A',1);
  removeMarkerEl('B',0);removeMarkerEl('B',1);
  refAInfo.textContent='Sin puntos marcados';
  refBInfo.textContent='Sin puntos marcados';
  syncRefGlobals();
  updateAlignGuide();
  updateTransformSummary();
  if(typeof checkAlignmentSuggestion==='function')checkAlignmentSuggestion(false);
}
document.getElementById('btnResetRef').onclick=resetRefPoints;
