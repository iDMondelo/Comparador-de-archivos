// ============================================================================
// reliability.js — SEMÁFORO DE FIABILIDAD por archivo. Capa de presentación
// pura: no analiza nada por su cuenta, solo interpreta los hechos que ya
// calcula overprint.js (mismo parseo de pdf-lib, una vez por archivo) y
// text-analysis.js (source.textMode). No toca el PDF, el motor de
// comparación ni la alineación.
// ============================================================================

// Un único motivo, el primero que aplique por severidad — no una lista.
function computeReliability(source){
  if(!source||!source.overprint)return null; // ráster: no aplica
  const s=source.overprint.stats;
  if(s.error)return{level:'red',reason:'No se pudo analizar el archivo'};
  if(s.encrypted)return{level:'red',reason:'Archivo cifrado'};
  if(s.nonPrintableAnnots>0)return{level:'red',reason:'Contiene anotaciones excluidas del render'};
  if(s.opm0>0)return{level:'red',reason:'Sobreimpresión con OPM 0: el calado real no se reproduce'};
  if(!s.hasOutputIntent)return{level:'amber',reason:'Sin perfil de salida declarado'};
  if(s.knockout>0)return{level:'amber',reason:'Grupo con sobreimpresión knockout sin aproximar'};
  if(source.textMode==='live'&&s.fontsNotEmbedded>0)return{level:'amber',reason:'Alguna fuente no está embebida'};
  return{level:'green',reason:null};
}

// Llamada desde renderTextIndicator() (text-analysis.js), que ya se invoca
// en todos los puntos donde source/textMode pueden haber cambiado — así no
// hace falta cablear puntos de llamada nuevos.
function renderReliabilityIndicator(which){
  const source=which==='A'?sourceA:sourceB;
  const el=document.getElementById('reliabilityDot'+which);
  if(!el)return;
  const r=computeReliability(source);
  if(!r){
    el.hidden=true;
    el.className='reliability-dot';
    el.removeAttribute('title');
    return;
  }
  el.hidden=false;
  el.className='reliability-dot '+r.level;
  if(r.reason)el.title=r.reason;
  else el.removeAttribute('title');
}

// El motivo ya vive en `title` (tooltip nativo al pasar el cursor). En
// pantallas táctiles, "pulsar" no dispara el tooltip nativo — se muestra el
// mismo texto en una línea flotante junto al punto durante unos segundos.
let reliabilityTapTimer=null;
function setupReliabilityTap(which){
  const el=document.getElementById('reliabilityDot'+which);
  if(!el)return;
  el.addEventListener('click',()=>{
    const reason=el.getAttribute('title');
    if(!reason)return;
    document.querySelectorAll('.reliability-tap').forEach(n=>n.remove());
    if(reliabilityTapTimer)clearTimeout(reliabilityTapTimer);
    const tip=document.createElement('span');
    tip.className='reliability-tap';
    tip.textContent=reason;
    el.insertAdjacentElement('afterend',tip);
    reliabilityTapTimer=setTimeout(()=>tip.remove(),4000);
  });
}
setupReliabilityTap('A');
setupReliabilityTap('B');
