// ============================================================================
// auto-anchor.js — búsqueda automática de anclas de alineación. Capa de
// entrada: elige por programa los elementos vectoriales que el usuario elegía
// a mano en vector-picker.js, y los entrega por la MISMA vía que las anclas
// manuales (setPointsFromAuto en align.js, hermana de setPointsFromVector).
//
// No calcula la transformación: eso sigue siendo de physical-align.js y
// similarity.js, que reciben las anclas sin saber si vinieron de un clic o de
// aquí. Tampoco toca el emparejador difuso de vector-picker.js
// (vpMatchScore): ese sirve para "el elemento más parecido" y es invariante a
// escala y giro, justo lo contrario de lo que hace falta aquí. Este archivo
// reutiliza de vector-geometry.js solo la extracción (buildVectorIndex), sin
// modificarla.
//
// El criterio es "coincidencia exacta y única":
//   - única, porque un objeto repetido (código de barras, glifo de texto
//     trazado, logo en varias caras, marcas de registro) tiene pareja
//     ambigua y no sirve de ancla;
//   - exacta, porque B es una revisión con cambios y la mayoría de objetos NO
//     van a casar: interesa quedarse solo con los que casan al 100%.
// "Exacta" no puede ser igualdad literal de números — una reexportación
// cambia la precisión de coma flotante, el punto de inicio del trazado o el
// orden de los segmentos — así que se define por tolerancia sobre geometría
// normalizada en puntos PDF (ver AA_EXACT_TOL_PT).
//
// Todas las tolerancias van en PUNTOS PDF, no en píxeles: los elementos que
// devuelve vector-geometry.js están en píxeles naturales del render (a 600 ppp
// un punto son 8,33 px), y A y B pueden estar renderizados a escalas
// distintas. Se convierte dividiendo por pxPerPt(source) — el mismo
// source.viewport.scale que ya usa physical-align.js.
// ============================================================================

// Desviación máxima admitida entre puntos correspondientes de dos trazados,
// tras normalizar posición, para declararlos el mismo objeto. Medido sobre
// pares reales de revisiones (PDF y .ai reexportados) la desviación de los
// objetos no modificados es 0,00000 pt, así que 0,01 pt es margen de sobra
// y no un valor ajustado a ojo.
const AA_EXACT_TOL_PT=0.01;
// Tolerancia en las dimensiones de la caja. Separada de la anterior porque es
// un filtro previo más barato: descarta sin recorrer los puntos.
const AA_BBOX_TOL_PT=0.01;
// Cuantización del descriptor barato con el que se agrupa antes del matching
// fino. Tiene que ser MÁS GRUESA que AA_EXACT_TOL_PT (si no, dos objetos
// idénticos podrían caer en grupos distintos), y lo bastante fina para que
// objetos realmente distintos no se amontonen en el mismo grupo.
const AA_DESCRIPTOR_QUANT_PT=0.05;
// Diagonal mínima de la caja de un objeto para valer como ancla. Medido sobre
// un arte real de packaging, la distribución de diagonales de los
// candidatos es bimodal: una nube de marcas de 4–5 pt de lado (diagonal 6–9 pt,
// la mediana del archivo) y el arte de verdad por encima de 190 pt. Esas marcas
// no dan emparejamientos falsos, pero son anclas pobres —el centro de una caja
// de 5 pt informa poco— y sepultan a los candidatos buenos. A 12 pt la nube
// desaparece por completo y quedan 46 candidatos en ese archivo (265 en un par
// limpio), de sobra para elegir 3.
const AA_MIN_SIZE_PT=12;
// Un objeto que ocupa casi toda la página en AMBOS ejes es el fondo o el
// sangrado, no arte: su caja coincide en cualquier par de archivos y no
// informa de nada. Se exigen los dos ejes a propósito: una barra que cruza la
// página a lo ancho pero mide 30 pt de alto sí es arte.
const AA_MAX_PAGE_FRACTION=0.9;
// Tope de nodos para probar todas las rotaciones cíclicas del trazado. Los
// artes reales traen trazados de decenas de miles de nodos (medido: 25 636 en
// un grupo único), y probar n rotaciones sobre n puntos sería O(n²) —
// ~1,3·10⁹ operaciones para ese único elemento. Por encima del tope solo se
// prueba el orden tal cual y el invertido, que es lo que cubre los casos
// reales de reexportación.
const AA_MAX_ROT_NODES=400;

// Nº de anclas. Con la escala bloqueada bastaría 1 para CALCULAR, pero no hay
// forma de saber si la pareja es falsa. Con 3 repartidas, cada una da su
// propio desplazamiento: si coinciden, la alineación queda verificada de forma
// independiente; si una discrepa, es un emparejamiento falso y se descarta.
const AA_ANCHOR_COUNT=3;
// Dispersión máxima admitida entre los desplazamientos que implica cada ancla
// (escala bloqueada), o residuo máximo al predecir la tercera ancla (escala
// desbloqueada). Es la misma tolerancia que ya usa physical-align.js para
// avisar de que dos pares de anclas no concuerdan (PA_PAIR_TOLERANCE_PT).
const AA_CONSENSUS_TOL_PT=0.5;
// Tres anclas juntas o casi en línea recta verifican mal el giro y la escala.
const AA_MIN_TRIANGLE_ANGLE_DEG=15;
// Tope de tríos a probar. Un fallo de consenso significa emparejamiento falso,
// que es raro; no hace falta explorar el espacio entero.
const AA_MAX_COMBINATIONS=20;
// La selección no puede enumerar los C(n,3) tríos posibles: con 266
// candidatos serían 3,1 millones. Se reduce antes a una reserva repartida por
// una rejilla sobre la página (el mejor candidato de cada celda), que por
// construcción ya está separada, y se completa con los mayores si quedan
// pocas celdas ocupadas. Con rejilla 4×4 la enumeración es C(16,3)=560.
const AA_POOL_GRID=4;
const AA_MIN_POOL=12;

// ---- utilidades de geometría, todas en puntos PDF -------------------------

// Perímetro recorriendo los nodos. No se reutilizan los segLengths del
// elemento porque vector-geometry.js los devuelve normalizados por el
// perímetro total (son invariantes a escala, y aquí hace falta la medida
// absoluta para poder comparar A con B en puntos).
function aaPerimeterPt(pts,s){
  let total=0;
  for(let i=1;i<pts.length;i++)total+=Math.hypot(pts[i][0]-pts[i-1][0],pts[i][1]-pts[i-1][1]);
  return total/s;
}

// Cuentas por tipo de comando a partir del path data, es decir "mismo número
// de segmentos por tipo (líneas / Bézier)". Se cuentan en vez de comparar la
// secuencia literal porque la secuencia rota con el punto de inicio del
// trazado, y el punto de inicio es precisamente una de las cosas que una
// reexportación puede cambiar.
function aaCmdCounts(d){
  let m=0,l=0,c=0,z=0;
  for(let i=0;i<d.length;i++){
    const ch=d[i];
    if(ch==='M')m++;else if(ch==='L')l++;else if(ch==='C')c++;else if(ch==='Z')z++;
  }
  return m+'/'+l+'/'+c+'/'+z;
}

// ¿Puede este elemento ser ancla? Los recortes y las máscaras no hacen falta
// filtrarlos: vector-geometry.js nunca los emite como elemento (W/W* solo
// dejan una caja de recorte), y las imágenes no entran en el índice.
function aaIsUsable(el,s,pageWPt,pageHPt){
  if(el.kind!=='pdf-path')return false;
  // El texto vivo (kind 'pdf-text') es un rectángulo de 4 esquinas derivado de
  // getTextContent(), no el contorno del glifo, y además arrastra el desfase
  // de matriz de XObject documentado en vector-geometry.js. No es geometría
  // comparable: fuera. El texto trazado sí llega como 'pdf-path'.
  if(el.isLikelyOutlinedText)return false;
  if(!el.pts||el.pts.length<2)return false;
  const w=el.bbox.w/s,h=el.bbox.h/s;
  if(Math.hypot(w,h)<AA_MIN_SIZE_PT)return false;
  if(w>=pageWPt*AA_MAX_PAGE_FRACTION&&h>=pageHPt*AA_MAX_PAGE_FRACTION)return false;
  return true;
}

// Descriptor barato para agrupar: todo lo que se puede comparar sin recorrer
// los puntos. Cuantizado para que dos objetos idénticos den la misma clave a
// pesar del ruido de coma flotante.
function aaDescriptor(el,s){
  const q=v=>Math.round(v/AA_DESCRIPTOR_QUANT_PT);
  return q(el.bbox.w/s)+'|'+q(el.bbox.h/s)+'|'+el.nodeCount+'|'+(el.isClosed?1:0)
        +'|'+q(aaPerimeterPt(el.pts,s))+'|'+aaCmdCounts(el.d);
}

// Nodos en puntos PDF y relativos al origen de su propia caja: así la
// comparación es de forma, independiente de dónde esté cada objeto en su
// página (que es justo lo que se quiere medir después, no ahora).
function aaNormalizedPts(el,s){
  const ox=el.bbox.x/s,oy=el.bbox.y/s,out=[];
  for(const p of el.pts)out.push([p[0]/s-ox,p[1]/s-oy]);
  return out;
}

// Coincidencia exacta: devuelve la desviación máxima en pt, o null si no
// coinciden. Prueba todas las rotaciones cíclicas y el orden invertido para
// tolerar que la reexportación haya cambiado el punto de inicio o el sentido
// del trazado.
//
// Límite conocido: `pts` solo guarda los nodos de ancla, no los puntos de
// control de las Bézier, así que dos formas con los mismos nodos y curvas
// distintas pasarían este filtro. El consenso entre las tres anclas (fase de
// selección) es quien caza un falso positivo así.
function aaExactMatch(elA,elB,sA,sB){
  if(elA.nodeCount!==elB.nodeCount)return null;
  if(elA.isClosed!==elB.isClosed)return null;
  if(aaCmdCounts(elA.d)!==aaCmdCounts(elB.d))return null;
  if(Math.abs(elA.bbox.w/sA-elB.bbox.w/sB)>AA_BBOX_TOL_PT)return null;
  if(Math.abs(elA.bbox.h/sA-elB.bbox.h/sB)>AA_BBOX_TOL_PT)return null;
  const pa=aaNormalizedPts(elA,sA),pb=aaNormalizedPts(elB,sB);
  const n=pa.length;
  if(n!==pb.length)return null;
  const variants=[pb,pb.slice().reverse()];
  const shifts=n<=AA_MAX_ROT_NODES?n:1;
  const earlyOut=AA_EXACT_TOL_PT*0.01;
  let best=Infinity;
  for(const seq of variants){
    for(let sh=0;sh<shifts;sh++){
      let worst=0;
      for(let i=0;i<n;i++){
        const q=seq[(i+sh)%n];
        const dev=Math.hypot(pa[i][0]-q[0],pa[i][1]-q[1]);
        if(dev>worst){worst=dev;if(worst>=best)break;}
      }
      if(worst<best)best=worst;
      if(best<=earlyOut)break;
    }
    if(best<=earlyOut)break;
  }
  return best<=AA_EXACT_TOL_PT?best:null;
}

// ---- búsqueda de candidatos ------------------------------------------------

// Agrupa por descriptor y devuelve solo los grupos con UN miembro: un objeto
// que aparece dos veces en su propio archivo ya es ambiguo de por sí.
function aaUniqueByDescriptor(elements,s,pageWPt,pageHPt){
  const groups=new Map();
  let usable=0;
  for(const el of elements){
    if(!aaIsUsable(el,s,pageWPt,pageHPt))continue;
    usable++;
    const key=aaDescriptor(el,s);
    const bucket=groups.get(key);
    if(bucket)bucket.push(el);
    else groups.set(key,[el]);
  }
  const unique=new Map();
  for(const[key,bucket] of groups)if(bucket.length===1)unique.set(key,bucket[0]);
  return{unique,usable,groupCount:groups.size};
}

// Devuelve {candidates,stats}. Cada candidato lleva el centro de su elemento
// en A y en B, en píxeles naturales — el mismo punto que produce
// vpAnchorPoint(el,'center'), que es el ancla por defecto del método manual.
async function findAutoAnchors(sourceA,sourceB,opts){
  const{onProgress,signal}=opts||{};
  const t0=performance.now();
  // El progreso se reenvía marcado con el archivo al que corresponde: cada
  // índice cuenta su propio 0→100 %, y sin la marca la interfaz no podría
  // distinguir el segundo recorrido de un reinicio del primero.
  const prog=which=>onProgress?(p=>onProgress({done:p.done,total:p.total,which})):undefined;
  const indexA=await buildVectorIndex(sourceA,{onProgress:prog('A'),signal,label:'A (auto)'});
  const indexB=await buildVectorIndex(sourceB,{onProgress:prog('B'),signal,label:'B (auto)'});
  const tExtract=performance.now();

  const sA=pxPerPt(sourceA),sB=pxPerPt(sourceB);
  const pageA=pageSizePt(sourceA),pageB=pageSizePt(sourceB);
  const ua=aaUniqueByDescriptor(indexA.elements,sA,pageA.w,pageA.h);
  const ub=aaUniqueByDescriptor(indexB.elements,sB,pageB.w,pageB.h);

  const candidates=[];
  for(const[key,elA] of ua.unique){
    const elB=ub.unique.get(key);
    if(!elB)continue;
    const maxDevPt=aaExactMatch(elA,elB,sA,sB);
    if(maxDevPt==null)continue;
    candidates.push({
      elA,elB,
      centerA:{x:elA.center.x,y:elA.center.y},
      centerB:{x:elB.center.x,y:elB.center.y},
      maxDevPt,
      sizePt:{w:elA.bbox.w/sA,h:elA.bbox.h/sA}
    });
  }
  const t1=performance.now();

  const stats={
    totalA:indexA.elements.length,totalB:indexB.elements.length,
    usableA:ua.usable,usableB:ub.usable,
    groupsA:ua.groupCount,groupsB:ub.groupCount,
    uniqueA:ua.unique.size,uniqueB:ub.unique.size,
    candidates:candidates.length,
    msExtract:Math.round(tExtract-t0),
    msSearch:Math.round(t1-tExtract),
    msTotal:Math.round(t1-t0)
  };
  console.log('[auto-anchor] candidatos',stats);
  return{candidates,stats};
}

// ---- selección de las 3 anclas y verificación por consenso -----------------

// Reserva de trabajo: el mejor candidato (caja mayor) de cada celda de una
// rejilla sobre la página, para que la enumeración parta de puntos ya
// repartidos en vez de de 266 candidatos amontonados en la misma zona.
function aaBuildPool(candidates,pageWPt,pageHPt,sA){
  const cells=new Map();
  const size=el=>Math.hypot(el.bbox.w,el.bbox.h);
  for(const c of candidates){
    const gx=Math.min(AA_POOL_GRID-1,Math.floor((c.centerA.x/sA)/(pageWPt/AA_POOL_GRID)));
    const gy=Math.min(AA_POOL_GRID-1,Math.floor((c.centerA.y/sA)/(pageHPt/AA_POOL_GRID)));
    const key=gx+','+gy;
    const prev=cells.get(key);
    if(!prev||size(c.elA)>size(prev.elA))cells.set(key,c);
  }
  const pool=[...cells.values()];
  if(pool.length<AA_MIN_POOL){
    const resto=candidates.filter(c=>!pool.includes(c)).sort((a,b)=>size(b.elA)-size(a.elA));
    for(const c of resto){
      pool.push(c);
      if(pool.length>=AA_MIN_POOL)break;
    }
  }
  return pool;
}

// Área del triángulo (el doble, da igual: solo se usa para ordenar) y ángulo
// mínimo en grados. Ambos sobre los centros en A, en puntos.
function aaTriangleArea(p1,p2,p3){
  return Math.abs((p2.x-p1.x)*(p3.y-p1.y)-(p3.x-p1.x)*(p2.y-p1.y))/2;
}
function aaMinAngleDeg(p1,p2,p3){
  const lados=[[p1,p2,p3],[p2,p3,p1],[p3,p1,p2]];
  let min=180;
  for(const[a,b,c] of lados){
    const v1x=b.x-a.x,v1y=b.y-a.y,v2x=c.x-a.x,v2y=c.y-a.y;
    const n1=Math.hypot(v1x,v1y),n2=Math.hypot(v2x,v2y);
    if(n1<1e-9||n2<1e-9)return 0;
    const cos=Math.max(-1,Math.min(1,(v1x*v2x+v1y*v2y)/(n1*n2)));
    const ang=Math.acos(cos)*180/Math.PI;
    if(ang<min)min=ang;
  }
  return min;
}

// Desplazamiento en puntos que implica cada ancla por separado. Es la misma
// cuenta que hace computeLockedTransform() con el par 1; se repite aquí para
// poder VALIDAR antes de registrar las anclas, sin modificar physical-align.js.
function aaOffsetPt(c,sA,sB){
  return{dx:c.centerA.x/sA-c.centerB.x/sB,dy:c.centerA.y/sA-c.centerB.y/sB};
}
function aaMaxSpreadPt(offsets){
  let max=0;
  for(let i=0;i<offsets.length;i++)for(let j=i+1;j<offsets.length;j++){
    const d=Math.hypot(offsets[i].dx-offsets[j].dx,offsets[i].dy-offsets[j].dy);
    if(d>max)max=d;
  }
  return max;
}

// Posición que la transformación de 2 anclas predice en A para un punto de B,
// según la misma composición que aplica drawTransformedB() en similarity.js:
// p_A = R(theta)·scale·(p_B − B1) + A1.
function aaPredictInA(t,A1,B1,pB){
  const dx=pB.x-B1.x,dy=pB.y-B1.y;
  const cos=Math.cos(t.thetaRad),sin=Math.sin(t.thetaRad);
  return{x:A1.x+t.scale*(dx*cos-dy*sin),y:A1.y+t.scale*(dx*sin+dy*cos)};
}

// Comprueba un trío ya ordenado (anclas 1 y 2 = el par más separado, 3 = la
// verificadora) y devuelve {ok,spreadPt}. `locked` viene de isScaleLockActive().
function aaCheckConsensus(trio,sA,sB,locked){
  if(locked){
    const offs=trio.map(c=>aaOffsetPt(c,sA,sB));
    const spreadPt=aaMaxSpreadPt(offs);
    return{ok:spreadPt<=AA_CONSENSUS_TOL_PT,spreadPt};
  }
  // Escala desbloqueada: la transformación sale de las anclas 1 y 2 con la
  // función existente, y la 3 tiene que caer donde esa transformación predice.
  const pt=c=>({A:{x:c.centerA.x/sA,y:c.centerA.y/sA},B:{x:c.centerB.x/sB,y:c.centerB.y/sB}});
  const a1=pt(trio[0]),a2=pt(trio[1]),a3=pt(trio[2]);
  const t=computeSimilarityTransform(a1.A,a2.A,a1.B,a2.B);
  const pred=aaPredictInA(t,a1.A,a1.B,a3.B);
  const spreadPt=Math.hypot(pred.x-a3.A.x,pred.y-a3.A.y);
  return{ok:spreadPt<=AA_CONSENSUS_TOL_PT,spreadPt};
}

// Ordena el trío dejando en las posiciones 1 y 2 el par más separado: son las
// únicas que consume la transformación (con la escala desbloqueada, el par más
// separado es el que mejor brazo de palanca da para escala y giro), y la
// tercera queda como verificadora.
function aaOrderTrio(trio,sA){
  const p=c=>({x:c.centerA.x/sA,y:c.centerA.y/sA});
  let mejor=0,dist=-1;
  for(let i=0;i<3;i++){
    const j=(i+1)%3;
    const d=Math.hypot(p(trio[i]).x-p(trio[j]).x,p(trio[i]).y-p(trio[j]).y);
    if(d>dist){dist=d;mejor=i;}
  }
  const j=(mejor+1)%3,k=(mejor+2)%3;
  return[trio[mejor],trio[j],trio[k]];
}

// Elige 3 anclas coherentes entre los candidatos. Devuelve
// {ok, anchors, spreadPt, reason, tried, poolSize}. No registra nada: el
// registro lo hace quien llama, por la misma vía que las anclas manuales.
function selectAndVerifyAnchors(candidates,sourceA,sourceB){
  const sA=pxPerPt(sourceA),sB=pxPerPt(sourceB);
  const pageA=pageSizePt(sourceA);
  const locked=typeof isScaleLockActive==='function'?isScaleLockActive():false;

  if(candidates.length<AA_ANCHOR_COUNT){
    return{ok:false,reason:'pocos-candidatos',found:candidates.length,tried:0,locked};
  }
  const pool=aaBuildPool(candidates,pageA.w,pageA.h,sA);
  const p=c=>({x:c.centerA.x/sA,y:c.centerA.y/sA});

  // Todos los tríos de la reserva, ordenados por área de triángulo
  // descendente y sin los casi colineales.
  const trios=[];
  for(let i=0;i<pool.length;i++)for(let j=i+1;j<pool.length;j++)for(let k=j+1;k<pool.length;k++){
    const p1=p(pool[i]),p2=p(pool[j]),p3=p(pool[k]);
    const ang=aaMinAngleDeg(p1,p2,p3);
    if(ang<AA_MIN_TRIANGLE_ANGLE_DEG)continue;
    trios.push({idx:[i,j,k],area:aaTriangleArea(p1,p2,p3),minAngle:ang});
  }
  if(!trios.length){
    return{ok:false,reason:'colineales',found:candidates.length,poolSize:pool.length,tried:0,locked};
  }
  trios.sort((a,b)=>b.area-a.area);

  let tried=0,mejorSpread=Infinity;
  for(const t of trios){
    if(tried>=AA_MAX_COMBINATIONS)break;
    tried++;
    const trio=aaOrderTrio(t.idx.map(i=>pool[i]),sA);
    const{ok,spreadPt}=aaCheckConsensus(trio,sA,sB,locked);
    if(spreadPt<mejorSpread)mejorSpread=spreadPt;
    if(ok){
      console.log('[auto-anchor] consenso',{intentos:tried,spreadPt,minAngle:t.minAngle,locked,poolSize:pool.length});
      return{
        ok:true,anchors:trio,spreadPt,minAngleDeg:t.minAngle,
        found:candidates.length,poolSize:pool.length,tried,locked
      };
    }
  }
  return{
    ok:false,reason:'discrepancia',found:candidates.length,
    poolSize:pool.length,tried,bestSpreadPt:mejorSpread,locked
  };
}

// Búsqueda + selección + verificación, de una pieza. No toca el estado de
// alineación: devuelve el resultado para que la capa de interfaz decida.
async function findVerifiedAnchors(sourceA,sourceB,opts){
  const t0=performance.now();
  const{candidates,stats}=await findAutoAnchors(sourceA,sourceB,opts);
  const sel=selectAndVerifyAnchors(candidates,sourceA,sourceB);
  sel.stats=stats;
  sel.msTotal=Math.round(performance.now()-t0);
  return sel;
}
