// ============================================================================
// app.js — orquestación general: ciclo de vida de archivos (raster/PDF/.ai),
// pestañas, comparación, exportación. Capa de entrada/presentación; el único
// contacto con el motor es enviarle ImageData y recibir sus resultados.
// ============================================================================

// Historial de versiones mostrado en el modal (cabecera "vX" / pie / modal).
// Para publicar una versión nueva: añade un objeto al PRINCIPIO de este
// array (más reciente primero) y, si ya hay 5, elimina el último. `version`
// es el número que se muestra como "vX" — no lleva el prefijo "v". `date` en
// formato AAAA-MM-DD. `changes` es un resumen de como mucho 2 frases.
const VERSION_HISTORY=[
  {version:'28',date:'2026-09-25',changes:[
    'Comparar se vuelve la acción principal (botón dorado y grande) con Reiniciar más pequeño debajo; el progreso de la comparación pasa de barra/%/tiempo a una sola línea escrita a máquina que termina en «Análisis completo».',
    'Se quita el aviso técnico de «Escala bloqueada a 1:1» y el panel de viabilidad se reduce a una frase cuando el análisis es viable (centrada y con el mismo ancho que la barra del umbral ΔE), manteniendo el detalle solo cuando hace falta decidir algo (memoria justa, archivo muy grande).'
  ]},
  {version:'27',date:'2026-09-24',changes:[
    'Más limpieza antes de comparar: se quita el resumen de escala/giro/desplazamiento y la etiqueta «Ajustes de comparación», y el umbral ΔE pasa a una barra centrada de la mitad de ancho.',
    'El panel de viabilidad se reduce a resolución, memoria estimada y el aviso final; cuando el archivo no es viable, el aviso recomienda probar otro navegador o recortar el PDF en vez de decir que no se puede.'
  ]},
  {version:'26',date:'2026-09-24',changes:[
    'Limpieza de «Opciones de render»: se quita el desplegable y el texto de diagnóstico de sobreimpresión — antes de comparar solo se ve el umbral ΔE, «Análisis a 600 ppp» y la casilla «Simular sobreimpresión».',
    'El autoactivado de la simulación de sobreimpresión no cambia: sigue marcándose solo cuando el archivo realmente la tiene.'
  ]},
  {version:'25',date:'2026-09-24',changes:[
    'La alineación pasa a hacerse solo por elemento vectorial: se quita el marcado manual de puntos a clic (arrastrar un punto ya puesto y ajustarlo con el teclado se sigue pudiendo hacer igual que antes) y el botón se renombra a «Alinear archivos».',
    'Para archivos que no son PDF/.ai en ambos lados, la sección de alineación muestra ahora un aviso de que no está disponible para ese tipo de archivo, en vez de la explicación de los dos métodos.'
  ]},
  {version:'24',date:'2026-09-24',changes:[
    'Vista de alineación simplificada: al cargar ambos archivos ahora solo se ve, centrado, el botón de alineación (o un aviso de una línea si no está disponible para ese tipo de archivo), sin el resto de explicaciones.',
    'Las cajas de previsualización de cada archivo son más altas y cada una lleva ahora su propia leyenda de zoom («Rueda: zoom · Arrastrar: desplazar · Doble clic: restablecer»).'
  ]}
];
const APP_VERSION=VERSION_HISTORY[0].version;
const ANALYSIS_DPI=600;

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

// ---- viabilidad (memoria/canvas a ANALYSIS_DPI) y progreso por etapas -----
const viabilityPanelEl=document.getElementById('viabilityPanel');
const viabilityForceRowEl=document.getElementById('viabilityForceRow');
const btnForceCompare=document.getElementById('btnForceCompare');
const viabilityConfirmBackdrop=document.getElementById('viabilityConfirmBackdrop');
const viabilityConfirmBody=document.getElementById('viabilityConfirmBody');
const viabilityConfirmAccept=document.getElementById('viabilityConfirmAccept');
const viabilityConfirmCancel=document.getElementById('viabilityConfirmCancel');
const viabilityConfirmClose=document.getElementById('viabilityConfirmClose');
const compareProgressEl=document.getElementById('compareProgress');
const compareProgressStageEl=document.getElementById('compareProgressStage');
const btnCancelCompare=document.getElementById('btnCancelCompare');

let lastViability=null;
let cancelRequested=false;

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

// ---- ciclo de vida de archivos (raster / PDF / .ai) ------------------------

async function handleFileSelected(file,which){
  if(!file)return;
  const nameEl=which==='A'?nameA:nameB;
  const prevSource=which==='A'?sourceA:sourceB;
  const zoneEl=which==='A'?dropA:dropB;
  status.textContent='Cargando…';
  try{
    const kind=detectSourceKind(file);
    if(kind==='svg')throw new Error('El formato SVG no es compatible. Usa PDF, .ai, JPG o PNG.');
    let source;
    if(kind==='pdf'||kind==='ai'){
      const{pdfDoc,pageCount,overprint}=await openPdf(file);
      const dpi=ANALYSIS_DPI;
      const rendered=await renderPdfPage(pdfDoc,1,dpi);
      source={...rendered,sourceType:kind,file,pdfDoc,pageNum:1,pageCount,textMode:null,textModeForced:false,overprint};
    }else{
      const rendered=await loadRaster(file);
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
    // Sobreimpresión (overprint.js): si este archivo activa la simulación,
    // el otro se reabre reescrito para que ambos reciban el mismo trato.
    if(typeof syncOverprintMode==='function')await syncOverprintMode();
    // Baja la vista solo tras el reabierto por sobreimpresión (puede volver a
    // dibujar los lienzos y cambiar su altura); si se hiciera antes, un
    // redibujado tardío la dejaría descuadrada.
    if(typeof consumeAlignJustRevealed==='function'&&consumeAlignJustRevealed()){
      const reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{
        alignSection.scrollIntoView({behavior:reduced?'auto':'smooth',block:'start'});
      }));
    }
  }catch(err){
    status.textContent='Error al cargar archivo '+which+': '+err.message;
  }
}

// Llamado desde pdf-source.js cuando el usuario cambia de página.
function onPdfSourceUpdated(which){
  hideResults();
  populatePdfControls(which,which==='A'?sourceA:sourceB);
  analyzeTextModeFor(which);
  resetRefPoints();
  updateAlignSection();
  checkReady();
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
  const ready=!!(sourceA&&sourceB);
  btnCompare.disabled=!ready;
  updateViabilityPanel(ready);
}

// ---- viabilidad de memoria a ANALYSIS_DPI, antes de comparar ---------------
// El límite de tamaño de canvas (falla en silencio en Safari) ya se
// comprueba en pdf-source.js justo antes de cada render — aquí solo se
// estima la MEMORIA necesaria para el propio cálculo de comparación, un
// juicio bajo incertidumbre que sí admite forzarlo si el usuario lo decide.
function updateViabilityPanel(ready){
  if(!ready){
    viabilityPanelEl.style.display='none';
    viabilityForceRowEl.style.display='none';
    lastViability=null;
    return;
  }
  const pixelsA=sourceA.naturalWidth*sourceA.naturalHeight;
  const pixelsB=sourceB.naturalWidth*sourceB.naturalHeight;
  const bigger=pixelsA>=pixelsB?sourceA:sourceB;
  const viability=computeViability(Math.max(pixelsA,pixelsB),bigger.naturalWidth,bigger.naturalHeight);
  lastViability=viability;
  renderViabilityPanel(viabilityPanelEl,viability);
  if(viability.level==='red'){
    btnCompare.disabled=true;
    // El límite de canvas nunca se puede forzar (resultado en blanco, no un
    // error) — solo se ofrece "forzar" cuando el motivo es la estimación de
    // memoria, que sí podría funcionar.
    viabilityForceRowEl.style.display=viability.exceedsCanvasCeiling?'none':'flex';
  }else{
    btnCompare.disabled=false;
    viabilityForceRowEl.style.display='none';
  }
}

// ---- modal de confirmación (ámbar: confirmar / rojo: forzar) --------------
let viabilityConfirmOnAccept=null;

function openViabilityConfirm(bodyHtml,acceptLabel,onAccept){
  viabilityConfirmBody.innerHTML=bodyHtml;
  viabilityConfirmAccept.textContent=acceptLabel;
  viabilityConfirmOnAccept=onAccept;
  viabilityConfirmBackdrop.classList.add('open');
  document.addEventListener('keydown',onViabilityConfirmKeydown);
}
function closeViabilityConfirm(){
  viabilityConfirmBackdrop.classList.remove('open');
  viabilityConfirmOnAccept=null;
  document.removeEventListener('keydown',onViabilityConfirmKeydown);
}
function onViabilityConfirmKeydown(e){
  if(e.key==='Escape')closeViabilityConfirm();
}
viabilityConfirmAccept.onclick=()=>{
  const fn=viabilityConfirmOnAccept;
  closeViabilityConfirm();
  if(fn)fn();
};
viabilityConfirmCancel.onclick=closeViabilityConfirm;
viabilityConfirmClose.onclick=closeViabilityConfirm;
viabilityConfirmBackdrop.addEventListener('click',e=>{
  if(e.target===viabilityConfirmBackdrop)closeViabilityConfirm();
});

function onCompareClick(){
  if(!lastViability||lastViability.level==='green'){compare();return;}
  if(lastViability.level==='amber'){
    openViabilityConfirm(
      'El análisis es posible pero exigente para la memoria de este navegador. Cierra otras pestañas o aplicaciones antes de continuar.',
      'Continuar',
      compare
    );
  }
  // level 'red' con btnCompare habilitado no debería ocurrir (se deshabilita
  // en updateViabilityPanel); si ocurriera, no hacer nada — se usa
  // btnForceCompare para ese caso.
}

btnForceCompare.onclick=()=>{
  openViabilityConfirm(
    'Este archivo excede la memoria estimada disponible en este navegador a 600 ppp. Forzar la comparación puede hacer que el navegador se quede sin memoria y se bloquee o se cierre la pestaña. Guarda tu trabajo en otras pestañas antes de continuar.',
    'Forzar de todos modos',
    compare
  );
};

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

btnCompare.onclick=onCompareClick;
document.getElementById('btnReset').onclick=resetAll;

// ---- geometría de alineación y extracción de píxeles -----------------------
// (misma lógica que el archivo original; solo cambia `img.naturalWidth` /
// `drawImage(img,...)` por la fuente normalizada `{drawable, naturalWidth,
// naturalHeight}` que ahora puede venir de un render PDF.)

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

// Notas del modo de escala bloqueada (physical-align.js): traslación pura en
// puntos, B renderizada ya desplazada (sin remuestreo); el lienzo es la unión
// de ambas páginas, pero el área comparada sigue siendo solo su intersección.
function updateLockedNotes(res){
  const t=res.transform;
  const notes=[];
  const sizeA=pageSizePt(sourceA),sizeB=pageSizePt(sourceB);
  if(!samePageSize(sizeA,sizeB)&&!t.aligned){
    notes.push('Aviso: los formatos de página son distintos y no se ha alineado por elemento — solo coincide lo que está en la misma posición respecto al origen de cada página.');
  }
  res.warnings.forEach(w=>notes.push('Aviso: '+w));
  if(res.area.w*res.area.h>0&&res.area.w*res.area.h<1600){
    notes.push('Aviso: el área de solapamiento es muy pequeña, las estadísticas pueden no ser representativas.');
  }
  if(notes.length){
    noteBox.innerHTML=notes.join('<br>');
    noteBox.style.display='block';
  }else{
    noteBox.style.display='none';
  }
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

// Cierra y olvida el worker de cálculo (parada garantizada del bucle ΔE en
// curso): usado al cancelar, ante un error del worker y al reiniciar.
// getWorker() lo vuelve a crear la próxima vez que haga falta.
function terminateWorker(){
  if(deWorker){deWorker.terminate();deWorker=null;}
}

async function onWorkerMessage(e){
  const msg=e.data;
  if(msg.type==='regionsResult'){
    if(typeof onRegionsResult==='function')onRegionsResult(msg);
    return;
  }
  if(msg.runId!==currentRunId)return;
  if(msg.type==='progress'){
    setCompareStage('Comparando píxel a píxel — ΔE2000');
  }else if(msg.type==='result'){
    await announceStage('Comparando píxel a píxel — ΔE2000');
    if(msg.runId!==currentRunId)return; // cancelado mientras se cedía el fotograma

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
    document.getElementById('sAreaCompared').textContent=(reportTransform&&reportTransform.locked)
      ?formatSizeMm(reportTransform.areaPt)
      :Math.round(comparedAreaPixels/(cW*cH)*100)+'%';

    statsRow.style.display='grid';
    resultsArea.style.display='block';
    status.textContent='';

    renderTab(currentTab==='texto'?'overlay':currentTab);
    setCompareStage('Análisis completo');
    finishCompareProgress();
    checkReady();
    threshSlider.disabled=false;
  }
}

function onWorkerError(err){
  terminateWorker();
  overlayData=null;heatmapData=null;pixelDEmap=null;
  hideCompareProgress();
  status.innerHTML='El navegador se quedó sin memoria durante el análisis.<br>'+
    '· Probar en Chrome, que admite canvas mayores que Safari<br>'+
    '· Cerrar otras pestañas y aplicaciones<br>'+
    '· Recortar el PDF a la zona de interés antes de compararlo';
  checkReady();
  threshSlider.disabled=false;
}

// ---- ilustración de la cabecera: pausa de su animación ----------------------
// Las animaciones CSS del SVG de la cabecera corren en el hilo principal: se
// pausan (clase cd-pausa, regla incluida en el propio SVG) mientras no se ve
// o mientras corre una comparación ΔE o el análisis de texto/OCR. Solo cambia
// esa clase; no interviene en compare() ni en el análisis de texto.
const heroArtEl=document.querySelector('.cd-ilustracion');
const heroArtPause={offscreen:false,compare:false,text:false};
function setHeroArtPaused(reason,on){
  heroArtPause[reason]=on;
  if(heroArtEl)heroArtEl.classList.toggle('cd-pausa',heroArtPause.offscreen||heroArtPause.compare||heroArtPause.text);
}
if(heroArtEl&&'IntersectionObserver' in window){
  new IntersectionObserver(entries=>setHeroArtPaused('offscreen',!entries[entries.length-1].isIntersecting)).observe(heroArtEl);
}

// ---- etapa de comparación: una sola línea, escrita a máquina (compare()) ---
// Sin barra ni porcentaje (rediseño v28): solo un <span> cuyo texto se
// reemplaza letra a letra. `_stageTypeToken` invalida una escritura en curso
// si llega una etiqueta nueva antes de terminar; si el texto pedido ya es el
// que se está mostrando (o escribiendo), no hace nada — evita reiniciar la
// animación en cada mensaje `progress` del worker, que llega con la misma
// etiqueta muchas veces seguidas.
let _stageTypeToken=0,_stageShownText='';
function typewriteStage(text){
  if(text===_stageShownText)return;
  _stageShownText=text;
  const token=++_stageTypeToken;
  const reduced=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduced){compareProgressStageEl.textContent=text;return;}
  compareProgressStageEl.textContent='';
  let i=0;
  const step=()=>{
    if(token!==_stageTypeToken)return;
    i++;
    compareProgressStageEl.textContent=text.slice(0,i);
    if(i<text.length)setTimeout(step,15);
  };
  step();
}

function setCompareStage(label){
  if(label)typewriteStage(label);
}

// Para transiciones de etapa que preceden un bloque pesado en el hilo
// principal (render de PDF, reconstrucción de ImageData): cede dos
// fotogramas para que el navegador PINTE la etiqueta antes de bloquear.
// No se usa en las actualizaciones de alta frecuencia del worker (ΔE/
// regiones), que ya llegan intercaladas con el hilo principal libre.
function announceStage(label){
  setCompareStage(label);
  return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
}

function showCompareProgress(){
  setHeroArtPaused('compare',true);
  cancelRequested=false;
  compareProgressEl.style.display='block';
  _stageShownText='';
  setCompareStage('Análisis a 600 ppp');
}

function finishCompareProgress(){
  setHeroArtPaused('compare',false);
  setTimeout(()=>{compareProgressEl.style.display='none';},1300);
}

function hideCompareProgress(){
  setHeroArtPaused('compare',false);
  compareProgressEl.style.display='none';
}

function CompareCancelledError(){}
CompareCancelledError.prototype=Object.create(Error.prototype);

function cancelCompare(){
  cancelRequested=true;
  currentRunId++; // invalida cualquier mensaje del worker o callback en vuelo
  terminateWorker();
  hideCompareProgress();
  status.textContent='Comparación cancelada.';
  checkReady();
  threshSlider.disabled=false;
}
btnCancelCompare.onclick=cancelCompare;

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
  status.textContent='';
  btnCompare.disabled=true;
  threshSlider.disabled=true;
  showCompareProgress();

  const similarityMode=!!(refA&&refB&&refA2&&refB2);
  const lockedMode=typeof isScaleLockActive==='function'&&isScaleLockActive();
  compareMaskGlobal=null;

  if(lockedMode){
    // Escala bloqueada 1:1 (physical-align.js): traslación pura en puntos, A y
    // B renderizadas de nuevo sobre el lienzo de la UNIÓN de páginas; el
    // excedente sobre la intersección real queda tramado (compareMaskGlobal),
    // igual que en el modo de 2 puntos.
    await announceStage('Análisis a 600 ppp');
    let res;
    try{
      res=await buildLockedAlignedRegion(sourceA,sourceB,refA,refB,refA2,refB2,async(stageIdx)=>{
        if(runId!==currentRunId)throw new CompareCancelledError();
        if(stageIdx===1)await announceStage('Análisis a 600 ppp');
      });
    }catch(err){
      hideCompareProgress();
      if(err instanceof CompareCancelledError)return;
      status.textContent='Error al alinear: '+err.message;
      checkReady();
      threshSlider.disabled=false;
      return;
    }
    if(runId!==currentRunId)return;
    const t=res.transform;
    cW=res.w;cH=res.h;
    imgAData=res.imgAData;imgBData=res.imgBData;
    compareMaskGlobal=res.compareMask;
    comparedAreaPixels=res.area.w*res.area.h;
    reportRefA=t.aligned?{...refA}:null;
    reportRefB=t.aligned?{...refB}:null;
    reportOffset={dx:t.dxPx,dy:t.dyPx};
    reportTransform={scale:1,thetaDeg:0,locked:true,dxPt:t.dxPt,dyPt:t.dyPt,areaPt:{w:res.area.wPt,h:res.area.hPt}};
    // rectA/rectB: offsets de cada render completo (origen de la unión) al
    // lienzo, para que la pestaña Texto (mapTextRectToCanvas) siga sabiendo
    // saltar al overlay.
    lastRegion={w:cW,h:cH,aligned:t.aligned,locked:true,dx:t.dxPx,dy:t.dyPx,
      rectA:{x:res.union.x0,y:res.union.y0},
      rectB:{x:res.union.x0-t.dxPx,y:res.union.y0-t.dyPx}};
    updateLockedNotes(res);
  }else if(similarityMode){
    await announceStage('Análisis a 600 ppp');
    await announceStage('Análisis a 600 ppp');
    const sim=buildSimilarityAlignedRegion(sourceA,sourceB,refA,refA2,refB,refB2);
    if(runId!==currentRunId)return;
    if(sim.w<=0||sim.h<=0){
      hideCompareProgress();
      status.textContent='Error: la imagen A no tiene tamaño válido.';
      checkReady();
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
    await announceStage('Análisis a 600 ppp');
    const region=computeAlignedRegion();
    if(region.w<=0||region.h<=0){
      hideCompareProgress();
      status.textContent='Error: no hay superposición entre las imágenes con los puntos de referencia elegidos.';
      checkReady();
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
    await announceStage('Análisis a 600 ppp');
    if(runId!==currentRunId)return;
    imgBData=getPixelsRegion(sourceB,region.rectB,cW,cH);

    updateNotes(region);
  }

  const thresh=parseInt(threshSlider.value);
  const minSizePct=parseFloat(minSizeInput.value)||0.1;
  const bufA=imgAData.data.buffer.slice(0);
  const bufB=imgBData.data.buffer.slice(0);
  if(compareMaskGlobal)neutralizeMaskedPixels(bufB,imgAData.data,compareMaskGlobal);

  await announceStage('Comparando píxel a píxel — ΔE2000');
  if(runId!==currentRunId)return;
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
  terminateWorker();
  hideCompareProgress();
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
  updateViabilityPanel(false);

  resetPdfControls('A');resetPdfControls('B');
  if(typeof resetOverprintUI==='function')resetOverprintUI();
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
    metodoAlineacion:typeof activeAlignMethod!=='undefined'?activeAlignMethod:null,
    puntosReferencia:(reportRefA&&reportRefB)?{
      A:reportTransform?{p1:reportRefA,p2:refA2}:reportRefA,
      B:reportTransform?{p1:reportRefB,p2:refB2}:reportRefB,
      offset:reportOffset
    }:null,
    transformacion:reportTransform?{
      escala:Number(reportTransform.scale.toFixed(4)),
      giroGrados:Number(reportTransform.thetaDeg.toFixed(2))
    }:null,
    escalaBloqueada:!!(reportTransform&&reportTransform.locked),
    sobreimpresionSimulada:(typeof isOverprintSimActive==='function')?isOverprintSimActive():false,
    desplazamientoPt:(reportTransform&&reportTransform.locked)?{dx:Number(reportTransform.dxPt.toFixed(3)),dy:Number(reportTransform.dyPt.toFixed(3))}:null,
    areaComparadaMm:(reportTransform&&reportTransform.locked)?{ancho:Number(ptToMm(reportTransform.areaPt.w).toFixed(2)),alto:Number(ptToMm(reportTransform.areaPt.h).toFixed(2))}:null,
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
      <div class="v-head"><span class="v-num">v${v.version}</span></div>
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

document.getElementById('footerVersionLink').onclick=function(e){e.preventDefault();openVersionModal(this);};
versionModalClose.onclick=closeVersionModal;
versionModalBackdrop.addEventListener('click',e=>{
  if(e.target===versionModalBackdrop)closeVersionModal();
});
