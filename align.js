// ============================================================================
// align.js — puntos de referencia para la alineación. Capa de entrada, no
// forma parte del motor de comparación. Soporta hasta 2 puntos por imagen:
// 0/1 punto mantiene el comportamiento original (solo traslación); con 2
// puntos por lado se calcula además escala y giro (ver similarity.js). Los
// puntos los coloca vector-picker.js (setPointsFromVector); este archivo solo
// los renderiza como marcas arrastrables/ajustables con el teclado (nudge.js)
// — ya no hay clic manual sobre el canvas para crear un punto nuevo.
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
const alignTransformSummaryEl=document.getElementById('alignTransformSummary');
const alignTransformWarnEl=document.getElementById('alignTransformWarn');
const alignMethodBadgeEl=document.getElementById('alignMethodBadge');
const alignFormatNoticeEl=document.getElementById('alignFormatNotice');
const scaleLockRowEl=document.getElementById('scaleLockRow');
const scaleLockStateEl=document.getElementById('scaleLockState');
const scaleLockTextEl=document.getElementById('scaleLockText');
const scaleLockToggleEl=document.getElementById('scaleLockToggle');
const ALIGN_VECTOR_KINDS=['pdf','ai'];

// Bloqueo de escala (physical-align.js): por defecto activo siempre que ambos
// archivos declaren dimensiones físicas (PDF/.ai). Se vuelve a bloquear al
// cargar un archivo nuevo; el usuario solo lo desbloquea si sabe que uno de
// los archivos fue reescalado.
let scaleLocked=true;

function scaleLockAvailable(){
  return typeof hasPhysicalDims==='function'&&hasPhysicalDims(typeof sourceA!=='undefined'?sourceA:null)&&hasPhysicalDims(typeof sourceB!=='undefined'?sourceB:null);
}

// Consumida por app.js (compare) y vector-picker.js (resumen del picker).
function isScaleLockActive(){
  return scaleLocked&&scaleLockAvailable();
}
const ALIGN_ZOOM_WIN=28;
const ALIGN_ZOOM_MAX=40;
const REF_HIT_RADIUS=14; // px de pantalla, para detectar arrastre sobre una marca ya colocada

// pointsA/pointsB: hasta 2 puntos {x,y} en coordenadas naturales, con huecos
// `null` cuando un punto se borra (para no perder la numeración 1/2).
let pointsA=[null,null],pointsB=[null,null];
// Alias que consume app.js: refA/refB (punto 1, modo 0/1 punto sin tocar) y
// refA2/refB2 (punto 2, solo presentes en modo similitud completa).
let refA=null,refB=null,refA2=null,refB2=null;

// Método de alineación actualmente en uso — puramente informativo (compare()
// sigue decidiendo su rama solo por refA/refB/refA2/refB2, esto es solo para
// el indicador de la UI): 'vector'|'pagebox'|'manual'|'none'.
let activeAlignMethod='none';

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
  if(typeof registerNudgeable==='function'){
    registerNudgeable(el,{
      getPoint:()=>(which==='A'?pointsA:pointsB)[idx],
      setPoint:(p)=>{
        const source=which==='A'?sourceA:sourceB;
        (which==='A'?pointsA:pointsB)[idx]=clampToSource(p,source);
      },
      onChange:()=>{positionMarkerEl(which,idx);refreshAfterPointsChange(which);}
    });
  }
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
    scaleLocked=true;
    if(scaleLockToggleEl)scaleLockToggleEl.checked=false;
    updateScaleLockUI();
    if(typeof updateVectorPickerEntryVisibility==='function')updateVectorPickerEntryVisibility();
    updateAlignFormatNotice();
    updateTransformSummary();
    drawAlignCoverage();
  }else{
    alignSection.style.display='none';
  }
}

// ---- bloqueo de escala: indicador + interruptor ----------------------------

function updateScaleLockUI(){
  if(!scaleLockRowEl)return;
  if(!scaleLockAvailable()){scaleLockRowEl.style.display='none';return;}
  scaleLockRowEl.style.display='flex';
  const dpiTxt=(sourceA.dpi===sourceB.dpi)?` · PPP común: ${sourceA.dpi}`:'';
  if(scaleLocked){
    scaleLockTextEl.textContent='Escala bloqueada a 1:1 — ambos archivos declaran dimensiones físicas'+dpiTxt;
    scaleLockStateEl.classList.remove('unlocked');
  }else{
    scaleLockTextEl.textContent='Escala desbloqueada — se calculará a partir de los elementos y obligará a remuestrear';
    scaleLockStateEl.classList.add('unlocked');
  }
}

if(scaleLockToggleEl){
  scaleLockToggleEl.onchange=()=>{
    scaleLocked=!scaleLockToggleEl.checked;
    updateScaleLockUI();
    updateAlignFormatNotice();
    updateTransformSummary();
    drawAlignCoverage();
    if(typeof checkAlignmentSuggestion==='function')checkAlignmentSuggestion(!!(pointsA[0]&&pointsA[1]&&pointsB[0]&&pointsB[1])&&!isScaleLockActive());
  };
}

// ---- miniaturas de la sección de alineación --------------------------------
// Muestran siempre el render íntegro de cada página, sin tramar y sin
// recortar: el tramado de "no comparable" solo tiene sentido una vez
// calculada la intersección real tras alinear, y eso solo ocurre en la vista
// final de resultados (ver drawMaskOverlay en similarity.js), no aquí — con
// 0 puntos colocados no hay ninguna alineación que justifique tramar nada.

function drawAlignCoverage(){
  if(!sourceA||!sourceB)return;
  ['A','B'].forEach(which=>{
    const canvas=alignCanvasEls[which];
    if(!canvas.width||!canvas.height)return;
    const source=which==='A'?sourceA:sourceB;
    const ctx=canvas.getContext('2d');
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(source.drawable,0,0);
  });
}

// Aviso específico según el formato de A y B: el método vectorial solo está
// disponible para PDF/.AI, así que el mensaje debe reflejar de entrada
// si el usuario ya está en el mejor escenario o si el resultado dependerá
// de la puntería/resolución.
function updateAlignFormatNotice(){
  if(!alignFormatNoticeEl||!sourceA||!sourceB)return;
  const aVec=ALIGN_VECTOR_KINDS.includes(sourceA.sourceType);
  const bVec=ALIGN_VECTOR_KINDS.includes(sourceB.sourceType);
  let text,cls;
  if(aVec&&bVec){
    // Alineación por caja de página (page.view = CropBox ∩ MediaBox; TrimBox/
    // ArtBox no accesibles en PDF.js 4.10): con la escala bloqueada, dos
    // cajas del mismo tamaño físico se alinean por su origen sin escala. Si
    // difieren, no se fuerza la coincidencia: se avisa y se ofrece el
    // elemento vectorial.
    const sizeA=pageSizePt(sourceA),sizeB=pageSizePt(sourceB);
    if(samePageSize(sizeA,sizeB)){
      text=`Alineación vectorial disponible — máxima precisión · Página de ${formatSizeMm(sizeA)} en ambos archivos: alineadas por el origen, sin escala`;
      cls='positive';
    }else{
      text=`Formatos de página distintos: A ${formatSizeMm(sizeA)} · B ${formatSizeMm(sizeB)}. No se fuerza la coincidencia: sin puntos se comparan superpuestas por el origen; para comparar el arte, alinea por elemento vectorial.`;
      cls='warn-strong';
    }
  }else if(aVec!==bVec){
    text='Comparando un formato vectorial con uno ráster: la comparación es posible pero menos fiable. Si puedes, exporta ambos al mismo formato y resolución.';
    cls='warn';
  }else{
    const sameDims=sourceA.naturalWidth===sourceB.naturalWidth&&sourceA.naturalHeight===sourceB.naturalHeight;
    if(!sameDims){
      text=`A: ${sourceA.naturalWidth} × ${sourceA.naturalHeight} px · B: ${sourceB.naturalWidth} × ${sourceB.naturalHeight} px — dimensiones distintas`;
      cls='warn-strong';
    }else{
      text='Los archivos ráster no permiten alineación vectorial. Para comparar dos imágenes es muy recomendable que ambas tengan el mismo tamaño de página y resolución: si no coinciden, el remuestreo introduce diferencias en los bordes que no son cambios reales del diseño.';
      cls='warn';
    }
  }
  alignFormatNoticeEl.textContent=text;
  alignFormatNoticeEl.className='align-format-notice '+cls;
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
  if(pts[0])parts.push(`Punto 1: (${formatEs(pts[0].x,2)}, ${formatEs(pts[0].y,2)})`);
  if(pts[1])parts.push(`Punto 2: (${formatEs(pts[1].x,2)}, ${formatEs(pts[1].y,2)})`);
  return parts.length?parts.join(' · '):'Sin puntos marcados';
}

function updateRefInfo(which){
  const el=which==='A'?refAInfo:refBInfo;
  const pts=which==='A'?pointsA:pointsB;
  el.textContent=formatPointsInfo(pts);
}

function formatEs(n,decimals){
  return n.toFixed(decimals).replace('.',',');
}

function updateTransformSummary(){
  const full=!!(pointsA[0]&&pointsA[1]&&pointsB[0]&&pointsB[1]);
  if(isScaleLockActive()&&pointsA[0]&&pointsB[0]){
    // Escala bloqueada: traslación pura calculada en puntos (physical-align.js).
    const t=computeLockedTransform(sourceA,sourceB,pointsA[0],pointsB[0],pointsA[1],pointsB[1]);
    alignTransformSummaryEl.textContent=formatLockedTransform(t);
    alignTransformSummaryEl.style.display='block';
    if(t.warnings.length){
      alignTransformWarnEl.textContent='Aviso: '+t.warnings.join(' ');
      alignTransformWarnEl.style.display='block';
    }else{
      alignTransformWarnEl.style.display='none';
    }
  }else if(full){
    const t=computeSimilarityTransform(pointsA[0],pointsA[1],pointsB[0],pointsB[1]);
    alignTransformSummaryEl.textContent=`Escala: ${formatEs(t.scale,3)}× · Giro: ${formatEs(t.thetaDeg,1)}° · Desplazamiento: ${formatEs(t.offset.dx,2)}, ${formatEs(t.offset.dy,2)} px`;
    alignTransformSummaryEl.style.display='block';
    const warns=transformWarnings(t.scale,t.thetaDeg,null);
    if(scaleLockAvailable()){
      const noise=unlockedNoiseWarning(t.scale);
      if(noise)warns.push(noise);
    }
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

function updateAlignMethodBadge(){
  if(!alignMethodBadgeEl)return;
  const labels={vector:'elemento vectorial',manual:'puntos manuales',pagebox:'caja de página',none:'—'};
  alignMethodBadgeEl.textContent='Método activo: '+(labels[activeAlignMethod]||labels.none);
}

// Todo clic/arrastre manual del usuario sobre los canvases de #alignSection
// pasa por aquí — por eso es el sitio natural para degradar el método activo
// a 'manual' (o 'pagebox' con 0 puntos). setPointsFromVector() llama a esta
// misma función y luego SOBRESCRIBE activeAlignMethod a 'vector' a
// continuación, así que un resultado del picker no queda mal etiquetado.
function refreshAfterPointsChange(which){
  updateRefInfo(which);
  syncRefGlobals();
  updateTransformSummary();
  activeAlignMethod=(pointsA[0]||pointsB[0])?'manual':'pagebox';
  updateAlignMethodBadge();
  drawAlignCoverage();
  // Con la escala bloqueada no hay remuestreo, así que no procede subir el
  // umbral ΔE por "ruido de alineación".
  if(typeof checkAlignmentSuggestion==='function')checkAlignmentSuggestion(!!(pointsA[0]&&pointsA[1]&&pointsB[0]&&pointsB[1])&&!isScaleLockActive());
}

// Llamado desde vector-picker.js al confirmar la selección de elemento
// vectorial. `pts` = {A1,B1,A2?,B2?} en coordenadas naturales — deja los
// puntos como marcas .ref-marker normales (nudgeables, arrastrables, etc.),
// exactamente el mismo estado que ya consume compare().
function setPointsFromVector(pts){
  pointsA[0]=pts.A1||null;pointsB[0]=pts.B1||null;
  pointsA[1]=pts.A2||null;pointsB[1]=pts.B2||null;
  positionAllMarkers('A');positionAllMarkers('B');
  refreshAfterPointsChange('A');refreshAfterPointsChange('B');
  activeAlignMethod='vector';
  updateAlignMethodBadge();
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
      // preventDefault() de aquí abajo bloquea el foco automático del
      // navegador — se fuerza a mano para que el nudge por teclado (flechas)
      // quede activo nada más soltar el arrastre.
      const markerEl=markerEls[which][hitIdx];
      if(markerEl)markerEl.focus();
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
  if(moved)alignCanvasEls[which].style.cursor='';
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
  updateTransformSummary();
  activeAlignMethod=(typeof sourceA!=='undefined'&&sourceA&&typeof sourceB!=='undefined'&&sourceB)?'pagebox':'none';
  updateAlignMethodBadge();
  if(typeof sourceA!=='undefined'&&sourceA&&typeof sourceB!=='undefined'&&sourceB)drawAlignCoverage();
  if(typeof checkAlignmentSuggestion==='function')checkAlignmentSuggestion(false);
}
document.getElementById('btnResetRef').onclick=resetRefPoints;
