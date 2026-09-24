// ============================================================================
// overprint.js — SIMULACIÓN APROXIMADA DE SOBREIMPRESIÓN. Capa de entrada:
// reescribe el PDF en memoria con pdf-lib antes de entregárselo a PDF.js.
// El archivo del usuario nunca se toca en disco y el motor de comparación
// no se entera de nada: sigue recibiendo ImageData.
//
// Principio: un objeto con sobreimpresión (ExtGState con /OP true para
// relleno o /op true para trazo) se imprime encima de lo que hay debajo sin
// calarlo. Visualmente equivale al modo de fusión Multiplicar — la misma
// traducción que hacen ArtPro y otros generadores cuando emiten grupos
// Darken/Multiply para que los visores la muestren. PDF.js ignora /OP pero
// sí aplica /BM (lo traduce a globalCompositeOperation del canvas), así que
// basta con cambiar el ExtGState.
//
// La reescritura se aplica SIEMPRE por igual a A y a B: aplicarla a uno solo
// generaría diferencias falsas en la comparación.
//
// Este mismo documento pdf-lib (cargado una sola vez por archivo) también
// deja leer, sin ningún parseo adicional, el resto de hechos que consume el
// semáforo de fiabilidad (reliability.js): cifrado, /OutputIntents,
// anotaciones con apariencia visible excluidas del render y fuentes no
// embebidas — todo queda en `stats`, junto a opStates/opm0/knockout.
// ============================================================================

const overprintRowEl=document.getElementById('renderOptionsRow');
const overprintToggleEl=document.getElementById('overprintToggle');

let overprintSimEnabled=false;   // estado efectivo del interruptor
let overprintUserTouched=false;  // true en cuanto el usuario pulsa el checkbox: deja de autoactivarse en la sesión

function isOverprintSimActive(){return overprintSimEnabled;}

function opName(n){return PDFLib.PDFName.of(n);}

function opIsTrue(obj){
  return obj===PDFLib.PDFBool.True||(obj instanceof PDFLib.PDFBool&&obj.asBoolean&&obj.asBoolean()===true);
}

// /BM ausente, /Normal o /Compatible (o array cuyo primer elemento lo es)
// cuenta como "sin modo de fusión". Cualquier otro modo lo puso el generador
// a propósito y no se toca.
function opBlendIsNormal(bm){
  if(bm==null)return true;
  if(bm instanceof PDFLib.PDFArray)bm=bm.size()?bm.get(0):null;
  if(bm==null)return true;
  return bm===opName('Normal')||bm===opName('Compatible');
}

// Recorre los recursos (ExtGState, XObjects de formulario y patrones de
// trama) de forma recursiva, con un set de referencias visitadas para no
// ciclar ni contar dos veces el mismo estado compartido.
function opWalkResources(res,ctx,stats,visited){
  if(!(res instanceof PDFLib.PDFDict))return;
  const gs=res.lookup(opName('ExtGState'));
  if(gs instanceof PDFLib.PDFDict){
    for(const[,raw]of gs.entries()){
      const tag=raw instanceof PDFLib.PDFRef?'g'+raw.toString():null;
      if(tag){if(visited.has(tag))continue;visited.add(tag);}
      const d=ctx.lookup(raw);
      if(!(d instanceof PDFLib.PDFDict))continue;
      const op=opIsTrue(d.get(opName('OP')))||opIsTrue(d.get(opName('op')));
      if(!op)continue;
      stats.opStates++;
      const opm=d.get(opName('OPM'));
      if(opm instanceof PDFLib.PDFNumber&&opm.asNumber()===0)stats.opm0++;
      const bm=ctx.lookup(d.get(opName('BM')));
      if(opBlendIsNormal(bm)){
        d.set(opName('BM'),opName('Multiply'));
        stats.translated++;
      }else{
        stats.keptBlend++;
      }
    }
  }
  const xo=res.lookup(opName('XObject'));
  if(xo instanceof PDFLib.PDFDict){
    for(const[,raw]of xo.entries()){
      const tag=raw instanceof PDFLib.PDFRef?'x'+raw.toString():null;
      if(tag){if(visited.has(tag))continue;visited.add(tag);}
      const s=ctx.lookup(raw);
      if(!(s instanceof PDFLib.PDFStream))continue;
      if(s.dict.get(opName('Subtype'))!==opName('Form'))continue;
      const group=s.dict.lookup(opName('Group'));
      if(group instanceof PDFLib.PDFDict&&opIsTrue(group.get(opName('K')))){
        // Grupo knockout: Multiply no lo aproxima bien. Se avisa y no se
        // toca nada de su interior.
        stats.knockout++;
        continue;
      }
      opWalkResources(s.dict.lookup(opName('Resources')),ctx,stats,visited);
    }
  }
  const fonts=res.lookup(opName('Font'));
  if(fonts instanceof PDFLib.PDFDict){
    for(const[,raw]of fonts.entries()){
      const tag=raw instanceof PDFLib.PDFRef?'f'+raw.toString():null;
      if(tag){if(visited.has(tag))continue;visited.add(tag);}
      const fd=ctx.lookup(raw);
      if(!(fd instanceof PDFLib.PDFDict))continue;
      stats.fontsTotal++;
      if(!opFontIsEmbedded(fd,ctx))stats.fontsNotEmbedded++;
    }
  }
  const pat=res.lookup(opName('Pattern'));
  if(pat instanceof PDFLib.PDFDict){
    for(const[,raw]of pat.entries()){
      const tag=raw instanceof PDFLib.PDFRef?'p'+raw.toString():null;
      if(tag){if(visited.has(tag))continue;visited.add(tag);}
      const s=ctx.lookup(raw);
      if(!(s instanceof PDFLib.PDFStream))continue;
      const pt=s.dict.get(opName('PatternType'));
      if(!(pt instanceof PDFLib.PDFNumber)||pt.asNumber()!==1)continue;
      opWalkResources(s.dict.lookup(opName('Resources')),ctx,stats,visited);
    }
  }
}

// "Embebida": para /Type0 se mira el FontDescriptor del primer
// DescendantFonts (fuente CID real); /Type3 no requiere FontFile (los
// glifos van inline en el propio PDF); el resto necesita FontFile,
// FontFile2 o FontFile3 en su FontDescriptor — sin él es una de las 14
// fuentes base u otra fuente del sistema del generador, no incluida en el
// archivo.
function opFontIsEmbedded(fontDict,ctx){
  const subtype=fontDict.get(opName('Subtype'));
  if(subtype===opName('Type3'))return true;
  let descSource=fontDict;
  if(subtype===opName('Type0')){
    const desc=ctx.lookup(fontDict.get(opName('DescendantFonts')));
    if(!(desc instanceof PDFLib.PDFArray)||desc.size()===0)return false;
    const cid=ctx.lookup(desc.get(0));
    if(!(cid instanceof PDFLib.PDFDict))return false;
    descSource=cid;
  }
  const fdesc=ctx.lookup(descSource.get(opName('FontDescriptor')));
  if(!(fdesc instanceof PDFLib.PDFDict))return false;
  return fdesc.has(opName('FontFile'))||fdesc.has(opName('FontFile2'))||fdesc.has(opName('FontFile3'));
}

// Anotaciones con apariencia visible (/AP) que el render excluye siempre
// (annotationMode DISABLE, pdf-source.js) — no cuenta /Link, /Popup ni
// /Widget: por defecto no pintan nada, así que excluirlas no cambia lo que
// se compara.
function opCountNonPrintableAnnots(pageNode,ctx,stats){
  const annots=ctx.lookup(pageNode.get(opName('Annots')));
  if(!(annots instanceof PDFLib.PDFArray))return;
  for(let i=0;i<annots.size();i++){
    const a=ctx.lookup(annots.get(i));
    if(!(a instanceof PDFLib.PDFDict))continue;
    const subtype=a.get(opName('Subtype'));
    if(subtype===opName('Link')||subtype===opName('Popup')||subtype===opName('Widget'))continue;
    const ap=ctx.lookup(a.get(opName('AP')));
    if(ap instanceof PDFLib.PDFDict)stats.nonPrintableAnnots++;
  }
}

// /Resources puede heredarse del árbol de páginas: se sube por /Parent.
function opPageResources(node,ctx){
  let d=node,guard=0;
  while(d instanceof PDFLib.PDFDict&&guard++<64){
    const r=d.lookup(opName('Resources'));
    if(r instanceof PDFLib.PDFDict)return r;
    d=ctx.lookup(d.get(opName('Parent')));
  }
  return null;
}

// Reescritura completa: devuelve los bytes nuevos y el recuento. Con
// `opts.onlyGroup` solo inyecta el grupo de página (uso diagnóstico).
async function rewritePdfForOverprint(bytes,opts){
  opts=opts||{};
  const stats={opStates:0,translated:0,keptBlend:0,opm0:0,knockout:0,groupInjected:false,pages:0,ms:0,
    encrypted:false,hasOutputIntent:false,nonPrintableAnnots:0,fontsTotal:0,fontsNotEmbedded:0};
  const t0=performance.now();
  const doc=await PDFLib.PDFDocument.load(bytes,{ignoreEncryption:true,updateMetadata:false,throwOnInvalidObject:false});
  const ctx=doc.context;
  stats.encrypted=!!doc.isEncrypted;
  const oi=ctx.lookup(doc.catalog.get(opName('OutputIntents')));
  stats.hasOutputIntent=oi instanceof PDFLib.PDFArray&&oi.size()>0;
  const visited=new Set();
  for(const page of doc.getPages()){
    stats.pages++;
    if(!opts.onlyGroup){
      opWalkResources(opPageResources(page.node,ctx),ctx,stats,visited);
      opCountNonPrintableAnnots(page.node,ctx,stats);
    }
    if(!page.node.has(opName('Group'))){
      page.node.set(opName('Group'),ctx.obj({S:'Transparency',CS:'DeviceRGB',I:true}));
      stats.groupInjected=true;
    }
  }
  const out=await doc.save({useObjectStreams:false,updateFieldAppearances:false});
  stats.ms=Math.round(performance.now()-t0);
  return{bytes:out,stats};
}

// Prepara la caché por archivo: bytes originales, bytes reescritos y
// recuento. Si pdf-lib no puede con el archivo, `rew` queda a null y
// `stats.error` explica por qué; entonces la simulación se deshabilita para
// AMBOS archivos (nunca se aplica a uno solo).
async function prepareOverprint(orig,label){
  if(typeof PDFLib==='undefined'){
    return{orig,rew:null,stats:{error:'pdf-lib no disponible'},applied:false};
  }
  try{
    const{bytes,stats}=await rewritePdfForOverprint(orig);
    console.log(`Sobreimpresión — ${label||'documento'}: ${stats.opStates} estados con /OP, ${stats.translated} traducidos a Multiply, ${stats.keptBlend} ya con fusión, OPM0 ${stats.opm0}, knockout ${stats.knockout}, grupo de página ${stats.groupInjected?'inyectado':'ya presente'} (${stats.ms} ms)`);
    return{orig,rew:bytes,stats,applied:false};
  }catch(err){
    console.warn('Sobreimpresión — no se pudo reescribir '+(label||'')+': ',err);
    return{orig,rew:null,stats:{error:err.message||String(err)},applied:false};
  }
}

// Llamada desde openPdf() ANTES de abrir el documento con PDF.js: decide si
// el archivo que entra debe abrirse ya reescrito. Autoactiva el interruptor
// si detecta sobreimpresión y el usuario no lo ha tocado a mano.
function decideOverprintForNewFile(overprint){
  if(overprint.stats.error)return false;
  if(!overprintUserTouched&&overprint.stats.opStates>0&&!overprintToggleEl.disabled){
    overprintSimEnabled=true;
    overprintToggleEl.checked=true;
  }
  return overprintSimEnabled;
}

function opSources(){
  const out=[];
  if(typeof sourceA!=='undefined'&&sourceA&&sourceA.pdfDoc)out.push(['A',sourceA]);
  if(typeof sourceB!=='undefined'&&sourceB&&sourceB.pdfDoc)out.push(['B',sourceB]);
  return out;
}

// Garantiza que cada fuente PDF cargada está abierta con los bytes que
// corresponden al estado actual del interruptor, reabriendo y
// re-renderizando las que no lo estén. Conserva puntos de alineación,
// PPP y página; solo invalida la comparación.
async function syncOverprintMode(opts){
  opts=opts||{};
  const sources=opSources();
  const errored=sources.filter(([,s])=>s.overprint&&s.overprint.stats.error);
  if(errored.length){
    overprintSimEnabled=false;
    overprintToggleEl.checked=false;
    overprintToggleEl.disabled=true;
  }else{
    overprintToggleEl.disabled=false;
  }
  const hadComparison=typeof pixelDEmap!=='undefined'&&!!pixelDEmap;
  let reopened=false;
  for(const[which]of sources){
    if(typeof reopenPdfSource!=='function')break;
    try{
      if(await reopenPdfSource(which))reopened=true;
    }catch(err){
      status.textContent='Error al reabrir el archivo '+which+': '+err.message;
    }
  }
  if(reopened){
    if(typeof hideResults==='function')hideResults();
    if(typeof sourceA!=='undefined'&&sourceA&&sourceB&&typeof initAlignCanvas==='function'){
      initAlignCanvas('A',sourceA);initAlignCanvas('B',sourceB);
      if(typeof positionAllMarkers==='function'){positionAllMarkers('A');positionAllMarkers('B');}
      if(typeof drawAlignCoverage==='function')drawAlignCoverage();
    }
    if(opts.fromToggle){
      status.textContent=hadComparison
        ?`Render actualizado ${overprintSimEnabled?'con':'sin'} simulación de sobreimpresión: la comparación anterior ya no es válida, repítela.`
        :`Render actualizado ${overprintSimEnabled?'con':'sin'} simulación de sobreimpresión.`;
    }
  }
  updateOverprintUI();
}

function updateOverprintUI(){
  const sources=opSources().filter(([,s])=>s.overprint);
  overprintRowEl.style.display=sources.length?'flex':'none';
}

function resetOverprintUI(){
  overprintSimEnabled=false;
  overprintUserTouched=false;
  overprintToggleEl.checked=false;
  overprintToggleEl.disabled=false;
  overprintRowEl.style.display='none';
}

overprintToggleEl.onchange=async()=>{
  overprintUserTouched=true;
  overprintSimEnabled=overprintToggleEl.checked;
  overprintToggleEl.disabled=true;
  try{await syncOverprintMode({fromToggle:true});}
  finally{if(!opSources().some(([,s])=>s.overprint&&s.overprint.stats.error))overprintToggleEl.disabled=false;}
};
