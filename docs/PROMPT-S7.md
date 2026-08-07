# escaner_disco — Sesión S7

Continuación de S6 (código desacoplado de macOS, `platform_support.py` en su sitio, repo público al día).

Objetivo único: añadir una vista treemap como alternativa al sunburst, en pestañas. Mismos datos, otro renderizado.

Se mantienen las restricciones de siempre: front vanilla sin frameworks ni CDN, código y commits en inglés.

Regla dura de esta sesión: no se toca ni una línea de Python. `scanner.py`, `server.py`, `cache.py` y `platform_support.py` quedan exactamente como están. S6 va a validarse en Windows en unos días; si algo falla allí, tiene que estar claro que la causa es el refactor de S6 y no esta sesión. Verificación al final:

```zsh
git diff --stat HEAD~N -- '*.py'    # debe estar vacío
```

No hagas `git push`. El push lo hago yo a mano.

Guarda este fichero directamente en `docs/PROMPT-S7.md`, no en la raíz. Si incluye rutas con mi nombre de usuario local, sustitúyelas por `TU_USUARIO` antes de guardarlo.

## Decisiones ya tomadas (no las replantees)

1. Pestañas, no vista partida. Sunburst y treemap ocupan el mismo hueco. Comparten breadcrumb, lista, zoom y estado. En un portátil de 13" dos gráficos simultáneos dejan cada uno en ~300 px y el treemap se vuelve ilegible.
2. Treemap anidado a 2 niveles, no plano. Ver los nietos es donde el treemap gana de verdad al sunburst: se lee de un vistazo que el peso está en `Library/Caches/algo` sin tener que bajar.
3. Mismo esquema de color que el sunburst. La función de color ya existe: tono derivado del índice del hijo dentro de su padre, heredado del ancestro de primer nivel. Reutilízala tal cual. Cambiar de pestaña debe conservar la lectura: lo que era azul sigue siendo azul.

## Tarea 1 — Conmutador de vista

Sobre el gráfico, junto al breadcrumb, dos pestañas: Sunburst | Treemap.

* Cambiar de pestaña no recarga datos ni resetea el zoom: el nodo actual, el breadcrumb y la lista se mantienen. Solo cambia el renderizador.
* La pestaña elegida se recuerda entre sesiones en `localStorage` (clave `escaner_disco.view`). Si el valor guardado no es válido, sunburst.
* Son `<button>` reales con `aria-pressed`, alcanzables por teclado.
* Al cambiar de pestaña, el gráfico oculto se desmonta del DOM, no se deja con `display: none`. Con miles de nodos, dos árboles SVG vivos es memoria y tiempo de layout tirados.

## Tarea 2 — El treemap (`static/app.js`)

### 2.1 Algoritmo

Squarified treemap (Bruls, Huizing & van Wijk). No uses slice-and-dice: con 40 hijos de tamaños muy dispares produce tiras de 2 px de ancho, ilegibles e imposibles de clicar.

La idea, para que no haya que buscarla:

1. Ordena los hijos por tamaño descendente.
2. Recorre el lado más corto del rectángulo disponible, acumulando elementos en una fila.
3. Añade el siguiente elemento a la fila solo si mejora (baja) la peor relación de aspecto de la fila. Si la empeora, cierra la fila, réstale su área al rectángulo disponible y empieza otra.
4. Repite sobre el rectángulo restante.

Escríbelo como función pura y aislada:

```js
function squarify(items, rect) // items: [{size, ...}] ordenados desc
                               // rect: {x, y, w, h}
                               // devuelve: [{...item, x, y, w, h}]
```

Que sea pura importa: es la única parte de esta sesión con lógica no trivial y así se puede probar a mano en la consola.

### 2.2 Anidamiento a 2 niveles

* Nivel 1: los hijos directos del nodo actual, colocados con `squarify` sobre el lienzo completo.
* Cada rectángulo de nivel 1 reserva una cabecera de 18 px arriba con el nombre y, si cabe, el tamaño. El resto del rectángulo, con 2 px de padding interior, se subdivide con `squarify` entre sus hijos (nivel 2).
* Umbrales, no negociables:
   * Un rectángulo de nivel 1 con menos de 60×40 px no se subdivide: se pinta macizo con su color y, si cabe, su nombre. Meter nietos ahí produce confeti.
   * Un rectángulo de cualquier nivel con menos de 3 px en cualquier lado no se dibuja. Es invisible, no se puede clicar y multiplica los nodos del DOM.
   * El texto se dibuja solo si el rectángulo lo admite entero. Nada de elipsis a mitad de palabra ni texto desbordado: si no cabe, no se pinta y el tooltip lo cuenta.
* Los nietos necesitan que el nodo actual venga con `depth >= 2`. El front ya pide `/api/node` con profundidad; asegúrate de que la vista treemap dispone de los nietos y, si el nodo está `truncated`, pide más profundidad antes de pintar, igual que hace el sunburst al hacer zoom.

### 2.3 SVG, no divs

`<rect>` dentro del mismo `<svg>` responsive que ya usa el proyecto, con `viewBox`. Motivo: reutiliza el sistema de coordenadas, el escalado y los patrones de eventos que ya existen para el sunburst, y el texto se recorta con `clipPath` sin pelearse con el flujo del documento.

A diferencia del sunburst, el lienzo no es cuadrado: usa la proporción del contenedor (aproximadamente 4:3). Un treemap cuadrado desperdicia ancho.

### 2.4 Interacción — idéntica a la del sunburst

* Hover: resalta el rectángulo, resalta la fila correspondiente de la lista y muestra el mismo tooltip (ruta, tamaño humano, % respecto al nodo actual). La sincronización con la lista debe funcionar en los dos sentidos y para los nietos también: al pasar por un nieto se resalta la fila de su padre.
* Clic: zoom, exactamente igual que en el sunburst. Clic en un nieto baja dos niveles de golpe.
* Casos especiales, coherentes con las decisiones ya tomadas:
   * Nodos `unreadable`: tamaño 0 → área 0 → no se dibujan. Igual que en el sunburst. No les inventes un tamaño mínimo: falsearía el gráfico, que es lo único que esta herramienta no se puede permitir. La lista y el banner son el canal para esa información.
   * Nodos `synthetic` ("Otros (N elementos)"): se dibujan (tienen tamaño real) pero no hacen zoom ni se subdividen: no hay ruta detrás.

### 2.5 Rendimiento

El caso peor es 40 hijos × 40 nietos = 1.600 rectángulos, y los umbrales de la 2.2 recortan bastantes. Aun así:

* Construye el SVG en un `DocumentFragment` y móntalo de una vez. Nada de `appendChild` en bucle sobre el árbol vivo.
* Delega los eventos en el `<svg>` contenedor, un solo listener, no 1.600.
* Al redimensionar la ventana, repinta con `requestAnimationFrame` y un debounce de ~150 ms.

Checkpoint: mide el tiempo de pintado del treemap en la raíz de `/System/Volumes/Data` y dime la cifra. Si pasa de 100 ms, páralo y lo hablamos antes de seguir.

## Tarea 3 — Estilos (`static/style.css`)

* Bordes de 1 px entre rectángulos, en el color de fondo, para que se separen sin añadir una paleta nueva.
* Cabeceras de nivel 1 con el color del nodo algo más oscuro, texto en `var(--text)`.
* Texto de nivel 2 en `var(--muted)`, tamaño menor.
* El resaltado de hover es el mismo tratamiento que ya usa el sunburst (no inventes uno nuevo).
* Las pestañas siguen el estilo del resto de la UI: discretas, tema oscuro, sin colores nuevos.

## Tarea 4 — Documentación

### 4.1 `README.md` (inglés, canónico)

* Menciona la vista treemap en la descripción y en la sección de uso.
* En Design decisions, un párrafo nuevo: por qué squarified y no slice-and-dice (relación de aspecto: las tiras finas son ilegibles e inclicables), por qué 2 niveles y no N (legibilidad frente a confeti), y por qué los nodos ilegibles siguen sin dibujarse también aquí.
* Si el README tiene captura, no hace falta añadir otra: lo indico yo si quiero.

### 4.2 `README.es.md`

Mismo cambio, en español (España).

### 4.3 `docs/PROMPT-S7.md`

Este mismo fichero, con el nombre de usuario sustituido por `TU_USUARIO`.

## Criterios de aceptación

1. Las dos pestañas funcionan y conservan el nodo actual y el breadcrumb al alternar.
2. La pestaña elegida sobrevive a recargar la página.
3. El treemap muestra dos niveles: hijos con cabecera y nietos dentro.
4. Ningún rectángulo de menos de 3 px de lado en el DOM. Ningún texto desbordado ni cortado a mitad.
5. Hover sincroniza en ambos sentidos con la lista, incluidos los nietos.
6. Clic hace zoom igual que el sunburst. Los nodos "Otros (N elementos)" no hacen zoom.
7. Las carpetas con candado no aparecen en el treemap (área 0), y siguen en la lista.
8. Redimensionar la ventana repinta sin romper el layout.
9. Tiempo de pintado en la raíz de un escaneo completo por debajo de 100 ms, medido e indicado.
10. `git diff --stat` sobre los commits de la sesión no toca ningún `.py`.
11. `git ls-files -z | xargs -0 grep -ln "TU_USUARIO"` vacío.
12. El resto de la app funciona igual que en S6: escaneo, caché, `/api/reveal`, banner de errores.

## Al terminar

Commits en inglés y granulares, separando algoritmo / vista y pestañas / estilos / docs.

Verifica la autoría antes de cerrar (no fuerces `-c` en los comandos de git, fue la causa del problema en S4):

```zsh
git log -5 --format='%h %an <%ae>'
```

No configures remoto ni hagas push.
