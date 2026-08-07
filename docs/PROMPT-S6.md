# escaner_disco — Sesión S6

Continuación de S5 (repo público en GitHub, caché a disco funcionando).

Objetivo único: **desacoplar el código de macOS** para que el mismo proyecto
corra en macOS, Windows y Linux. No se empaqueta nada todavía: al terminar S6 la
app debe arrancar en Windows con `python3 server.py` exactamente igual que hoy en
el Mac. El empaquetado es S7.

Se mantienen las restricciones de siempre: Python 3 solo stdlib (`ctypes` es
stdlib y su uso está autorizado en esta sesión), front vanilla sin frameworks ni
CDN, código y commits en inglés.

**No hagas `git push`.** El push lo hago yo a mano.

**Guarda este fichero directamente en `docs/PROMPT-S6.md`**, no en la raíz.

---

## Regla que gobierna toda la sesión

Hoy hay código específico de macOS repartido por `scanner.py`, `server.py` y
`cache.py`. Al terminar S6, **todo lo específico de un sistema operativo vive en
un único fichero nuevo**, `platform_support.py`. El resto del proyecto no
contiene ni un `sys.platform`, ni un `/System/Volumes/Data`, ni un `open -R`, ni
un `~/Library/Application Support`.

Verificación al final (no debe devolver nada fuera de `platform_support.py`):

```zsh
grep -rn "sys.platform\|darwin\|System/Volumes\|Library/Application Support\|open -R" \
  --include="*.py" . | grep -v platform_support.py
```

---

## Tarea 0 — Copia de seguridad

```zsh
cp -R ~/web/escaner_disco ~/web/escaner_disco-backup-S6
```

Verifica que existe antes de continuar.

---

## Tarea 1 — `platform_support.py` (nuevo)

Fichero nuevo en la raíz. API pública:

```python
def platform_id() -> str            # "macos" | "windows" | "linux"
def default_scan_root() -> str      # raíz sugerida por defecto
def quick_roots() -> list           # [{"label": "...", "path": "..."}] para los atajos de la UI
def default_excludes() -> tuple     # rutas a no recorrer nunca
def disk_size(st, path) -> int      # bytes realmente ocupados en disco
def reveal_command(path) -> list    # argv para revelar en el gestor de archivos
def cache_dir() -> str              # directorio de datos de la app
```

Si `platform_id()` devuelve algo no contemplado, el módulo se comporta como
Linux y lo registra por stderr una sola vez. No abortes.

### 1.1 Raíz por defecto y atajos

| SO | `default_scan_root()` | `quick_roots()` |
|---|---|---|
| macOS | `/System/Volumes/Data` | Home, Downloads, `~/Library` |
| Windows | La unidad del sistema (`os.environ["SystemDrive"] + "\\"`, normalmente `C:\`) | Home, Downloads, y **una entrada por cada unidad fija detectada** |
| Linux | `/` | Home, Downloads |

En Windows, detecta las unidades con `ctypes.windll.kernel32.GetLogicalDrives()`
y filtra por `GetDriveTypeW` == `DRIVE_FIXED` (3). No listes CD-ROM ni unidades
de red: escanear una unidad de red por accidente es un escaneo de horas.

### 1.2 Exclusiones por defecto

Se conservan las de macOS tal cual están hoy. Añade:

- **Windows**: `C:\Windows\CSC`, `C:\$Recycle.Bin`,
  `System Volume Information` en cualquier unidad, `pagefile.sys`,
  `hiberfil.sys`, `swapfile.sys`, `DumpStack.log.tmp`.
- **Linux**: `/proc`, `/sys`, `/dev`, `/run`, `/tmp` no (sí se escanea),
  `/var/lib/docker/overlay2` no se excluye pero se documenta que infla el total
  por los layers compartidos.

La comparación de rutas en Windows debe ser **insensible a mayúsculas**.

### 1.3 `disk_size(st, path)` — el punto delicado

- **macOS y Linux**: `st.st_blocks * 512`. Sin cambios, sin llamadas extra.
- **Windows**: `GetCompressedFileSizeW` vía `ctypes` sobre `kernel32`.
  - Firma: devuelve el `DWORD` bajo y escribe el alto en un puntero
    `LPDWORD`. El tamaño real es `high << 32 | low`.
  - Si devuelve `INVALID_FILE_SIZE` (`0xFFFFFFFF`), **hay que consultar
    `GetLastError()`**: solo es error si es distinto de `NO_ERROR`. Un fichero
    de exactamente 4 GB-1 devuelve ese valor legítimamente.
  - En caso de error, cae a `st.st_size` y no rompe el escaneo.
  - No la llames sobre directorios: para un directorio devuelve el tamaño de la
    entrada, no del contenido, y el árbol ya acumula desde los hijos.

**Constante de módulo `WINDOWS_EXACT_SIZE = True`**, documentada. Ponerla a
`False` usa `st_size` y se ahorra una llamada al sistema por fichero.

**Checkpoint obligatorio antes de seguir:** mide en Windows el tiempo de escaneo
de una carpeta de al menos 100.000 ficheros con la constante en `True` y en
`False`, y dime las dos cifras. Si `True` cuesta más del doble, lo hablamos antes
de dar la tarea por buena.

### 1.4 `reveal_command(path)`

| SO | argv |
|---|---|
| macOS | `["open", "-R", path]` |
| Windows | `["explorer", "/select,", path]` |
| Linux | `["xdg-open", parent_dir]` |

Tres avisos que van comentados en el código:

- **`explorer.exe` devuelve código de salida 1 aunque haya funcionado.** No
  trates el returncode como error en Windows; comprueba solo que el proceso
  arrancó.
- **En Linux no existe equivalente a `-R`.** `xdg-open` sobre un fichero lo
  *abre* con su aplicación asociada, que es exactamente lo que S4 prohibió. Por
  eso en Linux se abre **el directorio padre**, nunca el fichero.
- **`shell=True` sigue prohibido en los tres.** Lista de argumentos siempre.

### 1.5 `cache_dir()`

| SO | Ruta | Permisos |
|---|---|---|
| macOS | `~/Library/Application Support/escaner_disco` | dir 0700, ficheros 0600 |
| Windows | `%LOCALAPPDATA%\escaner_disco` | ver nota |
| Linux | `$XDG_DATA_HOME/escaner_disco` o `~/.local/share/escaner_disco` | dir 0700, ficheros 0600 |

Nota Windows: `os.chmod` con modos POSIX es casi un no-op en NTFS. No finjas que
funciona: aplica el `chmod` igualmente (es inocuo) y deja un comentario diciendo
que en Windows la protección real la da estar dentro del perfil del usuario en
`%LOCALAPPDATA%`, no el modo del fichero.

---

## Tarea 2 — `scanner.py`

Sustituye el código específico de macOS por llamadas a `platform_support`. Puntos
concretos:

1. `st_blocks * 512` → `platform_support.disk_size(st, path)`.
2. `DEFAULT_EXCLUDES` → `platform_support.default_excludes()`.
3. **Construcción de rutas**: hoy los nodos guardan solo `name` (S2) y la ruta se
   reconstruye concatenando. Usa `os.path.join`, nunca `"/" + name`. Ojo con la
   raíz en Windows: `os.path.join("C:\\", "Users")` funciona,
   `os.path.join("C:", "Users")` **no** (da `C:Users`, ruta relativa a la unidad).
   Normaliza la raíz con `os.path.abspath` al empezar el escaneo.
4. **Hardlinks**: el `set` de `(st_dev, st_ino)` funciona en Windows desde Python
   3.4, pero `st_ino` puede ser `0` en algunos sistemas de ficheros. Si
   `st_ino == 0`, no deduplicas: cuenta el fichero. Deja el comentario.
5. **Rutas largas de Windows**: por encima de 260 caracteres `os.scandir` falla
   salvo que el prefijo `\\?\` esté aplicado o el sistema tenga habilitadas las
   rutas largas. Aplica el prefijo `\\?\` a la ruta raíz en Windows y quítalo al
   construir las rutas que se devuelven al cliente. Si te complica el código más
   de lo razonable, **para y dímelo**: es preferible documentar la limitación que
   ensuciar el scanner.
6. El aviso del `--help` sobre *Acceso total al disco* solo debe salir en macOS.
   En Windows, el equivalente es ejecutar como administrador y el texto es otro.

**No cambies nada más del scanner.** La lógica de poda, acumulación y errores se
queda exactamente como está.

---

## Tarea 3 — `server.py` y `cache.py`

- `cache.py` usa `platform_support.cache_dir()`. `clear_all()` mantiene todo su
  blindaje de S5 sin cambios: sigue sin aceptar argumentos, sigue borrando solo
  `*.json.gz`, sigue sin `shutil.rmtree()`.
- `/api/reveal` usa `platform_support.reveal_command(path)`. **Todo el blindaje
  de S4 se mantiene intacto**: solo `POST`, ruta presente en el árbol escaneado,
  nodos sintéticos rechazados, comprobación de `Origin`, sin `shell=True`.
- **Caché entre plataformas**: añade `"platform"` al JSON de la caché junto a
  `format_version`. Al cargar, si el `platform` guardado no coincide con el
  actual, se ignora el fichero con aviso. Una caché de macOS no describe un disco
  de Windows.
- `/api/progress` añade `"platform": "macos" | "windows" | "linux"` para que el
  front adapte los textos.

---

## Tarea 4 — Front

Cambios mínimos, solo lo que sea incorrecto fuera de macOS:

- Los atajos de ruta se pintan desde `quick_roots()`, no hardcodeados.
- El texto del banner de errores menciona *Acceso total al disco* solo si
  `platform == "macos"`; en Windows dice ejecutar como administrador; en Linux,
  ejecutar con permisos suficientes.
- El separador de rutas del breadcrumb: no partas por `"/"` a pelo. Parte por el
  separador que corresponda o, mejor, que el servidor devuelva ya los tramos.

Nada de esto cambia el diseño ni añade pantallas.

---

## Tarea 5 — Documentación

### 5.1 `README.md` (inglés, canónico)

- **Platform support**: tabla de los tres sistemas indicando qué funciona y qué
  no. Sé explícito con las limitaciones conocidas: en Windows la ocupación real
  se obtiene con `GetCompressedFileSizeW` (coste: una llamada por fichero,
  desactivable con `WINDOWS_EXACT_SIZE`); en Linux `xdg-open` revela el
  directorio padre, no el fichero.
- **Design decisions**: párrafo nuevo explicando por qué todo lo específico de un
  SO vive en un solo módulo, y por qué en Windows se mide con
  `GetCompressedFileSizeW` en vez de `st_size` (coherencia con la decisión de S1
  de medir ocupación real, no tamaño lógico).
- La sección de **Full Disk Access** pasa a ser **Permissions**, con un apartado
  por sistema.
- Menciona que las cachés no son portables entre sistemas.

### 5.2 `README.es.md`

Mismo cambio, en español (España).

### 5.3 `docs/PROMPT-S6.md`

Este mismo fichero.

### 5.4 Saneado

```zsh
grep -rn "enri_ps" . --exclude-dir=.git
```

No debe devolver nada.

---

## Criterios de aceptación

**En macOS (no regresión — es el criterio más importante de la sesión):**

1. Total de `/System/Volumes/Data` **idéntico a S5 dentro del ±0,5%**
   (referencia: 123,3 GB, 233 rutas no legibles).
2. Tiempo de escaneo sin empeorar más de un 10% (referencia: ~35 s).
3. RSS máximo por debajo de 250 MB (referencia S5: 227 MB).
4. Caché sigue generándose, cargando en ~2 s y con el mismo tamaño (~2,9 MB).
5. `/api/reveal` abre Finder igual que en S4. El blindaje sigue: `GET` → 405,
   ruta no escaneada → 404, `Origin` ajeno → 403, sintético → 400.

**En Windows:**

6. `python server.py` arranca y sirve en `http://127.0.0.1:8765`.
7. Un escaneo de la carpeta de usuario termina sin traza de error, con la caché
   escrita en `%LOCALAPPDATA%\escaner_disco`.
8. "Mostrar en el explorador" abre el Explorador con el elemento seleccionado.
9. Las dos cifras del checkpoint 1.3 están medidas y anotadas.

**Ambos:**

10. El `grep` de la sección "Regla que gobierna toda la sesión" no devuelve nada
    fuera de `platform_support.py`.
11. `grep -rn "enri_ps" . --exclude-dir=.git` vacío.

---

## Al terminar

Commits en inglés y granulares, separando módulo de plataforma / scanner /
servidor y caché / frontend / docs.

Verifica la autoría antes de dar por cerrada la sesión (**no fuerces `-c` en los
comandos de git**, fue la causa del problema en S4):

```zsh
git log -6 --format='%h %an <%ae>'
```

No configures remoto ni hagas push.
