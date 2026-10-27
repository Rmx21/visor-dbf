# Visor DBF

Visor DBF es una aplicación web estática para inspeccionar archivos `.dbf` en el navegador. Muestra campos y registros, permite buscar en toda la tabla y ayuda a identificar si los archivos auxiliares `.cdx`, `.fpt` o `.dbt` pueden ser necesarios.

## Uso

1. Abre `index.html` en un navegador moderno, o sirve esta carpeta desde un servidor web estático.
2. Selecciona un archivo DBF.
3. Opcionalmente, selecciona el CDX, FPT o DBT correspondiente. Para un CDX compuesto compatible, el ícono dentro de **Archivo .cdx** descarga un CSV compacto de metadatos generales con una fila por etiqueta y sus referencias DBF fuera de rango. El análisis recorre hasta 100 000 páginas de etiquetas.
4. Pulsa **Analizar archivos**.
5. Recorre los registros por páginas de hasta 250 filas o usa la búsqueda para encontrar texto en todos los campos o en uno seleccionado. **Exacta** (predeterminado) coincide con el término completo; **Parcial** busca fragmentos de texto. Si escribes varias palabras separadas por espacios, **AND** (predeterminado) muestra registros que contienen todas; **OR** muestra los que contienen al menos una.
6. Opcionalmente, selecciona un campo en **Filtrar repetidos por** para mostrar solo los valores que aparecen más de una vez, con todas sus filas (incluida la primera) y ordenados por ese campo. El criterio se combina con la búsqueda.
7. Usa el botón de descarga en **Campos** o **Registros** para exportar la información a CSV. Los archivos se nombran `campos_NombreDelDbf.csv` y `registros_NombreDelDbf.csv`; la exportación incluye todos los registros que coincidan con los filtros activos, o toda la tabla cuando no hay filtros, no solo la página visible.

No requiere instalación, compilación ni dependencias de servidor.

## Privacidad y seguridad

- El visor lee los archivos seleccionados con el navegador y los procesa localmente; no contiene código para subirlos a ningún servidor.
- Los DBF y sus auxiliares pueden contener información personal o confidencial. No publiques datos reales en un repositorio Git, aunque el visor no los transmita por red.
- El análisis CDX lee etiquetas y recorre las entradas de índices compuestos compatibles. Marca referencias a registros fuera del rango disponible, pero no verifica que las claves coincidan con el DBF ni demuestra que el índice esté completo o actualizado. Las expresiones no se evalúan; cuando no se puede inferir el byte de relleno de una clave, se representa como `??`.
- Cuando se proporciona un FPT, el visor cruza los punteros de los campos memo del DBF para contar bloques legibles, no legibles, vacíos, de texto y binarios; si hay referencias no legibles, muestra los campos y hasta cinco números de registro por campo. No evalúa el contenido binario ni busca bloques FPT sin referencia en el DBF.
- La sección de dependencias ofrece indicios a partir del encabezado DBF y sus campos; no sustituye la validación con la aplicación que creó la tabla.
- Como cualquier lector de archivos locales, abrir archivos grandes consume memoria del navegador. La interfaz limita las filas renderizadas a 250 por página y procesa la búsqueda en bloques.
- `.gitignore` excluye DBF y archivos auxiliares para reducir el riesgo de agregarlos por accidente; revisa siempre los archivos staged antes de hacer push.

## Tecnologías

- HTML, CSS y JavaScript nativos.
- Sin dependencias, almacenamiento remoto ni backend.
