// ============================================================================
// pdf-facts.js — HECHOS DEL PDF PARA EL SEMÁFORO DE FIABILIDAD. Capa de
// entrada, SOLO LECTURA: carga el archivo con pdf-lib una vez y anota lo que
// consume reliability.js — cifrado, /OutputIntents, anotaciones con
// apariencia visible excluidas del render y fuentes no embebidas.
//
// El PDF nunca se reescribe: PDF.js renderiza siempre los bytes originales,
// idénticos para A y B. PDF.js ignora /OP, así que la sobreimpresión no se
// simula — a propósito: la simulación por Multiplicar (retirada en v31) hacía
// desaparecer los objetos blancos sobreimpresos.
//
// El motor de comparación no se entera de nada: sigue recibiendo ImageData.
// ============================================================================

function pfName(n){return PDFLib.PDFName.of(n);}

// Recorre los recursos (fuentes, XObjects de formulario y patrones de trama)
// de forma recursiva, con un set de referencias visitadas para no ciclar ni
// contar dos veces la misma fuente compartida.
function pfWalkResources(res,ctx,stats,visited){
  if(!(res instanceof PDFLib.PDFDict))return;
  const xo=res.lookup(pfName('XObject'));
  if(xo instanceof PDFLib.PDFDict){
    for(const[,raw]of xo.entries()){
      const tag=raw instanceof PDFLib.PDFRef?'x'+raw.toString():null;
      if(tag){if(visited.has(tag))continue;visited.add(tag);}
      const s=ctx.lookup(raw);
      if(!(s instanceof PDFLib.PDFStream))continue;
      if(s.dict.get(pfName('Subtype'))!==pfName('Form'))continue;
      pfWalkResources(s.dict.lookup(pfName('Resources')),ctx,stats,visited);
    }
  }
  const fonts=res.lookup(pfName('Font'));
  if(fonts instanceof PDFLib.PDFDict){
    for(const[,raw]of fonts.entries()){
      const tag=raw instanceof PDFLib.PDFRef?'f'+raw.toString():null;
      if(tag){if(visited.has(tag))continue;visited.add(tag);}
      const fd=ctx.lookup(raw);
      if(!(fd instanceof PDFLib.PDFDict))continue;
      stats.fontsTotal++;
      if(!pfFontIsEmbedded(fd,ctx))stats.fontsNotEmbedded++;
    }
  }
  const pat=res.lookup(pfName('Pattern'));
  if(pat instanceof PDFLib.PDFDict){
    for(const[,raw]of pat.entries()){
      const tag=raw instanceof PDFLib.PDFRef?'p'+raw.toString():null;
      if(tag){if(visited.has(tag))continue;visited.add(tag);}
      const s=ctx.lookup(raw);
      if(!(s instanceof PDFLib.PDFStream))continue;
      const pt=s.dict.get(pfName('PatternType'));
      if(!(pt instanceof PDFLib.PDFNumber)||pt.asNumber()!==1)continue;
      pfWalkResources(s.dict.lookup(pfName('Resources')),ctx,stats,visited);
    }
  }
}

// "Embebida": para /Type0 se mira el FontDescriptor del primer
// DescendantFonts (fuente CID real); /Type3 no requiere FontFile (los
// glifos van inline en el propio PDF); el resto necesita FontFile,
// FontFile2 o FontFile3 en su FontDescriptor — sin él es una de las 14
// fuentes base u otra fuente del sistema del generador, no incluida en el
// archivo.
function pfFontIsEmbedded(fontDict,ctx){
  const subtype=fontDict.get(pfName('Subtype'));
  if(subtype===pfName('Type3'))return true;
  let descSource=fontDict;
  if(subtype===pfName('Type0')){
    const desc=ctx.lookup(fontDict.get(pfName('DescendantFonts')));
    if(!(desc instanceof PDFLib.PDFArray)||desc.size()===0)return false;
    const cid=ctx.lookup(desc.get(0));
    if(!(cid instanceof PDFLib.PDFDict))return false;
    descSource=cid;
  }
  const fdesc=ctx.lookup(descSource.get(pfName('FontDescriptor')));
  if(!(fdesc instanceof PDFLib.PDFDict))return false;
  return fdesc.has(pfName('FontFile'))||fdesc.has(pfName('FontFile2'))||fdesc.has(pfName('FontFile3'));
}

// Anotaciones con apariencia visible (/AP) que el render excluye siempre
// (annotationMode DISABLE, pdf-source.js) — no cuenta /Link, /Popup ni
// /Widget: por defecto no pintan nada, así que excluirlas no cambia lo que
// se compara.
function pfCountNonPrintableAnnots(pageNode,ctx,stats){
  const annots=ctx.lookup(pageNode.get(pfName('Annots')));
  if(!(annots instanceof PDFLib.PDFArray))return;
  for(let i=0;i<annots.size();i++){
    const a=ctx.lookup(annots.get(i));
    if(!(a instanceof PDFLib.PDFDict))continue;
    const subtype=a.get(pfName('Subtype'));
    if(subtype===pfName('Link')||subtype===pfName('Popup')||subtype===pfName('Widget'))continue;
    const ap=ctx.lookup(a.get(pfName('AP')));
    if(ap instanceof PDFLib.PDFDict)stats.nonPrintableAnnots++;
  }
}

// /Resources puede heredarse del árbol de páginas: se sube por /Parent.
function pfPageResources(node,ctx){
  let d=node,guard=0;
  while(d instanceof PDFLib.PDFDict&&guard++<64){
    const r=d.lookup(pfName('Resources'));
    if(r instanceof PDFLib.PDFDict)return r;
    d=ctx.lookup(d.get(pfName('Parent')));
  }
  return null;
}

// Devuelve los hechos del archivo. Si pdf-lib no está o no puede con el
// archivo, `{error}` explica por qué (el semáforo lo muestra en rojo); el
// render no depende de esto.
async function analyzePdfFacts(bytes,label){
  if(typeof PDFLib==='undefined')return{error:'pdf-lib no disponible'};
  try{
    const stats={pages:0,ms:0,encrypted:false,hasOutputIntent:false,nonPrintableAnnots:0,fontsTotal:0,fontsNotEmbedded:0};
    const t0=performance.now();
    const doc=await PDFLib.PDFDocument.load(bytes,{ignoreEncryption:true,updateMetadata:false,throwOnInvalidObject:false});
    const ctx=doc.context;
    stats.encrypted=!!doc.isEncrypted;
    const oi=ctx.lookup(doc.catalog.get(pfName('OutputIntents')));
    stats.hasOutputIntent=oi instanceof PDFLib.PDFArray&&oi.size()>0;
    const visited=new Set();
    for(const page of doc.getPages()){
      stats.pages++;
      pfWalkResources(pfPageResources(page.node,ctx),ctx,stats,visited);
      pfCountNonPrintableAnnots(page.node,ctx,stats);
    }
    stats.ms=Math.round(performance.now()-t0);
    return stats;
  }catch(err){
    console.warn('Hechos del PDF — no se pudo analizar '+(label||'')+': ',err);
    return{error:err.message||String(err)};
  }
}
