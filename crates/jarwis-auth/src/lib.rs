//! `jarwis-auth`: OAuth 2.0 (Authorization Code + PKCE, loopback) con Google y
//! Microsoft (cuentas personales), refresh token en el Administrador de
//! credenciales de Windows y consultas de solo lectura.
//!
//! API pública pensada para reutilizarse desde Tauri (Fase 2): [`load_config`],
//! [`login`], [`access_token`], [`status`], [`logout`] y el módulo [`api`].
//! El access token solo vive en memoria.

// D-024 (`panic = "abort"`): sin pánicos por construcción fuera de los tests.
#![cfg_attr(
    not(test),
    deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing, clippy::string_slice)
)]

pub mod api;
mod error;
// `chunk[..n]` con n ≤ chunk.len() (lo garantiza `read`); revisado en JW-4-01.
#[allow(clippy::indexing_slicing)]
mod loopback;
mod store;

use std::fmt;
use std::path::PathBuf;
use std::str::FromStr;
use std::time::Duration;

use oauth2::basic::BasicClient;
use oauth2::{
    AuthType, AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken,
    PkceCodeChallenge, RedirectUrl, RefreshToken, RevocationUrl, Scope, StandardRevocableToken,
    TokenResponse, TokenUrl,
};
use serde::Deserialize;

pub use error::{AuthError, Result};
pub use oauth2::AccessToken;
// Cliente sin autenticación para hosts públicos fijos (clima).
pub use oauth2::reqwest;
pub use oauth2::reqwest::Client as HttpClient;
pub use store::MAX_SECRET_BYTES;

const GOOGLE_AUTH: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN: &str = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE: &str = "https://oauth2.googleapis.com/revoke";
const GOOGLE_SCOPES: &[&str] = &[
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/tasks.readonly",
];
const MS_AUTH: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const MS_TOKEN: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const MS_SCOPES: &[&str] = &[
    "User.Read",
    "Mail.Read",
    "Calendars.Read",
    "offline_access",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Google,
    Microsoft,
}

impl Provider {
    pub const ALL: [Provider; 2] = [Provider::Google, Provider::Microsoft];

    /// Nombre usado como "user" en el Administrador de credenciales.
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Google => "google",
            Provider::Microsoft => "microsoft",
        }
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for Provider {
    type Err = ();
    fn from_str(s: &str) -> std::result::Result<Self, ()> {
        match s.to_ascii_lowercase().as_str() {
            "google" => Ok(Provider::Google),
            "microsoft" | "outlook" => Ok(Provider::Microsoft),
            _ => Err(()),
        }
    }
}

// ---------------------------------------------------------------- Configuración

#[derive(Deserialize)]
pub struct GoogleClient {
    pub client_id: String,
    pub client_secret: String,
}

#[derive(Deserialize)]
pub struct MicrosoftClient {
    pub client_id: String,
}

/// Contenido de `%APPDATA%\JarWis\oauth-clients.json`. Sin `Debug` a propósito
/// (contiene el `client_secret` de Google).
#[derive(Deserialize)]
pub struct OAuthClients {
    pub google: Option<GoogleClient>,
    pub microsoft: Option<MicrosoftClient>,
}

pub fn config_path() -> Result<PathBuf> {
    let appdata = std::env::var_os("APPDATA").ok_or(AuthError::ConfigMissing)?;
    Ok(PathBuf::from(appdata).join("JarWis").join("oauth-clients.json"))
}

pub fn load_config() -> Result<OAuthClients> {
    let text = std::fs::read_to_string(config_path()?).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => AuthError::ConfigMissing,
        k => AuthError::ConfigUnreadable(k),
    })?;
    parse_config(&text)
}

fn parse_config(text: &str) -> Result<OAuthClients> {
    // Solo línea/columna: el Display de serde_json puede citar valores (secretos).
    serde_json::from_str(text).map_err(|e| {
        AuthError::ConfigInvalid(format!("JSON no válido (línea {}, columna {})", e.line(), e.column()))
    })
}

// ---------------------------------------------------------------- Cliente OAuth

/// Cliente HTTP compartido: sin redirecciones (recomendación de `oauth2`, evita SSRF).
/// JW-4-05: conexiones inactivas fuera del pool a los 30 s (por defecto 90 s), así
/// un sondeo cada 60 s nunca reutiliza un socket que pudo morir (suspensión, cambio de red).
pub fn http_client() -> Result<HttpClient> {
    Ok(HttpClient::builder()
        .redirect(oauth2::reqwest::redirect::Policy::none())
        .pool_idle_timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()?)
}

/// Las URLs son constantes válidas; el error solo existe para no usar `expect` (D-024).
fn fixed<T>(r: std::result::Result<T, oauth2::url::ParseError>) -> Result<T> {
    r.map_err(|_| AuthError::BadResponse("URL interna"))
}

macro_rules! base_client {
    ($cfg:expr, $p:expr) => {{
        match $p {
            Provider::Google => {
                let g = $cfg.google.as_ref().ok_or(AuthError::ProviderNotConfigured($p))?;
                BasicClient::new(ClientId::new(g.client_id.clone()))
                    .set_client_secret(ClientSecret::new(g.client_secret.clone()))
                    .set_auth_type(AuthType::RequestBody)
                    .set_auth_uri(fixed(AuthUrl::new(GOOGLE_AUTH.into()))?)
                    .set_token_uri(fixed(TokenUrl::new(GOOGLE_TOKEN.into()))?)
            }
            Provider::Microsoft => {
                let m = $cfg.microsoft.as_ref().ok_or(AuthError::ProviderNotConfigured($p))?;
                BasicClient::new(ClientId::new(m.client_id.clone()))
                    .set_auth_uri(fixed(AuthUrl::new(MS_AUTH.into()))?)
                    .set_token_uri(fixed(TokenUrl::new(MS_TOKEN.into()))?)
            }
        }
    }};
}

/// Resultado de un inicio de sesión correcto. Sin tokens.
pub struct LoginOutcome {
    /// Email de la cuenta (completo; enmascarar con [`mask_email`] al mostrarlo).
    pub account: Option<String>,
    pub refresh_token_len: usize,
}

/// Flujo completo: loopback + PKCE + navegador del sistema + canje + guardado.
/// `open_url` recibe la URL de autorización (la capa de UI decide cómo abrirla).
pub async fn login(
    provider: Provider,
    cfg: &OAuthClients,
    open_url: impl FnOnce(&str),
) -> Result<LoginOutcome> {
    let listener = loopback::bind()?;
    let port = listener.local_addr()?.port();
    // Microsoft solo admite "http://localhost" registrado (ignora el puerto);
    // Google usa la IP literal. En ambos casos escuchamos en 127.0.0.1.
    let redirect = match provider {
        Provider::Google => format!("http://127.0.0.1:{port}"),
        Provider::Microsoft => format!("http://localhost:{port}"),
    };
    let client = base_client!(cfg, provider)
        .set_redirect_uri(fixed(RedirectUrl::new(redirect))?);

    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let scopes = match provider {
        Provider::Google => GOOGLE_SCOPES,
        Provider::Microsoft => MS_SCOPES,
    };
    let mut req = client
        .authorize_url(CsrfToken::new_random)
        .add_scopes(scopes.iter().map(|s| Scope::new((*s).into())))
        .set_pkce_challenge(challenge);
    if provider == Provider::Google {
        req = req.add_extra_param("access_type", "offline").add_extra_param("prompt", "consent");
    }
    let (url, state) = req.url();
    open_url(url.as_str());

    let expected = state.secret().clone();
    let code = tokio::task::spawn_blocking(move || loopback::wait_for_code(listener, &expected))
        .await
        .map_err(|_| AuthError::Io(std::io::ErrorKind::Other))??;

    let http = http_client()?;
    let tok = client
        .exchange_code(AuthorizationCode::new(code))
        .set_pkce_verifier(verifier)
        .request_async(&http)
        .await
        .map_err(|e| error::map_token_error(provider, true, e))?;
    let refresh = tok.refresh_token().ok_or(AuthError::NoRefreshToken(provider))?;
    let len = refresh.secret().len();
    store::save(store::SERVICE, provider.as_str(), refresh.secret())?;

    let account = api::account_email(provider, &http, tok.access_token()).await.ok();
    Ok(LoginOutcome { account, refresh_token_len: len })
}

/// Obtiene un access token nuevo a partir del refresh token guardado.
/// Si el proveedor rota el refresh token (Microsoft siempre), se sobrescribe.
pub async fn access_token(provider: Provider, cfg: &OAuthClients) -> Result<AccessToken> {
    Ok(refresh_access(provider, cfg).await?.0)
}

/// Como [`access_token`], y además la validez (`expires_in`) que indica el proveedor.
pub async fn refresh_access(provider: Provider, cfg: &OAuthClients) -> Result<(AccessToken, Option<Duration>)> {
    let saved = store::load(store::SERVICE, provider.as_str())?
        .ok_or(AuthError::NotLoggedIn(provider))?;
    let client = base_client!(cfg, provider);
    let http = http_client()?;
    let refresh = RefreshToken::new(saved);
    let tok = client
        .exchange_refresh_token(&refresh)
        .request_async(&http)
        .await
        .map_err(|e| error::map_token_error(provider, false, e))?;
    if let Some(new) = tok.refresh_token()
        && new.secret() != refresh.secret()
    {
        store::save(store::SERVICE, provider.as_str(), new.secret())?;
    }
    Ok((tok.access_token().clone(), tok.expires_in()))
}

/// Hay refresh token guardado (solo el Administrador de credenciales, sin red).
pub fn has_session(provider: Provider) -> Result<bool> {
    Ok(store::load(store::SERVICE, provider.as_str())?.is_some())
}

pub struct ProviderStatus {
    pub stored: bool,
    /// `None` si no hay credencial; si no, el resultado de intentar refrescar.
    pub refresh: Option<Result<()>>,
}

pub async fn status(provider: Provider, cfg: &OAuthClients) -> Result<ProviderStatus> {
    let stored = store::load(store::SERVICE, provider.as_str())?.is_some();
    let refresh = if stored { Some(access_token(provider, cfg).await.map(|_| ())) } else { None };
    Ok(ProviderStatus { stored, refresh })
}

pub struct LogoutOutcome {
    /// Había credencial local y se borró.
    pub deleted: bool,
    /// Google: resultado de la revocación en el proveedor. Microsoft: `None`
    /// (no hay endpoint de revocación para cuentas personales).
    pub revoked: Option<Result<()>>,
}

/// Desconecta una cuenta. La credencial local se borra SIEMPRE: aunque no haya
/// configuración, aunque el secreto guardado esté dañado y aunque falle la revocación.
/// Sin `cfg` no se puede revocar en Google (`revoked = Some(Err(..))`).
pub async fn logout(provider: Provider, cfg: Option<&OAuthClients>) -> Result<LogoutOutcome> {
    logout_in(store::SERVICE, provider, cfg).await
}

async fn logout_in(service: &str, provider: Provider, cfg: Option<&OAuthClients>) -> Result<LogoutOutcome> {
    let saved = store::load(service, provider.as_str()).ok().flatten();
    let revoked = match (provider, saved, cfg) {
        (Provider::Google, Some(rt), Some(cfg)) => Some(revoke_google(cfg, rt).await),
        (Provider::Google, Some(_), None) => Some(Err(AuthError::ProviderNotConfigured(provider))),
        _ => None,
    };
    let deleted = store::delete(service, provider.as_str())?;
    Ok(LogoutOutcome { deleted, revoked })
}

async fn revoke_google(cfg: &OAuthClients, rt: String) -> Result<()> {
    let client = base_client!(cfg, Provider::Google)
        .set_revocation_url(fixed(RevocationUrl::new(GOOGLE_REVOKE.into()))?);
    let http = http_client()?;
    client
        .revoke_token(StandardRevocableToken::RefreshToken(RefreshToken::new(rt)))
        .map_err(|_| AuthError::BadResponse("configuración de revocación"))?
        .request_async(&http)
        .await
        .map_err(|e| error::map_token_error(Provider::Google, false, e))
}

// ---------------------------------------------------------------- Utilidades

/// Abre la URL en el navegador del sistema sin pasar por cmd/shell.
/// Ruta absoluta a rundll32 para no depender del PATH ni del directorio actual.
pub fn open_browser(url: &str) -> std::io::Result<()> {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| r"C:\Windows".into());
    let exe = PathBuf::from(root).join("System32").join("rundll32.exe");
    let status = std::process::Command::new(exe)
        .args(["url.dll,FileProtocolHandler", url])
        .status()?;
    if status.success() { Ok(()) } else { Err(std::io::ErrorKind::Other.into()) }
}

/// `usuario@example.com` → `u***@example.com`. Si no parece un email, `***`.
pub fn mask_email(email: &str) -> String {
    match email.trim().split_once('@') {
        Some((user, domain)) if !user.is_empty() && !domain.is_empty() => {
            let first = user.chars().next().unwrap_or('*');
            format!("{first}***@{domain}")
        }
        _ => "***".into(),
    }
}

/// Dominio de un remitente: `"Ana" <ana@example.com>` o `ana@example.com` → `example.com`.
pub fn sender_domain(from: &str) -> Option<String> {
    let addr = match (from.rfind('<'), from.rfind('>')) {
        (Some(a), Some(b)) if a < b => from.get(a + 1..b)?,
        _ => from,
    };
    let domain = addr.trim().rsplit_once('@')?.1.trim();
    (!domain.is_empty() && !domain.contains(char::is_whitespace)).then(|| domain.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn masks_email() {
        assert_eq!(mask_email("usuario@example.com"), "u***@example.com");
        assert_eq!(mask_email("a@example.org"), "a***@example.org");
        assert_eq!(mask_email("sin-arroba"), "***");
        assert_eq!(mask_email("@example.com"), "***");
    }

    #[test]
    fn extracts_sender_domain() {
        assert_eq!(sender_domain("\"Ana Pérez\" <ana@Example.COM>").as_deref(), Some("example.com"));
        assert_eq!(sender_domain("ana@example.com").as_deref(), Some("example.com"));
        assert_eq!(sender_domain("Banco <avisos@mail.example.net>").as_deref(), Some("mail.example.net"));
        assert_eq!(sender_domain("Sin dirección"), None);
        assert_eq!(sender_domain(""), None);
    }

    // Logout sin configuración: la credencial local se borra igualmente (sin red).
    #[tokio::test]
    #[ignore = "escribe en el Administrador de credenciales de Windows"]
    async fn logout_without_config_deletes_credential() {
        let svc = "JarWis-test";
        store::save(svc, "google", "valor-de-prueba").unwrap();
        let out = logout_in(svc, Provider::Google, None).await.unwrap();
        assert!(out.deleted);
        assert!(matches!(out.revoked, Some(Err(AuthError::ProviderNotConfigured(_)))));
        assert_eq!(store::load(svc, "google").unwrap(), None);

        store::save(svc, "microsoft", "valor-de-prueba").unwrap();
        let out = logout_in(svc, Provider::Microsoft, None).await.unwrap();
        assert!(out.deleted && out.revoked.is_none());
        assert_eq!(store::load(svc, "microsoft").unwrap(), None);
        // Segunda vez: nada que borrar, sin error.
        assert!(!logout_in(svc, Provider::Microsoft, None).await.unwrap().deleted);
    }

    #[test]
    fn config_errors_show_literal_path() {
        let s = AuthError::ConfigMissing.to_string();
        assert!(s.contains(r"%APPDATA%\JarWis\oauth-clients.json"), "{s}");
        let s = AuthError::ConfigUnreadable(std::io::ErrorKind::PermissionDenied).to_string();
        assert!(s.contains("%APPDATA%") && !s.contains(r"C:\Users"), "{s}");
    }

    #[test]
    fn config_errors_do_not_leak_values() {
        let err = parse_config(r#"{"google": {"client_id": 5, "client_secret": "GOCSPX-supersecreto"}}"#)
            .err()
            .expect("debe fallar");
        assert!(!err.to_string().contains("supersecreto"));
        let ok = parse_config(r#"{"microsoft": {"client_id": "abc"}}"#).unwrap();
        assert!(ok.google.is_none() && ok.microsoft.is_some());
    }

    #[test]
    fn error_display_is_sanitized() {
        // Código de error externo con basura/token: solo sobreviven [a-z0-9_.-].
        let e = AuthError::UserDenied(error::sanitize_code("access_denied<script>ya29.TOKEN?code=4/xyz"));
        let s = e.to_string();
        assert!(!s.contains('<') && !s.contains('?') && !s.contains('/') && !s.contains('='));
        assert!(s.len() < 160);
        // Ninguna variante fija contiene datos variables sensibles.
        for e in [
            AuthError::StateMismatch,
            AuthError::Timeout,
            AuthError::TokenRevoked(Provider::Google),
            AuthError::TokenTooLarge { len: 3000, max: MAX_SECRET_BYTES },
        ] {
            assert!(!e.to_string().contains("ya29"));
        }
    }

    // Error real de reqwest (conexión rechazada en loopback, sin Internet)
    // con una URL que lleva un código y un token en la query.
    #[tokio::test]
    async fn reqwest_errors_drop_url_and_query() {
        let http = http_client().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener); // puerto cerrado → conexión rechazada
        let raw = http
            .get(format!("http://127.0.0.1:{port}/cb?code=CODIGO-SECRETO&access_token=ya29.SECRETO"))
            .send()
            .await
            .unwrap_err();
        assert!(raw.to_string().contains("SECRETO"), "premisa: reqwest sí incluye la URL");
        let ours = AuthError::from(raw).to_string();
        assert!(!ours.contains("SECRETO") && !ours.contains("127.0.0.1"), "{ours}");
        assert!(ours.contains("conexión rechazada"), "{ours}");
    }

    // JW-4-05: servidores locales que fallan de distintas formas → etiqueta estática distinta.
    #[tokio::test]
    async fn reqwest_errors_get_specific_labels() {
        use std::io::{Read, Write};
        fn serve(reply: bool) -> u16 {
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            std::thread::spawn(move || {
                if let Ok((mut s, _)) = l.accept() {
                    let _ = s.read(&mut [0u8; 1024]);
                    if reply {
                        // Cierra sin responder.
                        drop(s);
                    } else {
                        // Acepta y calla: agujero negro.
                        std::thread::sleep(Duration::from_secs(3));
                        let _ = s.write_all(b"");
                    }
                }
            });
            port
        }
        let label = |e: oauth2::reqwest::Error| match AuthError::from(e) {
            AuthError::Network(k) => k,
            other => panic!("{other}"),
        };
        let http = http_client().unwrap();
        let closed = http.get(format!("http://127.0.0.1:{}/", serve(true))).send().await.unwrap_err();
        assert_eq!(label(closed), "error de transporte HTTP (sin respuesta)");

        let short = HttpClient::builder().timeout(Duration::from_millis(300)).build().unwrap();
        let silent = short.get(format!("http://127.0.0.1:{}/", serve(false))).send().await.unwrap_err();
        assert_eq!(label(silent), "tiempo de espera agotado");
    }
}
