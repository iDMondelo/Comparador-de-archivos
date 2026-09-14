// ============================================================================
// physical-align.js — alineación con ESCALA BLOQUEADA a 1:1 entre archivos
// con dimensiones físicas declaradas (PDF/.ai). Capa de entrada: no toca el
// motor ΔE (de-worker.js) ni el cálculo de similitud existente (similarity.js),
// que se siguen usando cuando la escala está desbloqueada o hay ráster.
//
// Principio: entre revisiones de un arte final el arte NO se escala; lo que
// cambia es la página. Por tanto la escala relativa es exactamente 1,0 y el
// giro 0: solo se determina el desplazamiento, y se hace en PUNTOS PDF
// (px / viewport.scale — nunca deducido del tamaño del canvas, que está
// redondeado a entero). B se renderiza de nuevo con ese desplazamiento
// incorporado al viewport (offsetX/offsetY de PDF.js), así queda alineado
// píxel a píxel con A sin ninguna interpolación posterior de bitmap.
//
// Nota sobre unidades: PageViewport de PDF.js ya multiplica `scale` por
// UserUnit dentro de `transform`, pero `viewport.scale` conserva dpi/72. Así
// que px / viewport.scale = puntos físicos con UserUnit ya absorbido.
// ============================================================================

const PA_PT_TO_MM=25.4/72;
const PA_PAIR_TOLERANCE_PT=0.5;   // discrepancia admisible entre los dos pares de anclas
const PA_PAGE_TOLERANCE_PT=0.5;   // dos cajas de página se consideran iguales por debajo de esto
const PA_NOISE_SCALE=0.005;       // ±0,5 %: escala medida que probablemente es ruido
const PA_EPS=1e-6;

function paFormat(n,decimals){
  return n.toFixed(decimals).replace('.',',');
}

function hasPhysicalDims(source){
  return !!source&&(source.sourceType==='pdf'||source.sourceType==='ai')&&!!source.viewport;
}

// Píxeles por punto físico del render actual de una fuente vectorial.
function pxPerPt(source){
  return source.viewport.scale;
}

// Tamaño de la caja de página renderizada (page.view = CropBox ∩ MediaBox,
// ya rotada según /Rotate) en puntos físicos. TrimBox/ArtBox no son
// accesibles en la API pública de PDF.js 4.10, así que esta es la única
// "caja de página" disponible.
function pageSizePt(source){
  const s=pxPerPt(source);
  return{w:source.viewport.width/s,h:source.viewport.height/s};
}

function ptToMm(pt){return pt*PA_PT_TO_MM;}

function formatSizeMm(size){
  return `${paFormat(ptToMm(size.w),1)} × ${paFormat(ptToMm(size.h),1)} mm`;
}

function samePageSize(sizeA,sizeB){
  return Math.abs(sizeA.w-sizeB.w)<=PA_PAGE_TOLERANCE_PT&&Math.abs(sizeA.h-sizeB.h)<=PA_PAGE_TOLERANCE_PT;
}

// Transformación bloqueada: escala 1, giro 0, desplazamiento en puntos a
// partir del par de anclas 1 (A1,B1) en píxeles naturales de cada render.
// Sin anclas → desplazamiento 0 (alineación por el origen de la caja de
// página). El par 2, si existe, solo sirve de comprobación y para informar
// de la escala que se habría medido.
function computeLockedTransform(sourceA,sourceB,A1,B1,A2,B2){
  const sA=pxPerPt(sourceA),sB=pxPerPt(sourceB);
  const warnings=[];
  const aligned=!!(A1&&B1);
  let dxPt=0,dyPt=0;
  if(aligned){
    dxPt=A1.x/sA-B1.x/sB;
    dyPt=A1.y/sA-B1.y/sB;
  }
  let pairDiscrepancyPt=null,measuredScale=null,measuredThetaDeg=null;
  if(aligned&&A2&&B2){
    const dx2=A2.x/sA-B2.x/sB,dy2=A2.y/sA-B2.y/sB;
    pairDiscrepancyPt=Math.hypot(dx2-dxPt,dy2-dyPt);
    const t=computeSimilarityTransform(
      {x:A1.x/sA,y:A1.y/sA},{x:A2.x/sA,y:A2.y/sA},
      {x:B1.x/sB,y:B1.y/sB},{x:B2.x/sB,y:B2.y/sB}
    );
    measuredScale=t.scale;measuredThetaDeg=t.thetaDeg;
    if(pairDiscrepancyPt>PA_PAIR_TOLERANCE_PT){
      warnings.push(`Los dos pares de anclas implican desplazamientos distintos (diferencia de ${paFormat(pairDiscrepancyPt,2)} pt): el arte no es idéntico entre archivos o uno de ellos fue reescalado. Si sabes que hubo reescalado, desbloquea la escala.`);
    }
  }
  const rotA=sourceA.viewport.rotation||0,rotB=sourceB.viewport.rotation||0;
  if((((rotA-rotB)%360)+360)%360!==0){
    warnings.push(`Las páginas declaran rotaciones distintas (A ${rotA}°, B ${rotB}°). Con la escala bloqueada no se corrige el giro: si el arte aparece girado, desbloquea la escala y usa dos elementos.`);
  }
  return{
    aligned,dxPt,dyPt,
    dxPx:dxPt*sA,dyPx:dyPt*sA,
    measuredScale,measuredThetaDeg,pairDiscrepancyPt,warnings
  };
}

// Intersección de las dos páginas en la rejilla de píxeles de A, una vez
// desplazada B. Se recorta a píxeles enteros hacia dentro, para que todo el
// lienzo esté dentro de ambas páginas. rectInB es el mismo rectángulo en
// píxeles naturales de B (para tramar la miniatura de B).
function computeComparableArea(sourceA,sourceB,dxPx,dyPx){
  const sA=pxPerPt(sourceA),sB=pxPerPt(sourceB);
  const bSize=pageSizePt(sourceB);
  const wBpx=bSize.w*sA,hBpx=bSize.h*sA;
  const wA=sourceA.naturalWidth,hA=sourceA.naturalHeight;
  const x0=Math.ceil(Math.max(0,dxPx)-PA_EPS),y0=Math.ceil(Math.max(0,dyPx)-PA_EPS);
  const x1=Math.floor(Math.min(wA,dxPx+wBpx)+PA_EPS),y1=Math.floor(Math.min(hA,dyPx+hBpx)+PA_EPS);
  const w=Math.max(0,x1-x0),h=Math.max(0,y1-y0);
  const k=sB/sA;
  return{
    x0,y0,w,h,
    wPt:w/sA,hPt:h/sA,
    rectInA:{x:x0,y:y0,w,h},
    rectInB:{x:(x0-dxPx)*k,y:(y0-dyPx)*k,w:w*k,h:h*k}
  };
}

function formatLockedTransform(t){
  let s=`Escala: 1,000× (bloqueada) · Giro: 0,00° · Desplazamiento: ${paFormat(t.dxPt,2)} × ${paFormat(t.dyPt,2)} pt (${paFormat(t.dxPx,2)} × ${paFormat(t.dyPx,2)} px)`;
  if(t.measuredScale!=null)s+=` · Escala medida: ${paFormat(t.measuredScale,4)}× — ignorada por el bloqueo`;
  return s;
}

// Aviso para el modo desbloqueado: una escala medida dentro de ±0,5 % de 1
// es, casi con seguridad, ruido de medición de las cajas de los elementos.
function unlockedNoiseWarning(scale){
  if(Math.abs(scale-1)<PA_NOISE_SCALE){
    return `La escala medida (${paFormat(scale,4)}×) está dentro de ±0,5 % de 1: probablemente es ruido de medición y aplicarla obligará a remuestrear. Vuelve a bloquear la escala.`;
  }
  return null;
}

// Construye el lienzo bloqueado: AMBOS archivos renderizados por PDF.js
// directamente sobre el lienzo de intersección, al mismo PPP y con el mismo
// origen. A solo recibe un desplazamiento entero (−x0,−y0): no se transforma
// el arte, pero sí se re-rasteriza sobre el mismo lienzo que B. Es necesario:
// el rasterizador del canvas elige distinta cobertura de antialiasing para
// un trazado según quede o no recortado por el borde del lienzo, así que
// recortar el render completo de A dejaba residuos de 1 px (RGB ≤ 20) a lo
// largo de los elementos que cruzan el borde de la intersección. Con la misma
// geometría de dispositivo y el mismo recorte, el arte idéntico da 0.
async function buildLockedAlignedRegion(sourceA,sourceB,A1,B1,A2,B2){
  const transform=computeLockedTransform(sourceA,sourceB,A1,B1,A2,B2);
  const area=computeComparableArea(sourceA,sourceB,transform.dxPx,transform.dyPx);
  if(area.w<=0||area.h<=0)throw new Error('las páginas no se solapan con el desplazamiento calculado.');

  const canvasA=await renderPdfPageAligned(sourceA,sourceA.dpi,{x:-area.x0,y:-area.y0},area.w,area.h);
  const imgAData=canvasA.getContext('2d').getImageData(0,0,area.w,area.h);
  canvasA.width=0;canvasA.height=0;

  const canvasB=await renderPdfPageAligned(sourceB,sourceA.dpi,{x:transform.dxPx-area.x0,y:transform.dyPx-area.y0},area.w,area.h);
  const imgBData=canvasB.getContext('2d').getImageData(0,0,area.w,area.h);
  canvasB.width=0;canvasB.height=0;

  return{w:area.w,h:area.h,imgAData,imgBData,transform,area,warnings:transform.warnings};
}
