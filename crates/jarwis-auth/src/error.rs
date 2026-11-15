//! Errores tipados de `jarwis-auth`.
//!
//! Regla de diseño: ningún `Display` puede contener tokens, códigos de
//! autorización, `client_secret`, URLs con query ni cuerpos de respuesta.
//! Por eso las variantes solo guardan datos de forma fija o saneados.

use std::fmt;

use oauth2::basic::BasicErrorResponseType;
use oauth2::{ErrorResponseType, HttpClientError, RequestTokenError, StandardErrorResponse};

use crate::Provider;

pub type Result<T> = std::result::Result<T, AuthError>;

/// Ruta de la configuración tal como se muestra al usuario.
pub const CONFIG_DISPLAY: &str = r"%APPDATA%\JarWis\oauth-clients.json";

#[derive(Debug)]
pub enum AuthError {
    /// No existe `%APPDATA%\JarWis\oauth-clients.json`.
    ConfigMissing,
    /// El archivo existe pero no se pudo leer (permisos, bloqueo, etc.).
    ConfigUnreadable(std::io::ErrorKind),
    /// El archivo existe pero no es JSON válido o le faltan campos.
    ConfigInvalid(String),
    /// El archivo no tiene sección para este proveedor.
    ProviderNotConfigured(Provider),
    /// El usuario canceló o denegó el consentimiento (código OAuth saneado).
    UserDenied(String),
    /// El `state` de la redirección no coincide: posible CSRF.
    StateMismatch,
    /// La petición de redirección no tiene el formato esperado.
    MalformedCallback,
    /// No llegó la redirección en el tiempo máximo.
    Timeout,
    /// No hay credencial guardada para el proveedor.
    NotLoggedIn(Provider),
    /// `invalid_grant` al canjear el código de autorización.
    CodeInvalid,
    /// `invalid_grant` al usar el refresh token: fue revocado o caducó.
    TokenRevoked(Provider),
    /// El proveedor no devolvió refresh token.
    NoRefreshToken(Provider),
    /// El refresh token supera el límite del Administrador de credenciales.
    TokenTooLarge { len: usize, max: usize },
    /// Fallo de red (sin URL ni detalles crudos).
    Network(&'static str),
    /// Error OAuth devuelto por el servidor (solo el código, saneado).
    OAuth(String),
    /// Respuesta HTTP no exitosa de una API (solo estado y endpoint lógico).
    Api { endpoint: &'static str, status: u16 },
    /// Respuesta de API que no se pudo interpretar (sin cuerpo).
    BadResponse(&'static str),
    /// Fallo del Administrador de credenciales (sin datos del secreto).
    Keyring(&'static str),
    /// Error local de E/S (servidor loopback, etc.).
    Io(std::io::ErrorKind),
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use AuthError::*;
        match self {
            // Ruta literal (sin expandir) para no exponer el nombre de usuario de Windows.
            ConfigMissing => write!(
                f,
                "falta el archivo de configuración {CONFIG_DISPLAY}; cópialo de oauth-clients.example.json"
            ),
            ConfigUnreadable(k) => {
                write!(f, "no se pudo leer el archivo de configuración {CONFIG_DISPLAY}: {k}")
            }
            CodeInvalid => write!(f, "el código de autorización caducó o no es válido; repite el login"),
            ConfigInvalid(r) => write!(f, "configuración OAuth inválida: {r}"),
            ProviderNotConfigured(p) => {
                write!(f, "el archivo de configuración no tiene la sección \"{p}\"")
            }
            UserDenied(c) => write!(f, "inicio de sesión cancelado o denegado por el usuario ({c})"),
            StateMismatch => write!(
                f,
                "el parámetro state no coincide; se rechazó la redirección (posible ataque CSRF)"
            ),
            MalformedCallback => write!(f, "la redirección del navegador no tiene el formato esperado"),
            Timeout => write!(f, "tiempo de espera agotado (5 min) sin recibir la redirección"),
            NotLoggedIn(p) => write!(f, "no hay sesión guardada para {p}; ejecuta: login {p}"),
            TokenRevoked(p) => write!(
                f,
                "la sesión de {p} fue revocada o caducó; vuelve a iniciar sesión: login {p}"
            ),
            NoRefreshToken(p) => write!(f, "{p} no devolvió refresh token; vuelve a iniciar sesión"),
            TokenTooLarge { len, max } => write!(
                f,
                "el refresh token ({len} bytes) supera el límite del Administrador de credenciales ({max} bytes); no se guardó"
            ),
            Network(k) => write!(f, "error de red: {k}"),
            OAuth(c) => write!(f, "el servidor OAuth devolvió un error: {c}"),
            Api { endpoint, status } => write!(f, "la API {endpoint} respondió HTTP {status}"),
            BadResponse(e) => write!(f, "respuesta inesperada de {e}"),
            Keyring(k) => write!(f, "Administrador de credenciales: {k}"),
            Io(k) => write!(f, "error de E/S local: {k}"),
        }
    }
}

impl std::error::Error for AuthError {}

/// Deja solo `[a-z0-9_.-]` y como máximo 64 caracteres. Para códigos de
/// error que vienen del exterior (redirección o servidor OAuth).
pub(crate) fn sanitize_code(raw: &str) -> String {
    let s: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        .take(64)
        .collect();
    if s.is_empty() { "desconocido".into() } else { s }
}

impl From<oauth2::reqwest::Error> for AuthError {
    // Nunca se usa el Display de reqwest: incluye la URL (con query).
    // JW-4-05: etiquetas más finas para diagnosticar; siguen siendo estáticas.
    fn from(e: oauth2::reqwest::Error) -> Self {
        use std::io::ErrorKind as K;
        let io = io_kind(&e);
        AuthError::Network(if e.is_timeout() {
            "tiempo de espera agotado"
        } else if e.is_connect() {
            match io {
                Some(K::ConnectionRefused) => "conexión rechazada",
                Some(K::TimedOut) => "tiempo de espera agotado al conectar",
                // tokio-rustls envuelve los errores TLS como InvalidData.
                Some(K::InvalidData) => "fallo TLS al conectar",
                _ => "no se pudo conectar (¿DNS o sin conexión a Internet?)",
            }
        } else if e.is_decode() {
            "respuesta no decodificable"
        } else if e.is_body() {
            "respuesta incompleta"
        } else {
            match io {
                Some(K::ConnectionReset | K::ConnectionAborted | K::BrokenPipe | K::UnexpectedEof) => {
                    "la conexión se cortó a mitad de la petición"
                }
                // hyper (conexión cerrada, respuesta HTTP no válida, protocolo…): sin io::Error en la cadena.
                _ if e.is_request() => "error de transporte HTTP (sin respuesta)",
                _ if e.is_builder() => "petición mal formada",
                _ => "fallo en la petición HTTP",
            }
        })
    }
}

/// Primer `io::ErrorKind` de la cadena de causas (sin Display: no hay datos).
fn io_kind(e: &(dyn std::error::Error + 'static)) -> Option<std::io::ErrorKind> {
    let mut cur = Some(e);
    while let Some(err) = cur {
        if let Some(io) = err.downcast_ref::<std::io::Error>() {
            return Some(io.kind());
        }
        cur = err.source();
    }
    None
}

impl From<keyring_core::Error> for AuthError {
    // Algunas variantes de keyring_core llevan los bytes del secreto: se descartan.
    fn from(e: keyring_core::Error) -> Self {
        use keyring_core::Error as K;
        AuthError::Keyring(match e {
            K::NoEntry => "no hay credencial guardada",
            K::TooLong(..) => "valor demasiado largo",
            K::BadEncoding(_) | K::BadDataFormat(..) => "el secreto guardado está dañado",
            K::NoStorageAccess(_) => "sin acceso al almacén",
            K::PlatformFailure(_) => "fallo de la plataforma",
            _ => "error inesperado",
        })
    }
}

impl From<std::io::Error> for AuthError {
    fn from(e: std::io::Error) -> Self {
        AuthError::Io(e.kind())
    }
}

/// Traduce errores de `oauth2` sin conservar cuerpos crudos ni descripciones.
/// `code_exchange`: `true` en el canje del código de autorización (cambia el
/// significado de `invalid_grant`).
pub(crate) fn map_token_error<T>(
    provider: Provider,
    code_exchange: bool,
    e: RequestTokenError<HttpClientError<oauth2::reqwest::Error>, StandardErrorResponse<T>>,
) -> AuthError
where
    T: ErrorResponseType + AsRef<str> + std::fmt::Display + 'static,
{
    match e {
        RequestTokenError::ServerResponse(r) => {
            let code = r.error().as_ref();
            if code == BasicErrorResponseType::InvalidGrant.as_ref() {
                if code_exchange { AuthError::CodeInvalid } else { AuthError::TokenRevoked(provider) }
            } else {
                AuthError::OAuth(sanitize_code(code))
            }
        }
        RequestTokenError::Request(HttpClientError::Reqwest(re)) => (*re).into(),
        RequestTokenError::Request(_) => AuthError::Network("fallo en la petición HTTP"),
        // Parse lleva el cuerpo crudo: se descarta.
        RequestTokenError::Parse(..) => AuthError::BadResponse("el servidor de tokens"),
        RequestTokenError::Other(_) => AuthError::BadResponse("el servidor de tokens"),
    }
}
