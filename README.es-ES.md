# metafaker

MetaFaker es una aplicación de navegador estática para cargar una o varias imágenes, re-codificarlas como JPEG y, ya sea eliminar los metadatos EXIF o reemplazarlos con un conjunto de metadatos generados. La aplicación es totalmente del lado del cliente. No hay backend, no hay paso de carga y no hay almacenamiento en la nube en la versión actual.

## Comportamiento actual

- Acepta múltiples imágenes mediante arrastrar y soltar o el selector de archivos.
- Construye una cola de lotes local con vistas previas y estado por imagen.
- Analiza los EXIF originales localmente en el navegador.
- Re-codifica cada imagen procesada como un nuevo JPEG.
- Elimina los metadatos por completo o inyecta un bloque EXIF generado.
- Descarga los archivos procesados localmente y mantiene el nombre de archivo original cuando es posible.

## Arquitectura

La aplicación está dividida en pequeños módulos de navegador:

- `index.html`
  Define el esquema de la UI, la zona de carga, el panel de vista previa, los botones de acción, el panel de metadatos y la única pestaña de metadatos.
- `css/style.css`
  Proporciona el diseño, la cola de lotes responsiva, el estilo de las tarjetas de vista previa, el estilo de la tabla de metadatos y las notificaciones toast.
- `js/main.js`
  Arranca la aplicación, inicializa el estado del tema y conecta los eventos de arrastrar/soltar y de entrada de archivos al controlador.
- `js/ui.js`
  Gestiona el estado de la aplicación, la administración de la cola, el renderizado, las descargas y el flujo de trabajo de procesamiento de alto nivel.
- `js/exif.js`
  Genera datos EXIF falsos, analiza los EXIF de origen, verifica los metadatos escritos, formatea los valores para su visualización y normaliza la salida de GPS.
- `js/data.js`
  Contiene la base de datos estática de cámaras, la base de datos de ubicaciones de EE. UU. y los datos de mapeo de lentes utilizados para metadatos falsos internamente consistentes.
- `js/helpers.js`
  Proporciona utilidades compartidas como la generación de IDs, formateo de bytes, ayudantes de conversión de GPS, ayudantes de blob/URL de datos y el flujo de exportación de canvas.

## Flujo de procesamiento

Para cada archivo cargado, la aplicación sigue este flujo:

1. El navegador lee el archivo de entrada localmente y crea una URL de objeto para la vista previa.
2. `exifr` analiza los metadatos originales del archivo de entrada.
3. Cuando el usuario hace clic en `Randomize Current` o `Randomize Entire Batch`, la imagen se dibuja en un canvas y se exporta como un nuevo JPEG.
4. `generateFake()` construye un perfil de cámara, datos de lente, marcas de tiempo, valores de exposición y una ubicación limitada a EE. UU. a partir de los conjuntos de datos estáticos.
5. `piexifjs` escribe ese bloque EXIF en el JPEG recién exportado.
6. Una segunda pasada de normalización de GPS reescribe las etiquetas de latitud y longitud a coordenadas y referencias convencionales de EE. UU.
7. La aplicación lee el JPEG resultante una vez más para verificar que los metadatos se escribieron correctamente antes de poner la salida a disposición para vista previa o descarga.

La ruta de `Strip Current Metadata` utiliza el mismo paso de exportación de canvas, pero omite la inyección de EXIF y deja el JPEG de salida sin metadatos.

## Generación de metadatos

Los datos EXIF generados se basan en perfiles estáticos en lugar de valores arbitrarios de formato libre. La intención es mantener la consistencia interna entre campos relacionados.

Ejemplos de campos que se generan conjuntamente:

- marca de la cámara, modelo y software
- marca del lente y modelo del lente
- velocidad de obturación, apertura, ISO, distancia focal y distancia focal equivalente a 35 mm
- balance de blancos, flash, modo de medición, programa de exposición y modo de exposición
- marcas de tiempo de captura incluyendo precisión de sub-segundos
- latitud GPS, longitud, altitud, sello de fecha y sello de hora

El conjunto de datos de ubicación se limita a ciudades de EE. UU. en `js/data.js`, y `js/exif.js` ajusta las coordenadas GPS finales a un cuadro delimitador de EE. UU. antes de escribirlas.

## Formato de exportación

- Los archivos de salida son siempre JPEG.
- Si el archivo cargado ya utilizaba una extensión `.jpg` o `.jpeg`, se conserva dicho nombre de archivo.
- Si el archivo de origen utilizaba otra extensión, se conserva el nombre base y la extensión pasa a ser `.jpg`.

El flujo de exportación de canvas en `js/helpers.js` crea un mapa de bits JPEG nuevo y puede redimensionar entradas grandes antes de la exportación. Esto mantiene el flujo de procesamiento uniforme y evita depender del formato del contenedor original.

## Dependencias de ejecución

La aplicación es estática, pero depende de dos librerías cargadas en el navegador:

- `piexifjs` desde jsDelivr para la escritura binaria de EXIF
- `exifr` desde jsDelivr para el análisis de EXIF y la verificación de lectura

No hay paso de compilación. Abrir `index.html` a través de un host estático es suficiente.

## Estado local

La aplicación almacena únicamente la preferencia del tema en `localStorage` bajo la clave `metafaker.theme`.

Las imágenes procesadas, las vistas previas y el estado de la cola residen en la memoria únicamente para la pestaña activa. Reiniciar la cola revoca las URLs de objeto y limpia ese estado en memoria.

## Notas de desarrollo

- La aplicación está diseñada para ejecutarse como un sitio estático.
- No existe una superficie de API del lado del servidor.
- La lógica de la cola y la vista previa están optimizadas para evitar renderizar cada miniatura a costo completo en lotes grandes en dispositivos móviles.
- El panel de metadatos siempre muestra los EXIF originales, los EXIF generados o un estado de eliminación explícito para la imagen seleccionada.

## Alojamiento

Dado que el proyecto es totalmente estático, puede alojarse en cualquier host estático sencillo como GitHub Pages. No se requieren variables de entorno ni claves de API para la versión actual que funciona solo localmente.
