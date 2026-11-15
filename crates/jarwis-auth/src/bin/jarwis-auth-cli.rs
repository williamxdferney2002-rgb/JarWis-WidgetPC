//! Ejecutable de pruebas de la Fase 1C. Solo lectura.

use std::process::ExitCode;

use jarwis_auth::api::{self, MailMeta};
use jarwis_auth::{AuthError, Provider, mask_email, sender_domain};

const HELP: &str = "\
jarwis-auth-cli: pruebas OAuth de JarWis (solo lectura)

USO:
  jarwis-auth-cli [--show] <comando>

COMANDOS:
  login <google|microsoft>   Abre el navegador para iniciar sesión y guarda el
                             refresh token en el Administrador de credenciales.
  status                     Indica por proveedor si hay sesión guardada y si
                             la renovación del token funciona.
  test <google|microsoft>    Renueva el token y consulta correo, calendario y
                             tareas. Por defecto solo metadatos neutros.
  logout <google|microsoft>  Desconecta la cuenta (revoca en Google y borra la
                             credencial local).

OPCIONES:
  --show   Muestra además asuntos, remitentes completos, títulos y la cuenta
           completa. ÚSALO SOLO TÚ, en tu propia terminal: nunca en una
           sesión de agente de IA, porque su salida entra en el contexto.
  -h, --help

Configuración: %APPDATA%\\JarWis\\oauth-clients.json
(ver oauth-clients.example.json).";

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let show = args.iter().any(|a| a == "--show");
    args.retain(|a| a != "--show");
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{HELP}");
        return ExitCode::SUCCESS;
    }
    let provider = || {
        args.get(1).and_then(|p| p.parse::<Provider>().ok()).ok_or(())
    };
    let res = match (args[0].as_str(), provider()) {
        ("status", _) if args.len() == 1 => cmd_status().await,
        ("login", Ok(p)) => cmd_login(p, show).await,
        ("test", Ok(p)) => cmd_test(p, show).await,
        ("logout", Ok(p)) => cmd_logout(p).await,
        _ => {
            eprintln!("Comando no válido.\n\n{HELP}");
            return ExitCode::from(2);
        }
    };
    match res {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("ERROR: {e}");
            ExitCode::FAILURE
        }
    }
}

fn account(email: &str, show: bool) -> String {
    if show { email.to_string() } else { mask_email(email) }
}

/// ID truncado a 8 caracteres.
fn short(id: &str) -> String {
    let t: String = id.chars().take(8).collect();
    if id.chars().count() > 8 { format!("{t}…") } else { t }
}

async fn cmd_login(p: Provider, show: bool) -> Result<(), AuthError> {
    let cfg = jarwis_auth::load_config()?;
    println!("Iniciando sesión con {p}. Se abrirá el navegador del sistema; tienes 5 minutos.");
    let out = jarwis_auth::login(p, &cfg, |url| {
        if jarwis_auth::open_browser(url).is_err() {
            println!("No se pudo abrir el navegador. Abre esta URL manualmente:\n{url}");
        }
    })
    .await?;
    let acc = out.account.as_deref().map(|a| account(a, show)).unwrap_or_else(|| "(no se pudo leer la cuenta)".into());
    println!("Sesión iniciada: {acc}");
    println!(
        "Refresh token guardado en el Administrador de credenciales (servicio \"JarWis\", usuario \"{p}\"): {} bytes.",
        out.refresh_token_len
    );
    Ok(())
}

async fn cmd_status() -> Result<(), AuthError> {
    let cfg = jarwis_auth::load_config()?;
    for p in Provider::ALL {
        let line = match jarwis_auth::status(p, &cfg).await {
            Ok(s) => match s.refresh {
                None => "sin sesión guardada".to_string(),
                Some(Ok(())) => "credencial guardada · renovación OK".to_string(),
                Some(Err(e)) => format!("credencial guardada · renovación FALLA: {e}"),
            },
            Err(e) => format!("error: {e}"),
        };
        println!("{p:<10} {line}");
    }
    Ok(())
}

fn print_mail(m: &MailMeta, show: bool) {
    let from = if show { m.from.clone() } else { sender_domain(&m.from).unwrap_or_else(|| "?".into()) };
    let read = match m.is_read {
        Some(true) => "leído",
        Some(false) => "NO leído",
        None => "-",
    };
    println!("  - id {} · {} · de {} · {}", short(&m.id), m.date, from, read);
    if let Some(sub) = &m.subject {
        println!("      asunto: {sub}");
    }
}

fn title(t: &Option<String>) -> String {
    t.as_ref().map(|t| format!(" · {t}")).unwrap_or_default()
}

async fn cmd_test(p: Provider, show: bool) -> Result<(), AuthError> {
    let cfg = jarwis_auth::load_config()?;
    let token = jarwis_auth::access_token(p, &cfg).await?;
    println!("Token renovado correctamente ({p}).");
    let http = jarwis_auth::http_client()?;
    let email = api::account_email(p, &http, &token).await?;
    println!("Cuenta: {}", account(&email, show));
    match p {
        Provider::Google => {
            let g = api::google_summary(&http, &token, show).await?;
            println!("Gmail: {} mensajes recientes", g.messages.len());
            g.messages.iter().for_each(|m| print_mail(m, show));
            println!("Calendar: {} eventos en los próximos 7 días", g.events.len());
            for e in &g.events {
                println!("  - id {} · {}{}", short(&e.id), e.start, title(&e.title));
            }
            println!(
                "Tasks: {} listas · {} tareas pendientes · {} con vencimiento{}",
                g.task_lists,
                g.pending_tasks,
                g.due_tasks.len(),
                if g.partial { " (parcial)" } else { "" }
            );
            for t in g.due_tasks.iter().take(10) {
                println!("  - id {} · vence {}{}", short(&t.id), t.due, title(&t.title));
            }
        }
        Provider::Microsoft => {
            let m = api::microsoft_summary(&http, &token, show).await?;
            println!("Outlook: {} mensajes recientes · {} no leídos en la bandeja de entrada", m.messages.len(), m.unread_inbox);
            m.messages.iter().for_each(|x| print_mail(x, show));
            println!("Calendario: {} eventos en los próximos 7 días (UTC)", m.events.len());
            for e in &m.events {
                println!("  - id {} · {}{}", short(&e.id), e.start, title(&e.title));
            }
        }
    }
    Ok(())
}

async fn cmd_logout(p: Provider) -> Result<(), AuthError> {
    // Sin configuración se borra igualmente la credencial local; solo se pierde la revocación.
    let cfg = jarwis_auth::load_config();
    if let Err(e) = &cfg {
        println!("AVISO: {e}. Se borrará la credencial local de todos modos.");
    }
    let out = jarwis_auth::logout(p, cfg.as_ref().ok()).await?;
    match out.revoked {
        Some(Ok(())) => println!("Acceso revocado en Google."),
        Some(Err(e)) => println!(
            "AVISO: no se pudo revocar en Google ({e}). Retíralo en https://myaccount.google.com/permissions"
        ),
        None if p == Provider::Microsoft => println!(
            "Microsoft no ofrece revocación por API para cuentas personales. Para retirar el consentimiento, \
             entra en https://account.live.com/consent/Manage y quita JarWis."
        ),
        None => {}
    }
    println!(
        "{}",
        if out.deleted { "Credencial local borrada." } else { "No había credencial local guardada." }
    );
    Ok(())
}
