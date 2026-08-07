# escaner_disco — Sesión S8

Continuación de S7. **Sesión de corrección, no de features.**

Al probar S6 en Windows por primera vez, el scanner **no desciende a ningún
subdirectorio**: `python scanner.py C:\Windows` devuelve 22 ficheros, 6,4 MB y
**0 errores**. Solo lista los ficheros sueltos del primer nivel. Fallo silencioso,
sin traza, sin contador de errores.

Se mantienen las restricciones de siempre: Python 3 solo stdlib, front vanilla,
código y commits en inglés.

**No hagas `git push`.** El push lo hago yo a mano.

**Guarda este fichero directamente en `docs/PROMPT-S8.md`.** Si contiene rutas
con mi nombre de usuario local, sustitúyelas por `TU_USUARIO`.

---

## Diagnóstico (ya hecho, no lo repitas)

En Windows, `os.scandir()` rellena los campos del `stat` a partir del listado del
directorio, **sin hacer la llamada extra al sistema** que obtendría el índice del
fichero. Consecuencia medida en el PC:

```
raiz  C:\Windows        st_dev: 311682304
hijo  C:\Windows\appcompat  st_dev: 0   st_ino: 0
```

El scanner compara el `st_dev` de cada directorio contra el de la raíz para no
cruzar volúmenes (decisión de S1). Como todos los hijos reportan `st_dev = 0` y
la raíz no, **todos los directorios parecen estar en otro volumen y se descartan
en silencio**. No se cuentan como error porque no lo son: es la regla de no
cruzar volúmenes haciendo su trabajo con un dato falso.

Verificado también en `C:\Windows\System32\drivers`: 431 ficheros planos, ninguna
subcarpeta recorrida.

En macOS y Linux `st_dev` viene siempre informado, por eso nunca se manifestó.

---

## Tarea 1 — `platform_support.py`: nueva función `same_volume`

La comprobación de volumen pasa a ser específica de plataforma, como manda la
regla de S6. Añade a la API pública:

```python
def same_volume(root_path, root_st, child_path, child_st) -> bool
```

- **macOS y Linux**: `root_st.st_dev == child_st.st_dev`. Comportamiento actual,
  sin cambios.
- **Windows**:
  1. Compara la unidad con `os.path.splitdrive()`, **insensible a mayúsculas**.
     Si difieren → `False`.
  2. Si además `child_st.st_dev != 0` y `root_st.st_dev != 0`, compara también
     los `st_dev`. Cuando el dato existe, se usa; cuando vale 0, se ignora.
  3. En cualquier otro caso → `True`.

**Limitación conocida, va comentada en el código y en el README:** un volumen
montado en una carpeta (junction a otra unidad) comparte letra de unidad y, si
`st_dev` viene a 0, se escanearía como si fuera parte del mismo volumen. Es raro
en equipos domésticos y el coste de la alternativa (un `os.stat()` real por cada
directorio) no compensa. Documentarlo, no ocultarlo.

---

## Tarea 2 — `scanner.py`: usar `same_volume`

Sustituye la comparación directa de `st_dev` por la llamada a
`platform_support.same_volume(...)`. **No cambies nada más**: ni la poda, ni la
acumulación, ni el manejo de errores, ni la construcción de rutas.

Revisa además si hay **otros sitios donde el scanner asuma que un `stat` de
`scandir` viene completo en Windows**. Los candidatos:

- `st_nlink`: si desde `scandir` vale siempre 1, la deduplicación de hardlinks
  nunca se dispara. No es un fallo de corrección (contar un hardlink dos veces
  infla, no oculta), pero **dilo en el resumen** si lo confirmas.
- `st_ino == 0`: ya contemplado en S6, verifica que sigue.

Si encuentras algún otro campo afectado, **para y dímelo antes de tocarlo**.

---

## Tarea 3 — Que el fallo no pueda volver a ser silencioso

Este bug sobrevivió a una sesión entera porque un escaneo vacío se ve igual que
un escaneo correcto de una carpeta pequeña. Añade una defensa mínima:

- Al terminar el escaneo, si la raíz tiene **al menos un subdirectorio** pero el
  árbol resultante **no contiene ningún directorio recorrido**, imprime un aviso
  destacado por stderr: el escaneo no ha descendido, algo va mal.
- El aviso no aborta ni cambia el código de salida. Solo avisa.

No inventes más heurísticas que esta. Una sola comprobación barata y clara.

---

## Tarea 4 — Documentación

### 4.1 `README.md` (inglés, canónico)

- En **Platform support**, nota sobre Windows: la comprobación de volumen usa la
  letra de unidad porque `os.scandir` no rellena `st_dev`, con la limitación de
  los volúmenes montados en carpeta.
- Si la sección de **Design decisions** menciona la regla de no cruzar volúmenes,
  matízala ahí.

### 4.2 `README.es.md`

Mismo cambio, en español (España).

### 4.3 `docs/PROMPT-S8.md`

Este mismo fichero.

---

## Criterios de aceptación

**En Windows (los que motivan la sesión — los verifico yo en el PC):**

1. `python scanner.py C:\Windows\System32\drivers` recorre las subcarpetas:
   más de 431 ficheros y un total mayor que 177,7 MB.
2. `python scanner.py C:\Windows` da un número de ficheros del orden de
   **cientos de miles**, no 22, y un contador de errores mayor que 0 (hay
   carpetas protegidas: que aparezcan es lo correcto).
3. El escaneo de la carpeta de usuario termina sin traza y escribe la caché en
   `%LOCALAPPDATA%\escaner_disco`.
4. Checkpoint pendiente de S6: tiempo de escaneo de una carpeta de ≥100.000
   ficheros con `WINDOWS_EXACT_SIZE = True` y con `False`. Las dos cifras.

**En macOS (no regresión — esta sesión sí toca Python):**

5. Total de `/System/Volumes/Data` dentro del ±0,5% de la referencia actual:
   **124,9 GB, 1.202.091 ficheros, 233 rutas no legibles**. Compara contra un
   escaneo hecho **en la misma sesión de terminal**, no contra la cifra escrita
   aquí: el disco deriva.
6. Tiempo sin empeorar más de un 10% (referencia 35,2 s) y RSS por debajo de
   250 MB (referencia 227 MB).

**Ambos:**

7. El `grep` de la regla de S6 sigue vacío fuera de `platform_support.py`.
8. `git ls-files -z | xargs -0 grep -ln "TU_USUARIO"` vacío.

---

## Al terminar

Commits en inglés y granulares, separando módulo de plataforma / scanner / docs.

Verifica la autoría antes de cerrar (**no fuerces `-c` en los comandos de git**):

```zsh
git log -4 --format='%h %an <%ae>'
```

No configures remoto ni hagas push.

**Aviso de medición:** cualquier cifra de escaneo en macOS solo vale si el
servidor o el script se lanzan desde una terminal con Acceso total al disco. La
firma de un escaneo inválido es **~429 rutas no legibles y ~116 GB**; la válida
es **233 y ~125 GB**. Si mides 429, la medición no cuenta.
