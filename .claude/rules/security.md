# Reglas de seguridad (todos los agentes)

- Nunca almacenar contraseñas, tokens ni secretos en texto plano, en el repo ni en logs.
- Persistencia de tokens: solo Administrador de credenciales de Windows (DPAPI).
- Nunca pedir ni aceptar credenciales reales en prompts. El usuario inicia sesión personalmente en las páginas oficiales.
- Nunca leer `.env*`, archivos de credenciales ni el contenido de la bóveda de Bitwarden.
- Nunca extraer ni imprimir secretos con la CLI de Bitwarden. Nunca desbloquear la bóveda automáticamente.
- La salida de comandos entra al contexto de los agentes: imprimir solo metadatos neutros de datos personales (conteos, IDs, fechas, dominio del remitente). El contenido completo solo con `--show`, que ejecuta únicamente el usuario.
- No enviar contenido de correos a modelos de IA sin autorización específica.
- Permisos OAuth mínimos y de solo lectura salvo autorización.
- No desarrollar criptografía propia. Priorizar bibliotecas y gestores consolidados.
- Ningún módulo puede bloquear la app por fallos de red o autenticación.
- El módulo de contraseñas está aislado de los demás.
