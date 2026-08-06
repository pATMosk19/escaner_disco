# escaner_disco — Sesión S4

Continuación de S3 (repo ya publicado en GitHub, público, MIT, un solo commit).

Objetivo: añadir **"Mostrar en Finder"** y **"Copiar ruta"** por fila de la lista.
Es la primera acción de la app con efecto fuera del proceso, así que la mitad del
trabajo es blindaje.

Se mantienen las restricciones de siempre: Python 3 solo stdlib, front vanilla sin
frameworks ni CDN, código y commits en inglés.

**No hagas `git push`.** El push lo hago yo a mano.

---

## Principio revisado: qué significa "solo lectura"

Hasta ahora "solo lectura" mezclaba dos ideas. A partir de S4 se separan:

- **La app nunca modifica el sistema de archivos.** Sigue siendo absoluto, sin
  excepciones. `open -R` lo respeta: solo abre una ventana de Finder.
- *Ningún endpoint tiene efectos laterales.* Esto se rompe deliberadamente, una
  sola vez, con `POST /api/reveal`.

Documenta esta distinción en el README (ver tarea 4). No la dejes implícita.

---

## Tarea 1 — `POST /api/reveal` en `server.py`

Nuevo endpoint. Body JSON: `{"path": "/Users/you/Downloads"}`.

Responde `{"ok": true}` con `200`, o `{"ok": false, "error": "..."}` con el
código que corresponda.

### Blindaje (todos los puntos son obligatorios)

El servidor escucha en `127.0.0.1:8765` **sin autenticación**. Cualquier página
web abierta en otra pestaña puede hacerle peticiones. Hoy eso solo permite leer
el árbol; un endpoint que lanza procesos sube el listón. Por eso:

1. **Solo `POST`.** Un `GET` lo dispararía cualquier web con
   `<img src="http://127.0.0.1:8765/api/reveal?path=...">`. Si llega `GET`,
   responde `405`.
2. **La ruta debe existir en el árbol escaneado.** Resuélvela caminando el árbol
   desde la raíz, exactamente igual que hace `/api/node`. Si no está, `404` y no
   se ejecuta nada. **Esta es la defensa principal**: no se acepta una ruta
   arbitraria del sistema, solo una que el propio escaneo haya producido.
3. **Nodos sintéticos no.** Si el nodo resuelto tiene `synthetic: true` (los
   "Otros (N elementos)"), responde `400`: no corresponde a una ruta real.
4. **Cabecera `Origin`.** Si la petición trae `Origin` y no es exactamente
   `http://127.0.0.1:8765`, responde `403`. Si no trae `Origin`, se acepta
   (es lo que hace `fetch` mismo-origen en algunos casos).
5. **Ejecución:** `subprocess.run(["open", "-R", path], timeout=5)`.
   - **Nunca `shell=True`.** Lista de argumentos siempre.
   - **Nunca `open` sin `-R`.** Sin `-R`, `open` *ejecuta* la aplicación asociada
     al fichero. Con `-R` solo lo revela en Finder. La diferencia entre las dos
     formas es la diferencia entre una utilidad y un agujero de seguridad.
   - Captura `subprocess.SubprocessError` y `OSError`, devuelve `500` con el
     mensaje. No dejes que tumbe el hilo del servidor.
6. Deja un comentario en el código, sobre el handler, explicando por qué existe
   cada una de estas comprobaciones. El próximo que lo lea tiene que entender que
   no son paranoia decorativa.

`/api/reveal` es el **único** endpoint con efectos laterales. Ninguno de los otros
cambia.

---

## Tarea 2 — Acciones por fila en el front

En cada fila de la lista, dos acciones que aparecen **al hacer hover sobre la
fila** (ocultas el resto del tiempo, para no ensuciar una tabla densa):

- **Mostrar en Finder** → `POST /api/reveal` con la ruta de la fila.
- **Copiar ruta** → `navigator.clipboard.writeText(path)`. No toca el servidor.

### Detalles

- Alineadas a la derecha de la fila. Iconos o texto corto, tú decides, pero que
  no descoloquen la barra de proporción ni el porcentaje al aparecer: reserva el
  hueco siempre, cambia solo la opacidad.
- El clic en una acción **no debe propagar** al `click` de la fila (que hace
  zoom). `stopPropagation()`.
- **Filas `unreadable` (candado):** "Copiar ruta" sí, "Mostrar en Finder"
  también — Finder puede revelar una carpeta que el scanner no pudo abrir, y de
  hecho es útil para ir a mirarla.
- **Filas sintéticas ("Otros (N elementos)"):** ninguna de las dos acciones. No
  hay ruta detrás.
- **Feedback:** confirmación breve y efímera (~1,5 s) junto a la fila, tanto en
  éxito como en error. Si `/api/reveal` falla, muestra el mensaje del servidor.
  Nada de `alert()`.
- Accesibilidad: son `<button>` reales con `aria-label`, alcanzables por teclado.
  El hover controla la opacidad, no la existencia en el DOM.

---

## Tarea 3 — CLI

En `scanner.py`, sin cambios de comportamiento. Solo si es trivial: nada.
Esta tarea existe para que quede claro que **el scanner no se toca en S4**.

---

## Tarea 4 — Documentación

### 4.1 `README.md` (inglés, canónico)

- En **Design decisions**, sustituye el párrafo de "read-only, no exceptions" por
  la versión matizada: la app nunca modifica el sistema de archivos, y hay
  exactamente un endpoint con efecto lateral (`POST /api/reveal`, que abre
  Finder). Explica por qué se considera seguro: `open -R` no ejecuta nada, la
  ruta tiene que existir en el árbol escaneado, y el endpoint es `POST` con
  comprobación de `Origin`.
- Añade `POST /api/reveal` a la lista de endpoints si el README la tiene.

### 4.2 `README.es.md`

Mismo cambio, en español (España).

### 4.3 `docs/PROMPT-S4.md`

Añade este mismo fichero.

### 4.4 Saneado

Antes de commitear, verifica que no has reintroducido rutas personales:

```zsh
grep -rn "you" . --exclude-dir=.git
```

No debe devolver nada.

---

## Criterios de aceptación

1. Hover sobre una fila muestra las dos acciones; el resto del tiempo no se ven
   y la fila no se descoloca al aparecer.
2. "Mostrar en Finder" abre Finder con el elemento seleccionado.
3. "Copiar ruta" deja la ruta en el portapapeles.
4. Clic en cualquiera de las dos **no** hace zoom en la fila.
5. `GET /api/reveal` devuelve `405`. `POST` con una ruta que no está en el árbol
   (p. ej. `/etc/passwd` si no se escaneó) devuelve `404` sin ejecutar nada.
6. `POST` con `Origin: http://evil.example` devuelve `403`.
7. Las filas "Otros (N elementos)" no muestran acciones.
8. `grep -rn "you" . --exclude-dir=.git` vacío.
9. El resto de la app funciona igual que en S3.

### Comprobación manual del blindaje

```zsh
curl -i "http://127.0.0.1:8765/api/reveal?path=/etc"                    # 405
curl -i -X POST -d '{"path":"/etc/passwd"}' http://127.0.0.1:8765/api/reveal   # 404
curl -i -X POST -H "Origin: http://evil.example" \
  -d '{"path":"/Users/you"}' http://127.0.0.1:8765/api/reveal            # 403
```

## Al terminar

Commits en inglés y granulares, separando servidor / frontend / docs.
No configures remoto ni hagas push.
