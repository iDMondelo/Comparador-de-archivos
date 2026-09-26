// ============================================================================
// threshold-control.js — control «Umbral ΔE» (capa de presentación):
// deslizador con escala no lineal + campo numérico con coma decimal,
// sincronizados en ambos sentidos. Solo decide QUÉ umbral hay: no recalcula
// nada. Avisa a app.js mediante los ganchos globales onThresholdApplied
// (agrupado por requestAnimationFrame, re-umbraliza el mapa ΔE ya calculado)
// y onThresholdCommitted (al confirmar el valor). Nunca habla con el worker
// ni toca el motor de comparación ni la alineación.
// ============================================================================

// Escala no lineal por tramos: 0,5–3,0 de 0,1 en 0,1 (26 posiciones) y
// 3,5–10,0 de 0,5 en 0,5 (14). La zona útil 0,5–3 ocupa el 64 % del recorrido
// y cada paso del deslizador (flechas incluidas) cambia el valor mostrado. Las
// 11 marcas de index.html se reparten por igual en el recorrido, no en ΔE.
const THRESH_MIN=0.5,THRESH_MAX=10,THRESH_DEFAULT=1;
const THRESH_STEPS=[];
for(let i=5;i<=30;i++)THRESH_STEPS.push(i/10);
for(let i=7;i<=20;i++)THRESH_STEPS.push(i/2);

const threshSlider=document.getElementById('thresh');
const threshInput=document.getElementById('threshInput');

let thresholdDE=THRESH_DEFAULT;
let threshApplyRaf=0;

// Valores ΔE mostrados en la interfaz: coma decimal (es-ES).
function formatDE(v,decimals=1){
  return Number(v).toFixed(decimals).replace('.',',');
}

function roundDE(v){
  return Math.round(Math.min(THRESH_MAX,Math.max(THRESH_MIN,v))*10)/10;
}

// Acepta coma o punto. Devuelve el número tal cual (sin acotar), o null si no
// es un número.
function parseDERaw(str){
  const v=parseFloat(String(str).trim().replace(',','.'));
  return Number.isFinite(v)?v:null;
}

// Valor validado para el umbral: acotado a [0,5; 10,0] y a 1 decimal.
function parseDE(str){
  const v=parseDERaw(str);
  return v===null?null:roundDE(v);
}

function nearestStepIndex(v){
  let best=0,bestD=Infinity;
  for(let i=0;i<THRESH_STEPS.length;i++){
    const d=Math.abs(THRESH_STEPS[i]-v);
    if(d<bestD){bestD=d;best=i;}
  }
  return best;
}

function getThresholdDE(){return thresholdDE;}

// opts.user: cambio hecho por el usuario (desactiva la sugerencia automática
//   de app.js). opts.fromSlider: no reposicionar el deslizador (es su propio
//   evento). opts.keepField: no reescribir el campo mientras se teclea.
//   opts.commit: confirmar además el valor (zonas, ver commitThreshold).
// Un valor tecleado que no está en la tabla se conserva tal cual; el
// deslizador solo se coloca en la posición más cercana.
function setThresholdDE(v,opts={}){
  thresholdDE=roundDE(v);
  if(!opts.fromSlider)threshSlider.value=String(nearestStepIndex(thresholdDE));
  threshSlider.setAttribute('aria-valuetext',formatDE(thresholdDE));
  if(!opts.keepField)threshInput.value=formatDE(thresholdDE);
  if(opts.user&&typeof onThresholdUserInput==='function')onThresholdUserInput();
  scheduleThresholdApply();
  if(opts.commit)commitThreshold();
}

// Agrupa los cambios de un mismo fotograma: al arrastrar llegan muchos
// eventos `input` seguidos y solo el último importa.
function scheduleThresholdApply(){
  if(threshApplyRaf)return;
  threshApplyRaf=requestAnimationFrame(()=>{
    threshApplyRaf=0;
    if(typeof onThresholdApplied==='function')onThresholdApplied(thresholdDE);
  });
}

// Valor confirmado: al soltar el deslizador, con cada flecha del teclado
// (el navegador dispara `change` en cada paso) o al validar el campo. app.js
// lo usa para lo que no debe repetirse en cada fotograma del arrastre.
function commitThreshold(){
  if(typeof onThresholdCommitted==='function')onThresholdCommitted(thresholdDE);
}

function setThresholdControlDisabled(disabled){
  threshSlider.disabled=disabled;
  threshInput.disabled=disabled;
}

threshSlider.addEventListener('input',()=>{
  const v=THRESH_STEPS[parseInt(threshSlider.value,10)];
  if(v===undefined)return;
  setThresholdDE(v,{user:true,fromSlider:true});
});
threshSlider.addEventListener('change',commitThreshold);

// Mientras se teclea solo se aplica un valor ya válido y dentro de rango
// (así «1» → «1,» → «1,5» no salta a 0,5 por el camino); al validar (Intro o
// salir del campo) se acota y se normaliza: «0» → 0,5, «50» → 10,0, y un
// texto que no es un número recupera el valor vigente.
threshInput.addEventListener('input',()=>{
  const v=parseDERaw(threshInput.value);
  if(v===null||v<THRESH_MIN||v>THRESH_MAX)return;
  setThresholdDE(v,{user:true,keepField:true});
});
function commitThresholdInput(){
  const v=parseDE(threshInput.value);
  setThresholdDE(v===null?thresholdDE:v,{user:v!==null,commit:true});
}
threshInput.addEventListener('change',commitThresholdInput);
threshInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();commitThresholdInput();}
});

// Estado inicial (y descarta un valor que el navegador haya restaurado del
// formulario al recargar): deslizador y campo reflejan THRESH_DEFAULT.
threshSlider.value=String(nearestStepIndex(thresholdDE));
threshSlider.setAttribute('aria-valuetext',formatDE(thresholdDE));
threshInput.value=formatDE(thresholdDE);
