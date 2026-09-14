// ============================================================================
// pdf-source.js — CAPA DE ENTRADA: acepta PDF y .ai (PDF-compatible) además
// de JPG/PNG. Renderiza a canvas y expone siempre el mismo objeto
// normalizado {drawable, naturalWidth, naturalHeight} que ya consumía el
// resto de la herramienta con HTMLImageElement — no toca el motor de
// comparación, que solo ve ImageData igual que antes.
// ============================================================================

const PDF_MAX_PIXELS=40_000_000; // guarda de memoria (~40 millones de píxeles)
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

function checkRenderSize(w,h){
  const px=Math.round(w)*Math.round(h);
  if(px>PDF_MAX_PIXELS){
    const mpx=(px/1_000_000).toFixed(1);
    throw new Error(`El render resultante sería de ${mpx} millones de píxeles (límite ~40M). Baja los PPP e inténtalo de nuevo.`);
  }
}

// Abre un PDF (o .ai PDF-compatible) y devuelve el documento y su nº de páginas.
async function openPdf(file){
  const pdfjsLib=await loadPdfJs();
  const buf=await file.arrayBuffer();
  let pdfDoc;
  try{
    pdfDoc=await pdfjsLib.getDocument({data:buf}).promise;
  }catch(err){
    throw new Error('No se pudo abrir el archivo como PDF. Si es un .ai, puede estar en formato PostScript puro (no compatible).');
  }
  return{pdfDoc,pageCount:pdfDoc.numPages};
}

// DIAGNÓSTICO Fase 1 (alineación por cajas de página): vuelca por consola
// todo lo que la API pública de PDF.js 4.10.38 realmente expone de una
// página. `view` NO es el MediaBox: el worker lo calcula como la
// intersección de CropBox y MediaBox. MediaBox/CropBox por separado se
// parsean dentro del worker pero nunca cruzan a este hilo, y BleedBox/
// TrimBox/ArtBox no se parsean en absoluto en esta versión — se deja
// constancia explícita en el log para no dar a entender que existen.
function logPdfPageBoxes(page,label){
  const PT_TO_MM=25.4/72;
  const [x0,y0,x1,y1]=page.view;
  const wMm=(x1-x0)*PT_TO_MM,hMm=(y1-y0)*PT_TO_MM;
  console.group(`Cajas PDF — ${label} (página ${page.pageNumber})`);
  console.log(`view (CropBox∩MediaBox): [${x0}, ${y0}, ${x1}, ${y1}] pt  →  ${wMm.toFixed(1)} × ${hMm.toFixed(1)} mm`);
  console.log(`rotate: ${page.rotate}°`);
  console.log(`userUnit: ${page.userUnit}`);
  console.log('MediaBox / CropBox por separado: no accesibles — el worker los calcula pero no los transmite al hilo principal');
  console.log('BleedBox / TrimBox / ArtBox: no definida — PDF.js 4.10.38 no las parsea');
  console.groupEnd();
}

// Renderiza una página del PDF a canvas al DPI elegido. Comprueba el
// tamaño ANTES de crear el canvas para no intentar el render y colgar el
// navegador con documentos grandes a PPP alto.
async function renderPdfPageToCanvas(pdfDoc,pageNum,dpi,label){
  const page=await pdfDoc.getPage(pageNum);
  logPdfPageBoxes(page,label||'documento');
  const viewport=page.getViewport({scale:dpi/72});
  checkRenderSize(viewport.width,viewport.height);
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(viewport.width);
  canvas.height=Math.round(viewport.height);
  const context=canvas.getContext('2d');
  await page.render({canvasContext:context,viewport}).promise;
  return{drawable:canvas,naturalWidth:canvas.width,naturalHeight:canvas.height,viewport,dpi};
}

// Render alineado (escala bloqueada, ver physical-align.js): la misma página
// al mismo PPP pero con el desplazamiento incorporado al viewport
// (offsetX/offsetY se suman en espacio de píxel tras escala y giro), sobre un
// canvas del tamaño del lienzo comparado. PDF.js resuelve un desplazamiento
// no entero en el propio rasterizado, con el mismo antialiasing que el
// render de A — nada de interpolar un bitmap ya rasterizado. Mismos
// parámetros de render que renderPdfPageToCanvas, deliberadamente.
async function renderPdfPageAligned(source,dpi,offsetPx,w,h){
  const page=await source.pdfDoc.getPage(source.pageNum);
  const viewport=page.getViewport({scale:dpi/72,offsetX:offsetPx.x,offsetY:offsetPx.y});
  checkRenderSize(w,h);
  const canvas=document.createElement('canvas');
  canvas.width=w;canvas.height=h;
  await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
  return canvas;
}

// Punto de entrada para todo lo que no es PDF/.ai: raster (usa loadImg ya
// existente, sin cambios).
async function loadRaster(file){
  const img=await loadImg(file);
  return{drawable:img,naturalWidth:img.naturalWidth,naturalHeight:img.naturalHeight,sourceType:'raster',_objectUrl:img._objectUrl};
}

// ---- UI: selector de PPP y de página por archivo ----------------------

const pdfControlsEls={
  A:document.getElementById('pdfControlsA'),
  B:document.getElementById('pdfControlsB')
};
const dpiSelectEls={A:document.getElementById('dpiA'),B:document.getElementById('dpiB')};
const pageRowEls={A:document.getElementById('pageRowA'),B:document.getElementById('pageRowB')};
const pageSelectEls={A:document.getElementById('pageA'),B:document.getElementById('pageB')};

function resetPdfControls(which){
  pdfControlsEls[which].style.display='none';
  pageRowEls[which].style.display='none';
  pageSelectEls[which].innerHTML='';
  dpiSelectEls[which].value='300';
}

// Muestra y rellena los controles de PPP/página para una fuente ya cargada.
function populatePdfControls(which,source){
  pdfControlsEls[which].style.display='flex';
  dpiSelectEls[which].value=String(source.dpi);
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
}

// Cambiar DPI o página vuelve a renderizar esa fuente (no recompara sola;
// el usuario sigue pulsando "Comparar"). Cuando AMBOS archivos son
// vectoriales, el PPP queda enlazado: cambiarlo en uno re-renderiza los dos
// al mismo valor, para que compartan escala física por construcción (ver
// physical-align.js).
function setupPdfControls(which){
  dpiSelectEls[which].onchange=async()=>{
    const dpi=parseInt(dpiSelectEls[which].value);
    const other=which==='A'?'B':'A';
    const thisSource=which==='A'?sourceA:sourceB;
    const otherSource=other==='A'?sourceA:sourceB;
    const linked=!!(thisSource&&thisSource.pdfDoc&&otherSource&&otherSource.pdfDoc);
    await rerenderPdfSource(which,{dpi});
    if(linked&&otherSource.dpi!==dpi){
      dpiSelectEls[other].value=String(dpi);
      await rerenderPdfSource(other,{dpi});
    }
  };
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
    const r=await renderPdfPageToCanvas(source.pdfDoc,source.pageNum,source.dpi,source.file&&source.file.name);
    Object.assign(source,r);
    status.textContent='';
    if(typeof onPdfSourceUpdated==='function')onPdfSourceUpdated(which);
  }catch(err){
    status.textContent='Error al renderizar página '+which+': '+err.message;
  }
}
