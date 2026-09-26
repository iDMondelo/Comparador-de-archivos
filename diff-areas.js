// ============================================================================
// diff-areas.js — índice por celdas del mapa ΔE que ya devolvió de-worker.js
// (Float32Array, un ΔE2000 por píxel). Sin dependencias: no recalcula ΔE, no
// toca el DOM ni el worker; solo resume el mapa para que re-umbralizar no
// obligue a recorrer la imagen entera (34,8 Mpx en un A4 a 600 ppp).
// ============================================================================

// Lado de la celda, en píxeles de la imagen comparada. Cada celda guarda el
// ΔE máximo de sus píxeles: con un umbral t, solo una celda con máximo >= t
// puede contener píxeles diferentes. 8×8 deja el índice en n/64 floats
// (≈2,1 MB para un A4 a 600 ppp).
const DIFF_CELL_PX=8;

// Una pasada por comparación. Cubre todos los píxeles (sin máscara de
// cobertura): el overlay se recolorea sobre la imagen completa y debe dar
// exactamente lo mismo que un recorrido completo. Un ΔE NaN nunca supera el
// umbral y tampoco sube el máximo de su celda.
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
