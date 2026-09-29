// ============================================================================
// overprint.js — SIMULACIÓN DE SOBREIMPRESIÓN. Capa de entrada: reescribe el
// PDF en memoria con pdf-lib antes de entregárselo a PDF.js. El archivo del
// usuario nunca se toca en disco y el motor de comparación no se entera de
// nada: sigue recibiendo ImageData.
//
// Principio: un objeto que sobreimprime no cala el fondo, solo añade su tinta
// a las planchas que le corresponden. PDF.js ignora /OP y /op, pero sí aplica
// /BM (lo traduce a globalCompositeOperation del canvas), así que la
// aproximación es traducir el ExtGState a /BM /Multiply — la misma traducción
// que hacen algunos RIP y generadores de preimpresión cuando emiten
// grupos Darken/Multiply para que los visores muestren la sobreimpresión.
//
// La reescritura se aplica SIEMPRE por igual a A y a B: aplicarla a uno solo
// generaría diferencias falsas en la comparación.
//
// QUÉ APRENDIMOS DE LA v30 (borrada en v31 porque hacía desaparecer los
// objetos blancos sobreimpresos). Su condición era un OR crudo,
// `/OP true || /op true`, sin mirar /OPM y sin saber qué se pintaba. Medido en
// pruebas/diag-sobreimpresion.html, eso fallaba en tres sitios:
//
//   · Blanco DeviceCMYK con /OP true y /OPM 0: la norma escribe los cuatro
//     componentes, así que el blanco DEBE calar. Multiplicar por blanco es la
//     identidad, así que el objeto se volatilizaba. Es la regresión de v31.
//   · /OP true con /op false sobre un relleno: por la norma ese relleno NO
//     sobreimprime (solo el trazo), y la v30 lo traducía igual.
//   · /op true declarado DENTRO de un Form XObject con /Group: el ExtGState se
//     traducía, pero el render no cambiaba en absoluto.
//
// Por eso aquí la decisión no sale solo del diccionario del ExtGState: antes de
// tocar nada se hace un ESCANEO DE SOLO LECTURA de los content streams
// (opCollectPaints) que averigua, para cada ExtGState, si gobierna rellenos o
// trazos, en qué familia de espacio de color, y si alguno de esos objetos es
// blanco en un espacio de dispositivo. Con eso:
//
//   · se traduce solo si la sobreimpresión efectiva afecta a lo que realmente
//     se pinta bajo ese estado (relleno: /op y si no existe /OP; trazo: /OP);
//   · el blanco en espacio de dispositivo no se traduce salvo con /OPM 1, que
//     es el único caso en que la norma lo hace invisible;
//   · /OPM solo se tiene en cuenta en espacios de dispositivo, nunca en tintas
//     Separation/DeviceN, que son lo habitual en metalgrafía.
//
// Si el escaneo no puede leer un content stream, se cae del lado de simular
// (mejor aproximar que no hacer nada) y se registra en consola.
//
// LÍMITES MEDIDOS de PDF.js, no de esta reescritura:
//   · /BM dentro de un Form XObject con /Group es inerte (el grupo se compone
//     aislado). Se arregla quitando el /Group de esos XObjects, y solo de esos.
//   · /BM dentro de un patrón de mosaico es inerte y NO tiene arreglo por
//     reescritura: PDF.js rasteriza la baldosa en su propio lienzo.
//
// Esta capa no toca el motor (de-worker.js), ni el cálculo de la
// transformación de alineación, ni el DOM de resultados. pdf-facts.js sigue
// siendo un parseo aparte y de solo lectura: aquí no se leen sus hechos.
// ============================================================================

function opName(n){return PDFLib.PDFName.of(n);}

function opLookupBool(ctx,d,k){
  const v=ctx.lookup(d.get(opName(k)));
  if(v==null)return null;
  if(v===PDFLib.PDFBool.True)return true;
  if(v===PDFLib.PDFBool.False)return false;
  if(v instanceof PDFLib.PDFBool&&v.asBoolean)return v.asBoolean()===true;
  return null;
}

function opLookupNum(ctx,d,k){
  const v=ctx.lookup(d.get(opName(k)));
  return v instanceof PDFLib.PDFNumber?v.asNumber():null;
}

// Sobreimpresión efectiva según ISO 32000: /op gobierna rellenos, texto e
// imágenes y hereda de /OP si no está presente; /OP gobierna los trazos.
function opFillOverprint(ctx,d){
  const op=opLookupBool(ctx,d,'op');
  if(op!==null)return op;
  const OP=opLookupBool(ctx,d,'OP');
  return OP===null?false:OP;
}
function opStrokeOverprint(ctx,d){
  const OP=opLookupBool(ctx,d,'OP');
  return OP===null?false:OP;
}

// /BM ausente, /Normal o /Compatible (o array cuyo primer elemento lo es)
// cuenta como "sin modo de fusión". Cualquier otro modo lo puso el generador a
// propósito: ya es transparencia real, PDF.js la resuelve, y no se toca.
function opBlendIsNormal(bm){
  if(bm==null)return true;
  if(bm instanceof PDFLib.PDFArray)bm=bm.size()?bm.get(0):null;
  if(bm==null)return true;
  return bm===opName('Normal')||bm===opName('Compatible');
}

const OP_REF=o=>o instanceof PDFLib.PDFRef?o.toString():null;

// ---------------------------------------------------------------------------
// Familia del espacio de color, que es lo único que necesita la decisión: si
// es de dispositivo (gray/rgb/cmyk) entran en juego /OPM y el blanco; si es
// Separation o DeviceN, la sobreimpresión es real y /OPM es irrelevante.
// ---------------------------------------------------------------------------
const OP_DEVICE=new Set(['gray','rgb','cmyk']);
function opCsFamily(ctx,cs,prof){
  if(cs==null||(prof||0)>8)return null;
  cs=ctx.lookup(cs);
  if(cs instanceof PDFLib.PDFName){
    const n=cs.asString?cs.asString():String(cs);
    if(n==='/DeviceGray'||n==='/CalGray'||n==='/G')return'gray';
    if(n==='/DeviceRGB'||n==='/CalRGB'||n==='/RGB')return'rgb';
    if(n==='/DeviceCMYK'||n==='/CMYK')return'cmyk';
    if(n==='/Pattern')return'pattern';
    return'otro';
  }
  if(cs instanceof PDFLib.PDFArray&&cs.size()){
    const fam=ctx.lookup(cs.get(0));
    const n=fam instanceof PDFLib.PDFName?(fam.asString?fam.asString():String(fam)):'';
    if(n==='/Separation')return'separation';
    if(n==='/DeviceN')return'devicen';
    if(n==='/Indexed'||n==='/I')return'indexed';
    if(n==='/Pattern')return'pattern';
    if(n==='/ICCBased'){
      const s=ctx.lookup(cs.get(1));
      const N=s&&s.dict?opLookupNum(ctx,s.dict,'N'):null;
      return N===1?'gray':N===4?'cmyk':'rgb';
    }
    if(n==='/CalGray')return'gray';
    if(n==='/CalRGB'||n==='/Lab')return'rgb';
    if(n==='/DeviceGray')return'gray';
    if(n==='/DeviceRGB')return'rgb';
    if(n==='/DeviceCMYK')return'cmyk';
  }
  return'otro';
}

// Resuelve un nombre de ExtGState recorriendo la cadena de /Resources de dentro
// hacia fuera. Devuelve el PDFDict resuelto, que sirve de clave estable tanto
// si la entrada es una referencia indirecta como si es un diccionario directo.
function opResolveGsName(ctx,cadenaRes,nombre){
  for(let i=cadenaRes.length-1;i>=0;i--){
    const res=cadenaRes[i];
    if(!(res instanceof PDFLib.PDFDict))continue;
    const gsD=res.lookup(opName('ExtGState'));
    if(!(gsD instanceof PDFLib.PDFDict))continue;
    const d=ctx.lookup(gsD.get(opName(nombre)));
    if(d instanceof PDFLib.PDFDict)return d;
  }
  return null;
}

// Resuelve un nombre de espacio de color contra los /Resources en vigor.
function opResolveCsName(ctx,res,nombre){
  if(nombre==='DeviceGray'||nombre==='G')return'gray';
  if(nombre==='DeviceRGB'||nombre==='RGB')return'rgb';
  if(nombre==='DeviceCMYK'||nombre==='CMYK')return'cmyk';
  if(nombre==='Pattern')return'pattern';
  if(!(res instanceof PDFLib.PDFDict))return'otro';
  const csDict=res.lookup(opName('ColorSpace'));
  if(!(csDict instanceof PDFLib.PDFDict))return'otro';
  return opCsFamily(ctx,csDict.get(opName(nombre)),0);
}

// Blanco = «sin tinta» en un espacio de dispositivo: 0 0 0 0 en CMYK, 1 en
// gris, 1 1 1 en RGB. Es el caso que Multiplicar haría desaparecer.
function opIsWhite(familia,comps){
  if(!comps||!comps.length)return false;
  if(familia==='cmyk')return comps.length>=4&&comps.slice(0,4).every(v=>v===0);
  if(familia==='gray')return comps.length>=1&&comps[0]===1;
  if(familia==='rgb')return comps.length>=3&&comps.slice(0,3).every(v=>v===1);
  return false;
}

// ---------------------------------------------------------------------------
// Lectura de content streams. decodePDFRawStream deshace FlateDecode y los
// demás filtros estándar; si no se puede descomprimir se devuelve null y el
// escaneo lo trata como «sin datos» (se simula por defecto).
// ---------------------------------------------------------------------------
function opBytesToLatin1(b){
  let s='';const CH=0x8000;
  for(let i=0;i<b.length;i+=CH)s+=String.fromCharCode.apply(null,b.subarray(i,i+CH));
  return s;
}

function opStreamText(stream){
  if(!(stream instanceof PDFLib.PDFStream))return null;
  try{
    if(typeof PDFLib.decodePDFRawStream==='function'){
      const d=PDFLib.decodePDFRawStream(stream).decode();
      if(d&&d.length!==undefined)return opBytesToLatin1(d);
    }
  }catch(e){/* cae al crudo si no hay filtro */}
  try{
    const filtro=stream.dict?stream.dict.get(opName('Filter')):null;
    if(filtro!=null)return null;                 // comprimido y no se pudo descomprimir
    const raw=stream.getContents?stream.getContents():stream.contents;
    return raw?opBytesToLatin1(raw):null;
  }catch(e){return null;}
}

// El contenido de una página puede ser un stream o un array de streams.
function opPageText(ctx,node){
  const c=ctx.lookup(node.get(opName('Contents')));
  if(c instanceof PDFLib.PDFStream)return opStreamText(c);
  if(c instanceof PDFLib.PDFArray){
    const partes=[];
    for(let i=0;i<c.size();i++){
      const t=opStreamText(ctx.lookup(c.get(i)));
      if(t===null)return null;
      partes.push(t);
    }
    return partes.join('\n');
  }
  return null;
}

const OP_DELIM=/[\s()<>\[\]{}\/%]/;
const OP_PINTA_RELLENO=new Set(['f','F','f*','B','B*','b','b*','sh','Tj','TJ',"'",'"']);
const OP_PINTA_TRAZO=new Set(['S','s','B','B*','b','b*']);

// ---------------------------------------------------------------------------
// Escaneo de un content stream. NO modifica nada: solo anota, para cada
// ExtGState (por referencia indirecta), qué se pinta bajo él. `estado` entra
// heredado, porque el estado gráfico se hereda al entrar en un Form XObject: un
// «gs» fijado fuera, antes de «/X Do», afecta a lo que pinte el XObject aunque
// sus propios /Resources no contengan ese ExtGState.
// ---------------------------------------------------------------------------
function opScanStream(src,ctx,cadenaRes,estado,paints,vistos,prof,stats){
  const res=cadenaRes[cadenaRes.length-1];
  if(src===null){stats.scanError++;return;}
  if((prof||0)>10)return;
  const n=src.length;
  let i=0,ops=[];
  // El estado gráfico ACUMULA los parámetros de cada ExtGState aplicado: dos
  // «gs» seguidos no se reemplazan. Se guardan los valores en vigor de
  // sobreimpresión y /OPM, y qué diccionario fijó el que manda ahora — que es
  // el que habrá que traducir.
  let st=estado?{...estado}:{opRelleno:false,opTrazo:false,opm:null,
          dueñoRelleno:null,dueñoTrazo:null,csF:null,csS:null,colF:null,colS:null};
  const pila=[];
  const nums=()=>ops.filter(o=>o.t==='num').map(o=>o.v);
  const ultimoNombre=()=>{for(let k=ops.length-1;k>=0;k--)if(ops[k].t==='name')return ops[k].v;return null;};

  // Anota el pintado en el ExtGState que tiene la última palabra sobre la
  // sobreimpresión de ese tipo. `simulable` marca si Multiplicar aporta algo:
  // lo aporta en tintas Separation/DeviceN siempre, y en espacios de
  // dispositivo solo con /OPM 1 (con /OPM 0 se escriben todos los componentes,
  // así que no hay sobreimpresión visible). `blancoSinOpm1` marca el caso que
  // Multiplicar haría desaparecer y que debe calar.
  const registra=(tipo,familia,blanco)=>{
    stats.scanPintados++;
    const activo=tipo==='relleno'?st.opRelleno:st.opTrazo;
    const dueño=tipo==='relleno'?st.dueñoRelleno:st.dueñoTrazo;
    if(!activo||!dueño){stats.scanPintadosSinOP++;return;}
    let e=paints.get(dueño);
    if(!e){e={relleno:false,trazo:false,familias:new Set(),simulable:false,blancoSinOpm1:false};
      paints.set(dueño,e);}
    if(tipo==='relleno')e.relleno=true;else e.trazo=true;
    if(familia)e.familias.add(familia);
    const opm1=st.opm===1;
    if(blanco&&!opm1)e.blancoSinOpm1=true;
    if(!OP_DEVICE.has(familia)||opm1)e.simulable=true;
  };

  while(i<n){
    const c=src[i];
    if(c===' '||c==='\n'||c==='\r'||c==='\t'||c==='\f'||c==='\0'){i++;continue;}
    if(c==='%'){while(i<n&&src[i]!=='\n'&&src[i]!=='\r')i++;continue;}
    if(c==='/'){
      let j=i+1;while(j<n&&!OP_DELIM.test(src[j]))j++;
      ops.push({t:'name',v:src.slice(i+1,j)});i=j;continue;
    }
    if(c==='('){                                  // cadena literal, paréntesis anidados
      let j=i+1,nivel=1;
      while(j<n&&nivel>0){
        if(src[j]==='\\'){j+=2;continue;}
        if(src[j]==='(')nivel++;else if(src[j]===')')nivel--;
        j++;
      }
      ops.push({t:'str'});i=j;continue;
    }
    if(c==='<'){
      if(src[i+1]==='<'){ops.push({t:'dict'});i+=2;continue;}
      let j=i+1;while(j<n&&src[j]!=='>')j++;
      ops.push({t:'str'});i=j+1;continue;
    }
    if(c==='>'){i+=(src[i+1]==='>')?2:1;continue;}
    if(c==='['||c===']'){ops.push({t:'arr'});i++;continue;}
    if(c==='{'||c==='}'){i++;continue;}
    if((c>='0'&&c<='9')||c==='+'||c==='-'||c==='.'){
      let j=i;while(j<n&&((src[j]>='0'&&src[j]<='9')||src[j]==='+'||src[j]==='-'||src[j]==='.'))j++;
      ops.push({t:'num',v:parseFloat(src.slice(i,j))||0});i=j;continue;
    }
    let j=i;while(j<n&&!OP_DELIM.test(src[j]))j++;
    if(j===i){i++;continue;}
    const op=src.slice(i,j);i=j;

    if(op==='BI'){                                // imagen en línea: saltar hasta EI
      let k=src.indexOf('ID',i);
      if(k<0){break;}
      k+=2;
      while(k<n){
        const e=src.indexOf('EI',k);
        if(e<0){k=n;break;}
        const antes=src[e-1],despues=src[e+2];
        if(/[\s\0]/.test(antes||' ')&&(despues===undefined||OP_DELIM.test(despues))){k=e+2;break;}
        k=e+2;
      }
      i=k;
      // La imagen en línea usa el color de relleno en vigor si es máscara; sin
      // parsear su diccionario se registra de forma conservadora.
      registra('relleno',st.csF,opIsWhite(st.csF,st.colF));
      ops=[];continue;
    }

    switch(op){
      case'q':pila.push({...st});break;
      case'Q':if(pila.length)st=pila.pop();break;
      case'gs':{
        const nm=ultimoNombre();
        stats.scanGs++;
        const D=nm?opResolveGsName(ctx,cadenaRes,nm):null;
        if(!D){stats.scanGsNoResuelto++;break;}
        // /OP fija la sobreimpresión de trazo y, si el mismo diccionario no
        // trae /op, también la de relleno. /op solo la de relleno.
        const OP=opLookupBool(ctx,D,'OP'),op=opLookupBool(ctx,D,'op');
        const opm=opLookupNum(ctx,D,'OPM');
        if(OP!==null){
          st.opTrazo=OP;st.dueñoTrazo=D;
          if(op===null){st.opRelleno=OP;st.dueñoRelleno=D;}
        }
        if(op!==null){st.opRelleno=op;st.dueñoRelleno=D;}
        if(opm!==null)st.opm=opm;
        break;
      }
      case'cs':{const nm=ultimoNombre();st.csF=nm?opResolveCsName(ctx,res,nm):null;st.colF=null;break;}
      case'CS':{const nm=ultimoNombre();st.csS=nm?opResolveCsName(ctx,res,nm):null;st.colS=null;break;}
      case'sc':case'scn':st.colF=nums();break;
      case'SC':case'SCN':st.colS=nums();break;
      case'g':st.csF='gray';st.colF=nums();break;
      case'G':st.csS='gray';st.colS=nums();break;
      case'rg':st.csF='rgb';st.colF=nums();break;
      case'RG':st.csS='rgb';st.colS=nums();break;
      case'k':st.csF='cmyk';st.colF=nums();break;
      case'K':st.csS='cmyk';st.colS=nums();break;
      case'Do':{
        const nm=ultimoNombre();
        if(nm&&res instanceof PDFLib.PDFDict){
          const xoD=res.lookup(opName('XObject'));
          if(xoD instanceof PDFLib.PDFDict){
            const raw=xoD.get(opName(nm));
            const s=ctx.lookup(raw);
            if(s instanceof PDFLib.PDFStream){
              const sub=s.dict.get(opName('Subtype'));
              if(sub===opName('Image')){
                // Una máscara de imagen pinta con el color de relleno en vigor;
                // el resto, con su propio espacio de color.
                const esMascara=opLookupBool(ctx,s.dict,'ImageMask')===true;
                if(esMascara)registra('relleno',st.csF,opIsWhite(st.csF,st.colF));
                else registra('relleno',opCsFamily(ctx,s.dict.get(opName('ColorSpace')),0),false);
              }else if(sub===opName('Form')){
                // Se escanea una vez por combinación de (Form XObject, estado
                // de sobreimpresión heredado): el mismo XObject puede pintarse
                // varias veces con sobreimpresión distinta.
                const clave=(OP_REF(raw)||nm)+'|'+(st.opRelleno?'R':'-')+(st.opTrazo?'T':'-')+'|'+st.opm;
                if(!vistos.has(clave)){
                  vistos.add(clave);
                  const propios=s.dict.lookup(opName('Resources'));
                  opScanStream(opStreamText(s),ctx,
                    propios instanceof PDFLib.PDFDict?cadenaRes.concat([propios]):cadenaRes,
                    st,paints,vistos,(prof||0)+1,stats);
                }
              }
            }
          }
        }
        break;
      }
      default:
        if(OP_PINTA_RELLENO.has(op))registra('relleno',st.csF,opIsWhite(st.csF,st.colF));
        if(OP_PINTA_TRAZO.has(op))registra('trazo',st.csS,opIsWhite(st.csS,st.colS));
    }
    ops=[];
  }
}

// Escaneo completo del documento: páginas y, por separado, los patrones de
// mosaico (su «gs» vive dentro de la baldosa, que PDF.js rasteriza aparte).
function opCollectPaints(doc,stats){
  const ctx=doc.context,paints=new Map(),vistos=new Set();
  for(const page of doc.getPages()){
    const res=opPageResources(page.node,ctx);
    opScanStream(opPageText(ctx,page.node),ctx,[res],null,paints,vistos,0,stats);
    opScanPatterns(res,ctx,paints,vistos,0,stats);
  }
  return paints;
}

function opScanPatterns(res,ctx,paints,vistos,prof,stats){
  if(!(res instanceof PDFLib.PDFDict)||(prof||0)>8)return;
  const pat=res.lookup(opName('Pattern'));
  if(pat instanceof PDFLib.PDFDict){
    for(const[,raw]of pat.entries()){
      const clave='pat'+(OP_REF(raw)||Math.random());
      if(vistos.has(clave))continue;vistos.add(clave);
      const s=ctx.lookup(raw);
      if(!(s instanceof PDFLib.PDFStream))continue;
      const pt=s.dict.get(opName('PatternType'));
      if(!(pt instanceof PDFLib.PDFNumber)||pt.asNumber()!==1)continue;
      const propios=s.dict.lookup(opName('Resources'));
      opScanStream(opStreamText(s),ctx,propios instanceof PDFLib.PDFDict?[res,propios]:[res],
        null,paints,vistos,(prof||0)+1,stats);
    }
  }
  const xo=res.lookup(opName('XObject'));
  if(xo instanceof PDFLib.PDFDict){
    for(const[,raw]of xo.entries()){
      const clave='patx'+(OP_REF(raw)||Math.random());
      if(vistos.has(clave))continue;vistos.add(clave);
      const s=ctx.lookup(raw);
      if(!(s instanceof PDFLib.PDFStream))continue;
      if(s.dict.get(opName('Subtype'))!==opName('Form'))continue;
      opScanPatterns(s.dict.lookup(opName('Resources')),ctx,paints,vistos,(prof||0)+1,stats);
    }
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

// ---------------------------------------------------------------------------
// La decisión, con lo que dice el diccionario Y lo que dice el escaneo.
// ---------------------------------------------------------------------------
function opDecide(ctx,d,info,hayErrorEscaneo){
  if(!opFillOverprint(ctx,d)&&!opStrokeOverprint(ctx,d))return{traducir:false,motivo:'no-sobreimprime'};
  // Sin datos del escaneo: si algún content stream fue ilegible se cae del lado
  // de simular; si el escaneo fue completo, este estado no llega a pintar nada
  // (declarado y no usado, o su sobreimpresión la anula un gs posterior).
  if(!info)return hayErrorEscaneo
    ?{traducir:true,motivo:'sin-escaneo'}
    :{traducir:false,motivo:'no-llega-a-pintar'};
  // El blanco tiene prioridad: antes que simular, que cale.
  if(info.blancoSinOpm1)return{traducir:false,motivo:'blanco-debe-calar'};
  if(!info.simulable)return{traducir:false,motivo:'opm0-en-espacio-de-dispositivo'};
  return{traducir:true,motivo:'sobreimpresion-efectiva'};
}

// ---------------------------------------------------------------------------
// Recorrido de recursos y reescritura. `cadena` son los Form XObjects que
// envuelven a estos /Resources: si se traduce un ExtGState declarado dentro de
// uno de ellos, hay que quitarles el /Group, porque PDF.js compone los grupos
// de transparencia de XObject siempre aislados y el /BM quedaría inerte
// (medido en V3 frente a V3b).
// ---------------------------------------------------------------------------
function opWalkResources(res,ctx,st,paints,visited,cadena,prof){
  if(!(res instanceof PDFLib.PDFDict)||(prof||0)>32)return;
  const gs=res.lookup(opName('ExtGState'));
  if(gs instanceof PDFLib.PDFDict){
    for(const[clave,raw]of gs.entries()){
      const tag=OP_REF(raw);
      if(tag){if(visited.has('g'+tag))continue;visited.add('g'+tag);}
      const d=ctx.lookup(raw);
      if(!(d instanceof PDFLib.PDFDict))continue;
      const dec=opDecide(ctx,d,paints.get(d),st.scanError>0);
      if(!dec.traducir){
        if(dec.motivo==='blanco-debe-calar')st.blancoRespetado++;
        else if(dec.motivo==='opm0-en-espacio-de-dispositivo')st.opm0Respetado++;
        else if(dec.motivo==='no-llega-a-pintar')st.noAplica++;
        if(dec.motivo!=='no-sobreimprime'){
          st.opStates++;
          st.detalle.push({clave:String(clave),motivo:dec.motivo,traducido:false});
        }
        continue;
      }
      st.opStates++;
      const bm=ctx.lookup(d.get(opName('BM')));
      if(!opBlendIsNormal(bm)){
        st.keptBlend++;
        st.detalle.push({clave:String(clave),motivo:'ya-tiene-BM',traducido:false});
        console.log('Sobreimpresión — '+String(clave)+' sobreimprime pero ya tiene /BM '+bm+
          ': se deja como está (ya es transparencia real, PDF.js la resuelve).');
        continue;
      }
      d.set(opName('BM'),opName('Multiply'));
      st.translated++;
      st.detalle.push({clave:String(clave),motivo:dec.motivo,traducido:true});
      // Desaislar los Form XObjects que envuelven este estado.
      for(const forma of cadena){
        if(forma.dict.has(opName('Group'))){
          forma.dict.delete(opName('Group'));
          st.gruposNeutralizados++;
        }
      }
      if(st.enPatron)st.patronesInertes++;
    }
  }
  const xo=res.lookup(opName('XObject'));
  if(xo instanceof PDFLib.PDFDict){
    for(const[,raw]of xo.entries()){
      const tag=OP_REF(raw);
      if(tag){if(visited.has('x'+tag))continue;visited.add('x'+tag);}
      const s=ctx.lookup(raw);
      if(!(s instanceof PDFLib.PDFStream))continue;
      if(s.dict.get(opName('Subtype'))!==opName('Form'))continue;
      // A diferencia de la v30, en los grupos knockout SÍ se entra: saltarlos
      // dejaba sin simular todo su interior.
      opWalkResources(s.dict.lookup(opName('Resources')),ctx,st,paints,visited,
        cadena.concat([s]),(prof||0)+1);
    }
  }
  const pat=res.lookup(opName('Pattern'));
  if(pat instanceof PDFLib.PDFDict){
    for(const[,raw]of pat.entries()){
      const tag=OP_REF(raw);
      if(tag){if(visited.has('p'+tag))continue;visited.add('p'+tag);}
      const s=ctx.lookup(raw);
      if(!(s instanceof PDFLib.PDFStream))continue;
      const pt=s.dict.get(opName('PatternType'));
      if(!(pt instanceof PDFLib.PDFNumber)||pt.asNumber()!==1)continue;
      const antes=st.enPatron;st.enPatron=true;
      opWalkResources(s.dict.lookup(opName('Resources')),ctx,st,paints,visited,cadena,(prof||0)+1);
      st.enPatron=antes;
    }
  }
}

// Apariencias de anotación: los ExtGStates también pueden vivir aquí, así que
// se recorren por completitud. Ojo: no cambian el render de la herramienta,
// porque renderPdfPage() excluye siempre las anotaciones (annotationMode
// DISABLE en pdf-source.js).
function opWalkAnnots(pageNode,ctx,st,paints,visited){
  const annots=ctx.lookup(pageNode.get(opName('Annots')));
  if(!(annots instanceof PDFLib.PDFArray))return;
  for(let i=0;i<annots.size();i++){
    const a=ctx.lookup(annots.get(i));
    if(!(a instanceof PDFLib.PDFDict))continue;
    const ap=ctx.lookup(a.get(opName('AP')));
    if(!(ap instanceof PDFLib.PDFDict))continue;
    for(const[,rawEstado]of ap.entries()){
      const est=ctx.lookup(rawEstado);
      const flujos=est instanceof PDFLib.PDFStream?[est]
        :est instanceof PDFLib.PDFDict?[...est.entries()].map(([,r])=>ctx.lookup(r)):[];
      for(const f of flujos){
        if(!(f instanceof PDFLib.PDFStream))continue;
        opWalkResources(f.dict.lookup(opName('Resources')),ctx,st,paints,visited,[f],0);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reescritura completa: devuelve los bytes nuevos y el recuento.
// ---------------------------------------------------------------------------
async function rewritePdfForOverprint(bytes,opts){
  opts=opts||{};
  const st={opStates:0,translated:0,keptBlend:0,blancoRespetado:0,opm0Respetado:0,noAplica:0,
    gruposNeutralizados:0,patronesInertes:0,scanError:0,groupInjected:false,pages:0,ms:0,
    scanGs:0,scanGsNoResuelto:0,scanPintados:0,scanPintadosSinOP:0,scanEstados:0,
    enPatron:false,detalle:[]};
  const t0=performance.now();
  const doc=await PDFLib.PDFDocument.load(bytes,{ignoreEncryption:true,updateMetadata:false,throwOnInvalidObject:false});
  const ctx=doc.context;
  const paints=opCollectPaints(doc,st);
  st.scanEstados=paints.size;
  const visited=new Set();
  for(const page of doc.getPages()){
    st.pages++;
    opWalkResources(opPageResources(page.node,ctx),ctx,st,paints,visited,[],0);
    opWalkAnnots(page.node,ctx,st,paints,visited);
    if(!page.node.has(opName('Group'))){
      page.node.set(opName('Group'),ctx.obj({S:'Transparency',CS:'DeviceRGB',I:true}));
      st.groupInjected=true;
    }
  }
  const out=await doc.save({useObjectStreams:false,updateFieldAppearances:false});
  st.ms=Math.round(performance.now()-t0);
  delete st.enPatron;
  return{bytes:out,stats:st};
}

// Prepara la caché por archivo: bytes originales, bytes reescritos y recuento.
// Si pdf-lib no puede con el archivo, `rew` queda a null y `stats.error`
// explica por qué; entonces la simulación se deshabilita para AMBOS archivos
// (nunca se aplica a uno solo).
async function prepareOverprint(orig,label){
  if(typeof PDFLib==='undefined'){
    return{orig,rew:null,stats:{error:'pdf-lib no disponible'},applied:false};
  }
  try{
    const{bytes,stats}=await rewritePdfForOverprint(orig.slice());
    console.log(`Sobreimpresión — ${label||'documento'}: ${stats.opStates} estados sobreimprimen, `+
      `${stats.translated} traducidos a Multiplicar, ${stats.keptBlend} ya con fusión propia, `+
      `${stats.blancoRespetado} blancos que deben calar, ${stats.opm0Respetado} con OPM 0 en espacio de `+
      `dispositivo, ${stats.noAplica} que no afectan a lo pintado, ${stats.gruposNeutralizados} grupos `+
      `desaislados (${stats.ms} ms)`);
    if(stats.patronesInertes)console.warn('Sobreimpresión — '+stats.patronesInertes+
      ' estado(s) dentro de un patrón de mosaico: PDF.js rasteriza la baldosa aparte, así que ahí la '+
      'simulación no tiene efecto.');
    if(stats.scanError)console.warn('Sobreimpresión — '+stats.scanError+
      ' content stream(s) ilegibles: esos estados se simulan por defecto.');
    return{orig,rew:bytes,stats,applied:false};
  }catch(err){
    console.warn('Sobreimpresión — no se pudo reescribir '+(label||'')+': ',err);
    return{orig,rew:null,stats:{error:err.message||String(err)},applied:false};
  }
}

// ---------------------------------------------------------------------------
// Botón «Sobreimprimir» e indicador. Vive bajo «Alinear archivos», junto al
// bloqueo de escala 1:1, y es GLOBAL a los dos archivos: la reescritura se
// aplica siempre por igual a A y a B, porque aplicarla a uno solo fabricaría
// diferencias falsas en la comparación.
// ---------------------------------------------------------------------------
const overprintRowEl=document.getElementById('renderOptionsRow');
const overprintBtnEl=document.getElementById('overprintToggle');
const overprintInfoEl=document.getElementById('overprintInfo');

let overprintSimEnabled=false;   // apagado por defecto: sin autoactivación

function isOverprintSimActive(){return overprintSimEnabled;}

function opSources(){
  const out=[];
  if(typeof sourceA!=='undefined'&&sourceA&&sourceA.overprint)out.push(['A',sourceA]);
  if(typeof sourceB!=='undefined'&&sourceB&&sourceB.overprint)out.push(['B',sourceB]);
  return out;
}

// Estado del botón y recuento de ExtGStates traducidos en cada archivo.
function opDescribe(){
  const fuentes=opSources();
  if(!fuentes.length)return'';
  const partes=fuentes.map(([w,s])=>{
    const st=s.overprint.stats;
    if(st.error)return w+': no se pudo analizar';
    if(!st.opStates)return w+': sin sobreimpresión';
    return w+': '+st.translated+(st.translated===1?' estado':' estados');
  });
  return(overprintSimEnabled?'Activa':'Desactivada')+' · '+partes.join(' · ');
}

// Garantiza que cada fuente PDF está abierta con los bytes que corresponden al
// estado del botón, reabriendo las que no lo estén. Conserva los puntos de
// alineación (por eso no se usa onPdfSourceUpdated, que los borra); solo
// invalida la comparación.
async function syncOverprintMode(opts){
  opts=opts||{};
  const fuentes=opSources();
  const fallidas=fuentes.filter(([,s])=>s.overprint.stats.error);
  if(fallidas.length){
    overprintSimEnabled=false;
    overprintBtnEl.disabled=true;
  }else{
    overprintBtnEl.disabled=false;
  }
  const habiaComparacion=typeof pixelDEmap!=='undefined'&&!!pixelDEmap;
  let reabierta=false;
  for(const[which]of fuentes){
    if(typeof reopenPdfSource!=='function')break;
    try{
      if(await reopenPdfSource(which))reabierta=true;
    }catch(err){
      status.textContent='Error al reabrir el archivo '+which+': '+err.message;
    }
  }
  if(reabierta){
    if(typeof hideResults==='function')hideResults();
    if(typeof sourceA!=='undefined'&&sourceA&&sourceB&&typeof initAlignCanvas==='function'){
      initAlignCanvas('A',sourceA);initAlignCanvas('B',sourceB);
      if(typeof positionAllMarkers==='function'){positionAllMarkers('A');positionAllMarkers('B');}
      if(typeof drawAlignCoverage==='function')drawAlignCoverage();
    }
    if(opts.fromToggle){
      status.textContent=habiaComparacion
        ?`Render actualizado ${overprintSimEnabled?'con':'sin'} sobreimpresión: la comparación anterior ya no vale, vuelve a comparar.`
        :`Render actualizado ${overprintSimEnabled?'con':'sin'} sobreimpresión.`;
    }
  }
  updateOverprintUI();
}

function updateOverprintUI(){
  const fuentes=opSources();
  overprintRowEl.style.display=fuentes.length?'inline-flex':'none';
  overprintBtnEl.setAttribute('aria-pressed',overprintSimEnabled?'true':'false');
  overprintInfoEl.textContent=opDescribe();
}

function resetOverprintUI(){
  overprintSimEnabled=false;
  overprintBtnEl.setAttribute('aria-pressed','false');
  overprintBtnEl.disabled=false;
  overprintInfoEl.textContent='';
  overprintRowEl.style.display='none';
}

overprintBtnEl.onclick=async()=>{
  overprintSimEnabled=!overprintSimEnabled;
  overprintBtnEl.setAttribute('aria-pressed',overprintSimEnabled?'true':'false');
  overprintBtnEl.disabled=true;
  try{await syncOverprintMode({fromToggle:true});}
  finally{if(!opSources().some(([,s])=>s.overprint.stats.error))overprintBtnEl.disabled=false;}
};
