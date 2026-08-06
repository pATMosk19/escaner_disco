# escaner_disco — Sesión S2

Continuación de S1 (ver `escaner_disco-continuacion-2026-08-06-S1.md`). Dos
objetivos independientes: **reducir la memoria del árbol** y **hacer visibles las
rutas que no se pueden leer**.

Se mantienen todas las restricciones de S1: Python 3 solo stdlib, front vanilla
sin frameworks ni CDN, solo lectura, código y commits en inglés.

---

## Tarea 1 — Memoria

Hoy: 929 MB de RSS para 1.208.199 nodos (~660 B/nodo). Objetivo: **por debajo de
400 MB** con el mismo escaneo.

### 1.1 Sustituir los `dict` por una clase con `__slots__`

```python
class Node:
    __slots__ = ("name", "size", "n_files", "is_dir", "children", "unreadable")
```

- `name` es **solo el nombre de la entrada**, no la ruta completa. La ruta se
  reconstruye concatenando los nombres al recorrer el árbol desde la raíz. Hoy
  guardamos 1,2 M de strings de ruta larga y es la mayor partida de memoria.
- `children` es `None` en los archivos, no una lista vacía.
- `server.py` construye el dict JSON al servir, a partir del `Node` y de la ruta
  acumulada durante el recorrido.

### 1.2 Podar al construir, no al servir

Al terminar de procesar un directorio (cuando ya se conoce el tamaño de todos sus
hijos):

1. Ordena los hijos por `size` descendente.
2. Si hay más de `MAX_CHILDREN = 40`, conserva los 40 mayores y **descarta los
   subárboles del resto**, sustituyéndolos por un único nodo sintético:
   `name = "Otros (N elementos)"`, `size` = suma de los descartados,
   `n_files` = suma de sus `n_files`, `is_dir = False`.
3. El `size` y el `n_files` del directorio padre se acumulan **antes** de podar,
   con todos los hijos. El total del escaneo no puede cambiar.

Consecuencia: `server.py` ya **no** genera el nodo "Otros" en `/api/node` —
llega hecho del scanner. Deja ahí solo la poda por `depth`. No hagas doble poda.

`MAX_CHILDREN` es una constante de módulo, documentada: subirla exige reescanear.

---

## Tarea 2 — Rutas no legibles

Hoy, sin `sudo`, el escaneo pierde un 13% del disco y la interfaz no lo indica en
ningún sitio. Un error silencioso convierte un dato en una mentira plausible.

### 2.1 En `scanner.py`

- Cuando un directorio no se puede abrir (`PermissionError` u `OSError`), en vez
  de saltarlo sin más, **guárdalo como nodo** con `unreadable = True`,
  `size = 0`, `is_dir = True`, `children = None`.
- Mantén además una lista global de rutas fallidas: guarda como máximo las
  primeras `MAX_ERROR_PATHS = 1000` y sigue contando el total. Así un escaneo con
  50.000 errores no se come la memoria que acabamos de ahorrar.
- El resumen del CLI ya imprime el contador; añade debajo las 10 primeras rutas
  y, si hay más, una línea `... y N más`.

### 2.2 En `server.py`

- Nuevo endpoint `GET /api/errors` →
  `{"total": 233, "truncated": false, "paths": ["/private/var/db/...", ...]}`.
  `truncated` es `true` si `total > MAX_ERROR_PATHS`.
- Los nodos con `unreadable` se serializan con `"unreadable": true`.

### 2.3 En el front

- **Banner** bajo el breadcrumb, visible en todo momento tras un escaneo con
  errores: `⚠️ 233 rutas no legibles — el total puede estar subestimado`. Clic
  → despliega la lista de rutas (`/api/errors`, pedida solo al desplegar). Si
  `truncated`, indica que se muestran las primeras 1.000 de N.
- El banner incluye una línea explicativa breve: conceder *Acceso total al disco*
  reduce los errores; ejecutar con `sudo` los reduce más, a costa de correr un
  servidor HTTP como root.
- **En la lista**: las filas `unreadable` se muestran con un icono de candado y
  un guion en la columna de tamaño, no un `0 B` (que sugeriría "está vacío"
  cuando lo cierto es "no lo sé").
- **En el sunburst no se dibujan**: tienen tamaño 0, así que su ángulo es 0. No
  inventes un tamaño mínimo para hacerlos visibles: falsearía el gráfico. La
  lista y el banner son el canal para esta información.

---

## Criterios de aceptación

1. `python3 scanner.py /System/Volumes/Data` da un total **idéntico al de S1
   dentro del ±0,5%** (referencia sin `sudo`: 123,5 GB, 1.208.199 archivos).
   Si el total cambia más que eso, la poda está restando donde no debe.
2. `/usr/bin/time -l` reporta un `maximum resident set size` **por debajo de
   400 MB** (referencia S1: 929 MB).
3. El tiempo de escaneo no empeora más de un 20% (referencia S1: 36,2 s).
4. Con errores presentes, el banner aparece, despliega las rutas y el contador
   coincide con el del CLI.
5. Las carpetas no legibles aparecen en la lista con candado, en el nivel del
   árbol que les corresponde.
6. Sigue sin haber ningún endpoint que modifique el sistema de archivos.

## Al terminar

Commits en inglés y granulares, separando las dos tareas (memoria / errores).
Actualiza el `README.md`: la sección "Decisiones" debe recoger por qué se poda a
40 hijos en el scanner y qué significa exactamente una carpeta con candado.
