// ============================================================================
// vector-geometry.js — extracción de geometría vectorial (SVG y PDF/.ai),
// índice espacial para hit-testing, heurística de texto trazado y cálculo de
// transformación con 1 elemento. Capa de entrada pura: no toca el motor ΔE,
// no depende de align.js/app.js/vector-picker.js — solo lee el `source`
// normalizado {drawable, naturalWidth, naturalHeight, sourceType, dpi, file,
// pdfDoc, pageNum, viewport} que ya usa el resto de la app.
//
// Todo queda en el mismo espacio de píxel natural que `source.naturalWidth/
// naturalHeight` (el que ya usa align.js), para poder anclar directamente
// sobre pointsA/pointsB sin conversiones adicionales.
// ============================================================================

function pxToMm(px,dpi){
  return px/(dpi||300)*25.4;
}

// Factor SVG (96dpi, "user units") -> px del render (dpi elegido). Compartido
// con renderSvgToCanvas en pdf-source.js para que ambos lados nunca diverjan.
function svgDpiScale(dpi){
  return (dpi||300)/96;
}

function isVectorGeometryAvailable(source){
  return !!source&&(source.sourceType==='svg'||source.sourceType==='pdf'||source.sourceType==='ai');
}

// ---- firma de forma común (ángulos/longitudes normalizados) ---------------
// `pts` es una polilínea ya en espacio de píxel; si `isClosed`, el último
// punto debe repetir al primero (mismo convenio en SVG y PDF más abajo).
function computePolylineSignatureData(pts,isClosed){
  const n=pts.length;
  const segLens=[];
  let perimeter=0;
  for(let i=0;i<n-1;i++){
    const dx=pts[i+1][0]-pts[i][0],dy=pts[i+1][1]-pts[i][1];
    const len=Math.hypot(dx,dy);
    segLens.push(len);
    perimeter+=len;
  }
  const segLengths=perimeter>0?segLens.map(l=>l/perimeter):segLens.map(()=>0);
  const angles=[];
  for(let i=1;i<n-1;i++){
    const v1x=pts[i][0]-pts[i-1][0],v1y=pts[i][1]-pts[i-1][1];
    const v2x=pts[i+1][0]-pts[i][0],v2y=pts[i+1][1]-pts[i][1];
    let da=Math.atan2(v2y,v2x)-Math.atan2(v1y,v1x);
    while(da<0)da+=Math.PI*2;
    while(da>=Math.PI*2)da-=Math.PI*2;
    angles.push(da);
  }
  return{angles,segLengths};
}

function computeShapeSignature(el){
  return{nodeCount:el.nodeCount,aspectRatio:el.aspectRatio,angles:el.angles,segLengths:el.segLengths,isClosed:el.isClosed};
}

// Firma de un <path> con varios subpaths (letra con agujero, icono
// multi-contorno): ángulos por subpath (sin generar ninguno en la frontera
// entre subpaths) y longitudes normalizadas contra el perímetro TOTAL del
// elemento, para que el emparejado automático (vpMatchScore) siga
// recibiendo angles/segLengths con la misma forma que un path simple.
function computeMultiSubpathSignatureData(subpaths){
  let totalPerimeter=0;
  const perSub=subpaths.map(sp=>{
    const segLens=[];
    for(let i=0;i<sp.pts.length-1;i++){
      const dx=sp.pts[i+1][0]-sp.pts[i][0],dy=sp.pts[i+1][1]-sp.pts[i][1];
      segLens.push(Math.hypot(dx,dy));
    }
    totalPerimeter+=segLens.reduce((a,b)=>a+b,0);
    const{angles}=computePolylineSignatureData(sp.pts,sp.isClosed);
    return{segLens,angles};
  });
  return{
    angles:perSub.flatMap(s=>s.angles),
    segLengths:perSub.flatMap(s=>totalPerimeter>0?s.segLens.map(l=>l/totalPerimeter):s.segLens.map(()=>0))
  };
}

// ---- extracción SVG ---------------------------------------------------
// El render de comparación sigue rasterizando el SVG a <img> (renderSvgToCanvas
// en pdf-source.js) — eso no cambia. Para el picker se monta el SVG inline por
// separado (oculto, visibility:hidden, tamaño = el mismo natural/dpi que ya usa
// el render), únicamente para poder leer getBBox()/getScreenCTM().

// El contenido de <use> vive en un shadow tree de UA no scriptable
// (use.shadowRoot es null; las interfaces SVGElementInstance de SVG 1.1
// están retiradas de los navegadores actuales), así que no se puede recorrer
// para leer getScreenCTM(). Se expande cada <use> "vivo" a un <g> con el
// contenido referenciado clonado a DOM real antes de indexar, para que el
// selector de shapes normal lo recoja sin más cambios.
function vgResolveUseElements(mounted){
  const SVGNS='http://www.w3.org/2000/svg';
  let guard=0;
  while(guard++<500){
    const uses=Array.from(mounted.querySelectorAll('use'))
      .filter(u=>!u.closest('defs,symbol,clipPath,mask,pattern'));
    if(!uses.length)break;
    for(const use of uses){
      const href=use.getAttribute('href')||use.getAttributeNS('http://www.w3.org/1999/xlink','href')||'';
      if(!href.startsWith('#')){use.remove();continue;}
      let target=null;
      try{target=mounted.querySelector('#'+CSS.escape(href.slice(1)));}catch(e){}
      if(!target||target===use||target.contains(use)){use.remove();continue;}

      const clone=target.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));

      let content=clone;
      if(clone.tagName.toLowerCase()==='symbol'){
        const svgWrap=document.createElementNS(SVGNS,'svg');
        for(const a of['viewBox','preserveAspectRatio']){
          if(clone.hasAttribute(a))svgWrap.setAttribute(a,clone.getAttribute(a));
        }
        svgWrap.setAttribute('width',use.getAttribute('width')||clone.getAttribute('width')||'100%');
        svgWrap.setAttribute('height',use.getAttribute('height')||clone.getAttribute('height')||'100%');
        while(clone.firstChild)svgWrap.appendChild(clone.firstChild);
        content=svgWrap;
      }

      const x=(use.x&&use.x.baseVal?use.x.baseVal.value:0)||0;
      const y=(use.y&&use.y.baseVal?use.y.baseVal.value:0)||0;
      const outer=document.createElementNS(SVGNS,'g');
      const useTf=use.getAttribute('transform')||'';
      outer.setAttribute('transform',(useTf+` translate(${x},${y})`).trim());
      outer.appendChild(content);
      use.replaceWith(outer);
    }
  }
}

async function extractSvgGeometry(source){
  const text=await source.file.text();
  const svgDoc=new DOMParser().parseFromString(text,'image/svg+xml');
  const svgRoot=svgDoc.documentElement;
  if(!svgRoot||svgRoot.nodeName!=='svg'||svgDoc.querySelector('parsererror')){
    throw new Error('SVG inválido o con errores de parseo');
  }

  const scale=svgDpiScale(source.dpi); // mismo factor que renderSvgToCanvas
  const cssW=source.naturalWidth/scale,cssH=source.naturalHeight/scale;

  const container=document.createElement('div');
  container.style.cssText=`position:fixed;left:0;top:0;width:${cssW}px;height:${cssH}px;visibility:hidden;pointer-events:none;z-index:-1;overflow:hidden;`;
  document.body.appendChild(container);

  const elements=[];
  try{
    const mounted=document.importNode(svgRoot,true);
    mounted.setAttribute('width','100%');
    mounted.setAttribute('height','100%');
    container.appendChild(mounted);
    vgResolveUseElements(mounted);

    const nodes=Array.from(mounted.querySelectorAll('path,rect,circle,ellipse,polygon,polyline,line'))
      .filter(el=>!el.closest('defs,symbol,clipPath,mask,pattern'));

    let nextId=0;
    for(const el of nodes){
      try{
        const shapeEl=buildSvgElement(el,nextId,scale);
        if(shapeEl){elements.push(shapeEl);nextId++;}
      }catch(e){/* elemento puntual con geometría degenerada — se ignora, no bloquea el resto */}
    }
  }finally{
    container.remove();
  }
  return elements;
}

function buildSvgElement(el,id,scale){
  const ctm=el.getScreenCTM();
  if(!ctm)return null;
  const tag=el.tagName.toLowerCase();
  const tf=(x,y)=>{
    const p=new DOMPoint(x,y).matrixTransform(ctm);
    return[p.x*scale,p.y*scale];
  };

  let pts=null,isClosed=false,subBuild=null;
  if(tag==='path'){
    const dAttr=(el.getAttribute('d')||'').trim();
    if(!dAttr)return null;
    // Un <path> puede traer varios subpaths (M...Z M...Z...) — típico de
    // texto trazado y de letras con agujero ("O","A","e"). Medir cada
    // subpath por separado evita conectar el final de uno con el inicio del
    // siguiente con una línea recta espuria.
    const rawSubs=dAttr.match(/[Mm][^Mm]*/g)||[dAttr];
    const tmp=document.createElementNS('http://www.w3.org/2000/svg','path');
    el.parentNode.insertBefore(tmp,el);
    subBuild=[];
    for(const subD of rawSubs){
      tmp.setAttribute('d',subD);
      let len=0;
      try{len=tmp.getTotalLength();}catch(e){len=0;}
      if(!(len>0))continue;
      const N=Math.max(8,Math.min(64,Math.round(len/3)));
      const localPts=[];
      for(let i=0;i<=N;i++){
        const lp=tmp.getPointAtLength(len*i/N);
        localPts.push(tf(lp.x,lp.y));
      }
      const subClosed=/[Zz]\s*$/.test(subD)||Math.hypot(localPts[0][0]-localPts[localPts.length-1][0],localPts[0][1]-localPts[localPts.length-1][1])<0.5;
      subBuild.push({pts:localPts,isClosed:subClosed});
    }
    tmp.remove();
    if(!subBuild.length)return null;
    pts=subBuild.flatMap(sp=>sp.pts);
    isClosed=subBuild.every(sp=>sp.isClosed);
  }else if(tag==='rect'){
    const x=parseFloat(el.getAttribute('x'))||0,y=parseFloat(el.getAttribute('y'))||0;
    const w=parseFloat(el.getAttribute('width'))||0,h=parseFloat(el.getAttribute('height'))||0;
    if(w<=0||h<=0)return null;
    pts=[tf(x,y),tf(x+w,y),tf(x+w,y+h),tf(x,y+h),tf(x,y)];
    isClosed=true;
  }else if(tag==='circle'||tag==='ellipse'){
    const cx=parseFloat(el.getAttribute('cx'))||0,cy=parseFloat(el.getAttribute('cy'))||0;
    const rx=tag==='circle'?(parseFloat(el.getAttribute('r'))||0):(parseFloat(el.getAttribute('rx'))||0);
    const ry=tag==='circle'?rx:(parseFloat(el.getAttribute('ry'))||0);
    if(rx<=0||ry<=0)return null;
    const N=32;
    pts=[];
    for(let i=0;i<=N;i++){
      const a=i/N*Math.PI*2;
      pts.push(tf(cx+rx*Math.cos(a),cy+ry*Math.sin(a)));
    }
    isClosed=true;
  }else if(tag==='polygon'||tag==='polyline'){
    const raw=(el.getAttribute('points')||'').trim().split(/[\s,]+/).filter(Boolean).map(Number);
    pts=[];
    for(let i=0;i+1<raw.length;i+=2)pts.push(tf(raw[i],raw[i+1]));
    if(pts.length<2)return null;
    isClosed=tag==='polygon';
    if(isClosed)pts.push(pts[0]);
  }else if(tag==='line'){
    const x1=parseFloat(el.getAttribute('x1'))||0,y1=parseFloat(el.getAttribute('y1'))||0;
    const x2=parseFloat(el.getAttribute('x2'))||0,y2=parseFloat(el.getAttribute('y2'))||0;
    pts=[tf(x1,y1),tf(x2,y2)];
    isClosed=false;
  }else{
    return null;
  }
  if(!pts||pts.length<2)return null;

  const bbox=boundsOfPoints(pts);
  if(bbox.w<=0&&bbox.h<=0)return null;

  const multi=!!(subBuild&&subBuild.length>1);
  const d=multi?subBuild.map(sp=>pointsToPathD(sp.pts,sp.isClosed)).join(''):pointsToPathD(pts,isClosed);
  const{angles,segLengths}=multi?computeMultiSubpathSignatureData(subBuild):computePolylineSignatureData(pts,isClosed);
  const nodeCount=multi?subBuild.reduce((s,sp)=>s+sp.pts.length-(sp.isClosed?1:0),0):pts.length-(isClosed?1:0);
  const result={
    id,kind:'svg',bbox,
    center:{x:bbox.x+bbox.w/2,y:bbox.y+bbox.h/2},
    nodeCount,isClosed,
    angles,segLengths,
    aspectRatio:bbox.h>0?bbox.w/bbox.h:0,
    isLikelyOutlinedText:false,isRealText:false,
    d,pts
  };
  if(multi)result.subpaths=subBuild.map(sp=>({bbox:boundsOfPoints(sp.pts),nodeCount:sp.pts.length-(sp.isClosed?1:0),isClosed:sp.isClosed}));
  return result;
}

function boundsOfPoints(pts){
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const[px,py]of pts){
    if(px<minX)minX=px;if(px>maxX)maxX=px;
    if(py<minY)minY=py;if(py>maxY)maxY=py;
  }
  return{x:minX,y:minY,w:maxX-minX,h:maxY-minY};
}

function pointsToPathD(pts,isClosed){
  let d=`M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)} `;
  for(let i=1;i<pts.length;i++)d+=`L ${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)} `;
  if(isClosed)d+='Z ';
  return d;
}

// ---- extracción PDF/.ai ------------------------------------------------
// Puerto a producción del bucle validado en el diagnóstico Fase 1
// (getOperatorList + pila CTM + mapeo por viewport.transform). Reutiliza
// `loadPdfJs()`, ya definida en pdf-source.js — mismo build vendido, sin
// duplicar carga de PDF.js (la función existe en window aunque este script
// se cargue antes: solo se invoca cuando el usuario abre el picker, mucho
// después de que todos los <script> ya se hayan ejecutado).

async function extractPdfGeometry(pdfDoc,pageNum,viewport,opts){
  const{onProgress,signal}=opts||{};
  const lib=await loadPdfJs();
  const OPS=lib.OPS,Util=lib.Util;
  const page=await pdfDoc.getPage(pageNum);
  const opList=await page.getOperatorList();
  const{fnArray,argsArray}=opList;

  const IDENTITY=[1,0,0,1,0,0];
  let ctm=IDENTITY;
  const stack=[];
  let inText=false;
  let nextId=0;
  const elements=[];

  function combinedMatrix(){return Util.transform(viewport.transform,ctm);}
  function mapPt(x,y){return Util.applyTransform([x,y],combinedMatrix());}

  function finishSubpath(pts,isTextFlag){
    if(!pts||pts.length<2)return;
    const isClosed=pts.length>2&&Math.hypot(pts[0][0]-pts[pts.length-1][0],pts[0][1]-pts[pts.length-1][1])<0.01;
    const bbox=boundsOfPoints(pts);
    if(bbox.w<=0&&bbox.h<=0)return;
    const{angles,segLengths}=computePolylineSignatureData(pts,isClosed);
    elements.push({
      id:nextId++,kind:'pdf-path',bbox,
      center:{x:bbox.x+bbox.w/2,y:bbox.y+bbox.h/2},
      nodeCount:pts.length-(isClosed?1:0),isClosed,
      angles,segLengths,
      aspectRatio:bbox.h>0?bbox.w/bbox.h:0,
      isLikelyOutlinedText:false,isRealText:!!isTextFlag,
      d:pointsToPathD(pts,isClosed),pts
    });
  }

  for(let i=0;i<fnArray.length;i++){
    if(signal&&signal.aborted){const err=new Error('cancelado');err.aborted=true;throw err;}
    const fn=fnArray[i],args=argsArray[i];
    if(fn===OPS.save){
      stack.push(ctm);
    }else if(fn===OPS.restore){
      ctm=stack.length?stack.pop():IDENTITY;
    }else if(fn===OPS.transform){
      ctm=Util.transform(ctm,args);
    }else if(fn===OPS.beginText){
      inText=true;
    }else if(fn===OPS.endText){
      inText=false;
    }else if(fn===OPS.constructPath){
      const[ops,coords]=args;
      let j=0,curPts=null;
      for(let k=0;k<ops.length;k++){
        const op=ops[k];
        if(op===OPS.moveTo){
          if(curPts)finishSubpath(curPts,inText);
          const x=coords[j++],y=coords[j++];
          curPts=[mapPt(x,y)];
        }else if(op===OPS.lineTo){
          const x=coords[j++],y=coords[j++];
          if(curPts)curPts.push(mapPt(x,y));
        }else if(op===OPS.curveTo){
          j+=4; // x1,y1,x2,y2 — puntos de control, no cuentan como nodo
          const x=coords[j++],y=coords[j++];
          if(curPts)curPts.push(mapPt(x,y));
        }else if(op===OPS.curveTo2){ // 'v': ctrl1 = punto actual
          j+=2; // x2,y2
          const x=coords[j++],y=coords[j++];
          if(curPts)curPts.push(mapPt(x,y));
        }else if(op===OPS.curveTo3){ // 'y': ctrl2 = punto final
          j+=2; // x1,y1
          const x=coords[j++],y=coords[j++];
          if(curPts)curPts.push(mapPt(x,y));
        }else if(op===OPS.closePath){
          if(curPts&&curPts.length)curPts.push(curPts[0]);
        }else if(op===OPS.rectangle){
          if(curPts)finishSubpath(curPts,inText);
          const rx=coords[j++],ry=coords[j++],rw=coords[j++],rh=coords[j++];
          finishSubpath([mapPt(rx,ry),mapPt(rx+rw,ry),mapPt(rx+rw,ry+rh),mapPt(rx,ry+rh),mapPt(rx,ry)],inText);
          curPts=null;
        }
      }
      if(curPts)finishSubpath(curPts,inText);
    }
    if(onProgress&&i>0&&i%20000===0){
      onProgress({done:i,total:fnArray.length});
      await new Promise(r=>setTimeout(r,0));
    }
  }
  if(onProgress)onProgress({done:fnArray.length,total:fnArray.length});
  return elements;
}

// ---- heurística "texto trazado" ----------------------------------------
// Señal de clúster (fila de elementos pequeños de altura similar), no de
// forma individual — un contorno de letra aislado es indistinguible de
// cualquier otro trazado pequeño. Aproximada por diseño: el toggle "incluir
// texto trazado" del picker es el escape hatch cuando se equivoca.

function classifyOutlinedText(elements,dpi){
  const scale=svgDpiScale(dpi);
  const minH=2*scale,maxH=40*scale; // ~2-40px a 96dpi, escalado al dpi de render actual
  // Un <path> con varios subpaths (letra con agujero, o una palabra/línea
  // entera exportada como un solo trazado) aporta un item por subpath, para
  // que la heurística de "fila de ≥3 glifos" siga disparando aunque el
  // exportador haya agrupado varios glifos en un único elemento.
  const items=[];
  for(const el of elements){
    if(el.subpaths&&el.subpaths.length>1){
      for(const sp of el.subpaths){
        items.push({center:{x:sp.bbox.x+sp.bbox.w/2,y:sp.bbox.y+sp.bbox.h/2},bbox:sp.bbox,parentEl:el});
      }
    }else{
      items.push({center:el.center,bbox:el.bbox,parentEl:el});
    }
  }
  const rows=[];
  const sorted=items.slice().sort((a,b)=>a.center.y-b.center.y);
  for(const item of sorted){
    let row=rows.find(r=>Math.abs(r.avgY-item.center.y)<r.avgH*1.5+2);
    if(!row){row={items:[],avgY:item.center.y,avgH:item.bbox.h||1};rows.push(row);}
    row.items.push(item);
    row.avgY=row.items.reduce((s,it)=>s+it.center.y,0)/row.items.length;
    row.avgH=row.items.reduce((s,it)=>s+it.bbox.h,0)/row.items.length;
  }
  let filtered=0;
  const marked=new Set();
  for(const row of rows){
    if(row.items.length<3)continue;
    const heights=row.items.map(it=>it.bbox.h);
    const mean=heights.reduce((a,b)=>a+b,0)/heights.length;
    if(mean<minH||mean>maxH)continue;
    const variance=heights.reduce((a,h)=>a+(h-mean)*(h-mean),0)/heights.length;
    const cv=mean>0?Math.sqrt(variance)/mean:1;
    if(cv>=0.25)continue;
    for(const it of row.items){
      if(!marked.has(it.parentEl)){marked.add(it.parentEl);it.parentEl.isLikelyOutlinedText=true;filtered++;}
    }
  }
  return{filtered,total:elements.length};
}

// ---- índice espacial (grid) para hit-testing sin recorrer todos los trazados
// Volumen real medido en el diagnóstico Fase 1: ~500 elementos/página,
// 25ms de extracción total — un grid uniforme es sobrado, no hace falta
// quadtree.

function buildSpatialIndex(elements,canvasW,canvasH){
  const CELL=64;
  const cols=Math.max(1,Math.ceil(canvasW/CELL));
  const rows=Math.max(1,Math.ceil(canvasH/CELL));
  const cells=new Map();
  elements.forEach((el,idx)=>{
    const x0=Math.max(0,Math.floor(el.bbox.x/CELL));
    const y0=Math.max(0,Math.floor(el.bbox.y/CELL));
    const x1=Math.min(cols-1,Math.floor((el.bbox.x+el.bbox.w)/CELL));
    const y1=Math.min(rows-1,Math.floor((el.bbox.y+el.bbox.h)/CELL));
    for(let cy=y0;cy<=y1;cy++){
      for(let cx=x0;cx<=x1;cx++){
        const k=cx+','+cy;
        if(!cells.has(k))cells.set(k,[]);
        cells.get(k).push(idx);
      }
    }
  });
  return{elements,cellSize:CELL,cols,rows,cells};
}

let _hitTestCtx=null;
function getHitTestCtx(){
  if(!_hitTestCtx)_hitTestCtx=document.createElement('canvas').getContext('2d');
  return _hitTestCtx;
}

function pointInElement(el,x,y){
  if(el._path2d===undefined){
    try{el._path2d=new Path2D(el.d);}catch(e){el._path2d=null;}
  }
  if(!el._path2d)return true; // 'd' degenerado (p.ej. una línea): ya pasó el filtro de bbox
  const ctx=getHitTestCtx();
  if(ctx.isPointInPath(el._path2d,x,y))return true;
  ctx.lineWidth=6; // margen generoso para trazados finos o líneas abiertas
  return ctx.isPointInStroke(el._path2d,x,y);
}

// Devuelve los elementos bajo (x,y), más pequeño (más "profundo") primero —
// para que el ciclo Alt+rueda del picker tenga un orden estable.
function hitTestPoint(index,x,y,includeOutlinedText){
  const cx=Math.floor(x/index.cellSize),cy=Math.floor(y/index.cellSize);
  const idxs=index.cells.get(cx+','+cy);
  if(!idxs||!idxs.length)return[];
  const seen=new Set(),hits=[];
  for(const i of idxs){
    if(seen.has(i))continue;
    seen.add(i);
    const el=index.elements[i];
    if(!includeOutlinedText&&el.isLikelyOutlinedText)continue;
    if(x<el.bbox.x||x>el.bbox.x+el.bbox.w||y<el.bbox.y||y>el.bbox.y+el.bbox.h)continue;
    if(!pointInElement(el,x,y))continue;
    hits.push(el);
  }
  hits.sort((a,b)=>(a.bbox.w*a.bbox.h)-(b.bbox.w*b.bbox.h));
  return hits;
}

// ---- punto de entrada único: extracción + índice, cacheado por fuente -----

async function buildVectorIndex(source,opts){
  const{onProgress,signal}=opts||{};
  const cacheKey=`${source.dpi}|${source.pageNum||1}`;
  if(source._vectorIndex&&source._vectorIndex.cacheKey===cacheKey){
    if(onProgress)onProgress({done:1,total:1});
    return source._vectorIndex;
  }
  let elements;
  if(source.sourceType==='svg'){
    elements=await extractSvgGeometry(source);
    if(onProgress)onProgress({done:1,total:1});
  }else if(source.sourceType==='pdf'||source.sourceType==='ai'){
    elements=await extractPdfGeometry(source.pdfDoc,source.pageNum,source.viewport,{onProgress,signal});
  }else{
    throw new Error('Esta fuente no tiene geometría vectorial disponible.');
  }
  const textStats=classifyOutlinedText(elements,source.dpi);
  const spatialIndex=buildSpatialIndex(elements,source.naturalWidth,source.naturalHeight);
  const index={elements,spatialIndex,stats:{total:elements.length,filteredText:textStats.filtered},cacheKey};
  source._vectorIndex=index;
  return index;
}

// ---- Fase 3 — transformación con 1 elemento por archivo -------------------
// Con 2 elementos se reutiliza computeSimilarityTransform (similarity.js) tal
// cual, sin ninguna función nueva.

function computeSingleElementTransform(elA,elB,anchorA,anchorB){
  const scaleX=elA.bbox.w/elB.bbox.w,scaleY=elA.bbox.h/elB.bbox.h;
  const scale=(scaleX+scaleY)/2;
  const offset={dx:Math.round(anchorA.x-anchorB.x),dy:Math.round(anchorA.y-anchorB.y)};
  const skewRatio=Math.max(scaleX,scaleY)/Math.max(Math.min(scaleX,scaleY),1e-6);
  const warnings=[];
  if(skewRatio-1>0.02)warnings.push('Las proporciones horizontal/vertical difieren más de un 2% — puede haber un giro que un solo elemento no puede deducir. Selecciona un segundo elemento para calcular el giro.');
  return{scale,thetaDeg:0,offset,warnings};
}
