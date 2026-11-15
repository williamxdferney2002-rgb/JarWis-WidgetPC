# Guía: registrar JarWis en Google y Microsoft

Estos pasos los haces **tú** en las consolas oficiales. Ningún agente inicia sesión por ti ni ve tus contraseñas.
Al terminar, tendrás un archivo `%APPDATA%\JarWis\oauth-clients.json` **fuera del repositorio**.

---

## Parte 1 — Google Cloud (sin facturación, sin costo)

1. Entra en https://console.cloud.google.com con tu cuenta de Gmail.
2. Arriba, en el selector de proyecto, elige **Nuevo proyecto**, ponle de nombre `JarWis` y pulsa Crear. **No** vincules ninguna cuenta de facturación.
3. Ve a **APIs y servicios → Biblioteca** y habilita, una por una:
   - Gmail API
   - Google Calendar API
   - Google Tasks API
4. Ve a **Google Auth Platform → Branding (Marca)**: nombre de la app `JarWis` y tu Gmail como correo de soporte. No subas logo ni dominios.
5. En **Audience (Público)**:
   - Tipo: **External**.
   - Estado: **Testing**.
   - En **Test users**, añade tu propio Gmail.
6. En **Data Access (Acceso a datos)** → *Add or remove scopes*, añade:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/gmail.readonly`
   - `.../auth/calendar.readonly`
   - `.../auth/tasks.readonly`
7. En **Clients (Clientes) → Create client**, elige el tipo **Desktop app**, ponle de nombre `JarWis Desktop` y pulsa Crear.
   - ⚠️ **Descarga el JSON en ese momento.** Google solo muestra el secreto una vez.
   - Guárdalo fuera del proyecto, por ejemplo en `Documentos`. **No** lo guardes en `C:\dev\JarWis`.
8. No envíes la app a verificación. Pasarla a producción (**Publish app**) se hace después, cuando la prueba de la Fase 1C salga bien (D-009).

> En modo Testing, el inicio de sesión dura 7 días: después, `status` o `test` darán "sesión revocada o caducada" y bastará con repetir `login google`. Al pasar a producción verás una pantalla de "app no verificada": pulsa *Configuración avanzada → Ir a JarWis*. Es normal en apps de uso personal.

## Parte 2 — Microsoft (requiere la decisión D-016)

Microsoft solo permite registrar apps dentro de un *tenant* de Entra.

1. Entra en https://entra.microsoft.com con tu cuenta de Outlook.
   - Si ya ves un directorio con nombre (no un código largo tipo GUID), ya tienes tenant: ve al paso 3.
2. Si no tienes tenant, la vía oficial es crear una **cuenta gratuita de Azure** en https://azure.microsoft.com/free.
   - Pide una tarjeta de crédito o débito (no prepago) para verificar tu identidad. No cobra, aunque puede aparecer una retención temporal de 1 USD.
   - **Esto contradice D-008. Decide tú si lo haces**, o aplazamos Outlook.
3. Ve a **Entra ID → App registrations → New registration**:
   - Name: `JarWis`.
   - Supported account types: **Personal Microsoft accounts only**.
   - Redirect URI: plataforma **Public client/native (mobile & desktop)** con el valor `http://localhost`.
   - Pulsa **Register**.
4. Copia el **Application (client) ID**. No crees secretos ni certificados.
5. En **Authentication**, deja "Allow public client flows" en **No**.
6. En **API permissions → Add a permission → Microsoft Graph → Delegated**, añade:
   - `Mail.Read`
   - `Calendars.Read`
   - `offline_access`

   `User.Read` ya viene incluido. **No** pulses "Grant admin consent".

## Parte 3 — Archivo de configuración local

1. Crea la carpeta `%APPDATA%\JarWis\`. Puedes pegar esa ruta en la barra del Explorador.
2. Dentro, crea el archivo `oauth-clients.json` con este contenido:
   ```json
   {
     "google":    { "client_id": "<client_id del JSON descargado>", "client_secret": "<client_secret del JSON descargado>" },
     "microsoft": { "client_id": "<Application (client) ID>" }
   }
   ```
   - Si aplazas Microsoft, omite esa entrada.
   - El `client_secret` de una app de escritorio no es confidencial según Google, pero aun así se mantiene fuera del repositorio.
3. Avísame en el chat cuando esté listo. **No pegues el contenido del archivo en el chat.**

## Parte 4 — Pruebas (las ejecutas tú, con mi guía)
```
cargo run -p jarwis-auth --bin jarwis-auth-cli -- login google
cargo run -p jarwis-auth --bin jarwis-auth-cli -- test google
cargo run -p jarwis-auth --bin jarwis-auth-cli -- --show test google
```
Usa `--show` **solo en tu propia terminal**: muestra asuntos y remitentes reales.
