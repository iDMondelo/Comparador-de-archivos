// ============================================================================
// marked-panel.js — CAPA DE PRESENTACIÓN de la vista «Marcado»: decide qué
// áreas con diferencias hay (diff-areas.js sobre el mapa ΔE que ya devolvió
// de-worker.js, con el umbral de threshold-control.js), mantiene su estado y
// gestiona el panel (mensaje, casilla, lista), el tooltip con ΔE máx./medio
// y la navegación. El dibujo vive en canvas-view.js. No recalcula ΔE ni
// habla con el worker.
// ============================================================================

const markedPanelEl=document.getElementById('markedPanel');
const markedSummaryEl=document.getElementById('markedSummary');
const markedListEl=document.getElementById('markedList');
const markedHighlightEl=document.getElementById('markedHighlight');
const markedTipEl=document.getElementById('markedTip');

// Filas como máximo en la lista (un umbral muy bajo sobre un raster con
// ruido puede dar miles de áreas; la lista no debe volverse inmanejable).
const MARKED_LIST_MAX=500;

let markedAreas=[];
let markedSelectedId=null;
let markedTipId=null;
let markedStale=true;      // las áreas no corresponden al umbral/encaje actuales
let markedMarginUsed=null; // margen de fusión (px de imagen) con que se calcularon
// Región de análisis opcional {x,y,w,h}, en píxeles de la imagen comparada.
// Hoy ninguna interfaz la fija (null = imagen completa); detectDiffAreas ya
// la respeta para cuando exista.
let diffAreasRoi=null;

// Margen de fusión en píxeles de imagen: el margen de pantalla del recuadro
// (--space-4) al zoom de encaje, que es el mínimo. Dos áreas cuyos recuadros
// se tocarían en encaje se funden en una, así que los recuadros no se solapan
// a ningún zoom y el recuento solo depende del umbral.
function markedMergeMarginPx(){
  const s=fitScale();
  return s>0?getMarkedStyle().margin/s:0;
}

function computeMarkedAreas(){
  markedSelectedId=null;
  hideMarkedTip();
  if(!pixelDEmap||!diffIndex){markedAreas=[];return;}
  markedMarginUsed=markedMergeMarginPx();
  markedAreas=detectDiffAreas(diffIndex,pixelDEmap,getThresholdDE(),{
    mask:compareMaskGlobal,roi:diffAreasRoi,mergeMarginPx:markedMarginUsed
  });
  markedStale=false;
}

function rebuildMarkedPatches(){
  buildMarkedPatches(markedAreas,getThresholdDE(),markedHighlightEl.checked);
}

// Desde renderTab('marcado'), con la imagen lavada ya en mainCanvas y la
// transformación de la vista aplicada. Los parches no dependen de mainCanvas:
// si nada cambió, se reutilizan (drawMarkedOverlay los rehace si el zoom ya
// no les basta).
function enterMarkedView(){
  if(markedStale){computeMarkedAreas();rebuildMarkedPatches();}
  renderMarkedPanel();
  drawMarkedOverlay();
}

// Desde app.js (onThresholdApplied), en el mismo fotograma que re-umbraliza
// el overlay: fuera de Marcado solo se marca pendiente.
function onMarkedThreshold(){
  markedStale=true;
  if(currentTab==='marcado'&&pixelDEmap)refreshMarked();
}

function refreshMarked(){
  computeMarkedAreas();
  rebuildMarkedPatches();
  renderMarkedPanel();
  drawMarkedOverlay();
}

// Resultado descartado (nueva comparación, archivo nuevo, reinicio): libera
// la imagen lavada y los parches, y olvida las áreas.
function clearMarked(){
  markedAreas=[];markedSelectedId=null;markedStale=true;markedMarginUsed=null;
  hideMarkedTip();
  releaseMarkedPatches();
  releaseWashedCache();
  markedSummaryEl.textContent='';
  markedListEl.innerHTML='';
  drawMarkedOverlay();
}

function markedSummaryText(n){
  if(n===0)return'No se han hallado diferencias con este umbral';
  if(n===1)return'Hallada 1 área con diferencias';
  return`Halladas ${n.toLocaleString('es')} áreas con diferencias`;
}

function renderMarkedPanel(){
  const n=markedAreas.length;
  markedSummaryEl.textContent=markedSummaryText(n);
  const rows=markedAreas.slice(0,MARKED_LIST_MAX).map(a=>
    `<div class="region-row${a.id===markedSelectedId?' active':''}" data-id="${a.id}">`+
    `<span class="region-badge area-badge">${a.id}</span>`+
    `<span>${a.w}×${a.h}px</span>`+
    `<span>ΔE máx ${formatDE(a.deltaEMax)}</span>`+
    `<span class="region-coords">${a.nPixeles.toLocaleString('es')} px</span>`+
    `</div>`
  );
  if(n>MARKED_LIST_MAX)rows.push(`<div class="hint">… y ${(n-MARKED_LIST_MAX).toLocaleString('es')} áreas más. Sube el umbral para centrarte en las diferencias mayores.</div>`);
  markedListEl.innerHTML=rows.join('');
  markedListEl.querySelectorAll('.region-row').forEach(row=>{
    row.onclick=()=>selectMarkedArea(parseInt(row.dataset.id,10),true);
  });
}

function selectMarkedArea(id,center){
  const a=markedAreas.find(x=>x.id===id);
  if(!a)return;
  markedSelectedId=id;markedTipId=id;
  renderMarkedPanel();
  if(center)centerOnMarkedArea(a); // redibuja vía applyCanvasTransform
  else drawMarkedOverlay();
}

function centerOnMarkedArea(a){
  const base=fitScale();
  const r=canvasWrap.getBoundingClientRect();
  const desiredScale=Math.min(r.width*0.5/Math.max(a.w,1),r.height*0.5/Math.max(a.h,1));
  const zoom=Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,desiredScale/base));
  centerViewOn(a.x+a.w/2,a.y+a.h/2,zoom,'marcado');
  syncMarkedPatchScale();
}

function stepMarkedArea(delta){
  if(!markedAreas.length)return;
  let idx=markedAreas.findIndex(a=>a.id===markedSelectedId);
  idx=idx<0?0:(idx+delta+markedAreas.length)%markedAreas.length;
  selectMarkedArea(markedAreas[idx].id,true);
}

// ---- tooltip ΔE máx./medio --------------------------------------------------

function hideMarkedTip(){
  markedTipId=null;
  markedTipEl.hidden=true;
}

// canvas-view.js lo llama al final de cada drawMarkedOverlay: el tooltip
// sigue a su recuadro con el zoom y el desplazamiento, y se oculta si el
// recuadro sale del visor.
function onMarkedOverlayDrawn(){
  if(markedTipId===null)return;
  const a=markedAreas.find(x=>x.id===markedTipId);
  const q=markedScreenRects.find(x=>x.id===markedTipId);
  const r=canvasWrap.getBoundingClientRect();
  if(!a||!q||q.x+q.w<0||q.y+q.h<0||q.x>r.width||q.y>r.height){markedTipEl.hidden=true;return;}
  markedTipEl.innerHTML=`<b>Área ${a.id}</b> · ΔE máx. ${formatDE(a.deltaEMax)} · ΔE medio ${formatDE(a.deltaEMedio)}`;
  markedTipEl.hidden=false;
  const tw=markedTipEl.offsetWidth,th=markedTipEl.offsetHeight,gap=8;
  let left=q.x+q.w/2-tw/2,top=q.y-th-gap;
  if(top<gap)top=q.y+q.h+gap;
  left=Math.max(gap,Math.min(left,r.width-tw-gap));
  top=Math.max(gap,Math.min(top,r.height-th-gap));
  markedTipEl.style.left=left+'px';
  markedTipEl.style.top=top+'px';
}

// ---- eventos ----------------------------------------------------------------

markedHighlightEl.onchange=()=>{
  if(!pixelDEmap||markedStale)return;
  rebuildMarkedPatches();
  drawMarkedOverlay();
};

// Clic (sin arrastre) sobre el lienzo: el recuadro bajo el cursor muestra su
// tooltip; fuera de cualquier recuadro, se cierra. El arrastre para desplazar
// lo gestiona canvas-view.js.
let markedPointerDown=null;
canvasWrap.addEventListener('mousedown',e=>{markedPointerDown={x:e.clientX,y:e.clientY};});
canvasWrap.addEventListener('click',e=>{
  const down=markedPointerDown;markedPointerDown=null;
  if(currentTab!=='marcado'||!down)return;
  if(Math.hypot(e.clientX-down.x,e.clientY-down.y)>=4)return;
  const r=canvasWrap.getBoundingClientRect();
  const px=e.clientX-r.left,py=e.clientY-r.top;
  const hit=markedScreenRects.find(q=>px>=q.x&&px<=q.x+q.w&&py>=q.y&&py<=q.y+q.h);
  if(hit)selectMarkedArea(hit.id,false);
  else if(markedTipId!==null){hideMarkedTip();}
});

document.addEventListener('keydown',e=>{
  if(currentTab!=='marcado'||resultsArea.style.display==='none')return;
  const tag=(e.target.tagName||'').toLowerCase();
  if(tag==='input'||tag==='select'||tag==='textarea')return;
  if(e.key==='Escape'){hideMarkedTip();return;}
  if(!markedAreas.length)return;
  if(e.key==='ArrowRight'||e.key==='n'||e.key==='N'){e.preventDefault();stepMarkedArea(1);}
  else if(e.key==='ArrowLeft'||e.key==='p'||e.key==='P'){e.preventDefault();stepMarkedArea(-1);}
});

// El margen de fusión depende del encaje, y el encaje del tamaño del visor.
let markedResizeTimer=null;
window.addEventListener('resize',()=>{
  clearTimeout(markedResizeTimer);
  markedResizeTimer=setTimeout(()=>{
    if(!pixelDEmap||markedMarginUsed===null)return;
    if(Math.abs(markedMergeMarginPx()-markedMarginUsed)<0.5)return;
    markedStale=true;
    if(currentTab==='marcado')refreshMarked();
  },150);
});
