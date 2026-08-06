# escaner_disco — Sesión S3

Continuación de S2. Objetivo único: **dejar el repositorio listo para publicarlo
como público en GitHub**, sin filtrar información personal.

No se toca funcionalidad. No se añaden features. Solo saneado, documentación,
licencia e historial.

Se mantienen las restricciones de siempre: Python 3 solo stdlib, front vanilla,
solo lectura, código y commits en inglés.

**No hagas `git push` ni configures remoto.** Eso lo hago yo a mano al final.

---

## Tarea 0 — Copia de seguridad (obligatoria, antes de nada)

La tarea 4 reescribe el historial de git y es irreversible. Antes de tocar nada:

```zsh
cp -R ~/web/escaner_disco ~/web/escaner_disco-backup-S3
```

Verifica que la copia existe y que contiene `.git/` antes de continuar. Si no
existe, para y avísame.

---

## Tarea 1 — Saneado de privacidad

### 1.1 Rutas personales

Busca en **todos** los ficheros del proyecto (incluidos `PROMPT-S1.md`,
`PROMPT-S2.md`, `README.md`, comentarios de código y docstrings) cualquier
aparición de:

- `/Users/you` → sustituir por `/Users/you`
- El nombre de usuario suelto `you` en cualquier contexto → `you`

Comando de verificación al terminar (no debe devolver nada):

```zsh
grep -rn "you" . --exclude-dir=.git
```

### 1.2 Cifras del disco en el README

En el README **se conservan** las cifras que sirven de benchmark de rendimiento,
porque son el argumento técnico del proyecto:

- RSS máximo: 929 MB (S1) → 227 MB (S2)
- Tiempo de escaneo: ~35 s
- Volumen de prueba: ~1,2 M de archivos, ~123 GB

Se **eliminan** las cifras que describen el contenido concreto de mi disco:

- El reparto por carpetas (`Users/` 59,8 GB (46%), `System/` 32,2 GB, etc.)
- La cifra de "Datos del sistema = 87,67 GB"
- Cualquier tamaño total del disco presentado como dato mío y no como ejemplo

Donde haga falta un ejemplo, redáctalo en genérico: "on a test volume of ~1.2M
files".

### 1.3 Comprobación de `.gitignore`

Verifica que contiene al menos:

```
*.json
__pycache__/
.DS_Store
```

Y confirma con `git status --ignored` que no hay ningún volcado de escaneo
trackeado. Si `git ls-files` devuelve algún `.json`, avísame antes de tocarlo.

---

## Tarea 2 — Licencia

Crea `LICENSE` en la raíz con el texto estándar de la **MIT License**:

```
Copyright (c) 2026 Enrique Pérez Santos
```

Añade la línea correspondiente al README (badge no, solo una sección `## License`
al final: "MIT — see [LICENSE](LICENSE)").

---

## Tarea 3 — Documentación bilingüe

### 3.1 `README.md` (inglés) — canónico

Reescríbelo entero en inglés. Estructura:

1. **Título y una línea** de qué es: a local, read-only disk usage analyzer for
   macOS with a navigable sunburst chart. No dependencies.
2. **Screenshot placeholder**: `![screenshot](docs/screenshot.png)` con un
   comentario HTML indicando que la imagen falta y la añado yo.
3. **Requirements**: macOS, Python 3 (stdlib only). No pip, no npm, no CDN.
4. **Usage**: `python3 server.py` → `http://127.0.0.1:8765`, y el modo CLI
   `python3 scanner.py /System/Volumes/Data`. Incluye cómo pararlo.
5. **Full Disk Access**: por qué hace falta, cómo concederlo, y el aviso de
   **lanzarlo desde Terminal y no desde el editor** — el proceso hereda los
   permisos TCC de quien lo lanza. Menciona que sin el permiso el total sale
   corto y que la app lo avisa con un banner.
6. **Design decisions** — la sección importante, en prosa breve, un párrafo por
   punto:
   - `st_blocks * 512` en vez de `st_size` (ocupación real, sparse files,
     compresión APFS; contrapartida: los clones APFS se cuentan dos veces).
   - Escanear `/System/Volumes/Data` y no `/` (firmlinks APFS → doble conteo).
     Consecuencia: el total no es comparable con Ajustes del Sistema.
   - Base 1000 (GB) y no 1024 (GiB), para cuadrar con Finder.
   - `MAX_CHILDREN = 40`: se poda **al construir el árbol**, no al servir. El
     `size` y `n_files` del padre se acumulan antes de podar, por eso el total no
     cambia. El resto se colapsa en un nodo sintético "Otros (N elementos)".
     **Subir la constante exige reescanear.**
   - Qué significa exactamente una **carpeta con candado**: directorio que no se
     pudo abrir. Muestra un guion, no `0 B` — `0 B` significaría "está vacío" y
     lo cierto es "no lo sé". No se dibuja en el sunburst porque su tamaño es 0 y
     darle un mínimo artificial falsearía el gráfico.
   - Solo lectura, sin excepciones: ningún endpoint modifica el sistema de
     archivos.
7. **Performance**: tabla S1 → S2 con RSS y tiempo (las cifras del punto 1.2).
8. **Project layout**: el árbol de ficheros.
9. **Docs**: nota de que `docs/` contiene las especificaciones originales de cada
   sesión, **escritas en español**.
10. **License**.

Al principio, una línea: `[Español](README.es.md)`.

### 3.2 `README.es.md`

Misma estructura y contenido en español (España). Empieza con:

```
> La versión canónica es [README.md](README.md) (inglés). Esta traducción puede
> ir por detrás.
```

### 3.3 `docs/`

Mueve `PROMPT-S1.md` y `PROMPT-S2.md` a `docs/` con `git mv`. Añade este mismo
fichero como `docs/PROMPT-S3.md`. Los tres ya saneados por la tarea 1.

**No incluyas** ningún fichero `escaner_disco-continuacion-*.md` en el repo. Si
alguno está en la carpeta del proyecto, añádelo a `.gitignore`.

---

## Tarea 4 — Historial limpio

Solo cuando las tareas 0-3 estén hechas y verificadas.

El historial actual contiene rutas personales en commits antiguos; cambiar los
ficheros ahora no las borra del historial. Colapsa todo en un único commit
inicial:

```zsh
git checkout --orphan public-main
git add -A
git commit -m "Initial public release: read-only disk usage analyzer for macOS"
git branch -D main
git branch -m main
```

Después verifica:

```zsh
git log --oneline              # un solo commit
git log -p | grep -c you   # debe dar 0
```

Si `git log -p` devuelve alguna coincidencia, **para y avísame**: no continúes.

---

## Criterios de aceptación

1. `grep -rn "you" . --exclude-dir=.git` no devuelve nada.
2. `git log -p | grep -c you` devuelve 0.
3. `git log --oneline` muestra un único commit.
4. Existen `LICENSE`, `README.md`, `README.es.md` y `docs/PROMPT-S{1,2,3}.md`.
5. `git ls-files` no lista ningún `.json` ni ningún fichero de continuación.
6. `python3 server.py` sigue arrancando y sirviendo en `http://127.0.0.1:8765`
   exactamente igual que antes: no se ha tocado funcionalidad.
7. La copia `~/web/escaner_disco-backup-S3` existe.

## Al terminar

Déjalo ahí. **No configures remoto ni hagas push**: el repo lo creo yo desde
GitHub y hago el push a mano. Dime en una línea el resultado de cada criterio.
