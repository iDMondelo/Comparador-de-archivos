// ============================================================================
// vector-picker.js — modal de selección de elemento vectorial (tercer método
// de alineación). Capa de entrada/presentación: al confirmar, escribe en el
// MISMO estado (pointsA/pointsB, vía setPointsFromVector en align.js) que ya
// escriben los clics manuales — no introduce un almacén paralelo ni toca
// compare()/similarity.js/de-worker.js.
//
// Sin zoom/pan propio (simplificación deliberada frente al visor principal):
// el stage se ajusta a "encajar" y el resaltado real de contorno + la
// etiqueta con medidas ya dan precisión suficiente para elegir un elemento.
// ============================================================================

const VP_MATCH_CLEAR=0.90,VP_MATCH_AMBIGUOUS=0.70;

let vpIndexA=null,vpIndexB=null;
let vpHoverEls={A:[],B:[]};
let vpHoverCycleIdx={A:0,B:0};
let vpHoverKey={A:null,B:null};
let vpSelected={A:null,B:null};
let vpSelected2={A:null,B:null};
let vpAnchorMode={A:'center',B:'center'};
let vpAnchorMode2={A:'center',B:'center'};
let vpAnchorNodeIdx={A:null,B:null};
let vpAnchorNodeIdx2={A:null,B:null};
let vpNodePickActive={A:false,B:false};
let vpIncludeOutlinedText=false;
let vpDebugBoxesOn=false;
let vpActivePair=1;
let vpBuildAbortCtrl=null;
let vpOpenerTrigger=null;

const vpEl=id=>document.getElementById(id);

// ---- apertura / cierre del modal ------------------------------------------

function openVectorPicker(trigger){
  vpOpenerTrigger=trigger||null;
  vpResetPickerState();
  vpEl('vectorPickerBackdrop').classList.add('open');
  vpEl('vectorPickerClose').focus();
  document.addEventListener('keydown',vpOnKeydown);
  vpBuildIndexes();
}

function closeVectorPicker(){
  vpEl('vectorPickerBackdrop').classList.remove('open');
  document.removeEventListener('keydown',vpOnKeydown);
  if(vpBuildAbortCtrl){vpBuildAbortCtrl.abort();vpBuildAbortCtrl=null;}
  if(vpOpenerTrigger)vpOpenerTrigger.focus();
}

function vpOnKeydown(e){
  if(e.key==='Escape')closeVectorPicker();
}

function vpResetPickerState(){
  vpIndexA=null;vpIndexB=null;
  vpHoverEls={A:[],B:[]};vpHoverCycleIdx={A:0,B:0};vpHoverKey={A:null,B:null};
  vpSelected={A:null,B:null};vpSelected2={A:null,B:null};
  vpAnchorMode={A:'center',B:'center'};vpAnchorMode2={A:'center',B:'center'};
  vpAnchorNodeIdx={A:null,B:null};vpAnchorNodeIdx2={A:null,B:null};
  vpNodePickActive={A:false,B:false};
  vpActivePair=1;
  vpIncludeOutlinedText=false;
  vpEl('vpIncludeText').checked=false;
  vpDebugBoxesOn=false;
  vpEl('vpDebugBoxes').checked=false;
  ['A','B'].forEach(w=>{
    vpEl('vpOverlay'+w).innerHTML='';
    vpEl('vpAnchorChoice'+w).style.display='none';
    vpEl('vpFloatLabel'+w).style.display='none';
  });
  vpEl('vpCandidatesPanel').style.display='none';
  vpEl('vpCandidatesList').innerHTML='';
  vpEl('vpSecondElementRow').style.display='none';
  vpEl('vpVerify').style.display='none';
  vpEl('vpMatchNotice').textContent='';
  vpEl('vpConfirm').disabled=true;
  vpEl('vpFilterStats').textContent='';
}

// ---- construcción de los índices (con progreso/cancelación) ---------------

async function vpBuildIndexes(){
  const progressEl=vpEl('vpProgress'),progressText=vpEl('vpProgressText');
  progressEl.style.display='flex';
  vpBuildAbortCtrl=new AbortController();
  const signal=vpBuildAbortCtrl.signal;
  try{
    vpIndexA=await buildVectorIndex(sourceA,{signal,label:'A',onProgress:p=>{progressText.textContent=`Analizando A… ${Math.round(p.done/p.total*100)}%`;}});
    vpIndexB=await buildVectorIndex(sourceB,{signal,label:'B',onProgress:p=>{progressText.textContent=`Analizando B… ${Math.round(p.done/p.total*100)}%`;}});
  }catch(err){
    if(err&&err.aborted){closeVectorPicker();return;}
    progressEl.style.display='none';
    vpSetMatchNotice('No se pudo extraer la geometría: '+err.message);
    return;
  }
  progressEl.style.display='none';
  vpEl('vpFilterStats').textContent=`${vpIndexA.stats.total+vpIndexB.stats.total} elementos indexados · ${vpIndexA.stats.filteredText+vpIndexB.stats.filteredText} filtrados como texto trazado`;
  await vpSetupStage('A');await vpSetupStage('B');
  vpBuildDebugBoxes('A');vpBuildDebugBoxes('B');
}

// ---- modo de depuración: cajas de todos los elementos indexados -----------
// Verificación visual directa de que la geometría indexada (bbox de cada
// elemento) encaja con el render — mismo <svg viewBox> y mismo espacio de
// coordenadas natural que ya usan el highlight y el contorno persistente.

function vpBuildDebugBoxes(which){
  const overlay=vpEl('vpOverlay'+which);
  const index=which==='A'?vpIndexA:vpIndexB;
  const old=overlay.querySelector('.vp-debug-boxes');
  if(old)old.remove();
  const g=document.createElementNS('http://www.w3.org/2000/svg','g');
  g.setAttribute('class','vp-debug-boxes'+(vpDebugBoxesOn?' on':''));
  if(index){
    for(const el of index.elements){
      if(el.nodeCount===37)console.log('[diag-transform] caja de depuración',{id:el.id,bbox:el.bbox,center:el.center});
      const r=document.createElementNS('http://www.w3.org/2000/svg','rect');
      r.setAttribute('x',el.bbox.x);r.setAttribute('y',el.bbox.y);
      r.setAttribute('width',el.bbox.w);r.setAttribute('height',el.bbox.h);
      r.setAttribute('class','vp-debug-box'+(el.isLikelyOutlinedText?' text':''));
      g.appendChild(r);
    }
  }
  overlay.insertBefore(g,overlay.firstChild);
}

vpEl('vpDebugBoxes').onchange=function(){
  vpDebugBoxesOn=this.checked;
  ['A','B'].forEach(w=>{
    const g=vpEl('vpOverlay'+w).querySelector('.vp-debug-boxes');
    if(g)g.classList.toggle('on',vpDebugBoxesOn);
  });
};

vpEl('vpCancelBuild').onclick=()=>{if(vpBuildAbortCtrl)vpBuildAbortCtrl.abort();closeVectorPicker();};

// ---- montaje del stage: render atenuado + overlay SVG en coordenadas nativas
//
// Fondo del stage: llama a renderPdfPage() directamente (no reutiliza
// source.drawable) para que el selector quede alimentado por la misma
// función de render que la vista previa y la vista final — el velo blanco
// translúcido de encima es una capa de UI para resaltar el elemento, no una
// diferencia de render.

async function vpSetupStage(which){
  const source=which==='A'?sourceA:sourceB;
  const canvas=vpEl('vpCanvas'+which);
  const overlay=vpEl('vpOverlay'+which);
  const wrap=vpEl('vpStageWrap'+which);
  const rendered=await renderPdfPage(source.pdfDoc,source.pageNum,source.dpi);
  console.log('[diag-transform] vpSetupStage',{which,
    source_naturalWidth:source.naturalWidth,source_naturalHeight:source.naturalHeight,
    rendered_naturalWidth:rendered.naturalWidth,rendered_naturalHeight:rendered.naturalHeight,
    source_viewportTransform:source.viewport&&source.viewport.transform,
    rendered_viewportTransform:rendered.viewport&&rendered.viewport.transform});
  canvas.width=rendered.naturalWidth;canvas.height=rendered.naturalHeight;
  const cctx=canvas.getContext('2d');
  cctx.drawImage(rendered.drawable,0,0);
  cctx.fillStyle='rgba(255,255,255,0.55)';
  cctx.fillRect(0,0,canvas.width,canvas.height);
  const r=wrap.getBoundingClientRect();
  const scale=Math.min(r.width/source.naturalWidth,r.height/source.naturalHeight);
  const w=Math.round(source.naturalWidth*scale),h=Math.round(source.naturalHeight*scale);
  canvas.style.width=w+'px';canvas.style.height=h+'px';
  overlay.setAttribute('width',w);overlay.setAttribute('height',h);
  overlay.setAttribute('viewBox',`0 0 ${source.naturalWidth} ${source.naturalHeight}`);
  overlay.style.width=w+'px';overlay.style.height=h+'px';
}

// ---- hover: resaltado real + ciclo Alt+rueda + etiqueta flotante ----------

function vpOnHover(which,e){
  const index=which==='A'?vpIndexA:vpIndexB;
  if(!index||vpNodePickActive[which])return;
  const canvas=vpEl('vpCanvas'+which);
  const n=alignEventToNatural(e,canvas); // reutilizado de align.js
  const hits=hitTestPoint(index.spatialIndex,n.x,n.y,vpIncludeOutlinedText);
  const key=hits.map(h=>h.id).join(',');
  if(key!==vpHoverKey[which]){vpHoverKey[which]=key;vpHoverCycleIdx[which]=0;}
  vpHoverEls[which]=hits;
  vpRenderHoverHighlight(which,e);
}

function vpClearHoverHighlight(which){
  vpHoverEls[which]=[];
  vpRenderHoverHighlight(which,null);
}

function vpCycleHover(which,dir){
  const hits=vpHoverEls[which];
  if(!hits||!hits.length)return;
  vpHoverCycleIdx[which]=(vpHoverCycleIdx[which]+dir+hits.length)%hits.length;
  vpRenderHoverHighlight(which,null);
}

function vpRenderHoverHighlight(which,e){
  const overlay=vpEl('vpOverlay'+which);
  let hoverPath=overlay.querySelector('.vp-hover-path');
  const hits=vpHoverEls[which];
  const active=hits&&hits.length?hits[vpHoverCycleIdx[which]]:null;
  const label=vpEl('vpFloatLabel'+which);
  if(!active){
    if(hoverPath)hoverPath.remove();
    label.style.display='none';
    return;
  }
  if(!hoverPath){
    hoverPath=document.createElementNS('http://www.w3.org/2000/svg','path');
    hoverPath.setAttribute('class','vp-hover-path');
    overlay.appendChild(hoverPath);
  }
  hoverPath.setAttribute('d',active.d);
  const source=which==='A'?sourceA:sourceB;
  const wMm=formatEs(pxToMm(active.bbox.w,source.dpi,source.userUnit),1);
  const hMm=formatEs(pxToMm(active.bbox.h,source.dpi,source.userUnit),1);
  const kindLabel=active.isRealText?'texto vivo':(active.isLikelyOutlinedText?'texto trazado (probable)':(active.kind==='pdf-path'?'trazado PDF':'forma SVG'));
  label.textContent=`${wMm}×${hMm} mm · ${active.nodeCount} nodos · ${kindLabel}`+(hits.length>1?` · ${vpHoverCycleIdx[which]+1}/${hits.length} (Alt+rueda)`:'');
  label.style.display='block';
  if(e){
    const wrapRect=vpEl('vpStageWrap'+which).getBoundingClientRect();
    label.style.left=(e.clientX-wrapRect.left+14)+'px';
    label.style.top=(e.clientY-wrapRect.top-30)+'px';
  }
}

// ---- selección: contorno persistente + puntos notables + emparejado ------

function vpAnchorPointsSet(el){
  return{
    center:{x:el.center.x,y:el.center.y},
    tl:{x:el.bbox.x,y:el.bbox.y},
    tr:{x:el.bbox.x+el.bbox.w,y:el.bbox.y},
    bl:{x:el.bbox.x,y:el.bbox.y+el.bbox.h},
    br:{x:el.bbox.x+el.bbox.w,y:el.bbox.y+el.bbox.h}
  };
}

function vpOppositeCorner(mode){
  return{tl:'br',tr:'bl',bl:'tr',br:'tl'}[mode]||null;
}

function vpAnchorPoint(el,mode,nodeIdx){
  if(mode==='node'&&el.pts&&nodeIdx!=null&&el.pts[nodeIdx])return{x:el.pts[nodeIdx][0],y:el.pts[nodeIdx][1]};
  const pts=vpAnchorPointsSet(el);
  return pts[mode]||pts.center;
}

function vpOnClick(which,e){
  if(vpNodePickActive[which]){vpPickNearestNode(which,e);return;}
  const hits=vpHoverEls[which];
  const active=hits&&hits.length?hits[vpHoverCycleIdx[which]]:null;
  if(!active)return;
  vpSelectElement(which,active);
}

function vpSelectElement(which,el){
  const sel=vpActivePair===1?vpSelected:vpSelected2;
  const mode=vpActivePair===1?vpAnchorMode:vpAnchorMode2;
  const nodeIdx=vpActivePair===1?vpAnchorNodeIdx:vpAnchorNodeIdx2;
  sel[which]=el;mode[which]='center';nodeIdx[which]=null;
  vpNodePickActive[which]=false;
  console.log('[diag-transform] vpSelectElement',{which,id:el.id,nodeCount:el.nodeCount,bbox:el.bbox,center:el.center,
    ctm:el._dbgCtm,combinedMatrix:el._dbgCombinedMatrix,viewportTransform:el._dbgViewportTransform});
  vpDrawPersistent(which,el,vpActivePair);
  vpShowAnchorChoice(which);
  vpUpdateConfirmState();
  vpUpdateTransformSummary();
  vpRenderVerifyPreview();
  if(which==='A'){
    vpSetMatchNotice('');
    vpShowCandidates([]);
    vpRunAutoMatch();
  }
}

function vpDrawPersistent(which,el,pairNum){
  const overlay=vpEl('vpOverlay'+which);
  const cls='vp-persistent-'+pairNum;
  const old=overlay.querySelector('.'+cls);
  if(old)old.remove();
  const g=document.createElementNS('http://www.w3.org/2000/svg','g');
  g.setAttribute('class','vp-persistent '+cls);
  const path=document.createElementNS('http://www.w3.org/2000/svg','path');
  path.setAttribute('d',el.d);
  path.setAttribute('class','vp-persistent-outline'+(pairNum===2?' pair2':''));
  g.appendChild(path);
  overlay.appendChild(g);
  vpDrawAnchorMarkers(which,pairNum);
}

function vpDrawAnchorMarkers(which,pairNum){
  const overlay=vpEl('vpOverlay'+which);
  const g=overlay.querySelector('.vp-persistent-'+pairNum);
  if(!g)return;
  g.querySelectorAll('.vp-anchor-dot').forEach(n=>n.remove());
  const sel=pairNum===1?vpSelected:vpSelected2;
  const mode=pairNum===1?vpAnchorMode:vpAnchorMode2;
  const nodeIdx=pairNum===1?vpAnchorNodeIdx:vpAnchorNodeIdx2;
  const el=sel[which];
  if(!el)return;
  const r=Math.max(el.bbox.w,el.bbox.h)*0.015+3;
  const pts=vpAnchorPointsSet(el);
  Object.keys(pts).forEach(k=>{
    const p=pts[k];
    const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
    c.setAttribute('cx',p.x);c.setAttribute('cy',p.y);c.setAttribute('r',r);
    c.setAttribute('class','vp-anchor-dot'+(mode[which]===k?' active':''));
    g.appendChild(c);
  });
  if(mode[which]==='node'&&nodeIdx[which]!=null&&el.pts&&el.pts[nodeIdx[which]]){
    const p=el.pts[nodeIdx[which]];
    const c=document.createElementNS('http://www.w3.org/2000/svg','circle');
    c.setAttribute('cx',p[0]);c.setAttribute('cy',p[1]);c.setAttribute('r',r);
    c.setAttribute('class','vp-anchor-dot active');
    g.appendChild(c);
  }
}

function vpShowAnchorChoice(which){
  const row=vpEl('vpAnchorChoice'+which);
  row.style.display='flex';
  row.querySelectorAll('.vp-anchor-opt').forEach(btn=>{
    btn.onclick=()=>{
      const mode=vpActivePair===1?vpAnchorMode:vpAnchorMode2;
      const nodeIdx=vpActivePair===1?vpAnchorNodeIdx:vpAnchorNodeIdx2;
      const m=btn.dataset.anchor;
      row.querySelectorAll('.vp-anchor-opt').forEach(b=>b.classList.toggle('active',b===btn));
      if(m==='node'){
        vpNodePickActive[which]=true;
        vpSetMatchNotice('Haz clic sobre el contorno resaltado para elegir el nodo de anclaje en '+which+'.');
        return;
      }
      mode[which]=m;nodeIdx[which]=null;vpNodePickActive[which]=false;
      vpDrawAnchorMarkers(which,vpActivePair);
      vpUpdateConfirmState();
      vpUpdateTransformSummary();
      vpRenderVerifyPreview();
    };
  });
}

function vpPickNearestNode(which,e){
  const sel=vpActivePair===1?vpSelected:vpSelected2;
  const el=sel[which];
  if(!el||!el.pts)return;
  const canvas=vpEl('vpCanvas'+which);
  const n=alignEventToNatural(e,canvas);
  let bestIdx=0,bestDist=Infinity;
  el.pts.forEach((p,i)=>{
    const d=Math.hypot(p[0]-n.x,p[1]-n.y);
    if(d<bestDist){bestDist=d;bestIdx=i;}
  });
  const nodeIdx=vpActivePair===1?vpAnchorNodeIdx:vpAnchorNodeIdx2;
  const mode=vpActivePair===1?vpAnchorMode:vpAnchorMode2;
  nodeIdx[which]=bestIdx;mode[which]='node';
  vpNodePickActive[which]=false;
  vpSetMatchNotice('');
  vpDrawAnchorMarkers(which,vpActivePair);
  vpUpdateConfirmState();
  vpUpdateTransformSummary();
  vpRenderVerifyPreview();
}

// ---- emparejado automático por firma de forma ------------------------------

function vpCyclicSeqScore(seqA,seqB,period){
  if(!seqA.length||!seqB.length)return seqA.length===seqB.length?1:0;
  if(seqA.length!==seqB.length){
    const meanA=seqA.reduce((a,b)=>a+b,0)/seqA.length;
    const meanB=seqB.reduce((a,b)=>a+b,0)/seqB.length;
    return Math.max(0,1-Math.abs(meanA-meanB)/(period||1));
  }
  const n=seqA.length;
  let best=Infinity;
  for(let shift=0;shift<n;shift++){
    let sum=0;
    for(let i=0;i<n;i++){
      let diff=Math.abs(seqA[i]-seqB[(i+shift)%n]);
      if(period)diff=Math.min(diff,period-diff);
      sum+=diff*diff;
    }
    if(sum<best)best=sum;
  }
  const rms=Math.sqrt(best/n);
  const norm=period?period/4:0.5;
  return Math.max(0,1-rms/norm);
}

function vpMatchScore(elA,elB){
  const sigA=computeShapeSignature(elA),sigB=computeShapeSignature(elB);
  if(sigA.isClosed!==sigB.isClosed)return 0;
  const nodeDiff=Math.abs(sigA.nodeCount-sigB.nodeCount);
  const nodeScore=nodeDiff===0?1:(nodeDiff<=1?0.6:Math.max(0,1-nodeDiff/Math.max(sigA.nodeCount,sigB.nodeCount,1)));
  if(nodeScore<=0)return 0;
  const arA=sigA.aspectRatio||1e-6,arB=sigB.aspectRatio||1e-6;
  const arDiff=Math.abs(arA-arB)/Math.max(arA,arB);
  const arScore=Math.max(0,1-arDiff/0.2);
  if(arScore<=0)return 0;
  const angleScore=vpCyclicSeqScore(sigA.angles,sigB.angles,Math.PI*2);
  const lenScore=vpCyclicSeqScore(sigA.segLengths,sigB.segLengths,1);
  return nodeScore*0.35+arScore*0.15+angleScore*0.3+lenScore*0.2;
}

function vpRunAutoMatch(){
  const elA=vpActivePair===1?vpSelected.A:vpSelected2.A;
  if(!elA||!vpIndexB)return;
  const candidates=vpIndexB.elements
    .filter(el=>vpIncludeOutlinedText||!el.isLikelyOutlinedText)
    .map(el=>({el,score:vpMatchScore(elA,el)}))
    .filter(c=>c.score>=VP_MATCH_AMBIGUOUS)
    .sort((a,b)=>b.score-a.score);

  if(!candidates.length){
    vpSetMatchNotice('No se encontró un elemento equivalente automáticamente en B — selecciónalo a mano.');
    vpShowCandidates([]);
    return;
  }
  const best=candidates[0],second=candidates[1];
  if(best.score>=VP_MATCH_CLEAR&&(!second||best.score-second.score>0.1)){
    vpSelectElement('B',best.el);
    vpSetMatchNotice(`Elemento equivalente localizado automáticamente (coincidencia ${Math.round(best.score*100)}%)`);
    vpShowCandidates([]);
  }else{
    vpSetMatchNotice('Varios candidatos posibles en B — elige el correcto.');
    vpShowCandidates(candidates.slice(0,8));
  }
}

function vpSetMatchNotice(text){
  vpEl('vpMatchNotice').textContent=text;
}

// Reutiliza las clases .region-row/.region-badge de regions-panel.js, sin
// inventar estilos nuevos para una lista numerada de candidatos.
function vpShowCandidates(list){
  const panel=vpEl('vpCandidatesPanel'),listEl=vpEl('vpCandidatesList');
  if(!list.length){panel.style.display='none';listEl.innerHTML='';return;}
  panel.style.display='block';
  list.forEach((c,i)=>console.log('[diag-transform] candidato en lista',{idx:i,score:c.score,id:c.el.id,nodeCount:c.el.nodeCount,center:c.el.center,bbox:c.el.bbox}));
  listEl.innerHTML=list.map((c,i)=>
    `<div class="region-row" data-idx="${i}">`+
    `<span class="region-badge">${i+1}</span>`+
    `<span>${Math.round(c.score*100)}% coincidencia</span>`+
    `<span>${c.el.nodeCount} nodos</span>`+
    `<span class="region-coords">(${Math.round(c.el.center.x)}, ${Math.round(c.el.center.y)})</span>`+
    `</div>`
  ).join('');
  listEl.querySelectorAll('.region-row').forEach(row=>{
    row.onclick=()=>{
      const idx=parseInt(row.dataset.idx,10);
      vpSelectElement('B',list[idx].el);
      vpShowCandidates([]);
      vpSetMatchNotice('Candidato '+(idx+1)+' seleccionado manualmente.');
    };
  });
}

// ---- segundo elemento (opcional, escala + giro con 2 elementos) -----------

vpEl('vpAddSecondElement').onclick=()=>{
  vpActivePair=2;
  vpSelected2={A:null,B:null};
  vpAnchorMode2={A:'center',B:'center'};
  vpAnchorNodeIdx2={A:null,B:null};
  vpEl('vpAnchorChoiceA').style.display='none';
  vpEl('vpAnchorChoiceB').style.display='none';
  vpSetMatchNotice('Selecciona el segundo elemento en A — lo más alejado posible del primero.');
};

// ---- verificación antes de aplicar -----------------------------------------

function vpFinalPoints(){
  if(!vpSelected.A||!vpSelected.B)return{A1:null,B1:null,A2:null,B2:null};
  const A1=vpAnchorPoint(vpSelected.A,vpAnchorMode.A,vpAnchorNodeIdx.A);
  const B1=vpAnchorPoint(vpSelected.B,vpAnchorMode.B,vpAnchorNodeIdx.B);
  let A2=null,B2=null;
  if(vpSelected2.A&&vpSelected2.B){
    A2=vpAnchorPoint(vpSelected2.A,vpAnchorMode2.A,vpAnchorNodeIdx2.A);
    B2=vpAnchorPoint(vpSelected2.B,vpAnchorMode2.B,vpAnchorNodeIdx2.B);
  }else{
    const oppA=vpOppositeCorner(vpAnchorMode.A),oppB=vpOppositeCorner(vpAnchorMode.B);
    if(oppA&&oppB){
      A2=vpAnchorPoint(vpSelected.A,oppA,null);
      B2=vpAnchorPoint(vpSelected.B,oppB,null);
    }
  }
  return{A1,B1,A2,B2};
}

function vpUpdateTransformSummary(){
  const summaryEl=vpEl('vpTransformSummary'),warnEl=vpEl('vpTransformWarn');
  const pts=vpFinalPoints();
  if(!pts.A1||!pts.B1){summaryEl.style.display='none';warnEl.style.display='none';return;}
  // Escala bloqueada (physical-align.js): la escala/giro medidos con las
  // cajas solo se muestran como dato; la transformación real es traslación.
  if(typeof isScaleLockActive==='function'&&isScaleLockActive()){
    const t=computeLockedTransform(sourceA,sourceB,pts.A1,pts.B1,pts.A2,pts.B2);
    summaryEl.textContent=formatLockedTransform(t);
    summaryEl.style.display='block';
    if(t.warnings.length){warnEl.textContent='Aviso: '+t.warnings.join(' ');warnEl.style.display='block';}
    else warnEl.style.display='none';
    return;
  }
  if(pts.A2&&pts.B2){
    const t=computeSimilarityTransform(pts.A1,pts.A2,pts.B1,pts.B2);
    summaryEl.textContent=`Escala: ${formatEs(t.scale,3)}× · Giro: ${formatEs(t.thetaDeg,1)}° · Desplazamiento: ${formatEs(t.offset.dx,2)}, ${formatEs(t.offset.dy,2)} px`;
    summaryEl.style.display='block';
    const warns=transformWarnings(t.scale,t.thetaDeg,null);
    if(typeof unlockedNoiseWarning==='function'&&typeof hasPhysicalDims==='function'&&hasPhysicalDims(sourceA)&&hasPhysicalDims(sourceB)){
      const noise=unlockedNoiseWarning(t.scale);
      if(noise)warns.push(noise);
    }
    if(warns.length){warnEl.textContent='Aviso: '+warns.join(' ');warnEl.style.display='block';}
    else warnEl.style.display='none';
  }else{
    const dx=pts.A1.x-pts.B1.x,dy=pts.A1.y-pts.B1.y;
    summaryEl.textContent=`Escala: 1,000× · Giro: 0,0° · Desplazamiento: ${formatEs(dx,2)}, ${formatEs(dy,2)} px (solo traslación — ancla "centro")`;
    summaryEl.style.display='block';
    warnEl.style.display='none';
  }
}

function vpRenderVerifyPreview(){
  const canvas=vpEl('vpVerifyCanvas');
  const ctx=canvas.getContext('2d');
  const size=200;
  canvas.width=size;canvas.height=size;
  ctx.clearRect(0,0,size,size);
  ctx.fillStyle='#f7f7f8';ctx.fillRect(0,0,size,size);
  if(!vpSelected.A||!vpSelected.B)return;
  const pad=20;
  const drawNormalized=(el,color)=>{
    const s=Math.min((size-2*pad)/Math.max(el.bbox.w,1),(size-2*pad)/Math.max(el.bbox.h,1));
    ctx.save();
    ctx.translate(size/2,size/2);
    ctx.scale(s,s);
    ctx.translate(-(el.bbox.x+el.bbox.w/2),-(el.bbox.y+el.bbox.h/2));
    ctx.lineWidth=2/s;
    ctx.strokeStyle=color;
    ctx.stroke(new Path2D(el.d));
    ctx.restore();
  };
  drawNormalized(vpSelected.A,'#9aa0a4');
  drawNormalized(vpSelected.B,'#0f456e');
}

function vpUpdateConfirmState(){
  const ready=!!(vpSelected.A&&vpSelected.B);
  vpEl('vpConfirm').disabled=!ready;
  vpEl('vpSecondElementRow').style.display=ready?'flex':'none';
  vpEl('vpVerify').style.display=ready?'block':'none';
}

// ---- confirmar / cancelar --------------------------------------------------

vpEl('vpConfirm').onclick=()=>{
  const pts=vpFinalPoints();
  if(!pts.A1||!pts.B1)return;
  setPointsFromVector(pts); // definida en align.js
  closeVectorPicker();
};
vpEl('vpCancel').onclick=closeVectorPicker;
vpEl('vectorPickerClose').onclick=closeVectorPicker;
vpEl('vectorPickerBackdrop').addEventListener('click',e=>{
  if(e.target===vpEl('vectorPickerBackdrop'))closeVectorPicker();
});
vpEl('vpIncludeText').onchange=function(){vpIncludeOutlinedText=this.checked;};

// ---- interacción de los stages (bindeada una sola vez) ---------------------

function vpSetupInteraction(which){
  const canvas=vpEl('vpCanvas'+which);
  canvas.addEventListener('mousemove',e=>vpOnHover(which,e));
  canvas.addEventListener('mouseleave',()=>vpClearHoverHighlight(which));
  canvas.addEventListener('wheel',e=>{
    if(!e.altKey)return;
    e.preventDefault();
    vpCycleHover(which,e.deltaY<0?-1:1);
  },{passive:false});
  canvas.addEventListener('click',e=>vpOnClick(which,e));
}
vpSetupInteraction('A');
vpSetupInteraction('B');

// ---- botón de entrada, condicionado a disponibilidad real ------------------

function updateVectorPickerEntryVisibility(){
  const btn=vpEl('btnOpenVectorPicker');
  if(!btn)return;
  const available=isVectorGeometryAvailable(typeof sourceA!=='undefined'?sourceA:null)&&isVectorGeometryAvailable(typeof sourceB!=='undefined'?sourceB:null);
  btn.style.display=available?'inline-flex':'none';
  const guide=vpEl('alignGuideText');
  if(guide)guide.style.display=available?'none':'block';
}
vpEl('btnOpenVectorPicker').onclick=function(){openVectorPicker(this);};
