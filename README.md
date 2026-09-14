# Comparador ΔE

Herramienta web para comparar dos versiones de un mismo diseño (por ejemplo, artes finales de envases) y detectar diferencias de color y de texto entre ambas.

Funciona íntegramente en el navegador: los archivos nunca se suben a ningún servidor, todo el procesamiento (lectura de PDF, OCR, cálculo de color) ocurre localmente en el equipo del usuario.

## Funcionalidades

- **Comparación píxel a píxel** en espacio Lab usando la fórmula **CIEDE2000**, con umbral de tolerancia ΔE ajustable.
- **Formatos de entrada**: PDF, .ai, SVG, JPG, PNG.
- **Alineación por elementos vectoriales** (método recomendado para PDF/.ai/SVG): se hace clic sobre un elemento real del diseño en el archivo A y la app detecta automáticamente el elemento equivalente en B por similitud de forma; con un punto de ancla se calcula la traslación, y con dos se calculan además escala y rotación.
- **Escala bloqueada a 1:1** entre archivos vectoriales: entre revisiones el arte no se escala, así que entre dos PDF/.ai solo se calcula el desplazamiento (en puntos PDF), B se renderiza ya desplazada sin remuestreo y se compara únicamente la intersección física de ambas páginas. Se puede desbloquear si un archivo fue reescalado.
- **Alineación manual** por puntos de referencia, como método alternativo (zoom y desplazamiento incluidos).
- **Ajuste fino por teclado** de los puntos/anclas de alineación (flechas = 1 px, Shift + flechas = 10 px).
- **Verificación de la alineación**: avisos automáticos si la escala, la rotación o la cobertura entre ambos archivos quedan fuera de rango, con resaltado de las zonas de A sin correspondencia en B.
- **Vistas de resultado**: overlay de diferencias y mapa de calor ΔE.
- **Análisis de texto** con OCR (vía [Tesseract.js](https://github.com/naptha/tesseract.js), idiomas español e inglés incluidos) para detectar cambios de texto entre ambas versiones.
- **Selección de regiones** para acotar el análisis a una zona concreta del diseño.
- **Exportación** de la vista actual y de un informe de la comparación.

## Uso

Abre `index.html` en un navegador moderno (Chrome, Edge o Firefox), o accede a la versión publicada en GitHub Pages. Carga el archivo A y el archivo B, ajusta el umbral ΔE si hace falta y pulsa "Comparar".

No requiere instalación, dependencias de Node ni build: es HTML/CSS/JS estático con las librerías de terceros ya incluidas en `lib/`.

## Estructura

| Archivo | Responsabilidad |
|---|---|
| `index.html` | Interfaz y estilos |
| `app.js` | Orquestación general: ciclo de vida de archivos, pestañas, comparación, exportación |
| `de-worker.js` | Web Worker que calcula la diferencia de color ΔE2000 |
| `pdf-source.js` | Carga y rasterizado de PDF/.ai/SVG (vía pdf.js) |
| `align.js` | Alineación manual de las dos imágenes por puntos de referencia |
| `vector-picker.js` | Alineación por elementos vectoriales: selección, matching automático y vista previa de la transformación |
| `vector-geometry.js` | Extracción de geometría vectorial desde SVG/PDF/.ai y detección de coincidencias por forma |
| `physical-align.js` | Alineación con escala bloqueada 1:1 entre PDF/.ai: desplazamiento en puntos, render de B desplazado e intersección de páginas |
| `similarity.js` | Cálculo de la transformación (traslación, escala, rotación) y de la máscara de cobertura entre A y B |
| `nudge.js` | Ajuste fino por teclado de los puntos/anclas de alineación |
| `canvas-view.js` | Renderizado de overlay y mapa de calor |
| `regions-panel.js` | Selección de regiones de análisis |
| `text-analysis.js` | OCR y comparación de texto (vía Tesseract.js) |
| `DESIGN.md` | Tokens visuales de marca usados en la interfaz |

## Librerías de terceros

Incluidas en `lib/` y con licencia propia (Apache 2.0):

- [pdf.js](https://github.com/mozilla/pdf.js) — Mozilla
- [Tesseract.js](https://github.com/naptha/tesseract.js) — naptha

## Licencia

MIT — ver [LICENSE](LICENSE).
