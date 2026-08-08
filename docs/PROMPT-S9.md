# escaner_disco — Sesión S9

> **Nota: este documento se escribió después de ejecutar la sesión.** S9 fue un
> arreglo de una línea y se dio directamente en el chat, sin spec previa. Se
> recoge aquí para que la serie `docs/PROMPT-S*.md` no tenga huecos y para dejar
> constancia del checkpoint que sigue abierto. A diferencia de los demás ficheros
> de esta carpeta, no es una especificación que Claude Code ejecutó.

Continuación de S8 (la app corre entera en Windows por primera vez).

Objetivo único: **arreglar la rama rota de `disk_size()`** para desbloquear el
checkpoint de `WINDOWS_EXACT_SIZE`.

---

## El bug

`platform_support.disk_size()` mezclaba dos decisiones en una sola guarda:

```python
if platform_id() != "windows" or not WINDOWS_EXACT_SIZE:
    return st.st_blocks * 512
```

En Windows con la constante en `False`, la condición se cumple por el segundo
término y cae al camino POSIX. `st_blocks` **no existe** en Windows:

```
AttributeError: 'os.stat_result' object has no attribute 'st_blocks'
```

La constante existía desde S6 como salida de emergencia por si
`GetCompressedFileSizeW` (una llamada al sistema por fichero) costaba demasiado.
Nunca se había puesto en `False`, así que el fallo esperó tres sesiones a que
alguien lo ejecutara.

---

## El arreglo

Separar la guarda en tres ramas explícitas:

| Condición | Devuelve |
|---|---|
| POSIX (macOS, Linux) | `st.st_blocks * 512` |
| Windows + `WINDOWS_EXACT_SIZE = True` | `GetCompressedFileSizeW` vía `ctypes` |
| Windows + `WINDOWS_EXACT_SIZE = False` | `st.st_size` |

La rama de fallback ya no toca `st_blocks` en ningún caso.

**Verificación:** se probó con un objeto `stat` sin el atributo `st_blocks` y la
rama de Windows no lanza `AttributeError`.

**Commit:** `79c6b3c`, sobre S8, autoría correcta, sin push desde la sesión.

---

## Pendiente: el checkpoint que esto desbloquea

Sigue **sin medir**. Hay que ejecutarlo en el PC, sobre `C:\Windows`:

```
python scanner.py C:\Windows      # con WINDOWS_EXACT_SIZE = True
python scanner.py C:\Windows      # con WINDOWS_EXACT_SIZE = False
```

Referencia con `True` (S8): **192.003 ficheros, 35,0 GB, 5 errores, 41,8 s**.

Criterio de decisión acordado en S6: si `True` cuesta **más del doble** que
`False`, hay que replantear el valor por defecto de la constante. La contrapartida
conocida es que `st_size` pierde la compresión NTFS y los sparse files, lo que
contradice la decisión de S1 de medir ocupación real — por eso el umbral es alto
y no se cambia el defecto por una diferencia pequeña.

---

## Pendiente de documentar (arrastrado de S8)

Tres hallazgos del PC que siguen sin llegar al README:

1. **Python de la Microsoft Store redirige `%LOCALAPPDATA%`.** La caché se
   escribe en
   `%LOCALAPPDATA%\Packages\PythonSoftwareFoundation.Python.3.11_…\LocalCache\Local\escaner_disco\`.
   El código es correcto; el contenedor del paquete es invisible desde dentro del
   proceso. Desaparece al empaquetar con PyInstaller, pero afecta a cualquiera que
   clone el repo. Mejor que una nota: detección al arrancar.
2. **El Explorador no viene al primer plano** con `explorer /select,`. Es la
   protección anti-robo-de-foco de Windows, no un error de la llamada. Decisión:
   documentarlo, no arreglarlo — `AllowSetForegroundWindow` es poco fiable con
   `explorer.exe` y `start` exigiría `shell=True`, prohibido desde S4.
3. **Hardlinks sin deduplicar en Windows.** `scandir` deja `st_ino = 0` y la
   dedup se guardó con `st_ino != 0` desde S6, así que nunca se dispara. El total
   sale **inflado, no oculto**; afecta sobre todo a `WinSxS`. No es fallo de
   corrección, pero hay que decirlo.

---

## Aprendizaje

**Una opción que nunca se ejecuta no es una opción.** `WINDOWS_EXACT_SIZE` era la
salida de emergencia por si la medición exacta salía cara, y la salida de
emergencia estaba rota. Medir una constante de escape es parte de probarla.
