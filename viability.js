// ============================================================================
// viability.js — estimación de viabilidad del análisis a ANALYSIS_DPI (ver
// app.js) antes de comparar: memoria estimada vs. disponible, y sonda del
// límite real de canvas de este navegador (falla en silencio en Safari, no
// lanza error, así que hay que medirlo en vez de suponerlo). No toca el
// motor de comparación ni la alineación — solo informa y, en su caso, deja
// que app.js decida bloquear o pedir confirmación antes de comparar.
// ============================================================================

// Búferes simultáneos durante una comparación: ImageData A + ImageData B +
// overlay de diferencias + mapa de calor ΔE (4 búferes × píxeles×4 bytes)
// + Float32Array del mapa ΔE (píxeles×4 bytes) + respaldo de los canvas
// visibles (~píxeles×4 bytes) + margen para los búferes internos que PDF.js
// reserva durante el render. 7× el tamaño de un único búfer píxeles×4B es
// una estimación razonable de ese total.
const MEMORY_ESTIMATE_FACTOR=7;
const DEVICE_MEMORY_USABLE_FRACTION=0.25; // fracción de la RAM total que el navegador puede llegar a usar
const CONSERVATIVE_MEMORY_BYTES=1*1024*1024*1024; // Safari/Firefox no informan: suposición conservadora
const VIABILITY_AMBER_RATIO=0.6, VIABILITY_RED_RATIO=0.9;
const CANVAS_PROBE_SIZES=[16384,8192,4096,2048]; // de mayor a menor

let _canvasSizeCeiling=null;

// Prueba real (no supuesta) del mayor canvas cuadrado utilizable: lo crea,
// pinta 1px de una esquina con un color conocido y lo relee con
// getImageData. Si el valor no coincide, este navegador devolvió un canvas
// en blanco/transparente para ese tamaño (el fallo silencioso de Safari) y
// se prueba el siguiente, menor.
function probeCanvasSizeCeiling(){
  for(const size of CANVAS_PROBE_SIZES){
    try{
      const c=document.createElement('canvas');
      c.width=size;c.height=size;
      const ctx=c.getContext('2d');
      if(!ctx)continue;
      ctx.fillStyle='rgb(12,34,56)';
      ctx.fillRect(size-1,size-1,1,1);
      const px=ctx.getImageData(size-1,size-1,1,1).data;
      if(px[0]===12&&px[1]===34&&px[2]===56)return size;
    }catch(err){
      // tamaño no soportado (excepción de memoria/índice) — probar el siguiente
    }
  }
  return CANVAS_PROBE_SIZES[CANVAS_PROBE_SIZES.length-1];
}

function getCanvasSizeCeiling(){
  if(_canvasSizeCeiling===null)_canvasSizeCeiling=probeCanvasSizeCeiling();
  return _canvasSizeCeiling;
}
// Sonda al arrancar (ver DESIGN): barata (unos pocos canvas pequeños),
// cacheada para el resto de la sesión.
getCanvasSizeCeiling();

// Memoria disponible, en este orden de preferencia. Nunca
// measureUserAgentSpecificMemory(): exige cabeceras COOP/COEP que no se
// pueden fijar en un alojamiento estático como GitHub Pages.
function getAvailableMemoryBytes(){
  try{
    if(performance&&performance.memory&&performance.memory.jsHeapSizeLimit){
      return{bytes:performance.memory.jsHeapSizeLimit,source:'jsHeapSizeLimit',conservative:false};
    }
  }catch(err){/* no disponible */}
  try{
    if(navigator&&navigator.deviceMemory){
      const totalBytes=navigator.deviceMemory*1024*1024*1024;
      return{bytes:totalBytes*DEVICE_MEMORY_USABLE_FRACTION,source:'deviceMemory',conservative:false};
    }
  }catch(err){/* no disponible */}
  return{bytes:CONSERVATIVE_MEMORY_BYTES,source:'conservative',conservative:true};
}

// pixels: recuento de píxeles del lado más exigente (ver app.js,
// updateViabilityPanel). Devuelve todo lo necesario para pintar el panel y
// decidir el estado del botón Comparar.
function computeViability(pixels,dimW,dimH){
  const mem=getAvailableMemoryBytes();
  const estBytes=pixels*4*MEMORY_ESTIMATE_FACTOR;
  const ratio=estBytes/mem.bytes;
  const ceiling=getCanvasSizeCeiling();
  const exceedsCanvasCeiling=dimW>ceiling||dimH>ceiling;
  let level;
  if(exceedsCanvasCeiling||ratio>=VIABILITY_RED_RATIO)level='red';
  else if(ratio>=VIABILITY_AMBER_RATIO)level='amber';
  else level='green';
  return{
    pixels,dimW,dimH,
    estBytes,availBytes:mem.bytes,availSource:mem.source,conservative:mem.conservative,
    ratio,level,ceiling,exceedsCanvasCeiling
  };
}

function formatGB(bytes){
  return(bytes/(1024*1024*1024)).toFixed(1).replace('.',',')+' GB';
}
function formatMB(bytes){
  return Math.round(bytes/(1024*1024)).toLocaleString('es')+' MB';
}
function formatBytesAuto(bytes){
  return bytes>=1024*1024*1024?formatGB(bytes):formatMB(bytes);
}

// Construye el bloque de diagnóstico y aplica la clase de estado
// (.align-format-notice + positive|warn|danger, ver DESIGN.md) sobre `el`.
// No decide qué hacer con el botón Comparar — eso lo resuelve app.js con el
// `viability.level` devuelto por computeViability().
function renderViabilityPanel(el,viability){
  const{estBytes,level,exceedsCanvasCeiling}=viability;
  if(level==='green'){
    el.innerHTML='✓ El análisis puede realizarse a 600 ppp.';
    el.className='align-format-notice positive';
    el.style.display='block';
    return;
  }
  const lines=[];
  lines.push('Análisis a 600 ppp');
  lines.push(`Memoria estimada: ${formatBytesAuto(estBytes)}`);
  if(exceedsCanvasCeiling){
    lines.push('Este archivo es demasiado grande para este navegador a 600 ppp. Prueba en Chrome (admite más resolución que Safari), cierra otras pestañas o recorta el PDF a la zona de interés.');
  }else if(level==='red'){
    lines.push('La memoria estimada supera la disponible en este navegador. Puedes forzar el análisis de todos modos, o antes cerrar otras pestañas o probar en Chrome.');
  }else{
    lines.push('El análisis es posible pero exigente. Cierra otras pestañas antes de continuar para reducir el riesgo de que el navegador se quede sin memoria.');
  }

  el.innerHTML=lines.join('<br>');
  el.className='align-format-notice '+(level==='amber'?'warn':'danger');
  el.style.display='block';
}
