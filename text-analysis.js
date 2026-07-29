// ============================================================================
// text-analysis.js — ANÁLISIS DE TEXTO: detección vivo/trazado, extracción
// (texto vivo o OCR), diff por palabras y presentación en la pestaña Texto.
// No toca el motor de comparación de píxeles; solo lee sourceA/sourceB y
// el resultado ya calculado por compare() (lastRegion) para poder saltar
// del texto al overlay.
// ============================================================================

const textDiffPanel=document.getElementById('textDiffPanel');
const btnAnalyzeText=document.getElementById('btnAnalyzeText');

// ---- detección automática texto vivo / trazado ----------------------------

async function detectTextMode(source){
  const page=await source.pdfDoc.getPage(source.pageNum);
  const textContent=await page.getTextContent();
  const totalChars=textContent.items.reduce((n,it)=>n+((it.str||'').trim().length),0);
  source.textMode=totalChars>20?'live':'traced';
  source.textModeForced=false;
  return source.textMode;
}

function renderTextIndicator(which){
  const source=which==='A'?sourceA:sourceB;
  const el=document.getElementById('textIndicator'+which);
  const btn=document.getElementById('btnForceOcr'+which);
  const langWrap=document.getElementById('ocrLangWrap'+which);
  if(!source||!source.pdfDoc){el.textContent='';el.className='text-indicator';btn.style.display='none';langWrap.style.display='none';return;}
  if(source.textMode==null){
    el.textContent='Analizando texto…';el.className='text-indicator';
    btn.style.display='none';langWrap.style.display='none';
    return;
  }
  if(source.textMode==='live'){
    el.textContent='Texto vivo detectado';
    el.className='text-indicator live';
    langWrap.style.display='none';
  }else{
    el.textContent='Texto trazado — se usará OCR';
    el.className='text-indicator traced';
    langWrap.style.display='inline-flex';
  }
  btn.style.display='inline-flex';
  btn.disabled=source.textMode==='traced'; // ya usa OCR, forzarlo de nuevo no aporta nada
}

async function analyzeTextModeFor(which){
  const source=which==='A'?sourceA:sourceB;
  if(!source||!source.pdfDoc)return;
  renderTextIndicator(which);
  await detectTextMode(source);
  renderTextIndicator(which);
}

function setupForceOcrButtons(){
  ['A','B'].forEach(which=>{
    document.getElementById('btnForceOcr'+which).onclick=()=>{
      const source=which==='A'?sourceA:sourceB;
      if(!source)return;
      source.textMode='traced';
      source.textModeForced=true;
      renderTextIndicator(which);
    };
  });
}
setupForceOcrButtons();

// ---- reconstrucción de orden de lectura y extracción de texto vivo --------

// Los items de getTextContent() no siempre llegan en orden de lectura
// visual; se agrupan por línea (proximidad vertical) y se ordenan en
// horizontal antes de trocear en palabras, para que el diff no compare
// texto "desordenado".
function reconstructReadingOrder(entries){
  const sorted=entries.slice().sort((a,b)=>a.y-b.y);
  const lines=[];
  for(const e of sorted){
    let line=lines.find(l=>Math.abs(l.y-e.y)<Math.max(e.h,l.h)*0.6);
    if(!line){line={y:e.y,h:e.h,items:[]};lines.push(line);}
    line.items.push(e);
  }
  lines.sort((a,b)=>a.y-b.y);
  const words=[];
  for(const line of lines){
    line.items.sort((a,b)=>a.x-b.x);
    for(const it of line.items){
      const parts=it.str.split(/\s+/).filter(Boolean);
      for(const p of parts)words.push({str:p,x:it.x,y:it.y,w:it.w,h:it.h});
    }
  }
  return words;
}

async function extractLiveText(source){
  const page=await source.pdfDoc.getPage(source.pageNum);
  const pdfjsLib=await loadPdfJs();
  const textContent=await page.getTextContent();
  const viewport=source.viewport;
  const entries=[];
  for(const item of textContent.items){
    if(!item.str||!item.str.trim())continue;
    const m=pdfjsLib.Util.transform(viewport.transform,item.transform);
    const scaleX=Math.hypot(viewport.transform[0],viewport.transform[1])||1;
    const scaleY=Math.hypot(viewport.transform[2],viewport.transform[3])||1;
    const wpx=Math.abs((item.width||0)*scaleX)||4;
    const hpx=Math.abs((item.height||Math.abs(item.transform[3])||10)*scaleY)||10;
    entries.push({str:item.str,x:m[4],y:m[5]-hpx,w:wpx,h:hpx});
  }
  const words=reconstructReadingOrder(entries);
  return{words,text:words.map(w=>w.str).join(' ')};
}

// ---- OCR (texto trazado) — carga diferida de Tesseract.js -----------------

const OCR_RENDER_DPI=600;
let tesseractPromise=null;
function loadTesseract(){
  if(!tesseractPromise){
    tesseractPromise=import('./lib/tesseract/tesseract.min.js').then(()=>window.Tesseract);
  }
  return tesseractPromise;
}

async function extractOcrText(source,lang,onProgress){
  const Tesseract=await loadTesseract();
  const page=await source.pdfDoc.getPage(source.pageNum);
  const viewport=page.getViewport({scale:OCR_RENDER_DPI/72});
  checkRenderSize(viewport.width,viewport.height);
  const canvas=document.createElement('canvas');
  canvas.width=Math.round(viewport.width);canvas.height=Math.round(viewport.height);
  await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;

  const worker=await Tesseract.createWorker(lang,1,{
    workerPath:'./lib/tesseract/worker.min.js',
    corePath:'./lib/tesseract/tesseract-core-simd.wasm.js',
    langPath:'./lib/tesseract/lang-data',
    gzip:true,
    logger:onProgress
  });
  const{data}=await worker.recognize(canvas);
  await worker.terminate();

  // El OCR corrió a 600ppp fijo; se reescala al espacio de render del DPI
  // de comparación elegido por el usuario (source.dpi) para que encaje con
  // rectA/rectB de computeAlignedRegion().
  const factor=(source.dpi||300)/OCR_RENDER_DPI;
  const words=(data.words||[]).filter(w=>w.text&&w.text.trim()).map(w=>({
    str:w.text,
    x:w.bbox.x0*factor,y:w.bbox.y0*factor,
    w:(w.bbox.x1-w.bbox.x0)*factor,h:(w.bbox.y1-w.bbox.y0)*factor
  }));
  canvas.width=0;canvas.height=0; // libera el render temporal a 600ppp
  return{words,text:data.text};
}

async function analyzeSourceText(which,onProgress){
  const source=which==='A'?sourceA:sourceB;
  if(source.textMode==='live')return await extractLiveText(source);
  const langSel=document.getElementById('ocrLang'+which);
  const lang=langSel?langSel.value:'spa';
  return await extractOcrText(source,lang,onProgress);
}

// ---- diff de palabras (LCS propio, sin dependencias) -----------------------

function diffWords(wordsA,wordsB){
  const a=wordsA.map(w=>w.str),b=wordsB.map(w=>w.str);
  const n=a.length,m=b.length;
  const dp=new Array(n+1);
  for(let i=0;i<=n;i++)dp[i]=new Int32Array(m+1);
  for(let i=n-1;i>=0;i--){
    for(let j=m-1;j>=0;j--){
      dp[i][j]=a[i]===b[j]?dp[i+1][j+1]+1:Math.max(dp[i+1][j],dp[i][j+1]);
    }
  }
  const raw=[];
  let i=0,j=0;
  while(i<n&&j<m){
    if(a[i]===b[j]){raw.push({type:'equal',text:a[i],wordA:wordsA[i],wordB:wordsB[j]});i++;j++;}
    else if(dp[i+1][j]>=dp[i][j+1]){raw.push({type:'del',text:a[i],wordA:wordsA[i]});i++;}
    else{raw.push({type:'add',text:b[j],wordB:wordsB[j]});j++;}
  }
  while(i<n){raw.push({type:'del',text:a[i],wordA:wordsA[i]});i++;}
  while(j<m){raw.push({type:'add',text:b[j],wordB:wordsB[j]});j++;}

  // fusiona del+add consecutivos en "modificado"
  const merged=[];
  for(let k=0;k<raw.length;k++){
    const cur=raw[k],next=raw[k+1];
    if(cur&&next&&cur.type==='del'&&next.type==='add'){
      merged.push({type:'mod',textOld:cur.text,textNew:next.text,wordA:cur.wordA,wordB:next.wordB});
      k++;
    }else merged.push(cur);
  }
  return merged;
}

// ---- mapeo texto → canvas comparado y presentación -------------------------

// Convierte un rect en espacio de render completo (A o B) al espacio del
// canvas comparado/recortado (cW×cH), restando el offset que ya calcula
// computeAlignedRegion() (guardado en lastRegion por compare() en app.js).
function mapTextRectToCanvas(rect,which){
  if(!lastRegion)return null;
  const off=which==='A'?lastRegion.rectA:lastRegion.rectB;
  const x=rect.x-off.x+rect.w/2,y=rect.y-off.y+rect.h/2;
  if(x<0||y<0||x>cW||y>cH)return null;
  return{x,y};
}

function escapeHtml(s){
  return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderTextDiff(diff){
  const parts=diff.map((d,idx)=>{
    if(d.type==='equal')return`<span class="tw-eq">${escapeHtml(d.text)}</span>`;
    if(d.type==='del')return`<span class="tw-del" data-idx="${idx}" tabindex="0">${escapeHtml(d.text)}</span>`;
    if(d.type==='add')return`<span class="tw-add" data-idx="${idx}" tabindex="0">${escapeHtml(d.text)}</span>`;
    return`<span data-idx="${idx}" tabindex="0"><span class="tw-del">${escapeHtml(d.textOld)}</span> → <span class="tw-add">${escapeHtml(d.textNew)}</span></span>`;
  }).join(' ');
  const stats=diff.reduce((s,d)=>{s[d.type]=(s[d.type]||0)+1;return s;},{});
  textDiffPanel.innerHTML=
    `<div class="legend">`+
    `<div class="legend-item"><div class="legend-dot dot-low"></div>Añadido (${stats.add||0})</div>`+
    `<div class="legend-item"><div class="legend-dot dot-high"></div>Eliminado (${stats.del||0})</div>`+
    `<div class="legend-item"><div class="legend-dot dot-mid"></div>Modificado (${stats.mod||0})</div>`+
    `</div><div class="text-diff-body">${parts||'<span class=\"hint\">Sin diferencias de texto.</span>'}</div>`;
  textDiffPanel.querySelectorAll('[data-idx]').forEach(el=>{
    el.onclick=()=>{
      const d=diff[parseInt(el.dataset.idx,10)];
      const word=d.wordB||d.wordA;
      const which=d.wordB?'B':'A';
      const c=word&&mapTextRectToCanvas(word,which);
      if(c)centerViewOn(c.x,c.y,6,'overlay');
      else status.textContent='Compara primero las imágenes para poder saltar al overlay.';
    };
  });
}

async function runTextComparison(){
  if(!sourceA||!sourceB)return;
  if(!sourceA.pdfDoc||!sourceB.pdfDoc){
    textDiffPanel.innerHTML='<div class="hint">El diff de texto solo está disponible cuando ambos archivos son PDF.</div>';
    return;
  }
  btnAnalyzeText.disabled=true;
  textDiffPanel.innerHTML='<div class="hint">Analizando texto…</div>';
  try{
    const progressA=makeOcrProgressHandler('A'),progressB=makeOcrProgressHandler('B');
    const[dataA,dataB]=await Promise.all([
      analyzeSourceText('A',progressA),
      analyzeSourceText('B',progressB)
    ]);
    hideOcrProgress('A');hideOcrProgress('B');
    const diff=diffWords(dataA.words,dataB.words);
    renderTextDiff(diff);
  }catch(err){
    textDiffPanel.innerHTML='<div class="hint">Error al analizar texto: '+err.message+'</div>';
  }finally{
    btnAnalyzeText.disabled=false;
  }
}

function makeOcrProgressHandler(which){
  const el=document.getElementById('ocrProgress'+which);
  if(!el)return null;
  return m=>{
    el.style.display='block';
    const pct=typeof m.progress==='number'?Math.round(m.progress*100):0;
    el.querySelector('.bar').style.width=pct+'%';
    el.querySelector('.pct').textContent=(m.status||'')+' '+pct+'%';
  };
}
function hideOcrProgress(which){
  const el=document.getElementById('ocrProgress'+which);
  if(el)el.style.display='none';
}

btnAnalyzeText.onclick=runTextComparison;

function clearTextDiff(){
  textDiffPanel.innerHTML='<div class="hint">Pulsa «Analizar texto» para comparar el copy de ambos archivos.</div>';
}
clearTextDiff();
