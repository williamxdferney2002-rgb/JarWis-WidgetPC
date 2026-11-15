//! Servidor loopback mínimo (std, sin crates) que recibe la redirección OAuth.
//!
//! Escucha en 127.0.0.1:<puerto efímero>, espera como máximo 5 minutos,
//! valida `state`, responde una página HTML mínima y se cierra.

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use oauth2::url::form_urlencoded;

use crate::error::{AuthError, Result, sanitize_code};

pub(crate) const CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const READ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REQUEST: usize = 8 * 1024;

/// Resultado del análisis de la primera línea de la petición.
#[derive(Debug, PartialEq)]
pub(crate) enum Callback {
    /// Redirección válida con el código de autorización.
    Code(String),
    /// Otra ruta (p. ej. /favicon.ico): se responde 404 y se sigue esperando.
    Ignore,
    /// `GET /` sin `state`, `code` ni `error` (p. ej. visita manual): 400 y se sigue esperando.
    BadRequest,
}

pub(crate) fn bind() -> Result<TcpListener> {
    Ok(TcpListener::bind(("127.0.0.1", 0))?)
}

/// Analiza la cabecera HTTP. Solo acepta `GET /?...` y compara `state`.
pub(crate) fn parse_request(head: &str, expected_state: &str) -> Result<Callback> {
    let line = head.lines().next().ok_or(AuthError::MalformedCallback)?;
    let mut parts = line.split(' ');
    let (method, target) = match (parts.next(), parts.next(), parts.next()) {
        (Some(m), Some(t), Some(v)) if v.starts_with("HTTP/") => (m, t),
        _ => return Err(AuthError::MalformedCallback),
    };
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    if method != "GET" || path != "/" {
        return Ok(Callback::Ignore);
    }
    let (mut code, mut state, mut error) = (None, None, None);
    for (k, v) in form_urlencoded::parse(query.as_bytes()) {
        match &*k {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    if state.is_none() && code.is_none() && error.is_none() {
        return Ok(Callback::BadRequest);
    }
    if state.as_deref() != Some(expected_state) {
        return Err(AuthError::StateMismatch);
    }
    if let Some(e) = error {
        return Err(AuthError::UserDenied(sanitize_code(&e)));
    }
    match code {
        Some(c) if !c.is_empty() => Ok(Callback::Code(c)),
        _ => Err(AuthError::MalformedCallback),
    }
}

/// Lee la cabecera con un plazo TOTAL por conexión de min(10 s, lo que quede
/// del plazo global): un cliente que envía byte a byte no puede alargarlo.
fn read_head(stream: &mut TcpStream, deadline: Instant) -> std::io::Result<String> {
    stream.set_nonblocking(false)?;
    let conn_deadline = deadline.min(Instant::now() + READ_TIMEOUT);
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < MAX_REQUEST {
        let left = conn_deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(ErrorKind::TimedOut.into());
        }
        stream.set_read_timeout(Some(left))?;
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn respond(stream: &mut TcpStream, status: &str, title: &str, msg: &str) {
    let body = format!(
        "<!doctype html><html lang=\"es\"><meta charset=\"utf-8\"><title>JarWis</title>\
         <body style=\"font-family:sans-serif;margin:3em\"><h1>{title}</h1><p>{msg}</p></body></html>"
    );
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
         Cache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // Si el navegador ya cerró la conexión no importa.
    let _ = stream.write_all(resp.as_bytes());
    let _ = stream.flush();
}

/// Bloqueante: ejecutar dentro de `spawn_blocking`.
/// Atiende conexiones hasta recibir la redirección a `/` (válida o no) o agotar el tiempo.
/// Las conexiones vacías (pre-conexiones del navegador) y otras rutas se descartan.
pub(crate) fn wait_for_code(listener: TcpListener, expected_state: &str) -> Result<String> {
    wait_until(listener, expected_state, Instant::now() + CALLBACK_TIMEOUT)
}

fn wait_until(listener: TcpListener, expected_state: &str, deadline: Instant) -> Result<String> {
    listener.set_nonblocking(true)?;
    loop {
        // El plazo global se comprueba en cada vuelta, haya o no conexiones.
        if Instant::now() >= deadline {
            return Err(AuthError::Timeout);
        }
        let mut stream = match listener.accept() {
            Ok((s, _)) => s,
            Err(e) if e.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            // Errores transitorios de un cliente concreto: seguir esperando.
            Err(e)
                if matches!(
                    e.kind(),
                    ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted | ErrorKind::Interrupted
                ) =>
            {
                continue;
            }
            Err(e) => return Err(e.into()),
        };
        let head = match read_head(&mut stream, deadline) {
            Ok(h) if !h.trim().is_empty() => h,
            _ => continue, // pre-conexión sin datos o cliente lento
        };
        match parse_request(&head, expected_state) {
            Ok(Callback::Ignore) => {
                respond(&mut stream, "404 Not Found", "No encontrado", "");
            }
            Ok(Callback::BadRequest) => {
                respond(&mut stream, "400 Bad Request", "Petición no válida", "");
            }
            Ok(Callback::Code(code)) => {
                respond(
                    &mut stream,
                    "200 OK",
                    "Inicio de sesión completado",
                    "Ya puedes cerrar esta pestaña y volver a JarWis.",
                );
                return Ok(code);
            }
            Err(e) => {
                respond(
                    &mut stream,
                    "400 Bad Request",
                    "No se completó el inicio de sesión",
                    "Vuelve a JarWis para ver el motivo.",
                );
                return Err(e);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ST: &str = "estado123";

    #[test]
    fn accepts_code_and_state() {
        let r = parse_request("GET /?code=4%2FabC&state=estado123&scope=x HTTP/1.1\r\nHost: a\r\n\r\n", ST);
        assert_eq!(r.unwrap(), Callback::Code("4/abC".into()));
    }

    #[test]
    fn rejects_wrong_or_missing_state() {
        let r = parse_request("GET /?code=abc&state=otro HTTP/1.1\r\n\r\n", ST);
        assert!(matches!(r, Err(AuthError::StateMismatch)));
        let r = parse_request("GET /?code=abc HTTP/1.1\r\n\r\n", ST);
        assert!(matches!(r, Err(AuthError::StateMismatch)));
        // Un error con state falso también se trata como CSRF.
        let r = parse_request("GET /?error=access_denied&state=x HTTP/1.1\r\n\r\n", ST);
        assert!(matches!(r, Err(AuthError::StateMismatch)));
    }

    #[test]
    fn detects_access_denied() {
        let r = parse_request("GET /?error=access_denied&state=estado123 HTTP/1.1\r\n\r\n", ST);
        match r {
            Err(AuthError::UserDenied(c)) => assert_eq!(c, "access_denied"),
            other => panic!("inesperado: {other:?}"),
        }
    }

    #[test]
    fn malformed_requests() {
        for head in ["", "basura", "GET /?code=a&state=estado123", "GET /?state=estado123 HTTP/1.1", "GET /?code=&state=estado123 HTTP/1.1"] {
            assert!(
                matches!(parse_request(head, ST), Err(AuthError::MalformedCallback)),
                "debió fallar: {head:?}"
            );
        }
        assert_eq!(parse_request("GET /favicon.ico HTTP/1.1", ST).unwrap(), Callback::Ignore);
        assert_eq!(parse_request("POST /?code=a&state=estado123 HTTP/1.1", ST).unwrap(), Callback::Ignore);
    }

    #[test]
    fn root_without_oauth_params_is_ignored() {
        for head in ["GET / HTTP/1.1", "GET /? HTTP/1.1", "GET /?foo=1 HTTP/1.1"] {
            assert_eq!(parse_request(head, ST).unwrap(), Callback::BadRequest, "{head:?}");
        }
    }

    // Una visita a "/" sin parámetros no aborta: después llega la redirección buena.
    #[test]
    fn bad_request_then_valid_callback() {
        let listener = bind().unwrap();
        let port = listener.local_addr().unwrap().port();
        let h = std::thread::spawn(move || wait_for_code(listener, ST));
        let send = |req: &[u8]| {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.write_all(req).unwrap();
            let mut resp = String::new();
            s.read_to_string(&mut resp).unwrap();
            resp
        };
        assert!(send(b"GET / HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 400"));
        assert!(send(b"GET /?code=ok&state=estado123 HTTP/1.1\r\n\r\n").starts_with("HTTP/1.1 200"));
        assert_eq!(h.join().unwrap().unwrap(), "ok");
    }

    // Un cliente que envía un byte cada 200 ms no puede alargar el plazo global.
    #[test]
    fn slow_client_cannot_extend_deadline() {
        let listener = bind().unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            for _ in 0..50 {
                if s.write_all(b"G").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        });
        let start = Instant::now();
        let r = wait_until(listener, ST, start + Duration::from_secs(1));
        assert!(matches!(r, Err(AuthError::Timeout)), "{r:?}");
        // Sin el plazo por conexión habría esperado 10 s (o los 10 s del cliente).
        assert!(start.elapsed() < Duration::from_secs(3), "{:?}", start.elapsed());
    }

    // Ida y vuelta por un socket local real (sin red externa).
    #[test]
    fn serves_one_callback_over_tcp() {
        let listener = bind().unwrap();
        let port = listener.local_addr().unwrap().port();
        let h = std::thread::spawn(move || wait_for_code(listener, ST));
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.write_all(b"GET /?code=xyz&state=estado123 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let mut resp = String::new();
        s.read_to_string(&mut resp).unwrap();
        assert!(resp.starts_with("HTTP/1.1 200"));
        assert!(!resp.contains("xyz"));
        assert_eq!(h.join().unwrap().unwrap(), "xyz");
    }
}
