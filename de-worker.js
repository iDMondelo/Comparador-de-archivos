// ============================================================================
// de-worker.js — Web Worker de cálculo. Cargado como worker clásico:
//   new Worker('./de-worker.js')
// ============================================================================

// ---- MOTOR DE COMPARACIÓN (NO TOCAR) --------------------------------------
// Idéntico byte a byte a la función workerEntry() del index.html original.
// rgbToXyz, xyzToLab, rgbToLab, deltaE2000, heatColor y el bucle principal
// de self.onmessage (rama 'compute') quedan intactos.

const LINEAR_LUT=new Float64Array(256);
for(let i=0;i<256;i++){
  const v=i/255;
  LINEAR_LUT[i]=v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4);
}
function rgbToXyz(r,g,b){
  r=LINEAR_LUT[r];g=LINEAR_LUT[g];b=LINEAR_LUT[b];
  return[
    r*0.4124564+g*0.3575761+b*0.1804375,
    r*0.2126729+g*0.7151522+b*0.0721750,
    r*0.0193339+g*0.1191920+b*0.9503041
  ];
}
function xyzToLab(x,y,z){
  function f(t){return t>0.008856?Math.cbrt(t):(7.787*t+16/116);}
  x/=0.95047;y/=1.00000;z/=1.08883;
  return[116*f(y)-16,500*(f(x)-f(y)),200*(f(y)-f(z))];
}
function rgbToLab(r,g,b){
  const[x,y,z]=rgbToXyz(r,g,b);
  return xyzToLab(x,y,z);
}
function deltaE2000(lab1,lab2){
  const[L1,a1,b1]=lab1,[L2,a2,b2]=lab2;
  const kL=1,kC=1,kH=1;
  const C1=Math.sqrt(a1*a1+b1*b1),C2=Math.sqrt(a2*a2+b2*b2);
  const Cb=(C1+C2)/2;
  const Cb7=Math.pow(Cb,7);
  const G=0.5*(1-Math.sqrt(Cb7/(Cb7+Math.pow(25,7))));
  const a1p=a1*(1+G),a2p=a2*(1+G);
  const C1p=Math.sqrt(a1p*a1p+b1*b1),C2p=Math.sqrt(a2p*a2p+b2*b2);
  function hp(bp,ap){
    if(Math.abs(ap)<1e-10&&Math.abs(bp)<1e-10)return 0;
    let h=Math.atan2(bp,ap)*180/Math.PI;
    if(h<0)h+=360;
    return h;
  }
  const h1p=hp(b1,a1p),h2p=hp(b2,a2p);
  const dLp=L2-L1,dCp=C2p-C1p;
  let dhp;
  if(C1p*C2p===0)dhp=0;
  else if(Math.abs(h2p-h1p)<=180)dhp=h2p-h1p;
  else if(h2p-h1p>180)dhp=h2p-h1p-360;
  else dhp=h2p-h1p+360;
  const dHp=2*Math.sqrt(C1p*C2p)*Math.sin(dhp*Math.PI/360);
  const Lbp=(L1+L2)/2,Cbp=(C1p+C2p)/2;
  let Hbp;
  if(C1p*C2p===0)Hbp=h1p+h2p;
  else if(Math.abs(h1p-h2p)<=180)Hbp=(h1p+h2p)/2;
  else if(h1p+h2p<360)Hbp=(h1p+h2p+360)/2;
  else Hbp=(h1p+h2p-360)/2;
  const T=1-0.17*Math.cos((Hbp-30)*Math.PI/180)+0.24*Math.cos(2*Hbp*Math.PI/180)+0.32*Math.cos((3*Hbp+6)*Math.PI/180)-0.20*Math.cos((4*Hbp-63)*Math.PI/180);
  const SL=1+0.015*Math.pow(Lbp-50,2)/Math.sqrt(20+Math.pow(Lbp-50,2));
  const SC=1+0.045*Cbp,SH=1+0.015*Cbp*T;
  const Cbp7=Math.pow(Cbp,7);
  const RC=2*Math.sqrt(Cbp7/(Cbp7+Math.pow(25,7)));
  const dTheta=30*Math.exp(-Math.pow((Hbp-275)/25,2));
  const RT=-Math.sin(2*dTheta*Math.PI/180)*RC;
  return Math.sqrt(Math.pow(dLp/(kL*SL),2)+Math.pow(dCp/(kC*SC),2)+Math.pow(dHp/(kH*SH),2)+RT*(dCp/(kC*SC))*(dHp/(kH*SH)));
}
function heatColor(t){
  if(t<0.25){const f=t/0.25;return[0,Math.round(f*200),Math.round(100+f*155)];}
  if(t<0.5){const f=(t-0.25)/0.25;return[Math.round(f*255),Math.round(200-f*130),255];}
  if(t<0.75){const f=(t-0.5)/0.25;return[255,Math.round(70+f*100),Math.round(255-f*255)];}
  const f=(t-0.75)/0.25;return[255,Math.round(170-f*100),0];
}

// ---- estado nuevo (fuera del bucle, no lo modifica) ----
// Cachea el último mapa ΔE calculado para poder recomputar regiones
// (Objetivo 4) sin repetir el cálculo Lab/ΔE2000 completo.
let lastDeMap=null,lastW=0,lastH=0,lastRunId=null;

self.onmessage=function(e){
  const msg=e.data;

  if(msg.type==='compute'){
    const{runId,width,height,threshold,bufA,bufB}=msg;
    const dA=new Uint8ClampedArray(bufA),dB=new Uint8ClampedArray(bufB);
    const n=width*height;
    const overlay=new Uint8ClampedArray(n*4);
    const heat=new Uint8ClampedArray(n*4);
    const deMap=new Float32Array(n);
    let diffCount=0,deMax=0;
    const progressStep=Math.max(1,Math.floor(n/50));

    for(let i=0;i<n;i++){
      const o=i*4;
      const rA=dA[o],gA=dA[o+1],bA=dA[o+2];
      const rB=dB[o],gB=dB[o+1],bB=dB[o+2];
      const labA=rgbToLab(rA,gA,bA);
      const labB=rgbToLab(rB,gB,bB);
      const de=deltaE2000(labA,labB);
      deMap[i]=de;
      if(de>deMax)deMax=de;

      if(de>=threshold){
        diffCount++;
        let or_,og,ob;
        if(de>15){or_=255;og=59;ob=59;}
        else if(de>5){or_=255;og=170;ob=0;}
        else{or_=0;og=204;ob=136;}
        overlay[o]=or_;overlay[o+1]=og;overlay[o+2]=ob;overlay[o+3]=210;
      }else{
        overlay[o]=rA;overlay[o+1]=gA;overlay[o+2]=bA;overlay[o+3]=80;
      }

      const norm=Math.min(de/30,1);
      const hc=heatColor(norm);
      heat[o]=hc[0];heat[o+1]=hc[1];heat[o+2]=hc[2];heat[o+3]=255;

      if(i%progressStep===0)self.postMessage({type:'progress',runId,done:i,total:n});
    }

    // ---- ANÁLISIS DE REGIONES (Objetivo 4) --------------------------------
    // Postprocesado sobre deMap ya calculado. No repite rgbToLab/deltaE2000.
    // OJO: deMap.buffer se transfiere en el postMessage de abajo, lo que lo
    // "detacha" (queda inutilizable) en cuanto se llama a postMessage. Por
    // eso la copia para poder recalcular regiones más tarde (sin rehacer el
    // bucle ΔE) se hace ANTES de transferirlo, nunca después.
    lastDeMap=new Float32Array(deMap);
    lastW=width;lastH=height;lastRunId=runId;

    self.postMessage({
      type:'result',runId,width,height,diffCount,deMax,
      overlayBuf:overlay.buffer,heatmapBuf:heat.buffer,deMapBuf:deMap.buffer
    },[overlay.buffer,heat.buffer,deMap.buffer]);

    const result=computeRegions(lastDeMap,lastW,lastH,threshold,msg.minSizePct,msg.mergeDistPct);
    self.postMessage({type:'regionsResult',runId,regions:result.regions,stats:result.stats});
    return;
  }

  if(msg.type==='regions'){
    const{runId,threshold,minSizePct,mergeDistPct}=msg;
    if(runId!==lastRunId||!lastDeMap){
      // La comparación de referencia ya no es la vigente: se ignora.
      return;
    }
    const result=computeRegions(lastDeMap,lastW,lastH,threshold,minSizePct,mergeDistPct);
    self.postMessage({type:'regionsResult',runId,regions:result.regions,stats:result.stats});
  }
};

// ---- CAPA DE ANÁLISIS DE REGIONES (Objetivo 4) -----------------------------
// Todo lo que sigue es código nuevo: agrupa en componentes conectados los
// píxeles que superan el umbral ΔE, descarta el ruido y fusiona cajas
// cercanas. No modifica ni depende de reescribir el bucle de arriba.

// minSizePct/mergeDistPct son porcentajes del lado menor del lienzo
// comparado (no píxeles absolutos), para que un PNG de 1000px y un PDF a
// 600ppp se comporten de forma equivalente ante el mismo valor de UI.
const REGION_MINSIZE_PCT_DEFAULT=0.8,REGION_MERGE_PCT_DEFAULT=0.6;

function computeRegions(deMap,w,h,threshold,minSizePct,mergeDistPct){
  const shortSide=Math.min(w,h);
  const minSizePx=(minSizePct||REGION_MINSIZE_PCT_DEFAULT)/100*shortSide;
  const mergeDistPx=(mergeDistPct||REGION_MERGE_PCT_DEFAULT)/100*shortSide;
  const raw=labelConnectedComponents(deMap,w,h,threshold);
  const kept=discardSmallRegions(raw,minSizePx);
  const merged=mergeRegions(kept,mergeDistPx);
  const padded=padRegions(merged,8,w,h);
  // Numeración estable en orden de lectura (arriba-abajo, izq-dcha) para que
  // "Número" y "ΔE máximo" sean dos criterios de orden distintos y útiles
  // en el panel (el panel reordena la lista sin tocar esta numeración).
  padded.sort((a,b)=>a.y-b.y||a.x-b.x);
  padded.forEach((r,idx)=>{r.id=idx+1;});
  return{regions:padded,stats:{detected:padded.length,discardedBySize:raw.length-kept.length}};
}

// Flood-fill con 8-conectividad (para no partir letras en diagonal en dos
// componentes) sobre los píxeles con ΔE >= threshold.
function labelConnectedComponents(deMap,w,h,threshold){
  const n=w*h;
  const visited=new Uint8Array(n);
  const regions=[];
  // Pila dinámica (índices empaquetados cy*w+cx), no un Int32Array del
  // tamaño de la imagen entera: la inmensa mayoría de las diferencias son
  // regiones pequeñas y localizadas, así que reservar de antemano memoria
  // para el peor caso (toda la imagen en un único componente) desperdiciaría
  // cientos de MB en renders grandes sin necesidad.
  const stack=[];

  for(let y=0;y<h;y++){
    for(let x=0;x<w;x++){
      const idx=y*w+x;
      if(visited[idx]||deMap[idx]<threshold)continue;

      stack.length=0;
      stack.push(idx);
      visited[idx]=1;

      let minX=x,maxX=x,minY=y,maxY=y,deMaxRegion=deMap[idx],pixelCount=0;

      while(stack.length>0){
        const cidx=stack.pop();
        const cx=cidx%w,cy=(cidx-cx)/w;
        pixelCount++;
        if(deMap[cidx]>deMaxRegion)deMaxRegion=deMap[cidx];
        if(cx<minX)minX=cx;if(cx>maxX)maxX=cx;
        if(cy<minY)minY=cy;if(cy>maxY)maxY=cy;

        for(let dy=-1;dy<=1;dy++){
          for(let dx=-1;dx<=1;dx++){
            if(dx===0&&dy===0)continue;
            const nx=cx+dx,ny=cy+dy;
            if(nx<0||ny<0||nx>=w||ny>=h)continue;
            const nidx=ny*w+nx;
            if(visited[nidx]||deMap[nidx]<threshold)continue;
            visited[nidx]=1;
            stack.push(nidx);
          }
        }
      }

      regions.push({x:minX,y:minY,w:maxX-minX+1,h:maxY-minY+1,pixelCount,deMaxRegion});
    }
  }
  return regions;
}

// Filtra por número de píxeles reales de la componente (no por bounding
// box), interpretando minSizePx (ya convertido a píxeles nativos por
// computeRegions, a partir del % del lado menor) como lado equivalente de
// área — más robusto contra ruido de compresión JPG con bounding box
// alargado (ringing) que un filtro por ancho/alto.
function discardSmallRegions(regions,minSizePx){
  const minArea=minSizePx*minSizePx;
  return regions.filter(r=>r.pixelCount>=minArea);
}

// Fusiona recuadros cuyo hueco (gap entre bordes, no distancia centro a
// centro) sea menor que mergeDist. Iterativo hasta punto fijo: una fusión
// puede acercar el nuevo recuadro combinado a otros vecinos.
function mergeRegions(regions,mergeDist){
  let current=regions.map(r=>({...r}));
  let merged=true;
  while(merged){
    merged=false;
    outer:
    for(let i=0;i<current.length;i++){
      for(let j=i+1;j<current.length;j++){
        if(boxGap(current[i],current[j])<mergeDist){
          current[i]=unionBox(current[i],current[j]);
          current.splice(j,1);
          merged=true;
          break outer;
        }
      }
    }
  }
  return current;
}

function boxGap(a,b){
  const dx=Math.max(a.x-(b.x+b.w),b.x-(a.x+a.w),0);
  const dy=Math.max(a.y-(b.y+b.h),b.y-(a.y+a.h),0);
  return Math.sqrt(dx*dx+dy*dy);
}

function unionBox(a,b){
  const x=Math.min(a.x,b.x),y=Math.min(a.y,b.y);
  const x2=Math.max(a.x+a.w,b.x+b.w),y2=Math.max(a.y+a.h,b.y+b.h);
  return{
    x,y,w:x2-x,h:y2-y,
    pixelCount:a.pixelCount+b.pixelCount,
    deMaxRegion:Math.max(a.deMaxRegion,b.deMaxRegion)
  };
}

function padRegions(regions,margin,w,h){
  return regions.map(r=>{
    const x=Math.max(0,r.x-margin);
    const y=Math.max(0,r.y-margin);
    const x2=Math.min(w,r.x+r.w+margin);
    const y2=Math.min(h,r.y+r.h+margin);
    return{x,y,w:x2-x,h:y2-y,pixelCount:r.pixelCount,deMaxRegion:r.deMaxRegion};
  });
}
