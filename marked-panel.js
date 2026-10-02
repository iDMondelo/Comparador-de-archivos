// ============================================================================
// marked-panel.js — CAPA DE PRESENTACIÓN de la vista «Marcado»: decide qué
// áreas con diferencias hay (diff-areas.js sobre el mapa ΔE que ya devolvió
// de-worker.js, con el umbral de threshold-control.js), mantiene su estado y
// gestiona el panel (mensaje, casilla, regleta de botones por área y línea
// de detalle), el tooltip con ΔE máx./medio y la navegación. El dibujo vive
// en canvas-view.js. No recalcula ΔE ni habla con el worker.
// ============================================================================

const markedPanelEl=document.getElementById('markedPanel');
const markedSummaryEl=document.getElementById('markedSummary');
const markedListEl=document.getElementById('markedList');
const markedHighlightEl=document.getElementById('markedHighlight');
const markedTipEl=document.getElementById('markedTip');
const markedOverflowEl=document.getElementById('markedOverflow');
const markedDetailEl=document.getElementById('markedDetail');

// Botones como máximo en la regleta (un umbral muy bajo sobre un raster con
// ruido puede dar miles de áreas; la regleta no debe volverse inmanejable).
const MARKED_LIST_MAX=100;

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
  markedSummaryEl.classList.remove('plain');
  markedListEl.innerHTML='';
  markedOverflowEl.hidden=true;markedOverflowEl.textContent='';
  markedDetailEl.hidden=true;markedDetailEl.textContent='';
  drawMarkedOverlay();
}

// Sin diferencias el resumen es una sola línea en --ink (clase `plain`); con
// ellas, el recuento en --ink/600 y la tolerancia en --ink-mute/400.
function markedSummaryHTML(n){
  const t=`ΔE ${formatDE(getThresholdDE())}`;
  if(n===0)return`No hay diferencias por encima de ${t}.`;
  const cuenta=n===1?'1 área con diferencias':`${n.toLocaleString('es')} áreas con diferencias`;
  return`<b>${cuenta}</b> // tolerancia ${t}`;
}

// Un botón por área, con el ΔE máx. y una barra proporcional al ΔE máx. de
// toda la comparación: la diferencia mayor se reconoce sin leer cifras. Se
// construye una sola vez por recálculo — la selección solo repinta estados en
// updateMarkedActive(), para no destruir el foco del botón pulsado.
function renderMarkedPanel(){
  const n=markedAreas.length;
  markedSummaryEl.innerHTML=markedSummaryHTML(n);
  markedSummaryEl.classList.toggle('plain',n===0);
  const shown=markedAreas.slice(0,MARKED_LIST_MAX);
  let deMaxAll=0;
  for(const a of markedAreas)if(a.deltaEMax>deMaxAll)deMaxAll=a.deltaEMax;
  markedListEl.innerHTML=shown.map(a=>{
    const pct=deMaxAll>0?a.deltaEMax/deMaxAll*100:0;
    return`<div class="marked-item">`+
    `<button type="button" class="marked-pill" data-id="${a.id}" aria-pressed="false" `+
    `aria-label="Área ${a.id}, ΔE máximo ${formatDE(a.deltaEMax)}, ${a.w} por ${a.h} píxeles, ${a.nPixeles.toLocaleString('es')} píxeles distintos">`+
    `${a.id}<span class="de">ΔE ${formatDE(a.deltaEMax)}</span></button>`+
    `<div class="marked-bar"><i style="width:max(4px,${pct.toFixed(1)}%)"></i></div>`+
    `</div>`;
  }).join('');
  markedListEl.querySelectorAll('.marked-pill').forEach(btn=>{
    btn.onclick=()=>selectMarkedArea(parseInt(btn.dataset.id,10),true);
  });
  if(n>MARKED_LIST_MAX){
    markedOverflowEl.textContent=`… y ${(n-MARKED_LIST_MAX).toLocaleString('es')} áreas más. Sube el umbral para centrarte en las diferencias mayores.`;
    markedOverflowEl.hidden=false;
  }else{
    markedOverflowEl.textContent='';markedOverflowEl.hidden=true;
  }
  updateMarkedActive(false);
}

// Estado del botón activo y línea de detalle. `moveFocus` solo cuando el foco
// ya estaba en la regleta: así ← → y N/P arrastran el anillo de foco consigo,
// pero un clic en el lienzo no lo roba.
function updateMarkedActive(moveFocus){
  let activeBtn=null;
  markedListEl.querySelectorAll('.marked-pill').forEach(btn=>{
    const on=parseInt(btn.dataset.id,10)===markedSelectedId;
    btn.setAttribute('aria-pressed',on?'true':'false');
    if(on)activeBtn=btn;
  });
  const a=markedSelectedId===null?null:markedAreas.find(x=>x.id===markedSelectedId);
  if(a){
    markedDetailEl.textContent=`Área ${a.id} // ${a.w} × ${a.h} px // ${a.nPixeles.toLocaleString('es')} px distintos`;
    markedDetailEl.hidden=false;
  }else{
    markedDetailEl.textContent='';markedDetailEl.hidden=true;
  }
  if(moveFocus&&activeBtn)activeBtn.focus();
}

function selectMarkedArea(id,center){
  const a=markedAreas.find(x=>x.id===id);
  if(!a)return;
  markedSelectedId=id;markedTipId=id;
  updateMarkedActive(markedListEl.contains(document.activeElement));
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

// ---- datos para el informe --------------------------------------------------

// app.js (btnExportReport) no lee ni el DOM de la regleta ni markedAreas: pide
// aquí las áreas ya formateadas. Vacío si no corresponden al umbral actual.
function getMarkedAreasForReport(){
  if(markedStale)return[];
  return markedAreas.map(a=>({id:a.id,ancho:a.w,alto:a.h,
    deMax:Number(a.deltaEMax.toFixed(2)),deMedio:Number(a.deltaEMedio.toFixed(2)),
    pixelesDiferentes:a.nPixeles}));
}

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
