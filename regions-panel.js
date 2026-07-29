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

let currentRegions=[];
let selectedRegionId=null;
let regionsVisible=true;
let regionsDebounceTimer=null;

const REGION_COLOR=getComputedStyle(document.documentElement).getPropertyValue('--sev-low').trim()||'#00cc88';
const REGION_HILITE=getComputedStyle(document.documentElement).getPropertyValue('--marker').trim()||'#22d3e8';

function drawRegionsOverlay(){
  if(!regionsCanvas.width||!regionsCanvas.height)return;
  rctx.clearRect(0,0,regionsCanvas.width,regionsCanvas.height);
  if(!regionsVisible)return;
  rctx.font='bold 14px "Montserrat",system-ui,sans-serif';
  currentRegions.forEach(r=>{
    const hi=r.id===selectedRegionId;
    rctx.lineWidth=hi?3:2;
    rctx.strokeStyle=hi?REGION_HILITE:REGION_COLOR;
    rctx.strokeRect(r.x+0.5,r.y+0.5,Math.max(r.w-1,1),Math.max(r.h-1,1));
    const label=String(r.id);
    const tw=rctx.measureText(label).width;
    rctx.fillStyle=hi?REGION_HILITE:REGION_COLOR;
    rctx.fillRect(r.x,r.y,tw+8,16);
    rctx.fillStyle='#08130e';
    rctx.fillText(label,r.x+4,r.y+12);
  });
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
    `<span>ΔE máx ${r.deMaxRegion.toFixed(1)}</span>`+
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

// Pide al worker que recalcule regiones a partir del deMap ya cacheado
// (sin repetir rgbToLab/deltaE2000), con un pequeño debounce para no
// saturar el worker mientras el usuario arrastra el umbral.
function requestRegionsUpdate(){
  if(!deWorker||!currentRunId||!pixelDEmap)return;
  clearTimeout(regionsDebounceTimer);
  regionsDebounceTimer=setTimeout(()=>{
    deWorker.postMessage({
      type:'regions',runId:currentRunId,
      threshold:parseInt(threshSlider.value),
      minSize:parseInt(minSizeInput.value)||20,
      mergeDist:15*getWorkingDpi()/300
    });
  },150);
}

// Llamado desde app.js (onWorkerMessage) cuando llega {type:'regionsResult'}
function onRegionsResult(msg){
  if(msg.runId!==currentRunId)return;
  currentRegions=msg.regions;
  selectedRegionId=currentRegions.length?currentRegions[0].id:null;
  regionsPanelWrap.style.display=currentRegions.length?'block':'none';
  drawRegionsOverlay();
  renderRegionsList();
}

function clearRegions(){
  currentRegions=[];selectedRegionId=null;
  regionsPanelWrap.style.display='none';
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
  if(regionsVisible&&currentRegions.length)octx.drawImage(regionsCanvas,0,0);
  return out;
}
