# escaner_disco — Sesión S1

Construye una aplicación local que analiza el uso de almacenamiento del Mac y lo
muestra como **sunburst navegable + lista ordenada**, estilo JDiskReport/DaisyDisk.

Trabaja en `~/web/escaner_disco/` (la carpeta ya existe).

## Restricciones globales

- Python 3 **solo stdlib**. Nada de pip, ni FastAPI, ni Flask.
- Frontend **HTML/CSS/JS vanilla**. Sin frameworks, sin CDN, sin D3. El sunburst
  se dibuja a mano con `<path>` SVG.
- **Solo lectura.** La app no borra, mueve ni modifica nada. No implementes
  ningún endpoint ni botón destructivo.
- Código, nombres de variables y commits en **inglés**. Comentarios en inglés.
- macOS es el único target de S1.

## Estructura de archivos

```
~/web/escaner_disco/
├── scanner.py
├── server.py
├── static/
│   ├── index.html
│   ├── app.js
│   └── style.css
└── README.md
```

---

## 1. `scanner.py`

Recorre un directorio y construye el árbol de tamaños en memoria.

### Requisitos

- **Iterativo, no recursivo.** Usa una pila explícita: hay rutas de más de 1000
  niveles y `RecursionError` mataría el escaneo.
- Usa `os.scandir()` con `entry.stat(follow_symlinks=False)`.
- **Nunca sigas symlinks.** Un symlink cuenta como entrada de tamaño ~0.
- **Tamaño real en disco**: `st_blocks * 512`, no `st_size`. Guarda ambos: el
  front mostrará `st_blocks * 512`.
- **Hardlinks**: si `st_nlink > 1`, guarda `(st_dev, st_ino)` en un `set` y
  cuenta el archivo una sola vez.
- **No cruces volúmenes**: si el `st_dev` de un directorio difiere del `st_dev`
  de la raíz del escaneo, no entres.
- **Exclusiones por defecto** (lista constante `DEFAULT_EXCLUDES`, editable):
  - `/dev`, `/Volumes`, `/private/var/vm`, `/System/Volumes/VM`
  - cualquier segmento de ruta que empiece por `.Snapshot`
  - `/System/Volumes/Data` cuando la raíz sea `/` (evita el doble conteo por
    firmlinks de APFS)
- **Errores**: captura `PermissionError` y `OSError` por entrada, incrementa un
  contador `errors` y sigue. Nunca abortes el escaneo por un error de permisos.
- **Progreso**: acepta un `callback(files_seen, current_path)` invocado cada
  20.000 entradas. Si no se pasa callback, no imprime nada.

### Estructura del nodo

```python
{
  "name": "Documents",
  "path": "/Users/kike/Documents",
  "size": 12345678,      # bytes reales, incluye descendientes
  "is_dir": True,
  "n_files": 4211,       # archivos totales bajo este nodo
  "children": [ ... ]    # ordenados por size desc; vacío en archivos
}
```

Los tamaños de directorio se acumulan hacia arriba al terminar de procesar
cada subárbol.

### CLI

```
python3 scanner.py /System/Volumes/Data
python3 scanner.py ~/Downloads --json out.json
```

Sin `--json`, imprime en stdout el top 20 de la raíz (nombre, tamaño humano, %)
y un resumen: total, nº de archivos, nº de errores, segundos empleados.

Añade una nota en el `--help`: para escanear fuera de `~` hace falta conceder
*Acceso total al disco* a la app desde la que se lanza (Terminal, iTerm o VS Code)
en Ajustes → Privacidad y seguridad.

---

## 2. `server.py`

Servidor HTTP local sobre `http.server.ThreadingHTTPServer`.

- Bind **solo a `127.0.0.1`**, puerto `8765` (configurable con `--port`).
- El árbol vive en memoria en un objeto global. Nunca se serializa entero al
  cliente: puede tener millones de nodos.

### Endpoints

| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/` y `/static/*` | Sirve `static/`. `Content-Type` correcto por extensión. |
| POST | `/api/scan` | Body JSON `{"path": "..."}`. Lanza el escaneo en un `threading.Thread` y responde `202` de inmediato. Si ya hay uno en curso, responde `409`. |
| GET | `/api/progress` | `{"state": "idle"\|"scanning"\|"done"\|"error", "files_seen": N, "current_path": "...", "elapsed": s, "errors": N, "message": "..."}` |
| GET | `/api/node?path=X&depth=3` | Devuelve el subárbol desde `X` podado a `depth` niveles. `depth` máximo 5. 404 si la ruta no existe en el árbol. |

### Poda en `/api/node`

- Ordena los hijos por tamaño descendente.
- Si un nodo tiene más de 40 hijos, devuelve los 40 mayores y añade un nodo
  sintético `{"name": "Otros (N elementos)", "size": suma_del_resto,
  "is_dir": false, "synthetic": true}`.
- Los nodos cortados por profundidad conservan su `size` pero llevan
  `"children": []` y `"truncated": true`, para que el front sepa que puede pedir
  más al hacer zoom.

---

## 3. Frontend (`static/`)

Layout de dos columnas: sunburst a la izquierda (~60%), lista a la derecha (~40%).

### Pantalla inicial

Input de texto con la ruta (valor por defecto `/System/Volumes/Data`), botón
"Escanear" y accesos rápidos a `~`, `~/Downloads`, `~/Library`. Al pulsar,
`POST /api/scan` y luego `GET /api/progress` cada 500 ms mostrando archivos
recorridos y ruta actual. Al llegar a `done`, pinta.

### Sunburst

- SVG cuadrado responsive con `viewBox`, centrado.
- **4 anillos** visibles. El centro es el nodo actual (círculo con el nombre y
  el tamaño total dentro, como el "Total" de la captura de referencia).
- Layout calculado a mano: cada hijo ocupa un ángulo proporcional a
  `size / parent.size`. Cada anillo tiene grosor fijo. Los sectores se generan
  con `<path>` y comandos `A` (arco).
- **No dibujes sectores de menos de 0.5°**: son invisibles y multiplican los
  nodos del DOM por diez.
- Color: HSL, tono derivado del índice del hijo dentro de su padre; los
  descendientes heredan el tono del ancestro de primer nivel y bajan
  luminosidad según la profundidad. Así un subárbol entero se lee de un vistazo.
- **Hover**: resalta el sector, resalta la fila correspondiente de la lista y
  muestra un tooltip con ruta, tamaño humano y % respecto al nodo actual.
- **Clic en un sector**: hace zoom (ese nodo pasa a ser el centro). Si el nodo
  viene con `truncated: true`, pide antes `/api/node` con más profundidad.
- **Breadcrumb** navegable sobre el gráfico, con la ruta desde la raíz del
  escaneo. Clic en cualquier tramo = subir a ese nivel.

### Lista

Tabla de los hijos directos del nodo actual, ordenada por tamaño descendente:
nombre, tamaño humano, porcentaje y una barra horizontal de proporción. Cada
fila usa el mismo color que su sector. Clic en fila = mismo zoom que el sector.
Icono distinto para carpeta y archivo.

### Formato de tamaños

Base **1000** (KB, MB, GB), no 1024. Es lo que usa Finder: si mostramos GiB los
números no cuadrarán con "Obtener información" y parecerá un bug.

---

## 4. `README.md`

Cómo arrancar (`python3 server.py`, abrir `http://127.0.0.1:8765`), el aviso de
Acceso total al disco, y una sección "Decisiones" que recoja: por qué
`st_blocks` y no `st_size`, por qué `/System/Volumes/Data` y no `/`, y por qué
base 1000.

---

## Criterios de aceptación

1. `python3 scanner.py ~/Downloads` termina sin traza de error aunque haya
   carpetas sin permiso, e imprime el top 20 y el resumen.
2. Escanear `/System/Volumes/Data` no cuelga el proceso ni dispara la RAM por
   encima de ~1 GB con un disco de ~1 M de archivos.
3. El total del escaneo de un volumen completo queda dentro de un ±10% de lo
   que reporta `df -H /`.
4. El sunburst pinta 4 anillos, hace zoom al clicar y el breadcrumb permite
   volver atrás.
5. La lista y el gráfico se resaltan en sincronía al pasar el ratón.
6. Ningún endpoint modifica el sistema de archivos.

## Al terminar

Haz commit con mensajes en inglés, granulares (uno por componente: scanner,
server, frontend, docs). No inicialices remoto ni hagas push.
