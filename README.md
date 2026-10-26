# Visor DBF

Visor DBF es una aplicación web estática para inspeccionar archivos `.dbf` en el navegador. Muestra campos y registros, permite buscar en toda la tabla y ayuda a identificar si los archivos auxiliares `.cdx`, `.fpt` o `.dbt` pueden ser necesarios.

## Uso

1. Abre `index.html` en un navegador moderno, o sirve esta carpeta desde un servidor web estático.
2. Selecciona un archivo DBF.
3. Opcionalmente, selecciona el CDX, FPT o DBT correspondiente.
4. Pulsa **Analizar archivos**.
5. Recorre los registros por páginas de hasta 250 filas o usa la búsqueda para encontrar texto en cualquier campo. Si escribes varias palabras separadas por espacios, **AND** (predeterminado) muestra registros que contienen todas; **OR** muestra los que contienen al menos una.
6. Usa el botón de descarga en **Campos** o **Registros** para exportar la información a CSV. Los archivos se nombran `campos_NombreDelDbf.csv` y `registros_NombreDelDbf.csv`; la exportación incluye todos los registros que coincidan con la búsqueda activa, o toda la tabla cuando no hay filtro, no solo la página visible.

No requiere instalación, compilación ni dependencias de servidor.

## Privacidad y seguridad

- El visor lee los archivos seleccionados con el navegador y los procesa localmente; no contiene código para subirlos a ningún servidor.
- Los DBF y sus auxiliares pueden contener información personal o confidencial. No publiques datos reales en un repositorio Git, aunque el visor no los transmita por red.
- La sección CDX/FPT ofrece indicios a partir del encabezado DBF y sus campos; no sustituye la validación con la aplicación que creó la tabla.
- Como cualquier lector de archivos locales, abrir archivos grandes consume memoria del navegador. La interfaz limita las filas renderizadas a 250 por página y procesa la búsqueda en bloques.
- `.gitignore` excluye DBF y archivos auxiliares para reducir el riesgo de agregarlos por accidente; revisa siempre los archivos staged antes de hacer push.

## Tecnologías

- HTML, CSS y JavaScript nativos.
- Sin dependencias, almacenamiento remoto ni backend.
