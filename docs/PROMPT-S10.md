# escaner_disco — Sesión S10
Continuación de S9 (fix de `disk_size` en Windows commiteado sobre S8).
Objetivo único: **detectar carpetas regenerables ("basura") durante el escaneo y
mostrarlas agregadas en una pestaña propia**. La app señala; el usuario decide.
Se mantienen las restricciones de siempre: Python 3 solo stdlib, front vanilla sin
frameworks ni CDN, código y commits en inglés.
**No hagas `git push`.** El push lo hago yo a mano.
**Guarda este fichero directamente en `docs/PROMPT-S10.md`**, no en la raíz. Si
incluye rutas con mi nombre de usuario local, sustitúyelas por `TU_USUARIO`.
---
## Decisiones ya tomadas (no las replantees)
1. **No hay borrado. Nunca.** La app no modifica el sistema de archivos. La única
   acción sobre una ruta detectada es "Mostrar en Finder / en el Explorador", que
   ya existe desde S4. Razones: el servidor escucha sin autenticación en
   `127.0.0.1:8765`, el árbol puede venir de una caché de hace días, y un falso
   positivo en un borrado no es un bug, es pérdida de datos.
2. **Reglas explícitas, nunca heurísticas.** Cada categoría se justifica en una
   línea. Se descarta "no accedido en 6 meses": presentaría una sospecha con la
   misma cara que un hecho, y `atime` es poco fiable en macOS.
3. **Detección durante el escaneo, no después.** El árbol se poda a
   `MAX_CHILDREN = 40` al construir (S2): las carpetas basura, pequeñas
   individualmente y grandes en conjunto, están colapsadas en los nodos "Otros" y
   serían invisibles para un análisis posterior. Esta es la razón de que S10 tenga
   que tocar `scanner.py`.
4. **Multiplataforma desde el principio**, con el catálogo en
   `platform_support.py`, como todo lo específico de un SO desde S6.
5. **La papelera queda fuera** en los tres sistemas. En Windows `$Recycle.Bin` ya
   está en las exclusiones desde S6 y sacarlo cambiaría el total del disco;
   contarla solo en macOS sería incoherente. Además es una carpeta que el sistema
   ya enseña y el usuario ya sabe vaciar: no necesita que la descubra esta
   herramienta. Documéntalo como decisión, no lo dejes implícito.
---
## Tarea 0 — Copia de seguridad
```zsh
cp -R ~/web/escaner_disco ~/web/escaner_disco-backup-S10
```
Verifica que existe antes de continuar.
---
## Tarea 1 — Catálogo de reglas en `platform_support.py`
Función nueva:
```python
def junk_rules() -> tuple   # tupla de dicts, inmutable, calculada una vez por proceso
```
Cada regla es un dict:
```python
{
  "id": "node_modules",          # estable, se usa como clave en la caché y la API
  "label": "node_modules",       # texto para la UI
  "kind": "name" | "path",
  "match": "node_modules",       # nombre exacto de directorio, o ruta absoluta ya expandida
  "why": "Regenerable with npm install from package.json",
}
```
- Los `id` son estables: si cambias uno, invalidas las cachés que lo usaran.
- Las reglas `path` se expanden con `os.path.expanduser` / variables de entorno
  **al construir la tupla**, no en el scanner. Si una ruta no se puede expandir
  (variable ausente), se omite la regla en silencio: no petardees.
- `why` en inglés, es lo que va al README y a la UI.
### 1.1 Reglas `kind = "name"` (los tres sistemas)
Nombre exacto de directorio, en cualquier ubicación.
| `id` | `why` |
|---|---|
| `node_modules` | Regenerable con `npm install` desde `package.json` |
| `__pycache__` | Bytecode, se regenera al ejecutar |
| `venv` (`.venv`) | Regenerable desde `requirements.txt` |
| `pytest_cache` (`.pytest_cache`) | Caché de test runner |
| `mypy_cache` (`.mypy_cache`) | Caché del type checker |
| `ruff_cache` (`.ruff_cache`) | Caché del linter |
| `derived_data` (`DerivedData`) | Xcode: índices y builds intermedios |
**Deliberadamente fuera: `dist`, `build`, `target`.** Son basura la mitad de las
veces y entregable la otra mitad. Una regla que falla el 50% contamina la
confianza en las demás. Deja el comentario en el código explicando por qué no
están, para que nadie las añada "por completitud".
### 1.2 Reglas `kind = "path"` — macOS
| `id` | Ruta | `why` |
|---|---|---|
| `user_caches` | `~/Library/Caches` | Caché de aplicaciones, se rehace sola |
| `system_caches` | `/Library/Caches` | Ídem a nivel de sistema |
| `user_logs` | `~/Library/Logs` | Logs históricos de aplicaciones |
| `ios_device_support` | `~/Library/Developer/Xcode/iOS DeviceSupport` | Símbolos de versiones de iOS que ya no se usan |
| `core_simulator` | `~/Library/Developer/CoreSimulator` | Runtimes de simulador descargados |
| `npm_cache` | `~/.npm/_cacache` | Caché de paquetes npm |
| `xdg_cache` | `~/.cache` | Convención Unix, herramientas varias |
| `docker_data` | `~/Library/Containers/com.docker.docker/Data` | Imágenes y volúmenes de Docker |
### 1.3 Reglas `kind = "path"` — Windows
| `id` | Ruta | `why` |
|---|---|---|
| `user_temp` | `%LOCALAPPDATA%\Temp` | Temporales de usuario |
| `system_temp` | `C:\Windows\Temp` | Temporales de sistema |
| `windows_update` | `C:\Windows\SoftwareDistribution\Download` | Instaladores de actualizaciones ya aplicadas |
| `package_cache` | `%LOCALAPPDATA%\Package Cache` | Instaladores conservados por Visual Studio |
| `npm_cache` | `%LOCALAPPDATA%\npm-cache` | Caché de paquetes npm |
| `pip_cache` | `%LOCALAPPDATA%\pip\Cache` | Caché de pip |
**`WinSxS` no entra.** Es el almacén de componentes de Windows: que sea grande
(18 GB medidos en el PC de referencia) no lo hace basura, y tocarlo rompe el
sistema. Coméntalo en el código.
### 1.4 Reglas `kind = "path"` — Linux
`~/.cache`, `/var/cache/apt/archives`, `~/.local/share/Trash` **no** (papelera,
ver decisión 5).
### 1.5 Comparación de rutas
- En Windows, insensible a mayúsculas: `os.path.normcase` en los dos lados.
- Una regla `path` casa si la ruta del directorio **es exactamente** la de la
  regla, no si empieza por ella. El anidamiento lo resuelve la tarea 2.
---
## Tarea 2 — Detección en `scanner.py`
Es el punto delicado de la sesión. **No cambies la lógica de poda, acumulación,
errores ni volúmenes.** Solo se añade contabilidad en paralelo.
### 2.1 Cuándo se marca y cuándo se cuenta
Son dos momentos distintos y confundirlos da cifras mal:
- **Al entrar** en un directorio (pre-orden), se comprueba si casa con alguna
  regla. Si casa, se anota la categoría junto a ese directorio en la pila.
- **Al cerrarlo** (post-orden, cuando su `size` y `n_files` ya están acumulados
  desde los hijos), se contabiliza en su categoría.
Contabilizar al entrar daría 0 bytes en todas las categorías. Contabilizar al
cerrar garantiza además que la cifra es correcta **aunque el padre pode luego ese
subárbol**: la poda ocurre al cerrar el padre, después.
### 2.2 Anidamiento — no contar dos veces
Al detectar un directorio, se atribuye **el subárbol entero** a esa categoría y
**se deja de detectar dentro de él**. Un `node_modules` dentro de otro
`node_modules`, o un `__pycache__` dentro de un `.venv`, no suman aparte.
Implementación: un flag `inside_junk` en el elemento de la pila, heredado por los
hijos. Si ya es `True`, no se evalúan reglas. Es una comprobación booleana por
directorio; el coste es despreciable.
### 2.3 El acumulador
Clase nueva en `scanner.py` (o módulo aparte si te queda más limpio):
```python
class JunkCollector:
    __slots__ = (...)
    def record(self, rule_id, path, size, n_files) -> None
    def result(self) -> dict
```
Por categoría acumula:
- `total_size` — suma exacta, sin límite.
- `n_paths` — número de directorios detectados, exacto, sin límite.
- `paths` — **solo las 20 mayores**, con `MAX_JUNK_PATHS = 20` como constante de
  módulo documentada. Usa un min-heap de `heapq` con `heappushpop` cuando ya hay
  20: coste constante y sin ordenar 300 elementos al final. Al serializar, ordena
  descendente.
- `truncated` — `true` si `n_paths > MAX_JUNK_PATHS`.
Mismo criterio que `MAX_ERROR_PATHS = 1000` de S2: el contador es exacto, la
lista está acotada. Sin cota, un disco con cientos de proyectos node mete cientos
de rutas largas en RAM y dentro del `.json.gz`.
Las categorías sin ninguna detección **no aparecen** en el resultado. Una lista
de doce ceros no informa de nada.
### 2.4 Salida del CLI
Bajo el resumen actual, si hay detecciones, una sección compacta ordenada por
tamaño descendente:
```
Regenerable data: 8.4 GB in 3 categories
  node_modules          4.2 GB   37 dirs
  ~/Library/Caches      3.1 GB    1 dir
  __pycache__           1.1 GB  214 dirs
```
### 2.5 Rendimiento
Una comparación de nombre contra un `frozenset` y, solo para los directorios, una
comparación de ruta contra un dict. **Checkpoint obligatorio:** mide el escaneo
completo de `/System/Volumes/Data` desde Terminal con TCC y compáralo con la
referencia. Si el tiempo empeora más de un 5% o el RSS sube por encima de 240 MB,
**para y dímelo antes de seguir**.
Referencia macOS (2026-08-08): **125,6 GB, 1.203.585 ficheros, 233 errores,
35,3 s, 227 MB RSS**. Si tu escaneo da 429-431 errores y ~118 GB, la terminal no
tiene Acceso total al disco: la medida no vale, avísame en vez de justificarla
como deriva del disco.
---
## Tarea 3 — `cache.py` y `server.py`
### 3.1 Caché
- Añade la clave `"junk"` al JSON, con el resultado del collector.
- **Sube `format_version` a 2.** Las cachés de S5-S9 no llevan el campo y no
  pueden inventárselo: se ignoran con aviso, como ya se hace con `platform` y
  `max_children`. Consecuencia asumida: un rescaneo obligatorio tras actualizar,
  en Mac y en PC. Menciónalo en el README.
### 3.2 Endpoint nuevo
| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/api/junk` | `{"categories": [{id, label, why, total_size, n_paths, truncated, paths: [{path, size, n_files}]}], "total_size": N}` |
- Ordenado por `total_size` descendente.
- `404` si no hay árbol activo.
- **Solo lectura, sin efectos laterales.** No hay ningún endpoint nuevo que
  escriba: `/api/reveal` ya existe y sirve para esto tal cual está, con todo su
  blindaje de S4 intacto.
---
## Tarea 4 — Front: tercera pestaña
### 4.1 Ubicación
Un tercer botón en el conmutador que ya existe: **Sunburst | Treemap | Basura**.
A diferencia de los otros dos, esta pestaña **sustituye el panel entero**
(gráfico *y* lista), porque no depende del nodo actual ni del breadcrumb: es una
vista del escaneo completo. El breadcrumb y el indicador de frescura siguen
visibles arriba. Al volver a Sunburst o Treemap, el nodo actual y el zoom se
conservan exactamente como estaban.
Se mantiene lo de S7: la vista inactiva **se desmonta del DOM**, no se oculta con
`display: none`. La preferencia sigue en `localStorage` (`escaner_disco.view`);
si el valor guardado es la pestaña de basura y no hay datos, cae a sunburst.
### 4.2 Contenido
Lista de categorías, cada una desplegable:
```
▾ node_modules                      4,2 GB    37 carpetas
    Regenerable with npm install from package.json
    ~/web/proyecto-a/node_modules            890 MB   [Mostrar] [Copiar]
    ~/web/proyecto-b/node_modules            610 MB   [Mostrar] [Copiar]
    … y 17 más (se muestran las 20 mayores de 37)
```
- El `why` de la regla, visible al desplegar. Es lo que permite discrepar de una
  categoría sin desconfiar de todas.
- Las acciones por fila son **las mismas de S4**, mismo componente, mismo
  `stopPropagation`. No escribas unas nuevas.
- Arriba, el total agregado: `8,4 GB en 3 categorías`.
- Si no hay detecciones, un texto neutro: "No se han encontrado carpetas
  regenerables en este escaneo". No es un logro ni un error.
- Si el árbol viene de una caché anterior a `format_version = 2`, la pestaña
  explica que hace falta rescanear, con el botón "Rescanear" que ya existe.
### 4.3 Lo que esta pestaña NO tiene
Ningún botón de borrar, ninguna casilla de selección, ningún "liberar espacio".
Si el diseño te pide un hueco para eso, el diseño está mal. Déjalo comentado en
el código.
---
## Tarea 5 — Documentación
### 5.1 `README.md` (inglés, canónico)
- Sección nueva **Regenerable data**: qué detecta, la **tabla completa de reglas
  con su justificación** (es el contrato con el usuario: si no puede leer por qué
  una carpeta está marcada, la herramienta le está pidiendo fe), y en negrita que
  la app no borra nada.
- En **Design decisions**, párrafos nuevos: por qué reglas explícitas y no
  heurísticas; por qué la detección va durante el escaneo y no después
  (`MAX_CHILDREN`); por qué `dist`/`build`/`target` y `WinSxS` quedan fuera; por
  qué la papelera queda fuera en los tres sistemas.
- `format_version = 2` invalida las cachés anteriores: un rescaneo tras
  actualizar.
- El endpoint `/api/junk` a la lista.
### 5.2 `README.es.md`
Mismo cambio, en español (España).
### 5.3 `docs/PROMPT-S10.md`
Este mismo fichero.
---
## Criterios de aceptación
1. `python3 scanner.py ~/web` detecta `node_modules` y `__pycache__` con un total
   coherente con `du -sh` sobre una de las rutas listadas.
2. Un `node_modules` anidado dentro de otro **no** suma dos veces. Verifícalo
   creando el caso a mano en `/tmp` y comparando con `du`.
3. El escaneo completo de `/System/Volumes/Data` no empeora más de un 5% en
   tiempo (ref. 35,3 s) ni sube de 240 MB de RSS (ref. 227 MB), **medido desde
   Terminal con TCC** (233 errores, no 429).
4. El total, el número de ficheros y el número de errores del escaneo son
   idénticos a los de S9: la contabilidad de basura no toca el árbol.
5. Una categoría con más de 20 rutas devuelve `truncated: true`, `n_paths` con el
   número real y exactamente 20 rutas, las 20 mayores.
6. `GET /api/junk` sin árbol activo devuelve `404`.
7. La tercera pestaña sustituye gráfico y lista; al volver a Sunburst se conserva
   el nodo actual y el zoom.
8. "Mostrar en Finder" funciona desde una fila de la pestaña de basura.
9. Una caché de S9 (`format_version = 1`) se ignora con aviso, sin petardear.
10. No existe ningún endpoint ni botón que borre nada.
11. `git ls-files -z | xargs -0 grep -ln "TU_USUARIO"` vacío.
12. El resto de la app funciona igual que en S9: escaneo, caché, `/api/reveal`,
    banner de errores, sunburst, treemap.
---
## Al terminar
Commits en inglés y granulares, separando catálogo de reglas / scanner y
collector / caché y servidor / frontend / docs.
Verifica la autoría antes de cerrar (**no fuerces `-c` en los comandos de git**,
fue la causa del problema en S4):
```zsh
git log -6 --format='%h %an <%ae>'
```
No configures remoto ni hagas push.
