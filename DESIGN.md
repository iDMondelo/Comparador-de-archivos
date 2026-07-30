# DESIGN.md — Tokens DMondelo (resumen)

Extraído de [`design-system/tokens/`](design-system/tokens/) y [`design-system/uploads/DESIGN.md`](design-system/uploads/DESIGN.md). Charcoal para texto, navy para acción, oro como relleno/regla — nunca como tipografía. Ver la fuente completa para el sistema entero (marketing, mock, componentes React); aquí solo lo necesario para reutilizar los tokens en herramientas/producto.

## Colores

| Token | Valor | Uso |
|---|---|---|
| `--primary` (navy) | `#0f456e` | Acción: botones, links, foco. 10:1 en blanco |
| `--primary-deep` | `#0b3758` | Hover de navy |
| `--primary-press` | `#082943` | Pressed de navy |
| `--primary-bg-subdued-hover` | `#dce8f1` | Fondo tag/tab activa (navy suave) |
| `--accent-gold` | `#dfa01f` | Relleno/regla/bloque. **Nunca tipografía** (2.3:1) |
| `--accent-gold-deep` | `#8a6210` | El único oro válido para texto (5.5:1) |
| `--ink` | `#454b4f` | Texto por defecto. 8.9:1 |
| `--ink-secondary` | `#5e6569` | Texto secundario |
| `--ink-mute` | `#6f767a` | Texto de apoyo, captions. Suelo de contraste 4.6:1 |
| `--canvas` | `#ffffff` | Fondo de página / tarjetas |
| `--canvas-soft` | `#f7f7f8` | Banda casi blanca |
| `--canvas-tint` | `#e0e1de` | Banda/tarjeta gris |
| `--hairline` | `#d6d9da` | Bordes de tarjeta |
| `--hairline-input` | `#c3c6c7` | Bordes de formulario |
| `--on-primary` | `#ffffff` | Texto sobre navy |

## Tipografía

Familia: **Montserrat** (texto, pesos 300–700) + **Playfair Display Bold Italic** (solo display, ≥24px).

| Token | Tamaño | Peso | Uso |
|---|---|---|---|
| `--heading-lg` | 22px | 600 | Títulos de tarjeta |
| `--heading-md` | 20px | 600 | Subtítulo |
| `--body-md` | 15px | 400 | Cuerpo de interfaz por defecto |
| `--caption` | 13px | 400 | Ayuda, etiquetas de tabla |
| `--micro-cap` | 10px | 700, versalitas, tracking +1px | Eyebrows y etiquetas todo-mayúsculas |
| `--button-sm` | 14px | 600, tracking +0.14px | Botones compactos |

Números que representan cantidades o medidas: `font-feature-settings:"tnum"` (cifras tabulares).

## Espaciado

Unidad base 8px: `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 24 · `--space-6` 32.

## Radios

| Token | Valor | Uso |
|---|---|---|
| `--radius-xs` | 4px | Chrome de tabla, tags con hairline |
| `--radius-sm` | 6px | Inputs de formulario |
| `--radius-md` | 8px | Tarjetas compactas, alertas |
| `--radius-lg` | 12px | Chrome de producto/dashboard (con sombra sutil) |
| `--radius-xl` | 16px | Chrome de mockup de producto (paneles grandes) |
| `--radius-pill` | 9999px | Todos los botones y tags |

## Elevación

Nivel 0 (plano) es la respuesta por defecto. `--elevation-1` (`rgba(15,34,51,.06) 0 1px 2px`) para tarjetas con leve relieve; `--elevation-2` (`rgba(15,34,51,.08) 0 8px 24px`) solo para paneles flotantes o chrome de mockup de producto. Nada de gradientes ni desenfoques.

## Aplicación en `index.html`

La herramienta pasa de tema oscuro genérico a la piel DMondelo: fondo claro (`--canvas-soft`), texto `--ink`, acción `--primary` (navy), botones y tabs en `--radius-pill`, tarjetas de estadísticas en `--radius-md` con `--elevation-1`, contenedores de imagen en `--radius-lg`, zona de carga en `--radius-xl`, cifras de resultado en `--heading-lg` con `tnum`, etiquetas todo-mayúsculas unificadas al patrón `--micro-cap`.

**Excepciones deliberadas, no ligadas a marca** (no tocar sin razón funcional):
- Fondo del visor de imagen (`--viewer-bg:#000`): negro neutro para no sesgar la percepción de color al inspeccionar las imágenes.
- Color del cursor/retícula de alineación (`--marker`): mantiene alto contraste sobre fotografías arbitrarias; el navy de marca se perdería sobre muchas imágenes.
- Colores de severidad ΔE (`--sev-high/mid/low`) y la paleta del mapa de calor: son salida del propio algoritmo de comparación, no decoración — no se tocan.
- Color de los recuadros de zonas de diferencia (`--region-mark:#FF00FF`): deliberadamente distinto de `--sev-*` para no confundirse con la leyenda de severidad ΔE (verde/naranja/rojo) ni perderse sobre artwork de packaging, donde el verde y el cian aparecen con frecuencia.
