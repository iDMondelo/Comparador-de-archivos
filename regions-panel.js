// ============================================================================
// regions-panel.js — CAPA DE PRESENTACIÓN de zonas diferentes (Objetivo 4).
// Dibuja los recuadros en un canvas apilado (nunca dentro del ImageData del
// motor) y gestiona el panel lateral de zonas. Solo lee resultados que ya
// calculó de-worker.js (mensaje 'regionsResult'); no recalcula ΔE.
// ============================================================================

const regionsPanelWrap=document.getElementById('regionsPanel');
const regionsListEl=document.getElementById('regionsList');
const toggleRegionsEl=document.getElementById('toggleRegions');
const minSizeInput=document.getElementById('regionMinSize');
const regionsSortBySel=document.getElementById('regionsSortBy');
const strokeSizeInput=document.getElementById('regionStrokeSize');
const strokeValEl=document.getElementById('regionStrokeVal');
const regionStatsEl=document.getElementById('regionStatsInfo');

let currentRegions=[];
let selectedRegionId=null;
let regionsVisible=true;
let regionsDebounceTimer=null;
let regionStrokePx=parseInt(strokeSizeInput.value)||3;

const REGION_COLOR=getComputedStyle(document.documentElement).getPropertyValue('--region-mark').trim()||'#FF00FF';
const REGION_HILITE=getComputedStyle(document.documentElement).getPropertyValue('--marker').trim()||'#22d3e8';

// Grosor de trazo y tamaño de fuente deseados en píxeles de PANTALLA (no de
// canvas nativo). paintRegions() los convierte a píxeles nativos dividiendo
// por screenScale, para que el grosor/tamaño aparente no cambie con el zoom.
const REGION_FONT_SCREEN_PX=18;
const REGION_BADGE_PAD_SCREEN_PX=5;
// Ancho de referencia usado solo para la exportación a PNG: el grosor de
// export escala con la resolución nativa del archivo (cW), nunca con el
// zoom de pantalla en el momento de exportar.
const REGION_EXPORT_REF_WIDTH=1000;

function paintRegions(targetCtx,screenScale){
  const s=Math.max(screenScale,1e-4);
  const lineW=regionStrokePx/s;
  const fontPx=REGION_FONT_SCREEN_PX/s;
  const pad=REGION_BADGE_PAD_SCREEN_PX/s;
  targetCtx.textAlign='center';
  targetCtx.textBaseline='middle';
  currentRegions.forEach(r=>{
    const hi=r.id===selectedRegionId;
    targetCtx.font=`bold ${fontPx}px "Montserrat",system-ui,sans-serif`;
    targetCtx.lineWidth=hi?lineW*1.5:lineW;
    targetCtx.strokeStyle=hi?REGION_HILITE:REGION_COLOR;
    targetCtx.strokeRect(r.x+0.5,r.y+0.5,Math.max(r.w-1,1),Math.max(r.h-1,1));
    const label=String(r.id);
    const tw=targetCtx.measureText(label).width;
    const radius=Math.max(fontPx*0.7,tw/2)+pad;
    targetCtx.beginPath();
    targetCtx.arc(r.x,r.y,radius,0,Math.PI*2);
    targetCtx.fillStyle=hi?REGION_HILITE:REGION_COLOR;
    targetCtx.fill();
    targetCtx.fillStyle='#08130e';
    targetCtx.fillText(label,r.x,r.y+fontPx*0.05);
  });
  targetCtx.textAlign='left';
  targetCtx.textBaseline='alphabetic';
}

function drawRegionsOverlay(){
  if(!regionsCanvas.width||!regionsCanvas.height)return;
  rctx.clearRect(0,0,regionsCanvas.width,regionsCanvas.height);
  if(!regionsVisible)return;
  const st=viewState[currentTab]||viewState.overlay;
  paintRegions(rctx,fitScale()*st.zoom);
}

function getSortedRegions(){
  const by=regionsSortBySel.value;
  const arr=currentRegions.slice();
  if(by==='de')arr.sort((a,b)=>b.deMaxRegion-a.deMaxRegion);
  else arr.sort((a,b)=>a.id-b.id);
  return arr;
}

function renderRegionsList(){
  const sorted=getSortedRegions();
  regionsListEl.innerHTML=sorted.length?sorted.map(r=>
    `<div class="region-row${r.id===selectedRegionId?' active':''}" data-id="${r.id}">`+
    `<span class="region-badge">${r.id}</span>`+
    `<span>${r.w}×${r.h}px</span>`+
    `<span>ΔE máx ${formatDE(r.deMaxRegion)}</span>`+
    `<span class="region-coords">(${r.x}, ${r.y})</span>`+
    `</div>`
  ).join(''):'<div class="hint">Sin zonas detectadas con los parámetros actuales.</div>';
  regionsListEl.querySelectorAll('.region-row').forEach(row=>{
    row.onclick=()=>selectRegion(parseInt(row.dataset.id,10));
  });
}

function centerOnRegion(region){
  const base=fitScale();
  const r=canvasWrap.getBoundingClientRect();
  const desiredScale=(r.width*0.5)/Math.max(region.w,1);
  let zoom=desiredScale/base;
  zoom=Math.min(ZOOM_MAX,Math.max(ZOOM_MIN,zoom));
  centerViewOn(region.x+region.w/2,region.y+region.h/2,zoom,currentTab);
}

function selectRegion(id){
  const region=currentRegions.find(r=>r.id===id);
  if(!region)return;
  selectedRegionId=id;
  renderRegionsList();
  drawRegionsOverlay();
  centerOnRegion(region);
}

function stepRegion(delta){
  if(!currentRegions.length)return;
  const sorted=getSortedRegions();
  let idx=sorted.findIndex(r=>r.id===selectedRegionId);
  idx=idx<0?0:(idx+delta+sorted.length)%sorted.length;
  selectRegion(sorted[idx].id);
}

document.addEventListener('keydown',e=>{
  if(!currentRegions.length||regionsPanelWrap.style.display==='none')return;
  const tag=(e.target.tagName||'').toLowerCase();
  if(tag==='input'||tag==='select'||tag==='textarea')return;
  if(e.key==='ArrowRight'||e.key==='n'||e.key==='N'){e.preventDefault();stepRegion(1);}
  else if(e.key==='ArrowLeft'||e.key==='p'||e.key==='P'){e.preventDefault();stepRegion(-1);}
});

toggleRegionsEl.onchange=()=>{regionsVisible=toggleRegionsEl.checked;drawRegionsOverlay();};
regionsSortBySel.onchange=renderRegionsList;
minSizeInput.oninput=()=>{
  clearTimeout(regionsDebounceTimer);
  regionsDebounceTimer=setTimeout(requestRegionsUpdate,200);
};
strokeSizeInput.oninput=()=>{
  regionStrokePx=parseInt(strokeSizeInput.value)||3;
  strokeValEl.textContent=regionStrokePx;
  drawRegionsOverlay();
};

// Pide al worker que recalcule regiones a partir del deMap ya cacheado
// (sin repetir rgbToLab/deltaE2000), con un pequeño debounce. Para el umbral
// solo se llama al confirmar el valor (app.js, onThresholdCommitted): al
// soltar el deslizador o por cada flecha, nunca en cada fotograma del
// arrastre.
function requestRegionsUpdate(){
  if(!deWorker||!currentRunId||!pixelDEmap)return;
  clearTimeout(regionsDebounceTimer);
  regionsDebounceTimer=setTimeout(()=>{
    deWorker.postMessage({
      type:'regions',runId:currentRunId,
      threshold:getThresholdDE(),
      minSizePct:parseFloat(minSizeInput.value)||0.1
    });
  },150);
}

// Llamado desde app.js (onWorkerMessage) cuando llega {type:'regionsResult'}
function onRegionsResult(msg){
  if(msg.runId!==currentRunId)return;
  currentRegions=msg.regions;
  selectedRegionId=currentRegions.length?currentRegions[0].id:null;
  regionsPanelWrap.style.display='block';
  if(msg.stats)regionStatsEl.textContent=`${msg.stats.detected} zonas detectadas · ${msg.stats.discardedBySize} descartadas por tamaño mínimo`;
  drawRegionsOverlay();
  renderRegionsList();
}

function clearRegions(){
  currentRegions=[];selectedRegionId=null;
  regionsPanelWrap.style.display='none';
  regionStatsEl.textContent='';
  if(regionsCanvas.width&&regionsCanvas.height)rctx.clearRect(0,0,regionsCanvas.width,regionsCanvas.height);
  regionsListEl.innerHTML='';
}

// Compone mainCanvas + regionsCanvas (si están visibles) en un único PNG,
// para que el archivo exportado sirva como documento de revisión con los
// recuadros y su numeración. No modifica el ImageData original.
function exportComposite(){
  if(!cW||!cH)return mainCanvas;
  const out=document.createElement('canvas');
  out.width=cW;out.height=cH;
  const octx=out.getContext('2d');
  octx.drawImage(mainCanvas,0,0);
  octx.drawImage(maskCanvas,0,0);
  if(regionsVisible&&currentRegions.length)paintRegions(octx,cW/REGION_EXPORT_REF_WIDTH);
  return out;
}
