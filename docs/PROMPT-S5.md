# escaner_disco — Sesión S5

Continuación de S4 (repo público en GitHub, 5 commits sobre el release inicial).

Objetivo único: **cachear el árbol escaneado a disco** para no reescanear en cada
arranque. Hoy son ~35 s de espera antes de poder mirar nada.

Se mantienen las restricciones de siempre: Python 3 solo stdlib, front vanilla sin
frameworks ni CDN, código y commits en inglés.

**No hagas `git push`.** El push lo hago yo a mano.

---

## Principio revisado: qué modifica la app

S4 dejó dos principios. El primero se matiza aquí:

- **La app nunca toca ficheros del usuario.** Sigue siendo absoluto. Lo que S5
  añade es que la app gestiona **sus propios ficheros de caché**, en su propio
  directorio, que ella misma ha creado.
- *Ningún endpoint tiene efectos laterales.* Ya roto en S4 con `/api/reveal`.
  S5 añade `/api/cache` (guardar implícito, listar, borrar).

Documenta la distinción en ambos README (tarea 5). El matiz importa: "no borra
nada" y "no borra nada tuyo" no son la misma promesa, y la segunda es la que
podemos cumplir.

---

## Tarea 1 — Módulo de caché (`cache.py`, nuevo)

Fichero nuevo en la raíz. Todo lo relativo a la caché vive aquí; `server.py` solo
lo llama.

### Ubicación y permisos

```
~/Library/Application Support/escaner_disco/
```

- Crear el directorio si no existe, con **modo 0700**.
- Cada fichero de caché con **modo 0600**.
- **Nunca dentro del proyecto.** El fichero es un mapa completo de los nombres de
  las carpetas del usuario. Añade `*.json.gz` al `.gitignore` igualmente, por si
  alguien cambia la ruta.

### Nombre del fichero

Un fichero por ruta escaneada, para poder tener varias cachés a la vez:

```
<sha256(ruta_absoluta)[:16]>.json.gz
```

La ruta original va **dentro** del JSON, no en el nombre del fichero.

### Formato

`json` + `gzip`, ambos de stdlib. Nada de `pickle`: deserializar pickle ejecuta
código, y esta herramienta no puede permitirse esa clase de riesgo ni siquiera en
un fichero propio.

Estructura:

```json
{
  "format_version": 1,
  "root_path": "/System/Volumes/Data",
  "scanned_at": 1754509620.0,
  "elapsed": 35.1,
  "total_size": 123600000000,
  "n_files": 1208540,
  "errors": 233,
  "error_paths": ["...", "..."],
  "max_children": 40,
  "tree": { ... }
}
```

- `tree` es el árbol serializado de forma compacta. Cada nodo:
  `{"n": name, "s": size, "f": n_files, "d": is_dir, "u": unreadable,
  "y": synthetic, "c": [hijos]}`. Omite las claves cuyo valor sea el de por
  defecto (`false`, `0`, sin hijos) — con 200-400k nodos, las claves cortas y las
  omisiones son la diferencia entre 30 MB y 8 MB.
- **`max_children` se guarda y se comprueba al cargar.** Si el fichero se generó
  con un `MAX_CHILDREN` distinto al del código actual, la caché no vale: se
  ignora y se avisa. Es la contrapartida de podar al construir (S2).
- `format_version`: si no coincide, ignorar el fichero sin petardear.

### API del módulo

```python
def cache_dir() -> str
def save(root_path, tree, meta) -> str        # devuelve la ruta del fichero
def load(root_path) -> tuple | None           # None si no hay o no es válida
def list_entries() -> list                    # [{path, scanned_at, size_on_disk, total_size, n_files}]
def clear_all() -> int                        # devuelve nº de ficheros borrados
```

### `clear_all()` — el único punto que borra

Blindaje obligatorio, mismo criterio que `/api/reveal` en S4:

1. **No acepta ningún argumento.** No hay forma de pedirle que borre otra cosa.
2. Borra únicamente ficheros **dentro de `cache_dir()`** que casen con
   `*.json.gz`. Cualquier otra cosa en esa carpeta se queda.
3. `os.remove()` fichero a fichero. **Nunca `shutil.rmtree()`**, ni siquiera
   sobre el directorio de caché: un `rmtree` con la variable equivocada es un
   desastre y no hay ninguna necesidad de asumir ese riesgo.
4. No sigue symlinks: comprueba con `os.path.islink()` y sáltalos.
5. Captura `OSError` por fichero, cuenta los borrados y sigue.

Deja un comentario sobre la función explicando por qué está escrita así.

---

## Tarea 2 — Integración en `server.py`

### 2.1 Guardado automático

Al terminar un escaneo con éxito, guardar la caché **sin preguntar**. Un botón
"guardar" que hay que recordar pulsar es un botón que no se pulsa.

Si el guardado falla (disco lleno, permisos), **no rompas el escaneo**: registra
el error y sigue. El árbol en memoria es lo importante; la caché es una comodidad.

### 2.2 Endpoints nuevos

| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/api/cache` | Lista las cachés guardadas: `{"entries": [{path, scanned_at, size_on_disk, total_size, n_files}], "dir": "..."}` |
| POST | `/api/cache/load` | Body `{"path": "..."}`. Carga esa caché en memoria como árbol activo. `404` si no existe, `409` si hay un escaneo en curso. |
| POST | `/api/cache/clear` | Borra **todas** las cachés. Responde `{"ok": true, "deleted": N}`. |

Blindaje de los dos `POST`, idéntico al de `/api/reveal`:

- Solo `POST`. Un `GET` a `/api/cache/clear` lo dispararía cualquier web con una
  etiqueta `<img>`. Si llega `GET` a esas dos rutas, `405`.
- Cabecera `Origin`: si viene y no es `http://127.0.0.1:8765`, `403`.
- `/api/cache/clear` **no recibe ninguna ruta**. El cliente dice "borra", no
  "borra esto". El servidor sabe cuál es su directorio.
- En `/api/cache/load`, la ruta recibida se usa solo para calcular el hash del
  nombre de fichero y buscarlo en el directorio de caché. Nunca se abre una ruta
  arbitraria del cliente.

### 2.3 Estado

`/api/progress` debe distinguir de dónde viene el árbol activo. Añade al JSON:

```json
"source": "scan" | "cache",
"scanned_at": 1754509620.0
```

El front necesita esto para mostrar la fecha del dato.

---

## Tarea 3 — Front: pantalla de inicio

Al cargar la página, `GET /api/cache`. Si hay entradas, la pantalla inicial las
muestra **junto** al input de ruta habitual, no en lugar de él:

```
Escaneos guardados
  /System/Volumes/Data — 123,6 GB, 1.208.540 archivos — 6 ago, 20:47   [Cargar]
  ~/Downloads          — 67,8 MB, 1.204 archivos      — 5 ago, 11:02   [Cargar]
```

- Fecha en formato local legible, no timestamp.
- **Nada se carga solo.** El usuario ve la fecha y decide. Arranque explícito,
  sin sorpresas.
- Si no hay cachés, esta sección no aparece.

---

## Tarea 4 — Front: indicador de frescura y borrado

### 4.1 Fecha del dato

Cuando el árbol activo viene de caché, mostrar junto al breadcrumb, de forma
permanente y discreta:

```
Datos del 6 ago, 20:47 · [Rescanear]
```

Es la misma filosofía que el banner de errores de S2: en vez de fingir que el
dato es fresco, decir cuándo se tomó. "Rescanear" relanza el escaneo de esa misma
ruta.

Si el árbol viene de un escaneo recién hecho, no hace falta el indicador.

### 4.2 Borrado

En la pantalla de inicio, bajo la lista de escaneos guardados, un botón discreto
**"Borrar escaneos guardados (N)"**.

- Confirmación previa **en la propia interfaz** (no `confirm()` del navegador):
  un texto que diga qué se va a borrar, cuántos ficheros y que el árbol en
  memoria no se pierde. Botón de cancelar por defecto.
- Al confirmar, `POST /api/cache/clear`. Toast con el resultado.
- La lista se vacía sin recargar la página.
- Deja claro en el texto que **solo se borran los ficheros de caché de la
  aplicación**, y muestra la ruta del directorio para que se pueda comprobar.

---

## Tarea 5 — Documentación

### 5.1 `README.md` (inglés, canónico)

- Sección nueva **Caching**: dónde vive el fichero, por qué fuera del proyecto
  (es un mapa de los nombres de tus carpetas), por qué JSON+gzip y no pickle, y
  que la caché no se invalida sola — se muestra la fecha y tú decides.
- En **Design decisions**, matiza el principio: la app nunca toca ficheros del
  usuario; gestiona sus propios ficheros de caché en su propio directorio, y el
  borrado no acepta rutas del cliente.
- Añade los tres endpoints nuevos a la lista.
- Menciona que subir `MAX_CHILDREN` invalida las cachés existentes.

### 5.2 `README.es.md`

Mismo cambio, en español (España).

### 5.3 `docs/PROMPT-S5.md`

Añade este mismo fichero.

### 5.4 Saneado

```zsh
grep -rn "you" . --exclude-dir=.git
```

No debe devolver nada.

---

## Criterios de aceptación

1. Un escaneo de `/System/Volumes/Data` genera el fichero en
   `~/Library/Application Support/escaner_disco/` con permisos `600`, y el
   directorio con `700`.
2. El fichero comprimido ocupa **menos de 15 MB** para ese escaneo. Si se pasa
   mucho, la serialización compacta no está haciendo su trabajo.
3. Cargar la caché tarda **menos de 3 s** (frente a los ~35 s del escaneo).
   Mídelo e indícalo.
4. El total, el número de archivos y el número de errores tras cargar la caché
   son **idénticos** a los del escaneo que la generó.
5. La pantalla de inicio lista los escaneos guardados con su fecha, y nada se
   carga automáticamente.
6. Con el árbol venido de caché, el indicador de fecha es visible y "Rescanear"
   funciona.
7. `GET /api/cache/clear` devuelve `405`. `POST` con `Origin: http://evil.example`
   devuelve `403`.
8. "Borrar escaneos guardados" pide confirmación en la UI, borra solo los
   `*.json.gz` del directorio de caché y devuelve el número correcto.
9. Un fichero de caché con `max_children` distinto al del código se ignora sin
   petardear.
10. El resto de la app funciona igual que en S4.
11. `grep -rn "you" . --exclude-dir=.git` vacío.

### Comprobación manual

```zsh
ls -la ~/Library/Application\ Support/escaner_disco/
curl -i http://127.0.0.1:8765/api/cache/clear                                          # 405
curl -i -X POST -H "Origin: http://evil.example" http://127.0.0.1:8765/api/cache/clear # 403
```

## Al terminar

Commits en inglés y granulares, separando módulo de caché / servidor / frontend /
docs. No configures remoto ni hagas push.

**Antes de terminar, verifica la autoría de los commits** — en S4 salieron con un
email distinto al de `git config`:

```zsh
git log -5 --format='%h %an <%ae>'
```
