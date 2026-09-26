// ============================================================================
// diff-areas.js — resúmenes del mapa ΔE que ya devolvió de-worker.js
// (Float32Array, un ΔE2000 por píxel): índice por celdas y detección de las
// áreas con diferencias de la vista «Marcado». Sin dependencias: no recalcula
// ΔE, no toca el DOM ni el worker. Todo trabaja sobre una rejilla de celdas,
// nunca con máscaras a resolución completa: a 600 ppp (34,8 Mpx en un A4)
// re-umbralizar no obliga a recorrer la imagen entera.
// ============================================================================

// Lado de la celda, en píxeles de la imagen comparada. Cada celda guarda el
// ΔE máximo de sus píxeles: con un umbral t, solo una celda con máximo >= t
// puede contener píxeles diferentes. 8×8 deja el índice en n/64 floats
// (≈2,1 MB para un A4 a 600 ppp).
const DIFF_CELL_PX=8;

// Una pasada por comparación. Cubre todos los píxeles (sin máscara de
// cobertura): el overlay se recolorea sobre la imagen completa y debe dar
// exactamente lo mismo que un recorrido completo; detectDiffAreas aplica la
// máscara y la región píxel a píxel. Un ΔE NaN nunca supera el umbral y
// tampoco sube el máximo de su celda.
function buildDiffCellIndex(deMap,w,h){
  const cell=DIFF_CELL_PX;
  const gw=Math.ceil(w/cell),gh=Math.ceil(h/cell);
  const cellMax=new Float32Array(gw*gh);
  for(let y=0;y<h;y++){
    const row=y*w,cRow=((y/cell)|0)*gw;
    for(let cx=0;cx<gw;cx++){
      const x0=cx*cell,x1=Math.min(w,x0+cell);
      let m=cellMax[cRow+cx];
      for(let i=row+x0,end=row+x1;i<end;i++){
        const de=deMap[i];
        if(de>m)m=de;
      }
      cellMax[cRow+cx]=m;
    }
  }
  return{cell,gw,gh,w,h,cellMax};
}

// ---- áreas con diferencias (vista «Marcado») --------------------------------

// Dilatación, en celdas, antes de buscar componentes: une diferencias
// separadas por menos de una celda (8 px, 0,34 mm a 600 ppp), como las letras
// de una palabra o un trazo con antialiasing discontinuo.
const DIFF_DILATE_CELLS=1;
// Área mínima, en píxeles diferentes reales (no en caja envolvente): por
// debajo se descarta como ruido de antialiasing o de compresión. 16 px ≈ 4×4
// px, 0,17 mm de lado a 600 ppp; un punto de texto de 6 pt ya pasa de 30 px.
const DIFF_MIN_PIXELS=16;

// index: buildDiffCellIndex(). t: umbral ΔE; un píxel cuenta si ΔE >= t,
// igual que en el overlay. Opciones:
//   mask: Uint8Array w×h de cobertura (0 = zona de A sin correspondencia en
//     B): esos píxeles no cuentan.
//   roi: {x,y,w,h}, región de análisis en píxeles: fuera no cuenta nada.
//   mergeMarginPx: margen, en píxeles de imagen, que se añade a cada caja;
//     dos cajas cuyos recuadros con margen se solaparían se funden en una.
//   minPixels: sustituye a DIFF_MIN_PIXELS.
// Proceso: celdas con ΔE máx >= t → dilatación → componentes 8-conexas de la
// rejilla → caja ajustada y estadísticas con los píxeles >= t de cada una →
// descarte por área mínima → fusión de cajas → orden de lectura.
// Devuelve [{id,x,y,w,h,nPixeles,deltaEMax,deltaEMedio}]: caja ajustada a los
// píxeles diferentes, sin el margen.
function detectDiffAreas(index,deMap,t,{mask=null,roi=null,mergeMarginPx=0,minPixels=DIFF_MIN_PIXELS}={}){
  const{cell,gw,gh,w,h,cellMax}=index;
  const n=gw*gh;
  let rx0=0,ry0=0,rx1=w,ry1=h;
  if(roi){
    rx0=Math.max(0,Math.floor(roi.x));ry0=Math.max(0,Math.floor(roi.y));
    rx1=Math.min(w,Math.ceil(roi.x+roi.w));ry1=Math.min(h,Math.ceil(roi.y+roi.h));
    if(rx1<=rx0||ry1<=ry0)return[];
  }
  const cx0=(rx0/cell)|0,cy0=(ry0/cell)|0,cx1=Math.ceil(rx1/cell),cy1=Math.ceil(ry1/cell);

  // 1. celdas que pueden contener píxeles diferentes
  const active=new Uint8Array(n);
  let any=false;
  for(let cy=cy0;cy<cy1;cy++){
    for(let c=cy*gw+cx0,end=cy*gw+cx1;c<end;c++){
      if(cellMax[c]>=t){active[c]=1;any=true;}
    }
  }
  if(!any)return[];

  // 2. dilatación: máximo separable (filas y luego columnas)
  let grown=active;
  const d=DIFF_DILATE_CELLS;
  if(d>0){
    const tmp=new Uint8Array(n);
    grown=new Uint8Array(n);
    for(let cy=0;cy<gh;cy++){
      const row=cy*gw;
      for(let cx=0;cx<gw;cx++){
        if(!active[row+cx])continue;
        for(let k=Math.max(0,cx-d),b=Math.min(gw-1,cx+d);k<=b;k++)tmp[row+k]=1;
      }
    }
    for(let cy=0;cy<gh;cy++){
      const row=cy*gw;
      for(let cx=0;cx<gw;cx++){
        if(!tmp[row+cx])continue;
        for(let k=Math.max(0,cy-d),b=Math.min(gh-1,cy+d);k<=b;k++)grown[k*gw+cx]=1;
      }
    }
  }

  // 3. componentes 8-conexas; de cada una se guardan solo sus celdas activas
  //    (las añadidas por la dilatación solo sirven de puente)
  const seen=new Uint8Array(n);
  const stack=[],comps=[];
  for(let c0=0;c0<n;c0++){
    if(!grown[c0]||seen[c0])continue;
    seen[c0]=1;stack.push(c0);
    const cells=[];
    while(stack.length){
      const c=stack.pop();
      if(active[c])cells.push(c);
      const cx=c%gw,cy=(c-cx)/gw;
      for(let ny=Math.max(0,cy-1),yb=Math.min(gh-1,cy+1);ny<=yb;ny++){
        for(let nx=Math.max(0,cx-1),xb=Math.min(gw-1,cx+1);nx<=xb;nx++){
          const nc=ny*gw+nx;
          if(grown[nc]&&!seen[nc]){seen[nc]=1;stack.push(nc);}
        }
      }
    }
    comps.push(cells);
  }

  // 4. caja y estadísticas con los píxeles diferentes de verdad; 5. descarte
  let boxes=[];
  for(const cells of comps){
    let x0=w,y0=h,x1=-1,y1=-1,cnt=0,max=0,sum=0;
    for(const c of cells){
      const cx=c%gw,cy=(c-cx)/gw;
      const px0=Math.max(rx0,cx*cell),px1=Math.min(rx1,cx*cell+cell);
      const py0=Math.max(ry0,cy*cell),py1=Math.min(ry1,cy*cell+cell);
      for(let y=py0;y<py1;y++){
        for(let x=px0,i=y*w+px0;x<px1;x++,i++){
          const de=deMap[i];
          if(!(de>=t))continue;
          if(mask&&!mask[i])continue;
          cnt++;sum+=de;
          if(de>max)max=de;
          if(x<x0)x0=x;if(x>x1)x1=x;
          if(y<y0)y0=y;if(y>y1)y1=y;
        }
      }
    }
    if(cnt>=minPixels)boxes.push({x0,y0,x1:x1+1,y1:y1+1,cnt,max,sum});
  }

  // 6. fusión hasta punto fijo: dos cajas se funden si, con el margen añadido
  //    a cada una, se solaparían (hueco entre ellas < 2 márgenes)
  const m=mergeMarginPx;
  let merged=true;
  while(merged){
    merged=false;
    for(let i=0;i<boxes.length;i++){
      const a=boxes[i];
      for(let j=i+1;j<boxes.length;j++){
        const b=boxes[j];
        if(a.x0-m<b.x1+m&&b.x0-m<a.x1+m&&a.y0-m<b.y1+m&&b.y0-m<a.y1+m){
          a.x0=Math.min(a.x0,b.x0);a.y0=Math.min(a.y0,b.y0);
          a.x1=Math.max(a.x1,b.x1);a.y1=Math.max(a.y1,b.y1);
          a.cnt+=b.cnt;a.sum+=b.sum;if(b.max>a.max)a.max=b.max;
          boxes[j]=boxes[boxes.length-1];boxes.pop();
          j=i;merged=true; // la caja creció: vuelve a compararla con todas
        }
      }
    }
  }

  // 7. orden de lectura (arriba→abajo, izquierda→derecha) y numeración
  boxes.sort((a,b)=>a.y0-b.y0||a.x0-b.x0);
  return boxes.map((b,k)=>({id:k+1,x:b.x0,y:b.y0,w:b.x1-b.x0,h:b.y1-b.y0,
    nPixeles:b.cnt,deltaEMax:b.max,deltaEMedio:b.sum/b.cnt}));
}
