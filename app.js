// ============================================================================
// app.js — orquestación general: ciclo de vida de archivos (raster/PDF/SVG),
// pestañas, comparación, exportación. Capa de entrada/presentación; el único
// contacto con el motor es enviarle ImageData y recibir sus resultados.
// ============================================================================

// Historial de versiones mostrado en el modal (cabecera "vX" / pie / modal).
// Para publicar una versión nueva: añade un objeto al PRINCIPIO de este
// array (más reciente primero). `version` es el número que se muestra como
// "vX" — no lleva el prefijo "v". `date` en formato AAAA-MM-DD. `changes` es
// la lista de viñetas del changelog de esa versión.
const VERSION_HISTORY=[
  {version:'8',date:'2026-07-30',changes:[
    'Añade ayuda plegable en la pantalla inicial (qué hace la herramienta, cómo usarla, umbral ΔE, alineación, formatos, limitaciones, privacidad).',
    'Añade este historial de versiones, accesible desde la cabecera y el pie.',
    'Cambia el umbral ΔE por defecto de 5 a 1 y lo sugiere automáticamente en 2 ante JPG o alineación con transformación de escala/giro.'
  ]},
  {version:'7',date:'2026-07-30',changes:[
    'Alineación por hasta 2 puntos de referencia por imagen: además de trasladar, corrige escala y giro, y marca las zonas sin contenido comparable de B.'
  ]},
  {version:'6a',date:'2026-07-30',changes:[
    'Ajustes de textos: aviso de beta y desarrollo activo, número de versión en cabecera, enlace de contacto por correo.'
  ]},
  {version:'6',date:'2026-07-30',changes:[
    'Publicación en GitHub Pages.'
  ]},
  {version:'5',date:'2026-07-30',changes:[
    'Añade licencia y documentación del proyecto.'
  ]},
  {version:'4',date:'2026-07-30',changes:[
    'Recuadros de zonas diferentes más precisos y legibles.',
    'Mejoras en la exportación a PNG.'
  ]},
  {version:'3',date:'2026-07-29',changes:[
    'Ajustes tras la incorporación de PDF.'
  ]},
  {version:'2',date:'2026-07-29',changes:[
    'Motor ΔE2000 en segundo plano (Web Worker).',
    'Soporte de PDF, .ai y SVG, con selección de PPP.',
    'Alineación manual por punto de referencia.',
    'Panel de zonas diferentes.',
    'Análisis de texto y comparación por palabras (OCR).'
  ]},
  {version:'1a',date:'2026-07-29',changes:[
    'Renombra el archivo principal para publicación.'
  ]},
  {version:'1',date:'2026-07-29',changes:[
    'Aplica el sistema de diseño de marca (color, tipografía) sobre la comparación píxel a píxel original.'
  ]}
];
const APP_VERSION=VERSION_HISTORY[0].version;

const fileA=document.getElementById('fileA'),fileB=document.getElementById('fileB');
const dropA=document.getElementById('dropA'),dropB=document.getElementById('dropB');
const nameA=document.getElementById('nameA'),nameB=document.getElementById('nameB');
const btnCompare=document.getElementById('btnCompare');
const status=document.getElementById('status');
const noteBox=document.getElementById('noteBox');
const statsRow=document.getElementById('statsRow');
const resultsArea=document.getElementById('resultsArea');
const imageTabsPane=document.getElementById('imageTabsPane');
const textPane=document.getElementById('textPane');
const threshSlider=document.getElementById('thresh');
const threshVal=document.getElementById('threshVal');
const legendThreshVal=document.getElementById('legendThreshVal');

let sourceA=null,sourceB=null,currentTab='overlay';
let overlayData=null,heatmapData=null,pixelDEmap=null;
let imgAData=null,imgBData=null;
let cW=0,cH=0;
let diffCount=0,deMax=0,pctDiff=0;
let currentRunId=0;
let deWorker=null;
let reportRefA=null,reportRefB=null,reportOffset={dx:0,dy:0};
let reportTransform=null;
let lastRegion=null;
let compareMaskGlobal=null,comparedAreaPixels=0;

// ---- sugerencia adaptativa de umbral ΔE ------------------------------------
let threshUserOverridden=false; // true en cuanto el usuario toca el slider a mano: deja de autoajustarse el resto de la sesión
let jpgSuggested=false;         // evita repetir el aviso JPG en el mismo ciclo de carga
let alignSuggested=false;       // evita repetir el aviso de alineación en cada mousemove de arrastre
const jpgFlags={A:false,B:false};
const threshSuggestNote=document.getElementById('threshSuggestNote');

// ---- carga de raster (JPG/PNG) — usada también por pdf-source.js ----------

function loadImg(file){
  return new Promise((res,rej)=>{
    if(!file.type||!file.type.startsWith('image/')){rej(new Error('el archivo no es una imagen soportada'));return;}
    const img=new Image();
    const url=URL.createObjectURL(file);
    img.onload=()=>{img._objectUrl=url;res(img);};
    img.onerror=()=>{URL.revokeObjectURL(url);rej(new Error('no se pudo cargar la imagen'));};
    img.src=url;
  });
}

// ---- ciclo de vida de archivos (raster / PDF / .ai / SVG) ------------------

async function handleFileSelected(file,which){
  if(!file)return;
  const nameEl=which==='A'?nameA:nameB;
  const prevSource=which==='A'?sourceA:sourceB;
  const zoneEl=which==='A'?dropA:dropB;
  status.textContent='Cargando…';
  try{
    const kind=detectSourceKind(file);
    let source;
    if(kind==='pdf'||kind==='ai'){
      const{pdfDoc,pageCount}=await openPdf(file);
      const dpi=300;
      const rendered=await renderPdfPageToCanvas(pdfDoc,1,dpi);
      source={...rendered,sourceType:kind,file,pdfDoc,pageNum:1,pageCount,textMode:null,textModeForced:false};
    }else{
      const rendered=await loadRasterOrSvg(file,300);
      source={...rendered,file};
    }
    if(prevSource){
      if(prevSource._objectUrl)URL.revokeObjectURL(prevSource._objectUrl);
      if(prevSource.pdfDoc)prevSource.pdfDoc.destroy();
    }
    if(which==='A')sourceA=source;else sourceB=source;
    jpgFlags[which]=/\.jpe?g$/i.test(file.name)||file.type==='image/jpeg';
    checkJpgSuggestion();
    nameEl.textContent=file.name;
    zoneEl.classList.add('filled');
    status.textContent='';
    hideResults();
    resetRefPoints();
    checkReady();
    updateAlignSection();
    if(source.pdfDoc){
      populatePdfControls(which,source);
      analyzeTextModeFor(which);
    }else{
      resetPdfControls(which);
      renderTextIndicator(which);
    }
  }catch(err){
    status.textContent='Error al cargar archivo '+which+': '+err.message;
  }
}

// Llamado desde pdf-source.js cuando el usuario cambia PPP o página.
function onPdfSourceUpdated(which){
  hideResults();
  populatePdfControls(which,which==='A'?sourceA:sourceB);
  analyzeTextModeFor(which);
  resetRefPoints();
  updateAlignSection();
}

fileA.onchange=e=>{if(e.target.files[0])handleFileSelected(e.target.files[0],'A');};
fileB.onchange=e=>{if(e.target.files[0])handleFileSelected(e.target.files[0],'B');};

function setupDropZone(zone,which){
  ['dragenter','dragover'].forEach(evt=>zone.addEventListener(evt,e=>{e.preventDefault();zone.classList.add('drag-over');}));
  ['dragleave','dragend'].forEach(evt=>zone.addEventListener(evt,()=>zone.classList.remove('drag-over')));
  zone.addEventListener('drop',e=>{
    e.preventDefault();
    zone.classList.remove('drag-over');
    const file=e.dataTransfer.files&&e.dataTransfer.files[0];
    if(file)handleFileSelected(file,which);
  });
}
setupDropZone(dropA,'A');
setupDropZone(dropB,'B');

function checkReady(){
  btnCompare.disabled=!(sourceA&&sourceB);
}

function hideResults(){
  statsRow.style.display='none';
  resultsArea.style.display='none';
  noteBox.style.display='none';
  overlayData=null;heatmapData=null;pixelDEmap=null;
  lastRegion=null;
  if(typeof clearRegions==='function')clearRegions();
  if(typeof clearTextDiff==='function')clearTextDiff();
}

threshSlider.oninput=()=>{
  threshUserOverridden=true;
  threshSuggestNote.style.display='none';
  threshVal.textContent=threshSlider.value;
  legendThreshVal.textContent=threshSlider.value;
  if(!pixelDEmap)return;
  recolorFromThreshold(parseInt(threshSlider.value));
  if(typeof requestRegionsUpdate==='function')requestRegionsUpdate();
};

// Sugiere (no impone) un umbral de 2 cuando hay una fuente probable de ruido
// que el umbral existe para filtrar: compresión JPG o remuestreo de una
// alineación con transformación de escala/giro. Nunca actúa si el usuario ya
// ha tocado el slider a mano.
function suggestThreshold(reason){
  if(threshUserOverridden)return;
  if(parseInt(threshSlider.value)<2){
    threshSlider.value='2';
    threshVal.textContent='2';
    legendThreshVal.textContent='2';
    if(pixelDEmap){
      recolorFromThreshold(2);
      if(typeof requestRegionsUpdate==='function')requestRegionsUpdate();
    }
  }
  threshSuggestNote.textContent=reason==='jpg'
    ?'Umbral ajustado a 2 por compresión JPG'
    :'Umbral ajustado a 2 por remuestreo de alineación';
  threshSuggestNote.style.display='block';
}

function checkJpgSuggestion(){
  if(!jpgSuggested&&(jpgFlags.A||jpgFlags.B)){
    jpgSuggested=true;
    suggestThreshold('jpg');
  }
}

// Llamada desde align.js cada vez que cambian los puntos de referencia.
function checkAlignmentSuggestion(fullSimilarity){
  if(fullSimilarity){
    if(!alignSuggested){
      alignSuggested=true;
      suggestThreshold('align');
    }
  }else{
    alignSuggested=false;
  }
}

btnCompare.onclick=compare;
document.getElementById('btnReset').onclick=resetAll;

// ---- geometría de alineación y extracción de píxeles -----------------------
// (misma lógica que el archivo original; solo cambia `img.naturalWidth` /
// `drawImage(img,...)` por la fuente normalizada `{drawable, naturalWidth,
// naturalHeight}` que ahora puede venir de un render PDF/SVG.)

function computeAlignedRegion(){
  let dx=0,dy=0;
  const aligned=!!(refA&&refB);
  if(aligned){dx=refB.x-refA.x;dy=refB.y-refA.y;}
  const ax0=Math.max(0,-dx),ax1=Math.min(sourceA.naturalWidth,sourceB.naturalWidth-dx);
  const ay0=Math.max(0,-dy),ay1=Math.min(sourceA.naturalHeight,sourceB.naturalHeight-dy);
  const w=Math.floor(ax1-ax0),h=Math.floor(ay1-ay0);
  const rectA={x:Math.round(ax0),y:Math.round(ay0)};
  const rectB={x:Math.round(ax0+dx),y:Math.round(ay0+dy)};
  return{w,h,rectA,rectB,dx,dy,aligned};
}

function getPixelsRegion(source,rect,w,h){
  const c=document.createElement('canvas');
  c.width=w;c.height=h;
  const cx=c.getContext('2d');
  cx.drawImage(source.drawable,rect.x,rect.y,w,h,0,0,w,h);
  return cx.getImageData(0,0,w,h);
}

function updateNotes(region){
  const notes=[];
  const sameDims=sourceA.naturalWidth===sourceB.naturalWidth&&sourceA.naturalHeight===sourceB.naturalHeight;
  if(!sameDims){
    notes.push(`Imagen A es ${sourceA.naturalWidth}×${sourceA.naturalHeight}px, Imagen B es ${sourceB.naturalWidth}×${sourceB.naturalHeight}px. Se comparó el área común de ${region.w}×${region.h}px`+(region.aligned?` (alineada con offset dx=${region.dx}, dy=${region.dy}).`:'.'));
  }else if(region.aligned){
    notes.push(`Alineación aplicada con offset dx=${region.dx}, dy=${region.dy}. Área comparada: ${region.w}×${region.h}px.`);
  }
  if(sourceA.dpi&&sourceB.dpi&&sourceA.dpi!==sourceB.dpi){
    notes.push(`Aviso: Imagen A se renderizó a ${sourceA.dpi}ppp e Imagen B a ${sourceB.dpi}ppp. Usa el mismo PPP en ambas para resultados coherentes.`);
  }
  if(region.w*region.h>0&&region.w*region.h<1600){
    notes.push('Aviso: el área de solapamiento es muy pequeña, las estadísticas pueden no ser representativas.');
  }
  if(notes.length){
    noteBox.innerHTML=notes.join('<br>');
    noteBox.style.display='block';
  }else{
    noteBox.style.display='none';
  }
}

// Notas para el modo de 2 puntos (similitud): a diferencia de updateNotes(),
// aquí siempre hay transformación aplicada, así que el aviso de remuestreo
// es constante; el resto son los avisos ya calculados por similarity.js
// (escala/giro fuera de rango, solape bajo).
function updateSimilarityNotes(sim){
  const notes=['Transformación aplicada — pueden aparecer diferencias leves en bordes por remuestreo.'];
  sim.warnings.forEach(w=>notes.push('Aviso: '+w));
  if(sourceA.dpi&&sourceB.dpi&&sourceA.dpi!==sourceB.dpi){
    notes.push(`Aviso: Imagen A se renderizó a ${sourceA.dpi}ppp e Imagen B a ${sourceB.dpi}ppp.`);
  }
  noteBox.innerHTML=notes.join('<br>');
  noteBox.style.display='block';
}

// ---- worker de cálculo ΔE2000 (de-worker.js) --------------------------------

function getWorker(){
  if(!deWorker){
    deWorker=new Worker('./de-worker.js');
    deWorker.onmessage=onWorkerMessage;
    deWorker.onerror=onWorkerError;
  }
  return deWorker;
}

function onWorkerMessage(e){
  const msg=e.data;
  if(msg.type==='regionsResult'){
    if(typeof onRegionsResult==='function')onRegionsResult(msg);
    return;
  }
  if(msg.runId!==currentRunId)return;
  if(msg.type==='progress'){
    status.textContent=`Analizando… ${Math.round(msg.done/msg.total*100)}%`;
  }else if(msg.type==='result'){
    cW=msg.width;cH=msg.height;
    overlayData=new ImageData(new Uint8ClampedArray(msg.overlayBuf),cW,cH);
    heatmapData=new ImageData(new Uint8ClampedArray(msg.heatmapBuf),cW,cH);
    pixelDEmap=new Float32Array(msg.deMapBuf);
    diffCount=msg.diffCount;deMax=msg.deMax;
    pctDiff=diffCount/comparedAreaPixels*100;
    resetViewState();

    document.getElementById('sDiff').textContent=diffCount.toLocaleString('es');
    document.getElementById('sPct').textContent=pctDiff.toFixed(1)+'%';
    document.getElementById('sDEmax').textContent=deMax.toFixed(1);
    document.getElementById('sAreaCompared').textContent=Math.round(comparedAreaPixels/(cW*cH)*100)+'%';

    statsRow.style.display='grid';
    resultsArea.style.display='block';
    status.textContent='';

    renderTab(currentTab==='texto'?'overlay':currentTab);
    btnCompare.disabled=false;
    threshSlider.disabled=false;
  }
}

function onWorkerError(err){
  status.textContent='Error al analizar: '+(err.message||'desconocido');
  btnCompare.disabled=false;
  threshSlider.disabled=false;
}

// Neutraliza en `bufB` (copia ya independiente del ImageData mostrado) los
// píxeles fuera de la máscara de cobertura, igualándolos a los de A: el
// motor calculará ΔE=0 ahí sin que se le tenga que enseñar el concepto de
// "no comparable". bufB es un ArrayBuffer recién clonado (ver compare()).
function neutralizeMaskedPixels(bufB,dataA,mask){
  const view=new Uint8ClampedArray(bufB);
  for(let i=0;i<mask.length;i++){
    if(mask[i])continue;
    const o=i*4;
    view[o]=dataA[o];view[o+1]=dataA[o+1];view[o+2]=dataA[o+2];view[o+3]=dataA[o+3];
  }
}

async function compare(){
  if(!sourceA||!sourceB)return;
  currentRunId++;
  const runId=currentRunId;
  status.textContent='Preparando…';
  btnCompare.disabled=true;
  threshSlider.disabled=true;

  const similarityMode=!!(refA&&refB&&refA2&&refB2);
  compareMaskGlobal=null;

  if(similarityMode){
    const sim=buildSimilarityAlignedRegion(sourceA,sourceB,refA,refA2,refB,refB2);
    if(sim.w<=0||sim.h<=0){
      status.textContent='Error: la imagen A no tiene tamaño válido.';
      btnCompare.disabled=false;
      threshSlider.disabled=false;
      return;
    }
    cW=sim.w;cH=sim.h;
    imgAData=sim.imgAData;imgBData=sim.imgBData;
    compareMaskGlobal=sim.compareMask;
    comparedAreaPixels=Math.max(1,Math.round(sim.coverageRatio*cW*cH));
    reportRefA={...refA};reportRefB={...refB};
    reportOffset=sim.offset;
    reportTransform={scale:sim.scale,thetaDeg:sim.thetaDeg,coverageRatio:sim.coverageRatio};
    lastRegion={w:cW,h:cH,aligned:true,similarity:true};
    updateSimilarityNotes(sim);
  }else{
    const region=computeAlignedRegion();
    if(region.w<=0||region.h<=0){
      status.textContent='Error: no hay superposición entre las imágenes con los puntos de referencia elegidos.';
      btnCompare.disabled=false;
      threshSlider.disabled=false;
      return;
    }
    cW=region.w;cH=region.h;
    reportRefA=region.aligned?{...refA}:null;
    reportRefB=region.aligned?{...refB}:null;
    reportOffset={dx:region.dx,dy:region.dy};
    reportTransform=null;
    lastRegion=region;
    comparedAreaPixels=cW*cH;

    imgAData=getPixelsRegion(sourceA,region.rectA,cW,cH);
    imgBData=getPixelsRegion(sourceB,region.rectB,cW,cH);

    updateNotes(region);
  }

  const thresh=parseInt(threshSlider.value);
  const minSizePct=parseFloat(minSizeInput.value)||0.8;
  const bufA=imgAData.data.buffer.slice(0);
  const bufB=imgBData.data.buffer.slice(0);
  if(compareMaskGlobal)neutralizeMaskedPixels(bufB,imgAData.data,compareMaskGlobal);

  status.textContent='Analizando… 0%';
  const worker=getWorker();
  worker.postMessage({type:'compute',runId,width:cW,height:cH,threshold:thresh,minSizePct,bufA,bufB},[bufA,bufB]);
}

function recolorFromThreshold(thresh){
  if(!pixelDEmap)return;
  const n=cW*cH;
  const dA=imgAData.data;
  let count=0;
  for(let i=0;i<n;i++){
    const o=i*4;
    const de=pixelDEmap[i];
    if(de>=thresh){
      count++;
      let or_,og,ob;
      if(de>15){or_=255;og=59;ob=59;}
      else if(de>5){or_=255;og=170;ob=0;}
      else{or_=0;og=204;ob=136;}
      overlayData.data[o]=or_;overlayData.data[o+1]=og;overlayData.data[o+2]=ob;overlayData.data[o+3]=210;
    }else{
      overlayData.data[o]=dA[o];overlayData.data[o+1]=dA[o+1];overlayData.data[o+2]=dA[o+2];overlayData.data[o+3]=80;
    }
  }
  diffCount=count;
  pctDiff=count/comparedAreaPixels*100;
  document.getElementById('sDiff').textContent=diffCount.toLocaleString('es');
  document.getElementById('sPct').textContent=pctDiff.toFixed(1)+'%';
  if(currentTab==='overlay')renderTab('overlay');
}

function renderTab(tab){
  mainCanvas.width=cW;mainCanvas.height=cH;
  maskCanvas.width=cW;maskCanvas.height=cH;
  regionsCanvas.width=cW;regionsCanvas.height=cH;
  if(tab==='overlay'){ctx.putImageData(overlayData,0,0);}
  else if(tab==='imgA'){ctx.putImageData(imgAData,0,0);}
  else if(tab==='imgB'){ctx.putImageData(imgBData,0,0);}
  else if(tab==='heatmap'){ctx.putImageData(heatmapData,0,0);}
  applyCanvasTransform();
  if(typeof drawMaskOverlay==='function')drawMaskOverlay();
  if(typeof drawRegionsOverlay==='function')drawRegionsOverlay();
}

document.querySelectorAll('.tab').forEach(t=>{
  t.onclick=()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));
    t.classList.add('active');
    currentTab=t.dataset.tab;
    if(currentTab==='texto'){
      imageTabsPane.style.display='none';
      textPane.style.display='block';
    }else{
      textPane.style.display='none';
      imageTabsPane.style.display='block';
      renderTab(currentTab);
    }
  };
});

function resetAll(){
  currentRunId++;
  [sourceA,sourceB].forEach(s=>{
    if(!s)return;
    if(s._objectUrl)URL.revokeObjectURL(s._objectUrl);
    if(s.pdfDoc)s.pdfDoc.destroy();
  });
  sourceA=null;sourceB=null;
  imgAData=null;imgBData=null;
  overlayData=null;heatmapData=null;pixelDEmap=null;
  cW=0;cH=0;
  diffCount=0;deMax=0;pctDiff=0;
  reportRefA=null;reportRefB=null;reportOffset={dx:0,dy:0};reportTransform=null;
  lastRegion=null;
  compareMaskGlobal=null;comparedAreaPixels=0;
  jpgFlags.A=false;jpgFlags.B=false;jpgSuggested=false;alignSuggested=false;
  threshSuggestNote.style.display='none';

  fileA.value='';fileB.value='';
  nameA.textContent='ningún archivo';nameB.textContent='ningún archivo';
  dropA.classList.remove('filled');dropB.classList.remove('filled');
  btnCompare.disabled=true;
  threshSlider.disabled=false;

  resetPdfControls('A');resetPdfControls('B');
  renderTextIndicator('A');renderTextIndicator('B');
  if(typeof clearTextDiff==='function')clearTextDiff();
  if(typeof clearRegions==='function')clearRegions();

  statsRow.style.display='none';
  resultsArea.style.display='none';
  noteBox.style.display='none';
  status.textContent='';

  resetRefPoints();
  resetViewState();
  alignSection.style.display='none';
  ctx.clearRect(0,0,mainCanvas.width,mainCanvas.height);
  mctx.clearRect(0,0,maskCanvas.width,maskCanvas.height);
  rctx.clearRect(0,0,regionsCanvas.width,regionsCanvas.height);
}

// ---- exportación -------------------------------------------------------

document.getElementById('btnExport').onclick=()=>{
  if(!overlayData)return;
  const names={overlay:'overlay',imgA:'imagenA',imgB:'imagenB',heatmap:'mapa_deltaE',texto:'overlay'};
  const label=currentTab==='texto'?'overlay':currentTab;
  const composite=(typeof exportComposite==='function')?exportComposite():mainCanvas;
  const a=document.createElement('a');
  a.download='comparacion_'+(names[label]||label)+'.png';
  a.href=composite.toDataURL('image/png');
  a.click();
};

document.getElementById('btnExportReport').onclick=()=>{
  if(!pixelDEmap)return;
  const report={
    timestamp:new Date().toISOString(),
    imagenA:{nombre:nameA.textContent,ancho:sourceA.naturalWidth,alto:sourceA.naturalHeight,tipo:sourceA.sourceType,ppp:sourceA.dpi||null,textoModo:sourceA.textMode||null},
    imagenB:{nombre:nameB.textContent,ancho:sourceB.naturalWidth,alto:sourceB.naturalHeight,tipo:sourceB.sourceType,ppp:sourceB.dpi||null,textoModo:sourceB.textMode||null},
    areaComparada:{ancho:cW,alto:cH,porcentaje:Number((comparedAreaPixels/(cW*cH)*100).toFixed(1))},
    puntosReferencia:(reportRefA&&reportRefB)?{
      A:reportTransform?{p1:reportRefA,p2:refA2}:reportRefA,
      B:reportTransform?{p1:reportRefB,p2:refB2}:reportRefB,
      offset:reportOffset
    }:null,
    transformacion:reportTransform?{
      escala:Number(reportTransform.scale.toFixed(4)),
      giroGrados:Number(reportTransform.thetaDeg.toFixed(2))
    }:null,
    umbralDE:parseInt(threshSlider.value),
    pixelesDiferentes:diffCount,
    porcentajeDiferente:Number(pctDiff.toFixed(2)),
    deMax:Number(deMax.toFixed(2)),
    zonasDetectadas:(typeof currentRegions!=='undefined')?currentRegions.length:0
  };
  const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.download='informe_comparacion.json';
  a.href=url;
  a.click();
  URL.revokeObjectURL(url);
};

// ---- avisos de beta / versión / contacto -----------------------------------

function initMetaUI(){
  document.getElementById('appVersionTag').textContent='v'+APP_VERSION;
  const subject=encodeURIComponent(`ComparadorΔE v${APP_VERSION} - Sugerencia`);
  const mailto=`mailto:contacto@diegomondelo.com?subject=${subject}`;
  document.getElementById('resultsFeedbackLink').href=mailto;
  document.getElementById('footerFeedbackLink').href=mailto;
}
initMetaUI();

// ---- historial de versiones (modal) ----------------------------------------

const versionModalBackdrop=document.getElementById('versionModalBackdrop');
const versionModalBody=document.getElementById('versionModalBody');
const versionModalClose=document.getElementById('versionModalClose');
let versionModalTrigger=null;
let versionModalRendered=false;

function renderVersionHistory(){
  if(versionModalRendered)return;
  versionModalBody.innerHTML=VERSION_HISTORY.map(v=>`
    <div class="version-entry">
      <div class="v-head"><span class="v-num">v${v.version}</span><span class="v-date">${v.date}</span></div>
      <ul>${v.changes.map(c=>`<li>${c}</li>`).join('')}</ul>
    </div>
  `).join('');
  versionModalRendered=true;
}

function openVersionModal(trigger){
  renderVersionHistory();
  versionModalTrigger=trigger||null;
  versionModalBackdrop.classList.add('open');
  versionModalClose.focus();
  document.addEventListener('keydown',onVersionModalKeydown);
}

function closeVersionModal(){
  versionModalBackdrop.classList.remove('open');
  document.removeEventListener('keydown',onVersionModalKeydown);
  if(versionModalTrigger)versionModalTrigger.focus();
}

function onVersionModalKeydown(e){
  if(e.key==='Escape')closeVersionModal();
}

document.getElementById('appVersionTag').onclick=function(){openVersionModal(this);};
document.getElementById('footerVersionLink').onclick=function(e){e.preventDefault();openVersionModal(this);};
versionModalClose.onclick=closeVersionModal;
versionModalBackdrop.addEventListener('click',e=>{
  if(e.target===versionModalBackdrop)closeVersionModal();
});
