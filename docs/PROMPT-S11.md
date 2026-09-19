# escaner_disco — Sesión S11

Continuación de S10 (detección de basura publicada; repo público al día).

Objetivo único: **empaquetar la app como `.app` de macOS** con PyInstaller, de modo
que se pueda copiar a otro Mac y funcionar con doble clic. Windows queda para una
sesión posterior, cuando haya PC delante.

Se mantienen las restricciones de siempre: el **código que se ejecuta** sigue
siendo Python 3 solo stdlib (`ctypes` autorizado desde S6) y front vanilla sin
frameworks ni CDN. Código y commits en inglés.

**No hagas `git push`.** El push lo hago yo a mano.

**Guarda este fichero directamente en `docs/PROMPT-S11.md`**, no en la raíz. Si
incluye rutas con mi nombre de usuario local, sustitúyelas por `TU_USUARIO`.

---

## Tarea 0 — Copia de seguridad

```zsh
cp -R ~/web/escaner_disco ~/web/escaner_disco-backup-S11
```

Verifica que existe antes de continuar.

---

## Decisiones ya tomadas (no las replantees)

1. **PyInstaller, no Tauri.** Tauri exigiría reescribir el scanner en Rust. Para
   instalar en unos pocos Macs conocidos, PyInstaller basta.
2. **PyInstaller es dependencia de build, no de ejecución.** Quien clone el repo
   sigue arrancando con `python3 server.py` sin instalar nada. La regla "cero
   dependencias" se mantiene intacta para el código que corre; el empaquetado
   vive aparte, en `packaging/`, y se documenta como tal. **No añadas ningún
   import de terceros a `scanner.py`, `server.py`, `cache.py` ni
   `platform_support.py`.**
3. **`--onedir` dentro de un `.app`, nunca `--onefile`.** `--onefile` descomprime
   a una ruta temporal distinta en cada arranque, y eso rompe el permiso de TCC,
   que se concede a una ruta concreta. `--onedir` arranca al instante y tiene
   ruta estable.
4. **Sin firmar y sin notarizar.** Una cuenta de desarrollador cuesta 99 €/año y
   no compensa para tres Macs conocidos. Se documenta el clic derecho → Abrir.
   Firma ad-hoc (`codesign -s -`) sí, porque es gratis y reduce sustos al copiar
   la app entre máquinas.
5. **El navegador se abre sobre `http://127.0.0.1:<puerto>`, nunca `localhost`.**
   Son orígenes distintos y el blindaje de `Origin` de S4 rechaza el segundo.
6. **Salida limpia con `POST /api/quit`.** Sin ventana propia, la app se quedaría
   corriendo invisible hasta un `pkill`. Se descarta el ítem en la barra de menús
   porque exigiría `pyobjc` o `rumps`, dependencias que sí se ejecutan.

---

## Tarea 1 — Punto de entrada (`app_main.py`, nuevo)

Fichero nuevo en la raíz. Es lo que ejecuta el `.app`. `server.py` se toca lo
imprescindible y **debe seguir funcionando solo**, exactamente como en S10.

Comportamiento:

1. Elegir puerto: intenta el 8765; si está ocupado, **no falles** — prueba los
   siguientes hasta el 8775 y usa el primero libre. Si ninguno lo está, escribe el
   error en el log y sal con código distinto de 0.
2. Arrancar el servidor en un hilo.
3. Esperar a que el puerto responda (sondeo corto con tope, no un `sleep` fijo).
4. Abrir el navegador con `webbrowser.open("http://127.0.0.1:<puerto>/")`.
5. Quedarse vivo hasta que se pida la salida.

Con `--windowed` no hay consola: `stdout` y `stderr` se pierden. Redirígelos a
`~/Library/Logs/escaner_disco/app.log` (rotación no hace falta; truncar al
arrancar basta). Sin eso, un fallo al arrancar es invisible.

**El puerto elegido debe llegar al blindaje de `Origin`**, que compara contra el
origen exacto. Si el servidor arranca en 8766, el único `Origin` válido es
`http://127.0.0.1:8766`. Haz que la comprobación en `server.py` use el puerto
real en uso, no la constante 8765. **Revísalo con cuidado: es el punto donde es
más fácil romper el blindaje de S4 sin darse cuenta.**

### 1.1 Rutas de recursos dentro del bundle

Empaquetado, `static/` no está junto al script: PyInstaller lo deja bajo
`sys._MEIPASS`. Añade a `platform_support.py`:

```python
def is_packaged() -> bool     # getattr(sys, "frozen", False)
def resource_dir() -> str     # base de los ficheros estáticos
```

`resource_dir()` devuelve `sys._MEIPASS` cuando la app está empaquetada y el
directorio del módulo en caso contrario. `server.py` sirve `static/` desde ahí.

**`cache_dir()` no cambia**: sigue siendo
`~/Library/Application Support/escaner_disco`, fuera del bundle y escribible.
Verifícalo empaquetado, no lo des por hecho.

---

## Tarea 2 — Salida limpia: `POST /api/quit`

### 2.1 En `server.py`

Nuevo endpoint `POST /api/quit`. Responde `{"ok": true}` y a continuación apaga
el servidor y termina el proceso de forma ordenada: **primero la respuesta,
después el cierre** (p. ej. `shutdown()` desde un hilo aparte, nunca desde el
propio handler, que se bloquearía).

**Blindaje idéntico al de `/api/reveal` (S4):**

- Solo `POST`. Un `GET` lo dispararía cualquier web con una etiqueta `<img>`. Si
  llega `GET`, `405`.
- Cabecera `Origin`: si viene y no es el origen real del servidor, `403`.
- No acepta ningún parámetro. El cliente dice "cierra", no "cierra esto".

Comentario sobre el handler explicando por qué existe cada comprobación, como se
hizo con `/api/reveal`.

**El principio de solo lectura se matiza, y hay que documentarlo:** la app sigue
sin modificar ficheros del usuario; ahora, además, puede terminarse a sí misma.
Matar el propio proceso no toca el sistema de archivos.

### 2.2 En el front

Botón discreto **"Salir"**, arriba a la derecha, junto al conmutador de vistas.

- Confirmación **en la propia interfaz**, no `confirm()` del navegador: un texto
  que diga que se cierra la aplicación y que la pestaña dejará de funcionar.
  Cancelar como opción por defecto.
- Al confirmar, `POST /api/quit` y sustituir el contenido de la página por un
  mensaje claro: la aplicación se ha cerrado, puedes cerrar esta pestaña.
- **Solo aparece cuando la app corre empaquetada.** Lanzada con
  `python3 server.py` se cierra con `Ctrl+C` y el botón sobra. Añade
  `"packaged": true|false` a `/api/config` y que el front decida con eso.

---

## Tarea 3 — Primer arranque y Acceso total al disco

**Es la parte más importante de la sesión.** El `.app` es un proceso distinto de
Terminal: **no hereda su permiso de TCC**, necesita el suyo propio. Un usuario
nuevo que abra la app sin concederlo verá ~430 rutas no legibles y unos 7 GB de
menos, con un banner que no sabrá interpretar.

La app no puede concederse el permiso ni pedirlo con un diálogo del sistema. Lo
único que puede hacer es **detectarlo y explicarlo bien**.

### 3.1 Detección

En `platform_support.py`:

```python
def has_full_disk_access() -> bool
```

En macOS, intenta listar un directorio que solo es legible con Acceso total al
disco (`~/Library/Application Support/com.apple.TCC/` es el canario habitual).
`False` si lanza `PermissionError`. `try/except` amplio: esta función **nunca**
puede tirar la app. En Windows y Linux devuelve `True` por ahora; coméntalo.

Expón el resultado en `/api/config` como `"full_disk_access": true|false`.

### 3.2 En la pantalla de inicio

Si `full_disk_access` es `false`, aviso visible **antes de escanear**, no
después:

- Qué pasa si escanea sin el permiso: el total saldrá corto y aparecerán cientos
  de carpetas no legibles.
- Cómo concederlo, con los pasos exactos: Ajustes del Sistema → Privacidad y
  seguridad → Acceso total al disco → botón `+` → seleccionar
  `Escáner de Disco.app`.
- **Que hay que cerrar la app por completo y volver a abrirla**: el permiso se
  aplica al arrancar el proceso, no en caliente. Aquí el botón "Salir" es útil.

No bloquees el escaneo: el usuario puede querer mirar solo su carpeta personal,
que no necesita el permiso. Informar, no impedir.

Aplica también cuando se ejecuta desde Terminal sin TCC: es el mismo problema
que llevamos seis sesiones detectando a mano por el número de errores.

---

## Tarea 4 — Build (`packaging/`, nuevo)

Carpeta nueva `packaging/` (no `build/`, que PyInstaller usa como directorio de
trabajo y crearía confusión) con:

- **`escaner_disco.spec`** y un script **`build_macos.sh`** que lo ejecute.
  Debe producir `dist/Escáner de Disco.app`.
  - `windowed`, modo `onedir`, `static/` incluido como datos.
  - `CFBundleIdentifier`: `com.pATMosk19.escanerdisco`.
  - Firma ad-hoc al final: `codesign --force --deep -s - "dist/Escáner de Disco.app"`.
  - Icono: si es trivial, uno sencillo; si no, anótalo como pendiente y sigue.
- **`packaging/README.md`**: cómo crear un venv de build (fuera del repo), instalar
  PyInstaller en él, lanzar el script y dónde queda el `.app`.

`.gitignore`: añade `build/`, `dist/` y el venv de build. **El `.spec` sí se
versiona.**

---

## Tarea 5 — Documentación

### 5.1 `README.md` (inglés, canónico)

- Sección nueva **Packaged app (macOS)**: cómo construirla; que va sin firmar y la
  primera vez se abre con clic derecho → Abrir; y **el apartado de TCC**: la app
  empaquetada necesita su propia entrada en Acceso total al disco, no vale la de
  Terminal, y hay que reiniciarla después de concederlo. Dónde está el log.
- En **Design decisions**: por qué `--onedir` y no `--onefile` (ruta estable para
  TCC); por qué PyInstaller es dependencia de build y no de ejecución; por qué
  `/api/quit` y no un ítem en la barra de menús; y el matiz del principio de
  solo lectura.
- `/api/quit` en la lista de endpoints.

### 5.2 `README.es.md`

Mismo cambio, en español (España).

### 5.3 `docs/PROMPT-S11.md`

Este mismo fichero.

---

## Criterios de aceptación

1. `python3 server.py` desde Terminal sigue funcionando **igual que en S10**:
   mismas vistas, misma caché, mismo blindaje. Sin botón "Salir".
2. El build produce `dist/Escáner de Disco.app` y abre con doble clic: arranca el
   servidor y abre el navegador solo, sin ventana de terminal.
3. Empaquetada, sirve `static/` correctamente: CSS, JS e iconos, sin errores en
   la consola del navegador.
4. Empaquetada, un escaneo de `~/Downloads` funciona y **la caché se escribe en
   `~/Library/Application Support/escaner_disco/`**, no dentro del bundle.
5. Con el 8765 ocupado por otro proceso, la app arranca en el siguiente puerto
   libre, el navegador abre ahí y **el blindaje de `Origin` usa el puerto real**:
   `POST` con `Origin: http://evil.example` → `403`; con el origen correcto → OK.
6. `GET /api/quit` → `405`. `POST` con `Origin` ajeno → `403`. `POST` legítimo
   cierra el servidor y el proceso termina (`pgrep` vacío después).
7. El botón "Salir" solo aparece empaquetada, pide confirmación en la UI y deja un
   mensaje claro al cerrar.
8. Sin Acceso total al disco concedido a la app, la pantalla de inicio muestra el
   aviso con los pasos **antes** de escanear, y el escaneo sigue siendo posible.
9. `/api/reveal` sigue abriendo Finder desde la app empaquetada.
10. Un fallo al arrancar deja rastro en `~/Library/Logs/escaner_disco/app.log`.
11. `git ls-files -z | xargs -0 grep -ln "TU_USUARIO"` vacío.
12. Ni `dist/`, ni `build/`, ni el venv de build aparecen en `git ls-files`.

### Comprobación manual

```zsh
# con la app empaquetada corriendo; sustituye PUERTO por el real
curl -i http://127.0.0.1:PUERTO/api/quit
curl -i -X POST -H "Origin: http://evil.example" http://127.0.0.1:PUERTO/api/quit
curl -i -X POST http://127.0.0.1:PUERTO/api/quit
pgrep -fl "Escáner de Disco"
```

Esperado, en orden: `405`, `403`, `200` y cierre, `pgrep` vacío.

**Nota sobre el criterio 8:** desde tu shell no puedo comprobar qué ve la app con
y sin permiso. Déjalo preparado y dime cómo lo verifico yo a mano.

---

## Al terminar

Commits en inglés y granulares, separando: punto de entrada y rutas de recursos /
endpoint de salida y botón / aviso de TCC / packaging / docs.

Verifica la autoría antes de cerrar (**no fuerces `-c` en los comandos de git**,
fue la causa del problema en S4):

```zsh
git log -6 --format='%h %an <%ae>'
```

No configures remoto ni hagas push.
