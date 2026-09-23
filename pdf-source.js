// ============================================================================
// pdf-source.js — CAPA DE ENTRADA: acepta PDF y .ai (PDF-compatible) además
// de JPG/PNG. Renderiza a canvas y expone siempre el mismo objeto
// normalizado {drawable, naturalWidth, naturalHeight} que ya consumía el
// resto de la herramienta con HTMLImageElement — no toca el motor de
// comparación, que solo ve ImageData igual que antes.
// ============================================================================

const PDF_LIB_PATH='./lib/pdfjs/pdf.min.mjs';
const PDF_WORKER_PATH='./lib/pdfjs/pdf.worker.min.mjs';

let pdfjsLibPromise=null;
function loadPdfJs(){
  if(!pdfjsLibPromise){
    pdfjsLibPromise=import(PDF_LIB_PATH).then(lib=>{
      lib.GlobalWorkerOptions.workerSrc=PDF_WORKER_PATH;
      return lib;
    });
  }
  return pdfjsLibPromise;
}

function detectSourceKind(file){
  const name=file.name.toLowerCase();
  if(file.type==='application/pdf'||name.endsWith('.pdf'))return'pdf';
  if(name.endsWith('.ai'))return'ai';
  if(file.type==='image/svg+xml'||name.endsWith('.svg'))return'svg';
  if(file.type&&file.type.startsWith('image/'))return'raster';
  return'unknown';
}

// Guardián incondicional (nunca "forzable"): un canvas que excede el límite
// real de este navegador no lanza un error legible, devuelve un resultado en
// blanco/transparente (fallo silencioso conocido de Safari) — por eso se
// compara contra el límite MEDIDO por viability.js, no contra un tope de
// píxeles arbitrario.
function checkRenderSize(w,h){
  const dimW=Math.round(w),dimH=Math.round(h);
  const ceiling=getCanvasSizeCeiling();
  if(dimW>ceiling||dimH>ceiling){
    throw new Error(`El render resultante (${dimW}×${dimH} px) supera el límite de canvas de este navegador (${ceiling}×${ceiling} px). Prueba en otro navegador (Chrome/Edge de escritorio admiten canvas mayores que Safari) o recorta el PDF a la zona de interés.`);
  }
}

// Abre un PDF (o .ai PDF-compatible) y devuelve el documento, su nº de
// páginas y la caché de sobreimpresión (overprint.js): bytes originales,
// bytes reescritos y recuento. La reescritura se ejecuta siempre, aunque el
// interruptor esté apagado, porque es también la detección. PDF.js
// TRANSFIERE el buffer que recibe (lo deja vacío), por eso siempre se le
// pasa una copia y la caché conserva los suyos.
async function openPdf(file){
  const pdfjsLib=await loadPdfJs();
  const orig=new Uint8Array(await file.arrayBuffer());
  const overprint=await prepareOverprint(orig,file.name);
  let useRew=decideOverprintForNewFile(overprint)&&!!overprint.rew;
  let pdfDoc;
  try{
    pdfDoc=await openPdfBytes(pdfjsLib,useRew?overprint.rew:overprint.orig);
  }catch(err){
    if(!useRew)throw new Error('No se pudo abrir el archivo como PDF. Si es un .ai, puede estar en formato PostScript puro (no compatible).');
    // El PDF reescrito no abre: se usa el original y se anula la simulación.
    console.warn('Sobreimpresión — PDF.js no abre el archivo reescrito, se usa el original: ',err);
    overprint.rew=null;
    overprint.stats={error:'PDF.js no pudo abrir el archivo reescrito'};
    useRew=false;
    pdfDoc=await openPdfBytes(pdfjsLib,overprint.orig);
  }
  overprint.applied=useRew;
  return{pdfDoc,pageCount:pdfDoc.numPages,overprint};
}

function openPdfBytes(pdfjsLib,bytes){
  return pdfjsLib.getDocument({data:bytes.slice()}).promise;
}

// Reabre una fuente ya cargada con los bytes que corresponden al estado
// actual del interruptor de sobreimpresión y vuelve a renderizar la misma
// página al mismo PPP. Devuelve true si hubo que reabrir. Llamada desde
// syncOverprintMode() (overprint.js).
async function reopenPdfSource(which){
  const source=which==='A'?sourceA:sourceB;
  if(!source||!source.pdfDoc||!source.overprint)return false;
  const wantRew=isOverprintSimActive()&&!!source.overprint.rew;
  if(source.overprint.applied===wantRew)return false;
  const pdfjsLib=await loadPdfJs();
  status.textContent='Renderizando página…';
  const newDoc=await openPdfBytes(pdfjsLib,wantRew?source.overprint.rew:source.overprint.orig);
  const oldDoc=source.pdfDoc;
  source.pdfDoc=newDoc;
  source.overprint.applied=wantRew;
  oldDoc.destroy();
  const r=await renderPdfPage(newDoc,source.pageNum,source.dpi);
  Object.assign(source,r);
  status.textContent='';
  return true;
}

// Única función de render de página PDF→canvas de toda la herramienta:
// vista previa, selector de elemento vectorial, vista final tras alinear y
// OCR pasan todos por aquí (ver encargo "unificación del render"). Comprueba
// el tamaño ANTES de crear el canvas para no intentar el render y colgar el
// navegador con documentos grandes a PPP alto.
//
// `offsetPt` (opcional, en PUNTOS PDF, no píxeles): desplazamiento ya
// incorporado al viewport (offsetX/offsetY de PDF.js, en espacio de píxel
// tras escala) para las vistas con alineación ya aplicada — 0 si se omite.
// PDF.js resuelve un desplazamiento no entero en el propio rasterizado, con
// el mismo antialiasing que un render sin desplazar — nada de interpolar un
// bitmap ya rasterizado.
// `canvasW`/`canvasH` (opcional): tamaño del lienzo si es distinto del de la
// página (p. ej. el lienzo de comparación); por defecto, el de la página.
//
// Sobreimpresión: no es parámetro de esta función — se resuelve reescribiendo
// los bytes del PDF antes de abrirlo (overprint.js/openPdf), así que las tres
// fases, al recibir el mismo pdfDoc, la reflejan igual automáticamente.
//
// Color de soporte: relleno blanco opaco fijo antes de pintar la página, para
// que ningún archivo con zonas transparentes componga de forma distinta
// según la fase.
//
// Anotaciones: SIEMPRE excluidas (annotationMode DISABLE) — PDF.js, con su
// valor por defecto, pinta las apariencias de anotación (icono de nota,
// resaltados, etc.) directamente sobre el canvas aunque no exista ningún
// AnnotationLayer explícito en el código; eso no es contenido de impresión.
async function renderPdfPage(pdfDoc,pageNum,dpi,{offsetPt,canvasW,canvasH}={}){
  const page=await pdfDoc.getPage(pageNum);
  const scale=dpi/72;
  const offsetX=offsetPt?offsetPt.x*scale:0;
  const offsetY=offsetPt?offsetPt.y*scale:0;
  const viewport=page.getViewport({scale,offsetX,offsetY});
  console.log('[diag-transform] renderPdfPage viewport',{pageNum,dpi,offsetX,offsetY,
    scale:viewport.scale,width:viewport.width,height:viewport.height,
    rotation:viewport.rotation,transform:viewport.transform});
  const w=canvasW??Math.round(viewport.width);
  const h=canvasH??Math.round(viewport.height);
  checkRenderSize(w,h);
  const canvas=document.createElement('canvas');
  canvas.width=w;canvas.height=h;
  const context=canvas.getContext('2d');
  context.fillStyle='#fff';
  context.fillRect(0,0,w,h);
  const pdfjsLib=await loadPdfJs();
  await page.render({canvasContext:context,viewport,annotationMode:pdfjsLib.AnnotationMode.DISABLE}).promise;
  return{drawable:canvas,naturalWidth:w,naturalHeight:h,viewport,dpi};
}

// Punto de entrada para todo lo que no es PDF/.ai: raster (usa loadImg ya
// existente, sin cambios).
async function loadRaster(file){
  const img=await loadImg(file);
  return{drawable:img,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,sourceType:'raster',_objectUrl:img._objectUrl};
}

// ---- UI: indicador de resolución y selector de página por archivo -----

const pdfControlsEls={
  A:document.getElementById('pdfControlsA'),
  B:document.getElementById('pdfControlsB')
};
const pageRowEls={A:document.getElementById('pageRowA'),B:document.getElementById('pageRowB')};
const pageSelectEls={A:document.getElementById('pageA'),B:document.getElementById('pageB')};
const analysisResolutionInfoEl=document.getElementById('analysisResolutionInfo');

function resetPdfControls(which){
  pdfControlsEls[which].style.display='none';
  pageRowEls[which].style.display='none';
  pageSelectEls[which].innerHTML='';
  updateAnalysisResolutionIndicator();
}

// Indicador de solo lectura junto al interruptor de sobreimpresión (misma
// fila, #renderOptionsRow, cuya visibilidad la sigue gobernando por completo
// overprint.js — aquí solo se rellena el texto). Muestra las dimensiones ya
// renderizadas a ANALYSIS_DPI de cada fuente PDF/.ai cargada; si hay un
// archivo ráster junto a un PDF, o si A y B difieren de tamaño, se listan
// ambas por separado.
function updateAnalysisResolutionIndicator(){
  if(!analysisResolutionInfoEl)return;
  const A=typeof sourceA!=='undefined'?sourceA:null,B=typeof sourceB!=='undefined'?sourceB:null;
  const pdfSources=[['A',A],['B',B]].filter(([,s])=>s&&s.pdfDoc);
  if(!pdfSources.length){analysisResolutionInfoEl.textContent='';return;}
  const sameDims=A&&B&&A.naturalWidth===B.naturalWidth&&A.naturalHeight===B.naturalHeight;
  if(pdfSources.length===2&&sameDims){
    analysisResolutionInfoEl.textContent=`Análisis a ${ANALYSIS_DPI} ppp — ${A.naturalWidth.toLocaleString('es')} × ${A.naturalHeight.toLocaleString('es')} px`;
    return;
  }
  const parts=[['A',A],['B',B]].map(([label,s])=>{
    if(!s)return null;
    return s.pdfDoc
      ?`${label}: ${s.naturalWidth.toLocaleString('es')} × ${s.naturalHeight.toLocaleString('es')} px (${ANALYSIS_DPI} ppp)`
      :`${label}: ${s.naturalWidth.toLocaleString('es')} × ${s.naturalHeight.toLocaleString('es')} px (nativo, sin ppp)`;
  }).filter(Boolean);
  analysisResolutionInfoEl.textContent=`Análisis a ${ANALYSIS_DPI} ppp — `+parts.join(' · ');
}

// Muestra y rellena los controles de página para una fuente ya cargada.
function populatePdfControls(which,source){
  pdfControlsEls[which].style.display='flex';
  if(source.pageCount>1){
    pageRowEls[which].style.display='inline-flex';
    pageSelectEls[which].innerHTML='';
    for(let p=1;p<=source.pageCount;p++){
      const opt=document.createElement('option');
      opt.value=p;opt.textContent='Página '+p;
      if(p===source.pageNum)opt.selected=true;
      pageSelectEls[which].appendChild(opt);
    }
  }else{
    pageRowEls[which].style.display='none';
  }
  updateAnalysisResolutionIndicator();
}

// Cambiar de página vuelve a renderizar esa fuente (no recompara sola; el
// usuario sigue pulsando "Comparar"). La resolución es fija (ANALYSIS_DPI),
// ya no hay selector de PPP que enlazar entre A y B.
function setupPdfControls(which){
  pageSelectEls[which].onchange=()=>rerenderPdfSource(which,{pageNum:parseInt(pageSelectEls[which].value)});
}
setupPdfControls('A');
setupPdfControls('B');

// Implementada aquí porque solo aplica a fuentes con pdfDoc (PDF/.ai);
// llama de vuelta a app.js vía la función global onPdfSourceUpdated().
async function rerenderPdfSource(which,changes){
  const source=which==='A'?sourceA:sourceB;
  if(!source||!source.pdfDoc)return;
  Object.assign(source,changes);
  status.textContent='Renderizando página…';
  try{
    const r=await renderPdfPage(source.pdfDoc,source.pageNum,source.dpi);
    Object.assign(source,r);
    status.textContent='';
    if(typeof onPdfSourceUpdated==='function')onPdfSourceUpdated(which);
  }catch(err){
    status.textContent='Error al renderizar página '+which+': '+err.message;
  }
}
