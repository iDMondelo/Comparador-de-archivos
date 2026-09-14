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

function pxToMm(px,dpi,userUnit){
  return px/(dpi||300)*25.4*(userUnit||1);
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
// Reutiliza `loadPdfJs()`, ya definida en pdf-source.js — mismo build
// vendido, sin duplicar carga de PDF.js (la función existe en window aunque
// este script se cargue antes: solo se invoca cuando el usuario abre el
// picker, mucho después de que todos los <script> ya se hayan ejecutado).
//
// Generalidad exigida (ver encargo de corrección): MediaBox con origen
// distinto de (0,0), CropBox≠MediaBox, /Rotate, UserUnit, Form XObjects
// anidados con matriz/BBox propios, curvas Bézier reales, recorte (W n) que
// no debe generar elementos, y texto vivo indexable. Todo pasa por la MISMA
// combinedMatrix()/mapPt() que ya usa el render (viewport.transform × CTM
// acumulada) — ninguna otra función convierte coordenadas por su cuenta.

function unionBBox(a,b){
  if(!a)return{x:b.x,y:b.y,w:b.w,h:b.h};
  const x0=Math.min(a.x,b.x),y0=Math.min(a.y,b.y);
  const x1=Math.max(a.x+a.w,b.x+b.w),y1=Math.max(a.y+a.h,b.y+b.h);
  return{x:x0,y:y0,w:x1-x0,h:y1-y0};
}
function bboxIntersects(a,b){
  return a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;
}
function bboxIntersection(a,b){
  const x0=Math.max(a.x,b.x),y0=Math.max(a.y,b.y);
  const x1=Math.min(a.x+a.w,b.x+b.w),y1=Math.min(a.y+a.h,b.y+b.h);
  if(x1<=x0||y1<=y0)return{x:x0,y:y0,w:0,h:0};
  return{x:x0,y:y0,w:x1-x0,h:y1-y0};
}

function segsToPathD(segs){
  let d='';
  for(const s of segs){
    if(s.t==='M')d+=`M ${s.p[0].toFixed(2)} ${s.p[1].toFixed(2)} `;
    else if(s.t==='L')d+=`L ${s.p[0].toFixed(2)} ${s.p[1].toFixed(2)} `;
    else if(s.t==='C')d+=`C ${s.c1[0].toFixed(2)} ${s.c1[1].toFixed(2)} ${s.c2[0].toFixed(2)} ${s.c2[1].toFixed(2)} ${s.p[0].toFixed(2)} ${s.p[1].toFixed(2)} `;
  }
  return d;
}

// ---- acumulador de subtrazado (geometría PDF ya mapeada a espacio de render)
// `anchors` son solo los nodos reales (finales de segmento: moveTo/lineTo/
// curva/rect) — igual que antes, para no romper nodeCount ni el firmado por
// forma. `segs` guarda además los puntos de control de cada curva, solo para
// poder construir el Path2D/`d` real y una caja que los contenga.

function newSubpathAccum(x,y){
  return{anchors:[[x,y]],segs:[{t:'M',p:[x,y]}],minX:x,maxX:x,minY:y,maxY:y};
}
function accumBBox(acc,x,y){
  if(x<acc.minX)acc.minX=x;if(x>acc.maxX)acc.maxX=x;
  if(y<acc.minY)acc.minY=y;if(y>acc.maxY)acc.maxY=y;
}
function accumLine(acc,p){
  acc.anchors.push(p);acc.segs.push({t:'L',p});
  accumBBox(acc,p[0],p[1]);
}
function accumCurve(acc,c1,c2,p){
  acc.anchors.push(p);acc.segs.push({t:'C',c1,c2,p});
  accumBBox(acc,c1[0],c1[1]);accumBBox(acc,c2[0],c2[1]);accumBBox(acc,p[0],p[1]);
}
function accumClose(acc){
  if(!acc||!acc.anchors.length)return;
  const p0=acc.anchors[0],last=acc.anchors[acc.anchors.length-1];
  if(Math.hypot(p0[0]-last[0],p0[1]-last[1])>1e-6){
    acc.anchors.push(p0);acc.segs.push({t:'L',p:p0});
  }
  acc.forceClosed=true;
}
function finalizeSubpath(acc){
  const first=acc.anchors[0],last=acc.anchors[acc.anchors.length-1];
  const isClosed=!!acc.forceClosed||(acc.anchors.length>2&&Math.hypot(first[0]-last[0],first[1]-last[1])<0.01);
  return{pts:acc.anchors,segs:acc.segs,isClosed,bbox:{x:acc.minX,y:acc.minY,w:acc.maxX-acc.minX,h:acc.maxY-acc.minY}};
}
function pushFinalizedSubpath(list,acc){
  if(!acc||acc.anchors.length<2)return;
  const sp=finalizeSubpath(acc);
  if(sp.bbox.w<=0&&sp.bbox.h<=0)return;
  list.push(sp);
}
// Cierre implícito de los operadores "close+paint" (s/b/b*): si el stream no
// trajo un `h` explícito, la pintura igual cierra el subtrazado.
function forceCloseSubpath(sp){
  if(sp.isClosed)return;
  const p0=sp.pts[0];
  sp.pts.push(p0);sp.segs.push({t:'L',p:p0});
  sp.isClosed=true;
}

// Un elemento PDF puede agrupar varios subtrazados (letra con agujero, un
// `Do` que dibuja de una vez toda una palabra) — mismo patrón que ya usa
// buildSvgElement, para que ambos lados indexen "un path = un elemento".
function buildPdfElement(id,subpaths,isTextFlag){
  const multi=subpaths.length>1;
  const pts=multi?subpaths.flatMap(sp=>sp.pts):subpaths[0].pts;
  const isClosedAll=multi?subpaths.every(sp=>sp.isClosed):subpaths[0].isClosed;
  let bbox=null;
  for(const sp of subpaths)bbox=unionBBox(bbox,sp.bbox);
  const d=subpaths.map(sp=>segsToPathD(sp.segs)+(sp.isClosed?'Z ':'')).join('');
  const{angles,segLengths}=multi?computeMultiSubpathSignatureData(subpaths):computePolylineSignatureData(pts,isClosedAll);
  const nodeCount=multi?subpaths.reduce((s,sp)=>s+sp.pts.length-(sp.isClosed?1:0),0):pts.length-(isClosedAll?1:0);
  const result={
    id,kind:'pdf-path',bbox,
    center:{x:bbox.x+bbox.w/2,y:bbox.y+bbox.h/2},
    nodeCount,isClosed:isClosedAll,
    angles,segLengths,
    aspectRatio:bbox.h>0?bbox.w/bbox.h:0,
    isLikelyOutlinedText:false,isRealText:!!isTextFlag,
    d,pts
  };
  if(multi)result.subpaths=subpaths.map(sp=>({bbox:sp.bbox,nodeCount:sp.pts.length-(sp.isClosed?1:0),isClosed:sp.isClosed}));
  return result;
}

async function extractPdfGeometry(pdfDoc,pageNum,viewport,opts){
  const{onProgress,signal}=opts||{};
  const lib=await loadPdfJs();
  const OPS=lib.OPS,Util=lib.Util;
  const page=await pdfDoc.getPage(pageNum);
  const opList=await page.getOperatorList();
  const{fnArray,argsArray}=opList;

  const PAINT_OPS=new Set([OPS.stroke,OPS.closeStroke,OPS.fill,OPS.eoFill,OPS.fillStroke,OPS.eoFillStroke,OPS.closeFillStroke,OPS.closeEOFillStroke]);
  const CLOSE_IMPLIED_OPS=new Set([OPS.closeStroke,OPS.closeFillStroke,OPS.closeEOFillStroke]);

  const IDENTITY=[1,0,0,1,0,0];
  let ctm=IDENTITY;
  let clip=null; // bbox activo en espacio de render, o null = sin recorte
  const stack=[]; // {ctm,clip} — compartida por q/Q y por los Form XObject (misma semántica de anidamiento)
  let inText=false;
  let nextId=0;
  let xObjectCount=0,paintOpCount=0,clipDiscardedCount=0;
  const elements=[];
  let pendingPath=null,pendingClipBBox=null;

  function combinedMatrix(){return Util.transform(viewport.transform,ctm);}
  function mapPt(x,y){return Util.applyTransform([x,y],combinedMatrix());}

  // Un elemento solo se crea cuando el path efectivamente se pinta
  // (fill/stroke/fillStroke y variantes). `W n` (recorte sin pintado) o `n`
  // suelto no generan elemento — pero si hubo `clip`/`eoClip` pendiente, su
  // caja sí se registra como recorte activo para descartar geometría
  // posterior que quede fuera.
  function commitPending(fn,isPaint){
    if(pendingPath){
      if(isPaint&&CLOSE_IMPLIED_OPS.has(fn)){
        const subs=pendingPath.subpaths;
        if(subs.length)forceCloseSubpath(subs[subs.length-1]);
      }
      if(isPaint&&pendingPath.subpaths.length){
        const el=buildPdfElement(nextId,pendingPath.subpaths,pendingPath.isText);
        if(!clip||bboxIntersects(el.bbox,clip)){elements.push(el);nextId++;}
        else clipDiscardedCount++;
      }
    }
    if(pendingClipBBox){
      clip=clip?bboxIntersection(clip,pendingClipBBox):pendingClipBBox;
      pendingClipBBox=null;
    }
    pendingPath=null;
  }

  for(let i=0;i<fnArray.length;i++){
    if(signal&&signal.aborted){const err=new Error('cancelado');err.aborted=true;throw err;}
    const fn=fnArray[i],args=argsArray[i];
    if(fn===OPS.save){
      stack.push({ctm,clip});
    }else if(fn===OPS.restore){
      const top=stack.length?stack.pop():{ctm:IDENTITY,clip:null};
      ctm=top.ctm;clip=top.clip;
    }else if(fn===OPS.transform){
      ctm=Util.transform(ctm,args);
    }else if(fn===OPS.paintFormXObjectBegin){
      // args=[matrix,bbox] (bbox puede venir null si el XObject define Group) —
      // sin esto, cualquier trazado dentro de un Form con Matrix propia queda
      // desplazado exactamente esa transformación (causa raíz del bug de
      // geometría desplazada).
      xObjectCount++;
      stack.push({ctm,clip});
      const matrix=args&&args[0],bbox=args&&args[1];
      if(matrix)ctm=Util.transform(ctm,matrix);
      if(bbox){
        const[bx0,by0,bx1,by1]=bbox;
        const formClip=boundsOfPoints([mapPt(bx0,by0),mapPt(bx1,by0),mapPt(bx1,by1),mapPt(bx0,by1)]);
        clip=clip?bboxIntersection(clip,formClip):formClip;
      }
    }else if(fn===OPS.paintFormXObjectEnd){
      const top=stack.length?stack.pop():{ctm:IDENTITY,clip:null};
      ctm=top.ctm;clip=top.clip;
    }else if(fn===OPS.beginText){
      inText=true;
    }else if(fn===OPS.endText){
      inText=false;
    }else if(fn===OPS.constructPath){
      const[ops,coords]=args;
      let j=0,acc=null;
      if(!pendingPath)pendingPath={subpaths:[],isText:inText};
      const subpaths=pendingPath.subpaths;
      for(let k=0;k<ops.length;k++){
        const op=ops[k];
        if(op===OPS.moveTo){
          if(acc)pushFinalizedSubpath(subpaths,acc);
          const x=coords[j++],y=coords[j++];
          const p=mapPt(x,y);
          acc=newSubpathAccum(p[0],p[1]);
        }else if(op===OPS.lineTo){
          const x=coords[j++],y=coords[j++];
          if(acc)accumLine(acc,mapPt(x,y));
        }else if(op===OPS.curveTo){ // 'c': x1 y1 x2 y2 x3 y3 — curva completa
          const c1=mapPt(coords[j],coords[j+1]);j+=2;
          const c2=mapPt(coords[j],coords[j+1]);j+=2;
          const p=mapPt(coords[j],coords[j+1]);j+=2;
          if(acc)accumCurve(acc,c1,c2,p);
        }else if(op===OPS.curveTo2){ // 'v': ctrl1 implícito = punto actual
          const c2=mapPt(coords[j],coords[j+1]);j+=2;
          const p=mapPt(coords[j],coords[j+1]);j+=2;
          if(acc)accumCurve(acc,acc.anchors[acc.anchors.length-1],c2,p);
        }else if(op===OPS.curveTo3){ // 'y': ctrl2 implícito = punto final
          const c1=mapPt(coords[j],coords[j+1]);j+=2;
          const p=mapPt(coords[j],coords[j+1]);j+=2;
          if(acc)accumCurve(acc,c1,p,p);
        }else if(op===OPS.closePath){
          if(acc)accumClose(acc);
        }else if(op===OPS.rectangle){
          if(acc){pushFinalizedSubpath(subpaths,acc);acc=null;}
          const rx=coords[j++],ry=coords[j++],rw=coords[j++],rh=coords[j++];
          const p1=mapPt(rx,ry),p2=mapPt(rx+rw,ry),p3=mapPt(rx+rw,ry+rh),p4=mapPt(rx,ry+rh);
          const racc=newSubpathAccum(p1[0],p1[1]);
          accumLine(racc,p2);accumLine(racc,p3);accumLine(racc,p4);accumClose(racc);
          pushFinalizedSubpath(subpaths,racc);
        }
      }
      if(acc)pushFinalizedSubpath(subpaths,acc);
    }else if(fn===OPS.clip||fn===OPS.eoClip){
      if(pendingPath&&pendingPath.subpaths.length){
        let u=null;
        for(const sp of pendingPath.subpaths)u=unionBBox(u,sp.bbox);
        pendingClipBBox=u;
      }
    }else if(PAINT_OPS.has(fn)){
      paintOpCount++;
      commitPending(fn,true);
    }else if(fn===OPS.endPath){
      commitPending(fn,false);
    }
    if(onProgress&&i>0&&i%20000===0){
      onProgress({done:i,total:fnArray.length});
      await new Promise(r=>setTimeout(r,0));
    }
  }
  if(onProgress)onProgress({done:fnArray.length,total:fnArray.length});
  return{
    elements,
    stats:{xObjectCount,paintOpCount,clipDiscardedCount,rotate:page.rotate,userUnit:page.userUnit,pageNumber:page.pageNumber}
  };
}

// ---- texto vivo (BT/ET + showText) como elemento indexable ----------------
// Se apoya en page.getTextContent() (API pública de pdf.js, ya resuelve
// fuentes/anchos) en vez de reimplementar Tm/Td/TJ a mano. Cada item trae su
// propia `transform`; se combina con viewport.transform con el MISMO patrón
// que combinedMatrix() usa para los trazados (documentado así en el propio
// TextLayer de pdf.js). Limitación conocida: getTextContent() no acumula la
// matriz de los Form XObject, así que texto vivo dentro de un XObject con
// Matrix propia puede no coincidir exactamente con el render — a verificar
// con un archivo real que tenga XObjects anidados con texto dentro.
async function extractPdfLiveText(pdfDoc,pageNum,viewport,opts){
  const{signal}=opts||{};
  const lib=await loadPdfJs();
  const Util=lib.Util;
  const page=await pdfDoc.getPage(pageNum);
  const textContent=await page.getTextContent();
  const elements=[];
  let nextId=0;
  for(const item of textContent.items){
    if(signal&&signal.aborted){const err=new Error('cancelado');err.aborted=true;throw err;}
    if(!item.str||!item.str.trim())continue;
    if(!item.width||item.width<=0)continue;
    const tx=Util.transform(viewport.transform,item.transform);
    const fontHeight=Math.hypot(tx[2],tx[3]);
    if(fontHeight<=0)continue;
    const ascent=fontHeight*0.8,descent=fontHeight*0.2;
    const p0=Util.applyTransform([0,0],tx);
    const p1=Util.applyTransform([item.width,0],tx);
    const up=[tx[2]/fontHeight*ascent,tx[3]/fontHeight*ascent];
    const down=[-tx[2]/fontHeight*descent,-tx[3]/fontHeight*descent];
    const corners=[
      [p0[0]+up[0],p0[1]+up[1]],
      [p1[0]+up[0],p1[1]+up[1]],
      [p1[0]+down[0],p1[1]+down[1]],
      [p0[0]+down[0],p0[1]+down[1]]
    ];
    corners.push(corners[0]);
    const bbox=boundsOfPoints(corners);
    if(bbox.w<=0&&bbox.h<=0)continue;
    const{angles,segLengths}=computePolylineSignatureData(corners,true);
    elements.push({
      id:nextId++,kind:'pdf-text',bbox,
      center:{x:bbox.x+bbox.w/2,y:bbox.y+bbox.h/2},
      nodeCount:4,isClosed:true,
      angles,segLengths,
      aspectRatio:bbox.h>0?bbox.w/bbox.h:0,
      isLikelyOutlinedText:false,isRealText:true,
      d:pointsToPathD(corners,true),pts:corners,
      text:item.str
    });
  }
  return elements;
}

function logPdfIndexSummary(label,stats,filteredAsOutlinedText){
  console.group(`Índice vectorial PDF — ${label} (página ${stats.pageNumber})`);
  console.log(`rotate: ${stats.rotate}°, userUnit: ${stats.userUnit}`);
  console.log(`Form XObjects atravesados: ${stats.xObjectCount}`);
  console.log(`Operaciones de pintado: ${stats.paintOpCount}`);
  console.log(`Trazados descartados por quedar fuera del recorte activo: ${stats.clipDiscardedCount}`);
  console.log(`Elementos indexados — trazados: ${stats.pathElementCount}, texto vivo: ${stats.textElementCount}`);
  console.log(`Elementos filtrados como texto trazado: ${filteredAsOutlinedText}`);
  console.groupEnd();
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
    if(el.isRealText)continue; // texto vivo confirmado: nunca es candidato a "texto trazado"
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
  const{onProgress,signal,label}=opts||{};
  const cacheKey=`${source.dpi}|${source.pageNum||1}`;
  if(source._vectorIndex&&source._vectorIndex.cacheKey===cacheKey){
    if(onProgress)onProgress({done:1,total:1});
    return source._vectorIndex;
  }
  let elements;
  let pdfStats=null;
  if(source.sourceType==='svg'){
    elements=await extractSvgGeometry(source);
    if(onProgress)onProgress({done:1,total:1});
  }else if(source.sourceType==='pdf'||source.sourceType==='ai'){
    const pathResult=await extractPdfGeometry(source.pdfDoc,source.pageNum,source.viewport,{onProgress,signal});
    let textElements=[];
    try{
      textElements=await extractPdfLiveText(source.pdfDoc,source.pageNum,source.viewport,{signal});
    }catch(e){
      if(e&&e.aborted)throw e;
      console.warn('No se pudo extraer texto vivo del PDF:',e);
    }
    elements=pathResult.elements.concat(textElements);
    pdfStats=Object.assign({},pathResult.stats,{pathElementCount:pathResult.elements.length,textElementCount:textElements.length});
    source.userUnit=pathResult.stats.userUnit;
  }else{
    throw new Error('Esta fuente no tiene geometría vectorial disponible.');
  }
  elements.forEach((el,idx)=>{el.id=idx;}); // ids únicos tras fusionar trazados+texto
  const textStats=classifyOutlinedText(elements,source.dpi);
  const spatialIndex=buildSpatialIndex(elements,source.naturalWidth,source.naturalHeight);
  const index={elements,spatialIndex,stats:{total:elements.length,filteredText:textStats.filtered},cacheKey};
  if(pdfStats)logPdfIndexSummary(label||source.sourceType,pdfStats,textStats.filtered);
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
