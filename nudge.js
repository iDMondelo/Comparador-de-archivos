// ============================================================================
// nudge.js — afinado por teclado de un marcador puntual (flechas = 1px,
// Mayús+flecha = 10px). Capacidad compartida: la usan tanto los puntos
// manuales (align.js) como las anclas del picker vectorial (vector-picker.js)
// — antes de este archivo no existía ningún nudge por teclado en la app.
// Un solo marcador "activo" a la vez, por foco (clic o Tab); cambiar de
// marcador cambia cuál se mueve con las flechas.
// ============================================================================

let nudgeSelected=null; // {getPoint,setPoint,onChange} | null

function registerNudgeable(el,{getPoint,setPoint,onChange}){
  el.tabIndex=0;
  el.addEventListener('focus',()=>{
    nudgeSelected={getPoint,setPoint,onChange,el};
    el.classList.add('nudge-active');
  });
  el.addEventListener('blur',()=>{
    if(nudgeSelected&&nudgeSelected.el===el)nudgeSelected=null;
    el.classList.remove('nudge-active');
  });
}

document.addEventListener('keydown',e=>{
  if(!nudgeSelected)return;
  const tag=(e.target.tagName||'').toLowerCase();
  if(tag==='input'||tag==='select'||tag==='textarea')return;
  const step=e.shiftKey?10:1;
  let dx=0,dy=0;
  if(e.key==='ArrowLeft')dx=-step;
  else if(e.key==='ArrowRight')dx=step;
  else if(e.key==='ArrowUp')dy=-step;
  else if(e.key==='ArrowDown')dy=step;
  else return;
  e.preventDefault();
  const p=nudgeSelected.getPoint();
  if(!p)return;
  nudgeSelected.setPoint({x:p.x+dx,y:p.y+dy});
  nudgeSelected.onChange();
});
