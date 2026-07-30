// ============================================================================
// similarity.js — transformación de similitud (traslación + escala + giro) a
// partir de 2 puntos de referencia por imagen. Capa de entrada, no forma
// parte del motor de comparación: construye el ImageData de B ya remuestreado
// en el sistema de coordenadas de A, más la máscara de zonas no comparables.
// A nunca se transforma: es la referencia aprobada.
// ============================================================================

const SIMILARITY_SCALE_WARN=0.25;      // ±25% respecto a 1×
const SIMILARITY_ROTATION_WARN_DEG=15; // grados
const SIMILARITY_COVERAGE_WARN=0.70;   // 70% de solape efectivo

// A1,A2,B1,B2 son puntos {x,y} en coordenadas naturales de cada imagen.
function computeSimilarityTransform(A1,A2,B1,B2){
  const vAx=A2.x-A1.x,vAy=A2.y-A1.y;
  const vBx=B2.x-B1.x,vBy=B2.y-B1.y;
  const distA=Math.hypot(vAx,vAy),distB=Math.hypot(vBx,vBy);
  const scale=distB>1e-6?distA/distB:1;
  const thetaRad=Math.atan2(vAy,vAx)-Math.atan2(vBy,vBx);
  return{
    scale,thetaRad,thetaDeg:thetaRad*180/Math.PI,
    offset:{dx:Math.round(A1.x-B1.x),dy:Math.round(A1.y-B1.y)}
  };
}

// coverageRatio puede ser null cuando aún no se ha construido el lienzo
// (vista previa en align.js, antes de pulsar «Comparar»).
function transformWarnings(scale,thetaDeg,coverageRatio){
  const warnings=[];
  if(Math.abs(scale-1)>SIMILARITY_SCALE_WARN)warnings.push('La escala se desvía más de un 25% de 1× — puede haber un error al marcar los puntos.');
  if(Math.abs(thetaDeg)>SIMILARITY_ROTATION_WARN_DEG)warnings.push('El giro supera los 15° — puede haber un error al marcar los puntos.');
  if(coverageRatio!=null&&coverageRatio<SIMILARITY_COVERAGE_WARN)warnings.push(`El solape efectivo es del ${Math.round(coverageRatio*100)}% — los puntos de referencia probablemente estén mal marcados.`);
  return warnings;
}

// Aplica la secuencia de transformaciones de canvas que deja
// p_Aspace = R(theta)·scale·(p_B - B1) + A1
function drawTransformedB(ctx,sourceB,A1,B1,scale,thetaRad){
  ctx.save();
  ctx.translate(A1.x,A1.y);
  ctx.rotate(thetaRad);
  ctx.scale(scale,scale);
  ctx.translate(-B1.x,-B1.y);
  ctx.drawImage(sourceB.drawable,0,0);
  ctx.restore();
}

// Construye el resultado completo del modo de 2 puntos: A tal cual (define
// el lienzo, w×h = tamaño nativo de A), B remuestreado sobre ese lienzo y la
// máscara de cobertura (qué zonas del lienzo tienen contenido real de B).
function buildSimilarityAlignedRegion(sourceA,sourceB,A1,A2,B1,B2){
  const{scale,thetaRad,thetaDeg,offset}=computeSimilarityTransform(A1,A2,B1,B2);
  const w=sourceA.naturalWidth,h=sourceA.naturalHeight;

  const canvasA=document.createElement('canvas');
  canvasA.width=w;canvasA.height=h;
  canvasA.getContext('2d').drawImage(sourceA.drawable,0,0);

  const canvasB=document.createElement('canvas');
  canvasB.width=w;canvasB.height=h;
  const bctx=canvasB.getContext('2d');
  bctx.imageSmoothingEnabled=true;
  bctx.imageSmoothingQuality='high';
  drawTransformedB(bctx,sourceB,A1,B1,scale,thetaRad);

  // Máscara de cobertura: mismo transform, pero rellenando el rectángulo de
  // B con blanco opaco en vez de dibujar la imagen. El canal alfa resultante
  // (con el habitual antialiasing de bordes al rotar) indica qué píxeles del
  // lienzo tienen contenido real de B.
  const coverageCanvas=document.createElement('canvas');
  coverageCanvas.width=w;coverageCanvas.height=h;
  const covCtx=coverageCanvas.getContext('2d');
  covCtx.save();
  covCtx.translate(A1.x,A1.y);
  covCtx.rotate(thetaRad);
  covCtx.scale(scale,scale);
  covCtx.translate(-B1.x,-B1.y);
  covCtx.fillStyle='#fff';
  covCtx.fillRect(0,0,sourceB.naturalWidth,sourceB.naturalHeight);
  covCtx.restore();

  const imgAData=canvasA.getContext('2d').getImageData(0,0,w,h);
  const imgBData=canvasB.getContext('2d').getImageData(0,0,w,h);
  const maskAlpha=covCtx.getImageData(0,0,w,h).data;

  const n=w*h;
  const compareMask=new Uint8Array(n);
  let coveredCount=0;
  for(let i=0;i<n;i++){
    if(maskAlpha[i*4+3]>=128){compareMask[i]=1;coveredCount++;}
  }
  const coverageRatio=n>0?coveredCount/n:0;

  return{
    w,h,scale,thetaDeg,offset,
    imgAData,imgBData,compareMask,coverageRatio,
    warnings:transformWarnings(scale,thetaDeg,coverageRatio)
  };
}

// ---- capa de presentación: tramado sobre zonas no comparables ------------
// Pintado sobre maskCanvas (ver canvas-view.js), apilado igual que
// regionsCanvas. Se ejecuta una vez por render de pestaña; no participa en
// el cálculo de ΔE ni en la detección de regiones.

let maskStripePattern=null;
function getMaskStripePattern(){
  if(maskStripePattern)return maskStripePattern;
  const p=document.createElement('canvas');
  p.width=10;p.height=10;
  const pctx=p.getContext('2d');
  pctx.strokeStyle='rgba(111,118,122,0.6)';
  pctx.lineWidth=2;
  pctx.beginPath();
  pctx.moveTo(-2,10);pctx.lineTo(10,-2);
  pctx.moveTo(3,13);pctx.lineTo(13,3);
  pctx.stroke();
  maskStripePattern=mctx.createPattern(p,'repeat');
  return maskStripePattern;
}

function drawMaskOverlay(){
  if(!maskCanvas.width||!maskCanvas.height)return;
  mctx.clearRect(0,0,maskCanvas.width,maskCanvas.height);
  if(typeof compareMaskGlobal==='undefined'||!compareMaskGlobal)return;
  const w=maskCanvas.width,h=maskCanvas.height;
  const base=new ImageData(w,h);
  const d=base.data;
  for(let i=0;i<compareMaskGlobal.length;i++){
    if(!compareMaskGlobal[i]){
      const o=i*4;
      d[o]=224;d[o+1]=225;d[o+2]=222;d[o+3]=140;
    }
  }
  mctx.putImageData(base,0,0);
  mctx.globalCompositeOperation='source-atop';
  mctx.fillStyle=getMaskStripePattern();
  mctx.fillRect(0,0,w,h);
  mctx.globalCompositeOperation='source-over';
}
