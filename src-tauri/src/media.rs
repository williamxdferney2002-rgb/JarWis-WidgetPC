//! Multimedia (JW-3-02): sesión actual de los controles de transporte del
//! sistema (GSMTC). Funciona en una app sin empaquetar (prototipo verificado).
//!
//! Llamadas bloqueantes (`join`): ejecutar siempre fuera del hilo principal
//! (ver `main.rs`, D-027). WinRT se activa en el MTA implícito de windows-rs,
//! que `audio::keep_mta_alive` mantiene vivo de por vida del proceso.
//! Privacidad: título y artista son datos del usuario; nunca se registran.

use serde::{Deserialize, Serialize};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaState {
    pub title: String,
    pub artist: String,
    pub playing: bool,
    pub can_prev: bool,
    pub can_next: bool,
    pub can_play_pause: bool,
    pub app_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    PlayPause,
    Next,
    Prev,
}

fn err(what: &str) -> impl FnOnce(windows::core::Error) -> String + '_ {
    move |e| format!("{what}: {e}")
}

/// `None` si no hay ninguna sesión multimedia.
fn session() -> Result<Option<Session>, String> {
    // El MTA implícito debe sobrevivir a los `CoUninitialize` de `Com` (H1).
    crate::audio::keep_mta_alive();
    let mgr = Manager::RequestAsync().and_then(|op| op.join()).map_err(err("Controles multimedia no disponibles"))?;
    // Sin sesión, GetCurrentSession devuelve un objeto nulo, que windows-rs da como error.
    Ok(mgr.GetCurrentSession().ok())
}

pub fn state() -> Result<Option<MediaState>, String> {
    let Some(s) = session()? else { return Ok(None) };
    let info = s.GetPlaybackInfo().map_err(err("No se pudo leer la reproducción"))?;
    let c = info.Controls().map_err(err("No se pudo leer la reproducción"))?;
    // Las propiedades pueden fallar (app sin metadatos): se dejan vacías.
    let props = s.TryGetMediaPropertiesAsync().and_then(|op| op.join()).ok();
    let text = |f: fn(&_) -> windows::core::Result<windows::core::HSTRING>| {
        props.as_ref().and_then(|p| f(p).ok()).map(|h| h.to_string_lossy()).unwrap_or_default()
    };
    Ok(Some(MediaState {
        title: text(|p| p.Title()),
        artist: text(|p| p.Artist()),
        playing: info.PlaybackStatus().is_ok_and(|st| st == Status::Playing),
        can_prev: c.IsPreviousEnabled().unwrap_or(false),
        can_next: c.IsNextEnabled().unwrap_or(false),
        can_play_pause: c.IsPlayPauseToggleEnabled().unwrap_or(false),
        app_id: s.SourceAppUserModelId().map(|h| h.to_string_lossy()).unwrap_or_default(),
    }))
}

/// Devuelve si la app de la sesión aceptó la orden.
pub fn control(action: Action) -> Result<bool, String> {
    let s = session()?.ok_or("No hay ninguna reproducción activa")?;
    match action {
        Action::PlayPause => s.TryTogglePlayPauseAsync(),
        Action::Next => s.TrySkipNextAsync(),
        Action::Prev => s.TrySkipPreviousAsync(),
    }
    .and_then(|op| op.join())
    .map_err(err("No se pudo enviar la orden multimedia"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn action_serde() {
        assert_eq!(serde_json::from_str::<Action>(r#""playPause""#).unwrap(), Action::PlayPause);
        assert_eq!(serde_json::from_str::<Action>(r#""next""#).unwrap(), Action::Next);
        assert_eq!(serde_json::from_str::<Action>(r#""prev""#).unwrap(), Action::Prev);
        assert!(serde_json::from_str::<Action>(r#""stop""#).is_err());
    }

    #[test]
    fn state_serde() {
        let s = MediaState {
            title: "t".into(),
            artist: "a".into(),
            playing: true,
            can_prev: false,
            can_next: true,
            can_play_pause: true,
            app_id: "x".into(),
        };
        let json = serde_json::to_string(&s).unwrap();
        for k in ["\"title\"", "\"artist\"", "\"playing\"", "\"canPrev\"", "\"canNext\"", "\"canPlayPause\"", "\"appId\""] {
            assert!(json.contains(k), "{k}");
        }
    }

    /// Prototipo GSMTC sin empaquetar: solo lectura, sin enviar órdenes.
    /// Imprime metadatos neutros (nunca el título).
    #[test]
    fn live_read_does_not_panic() {
        match state() {
            Ok(None) => {
                let n = Manager::RequestAsync().and_then(|op| op.join()).and_then(|m| m.GetSessions()).and_then(|l| l.Size());
                println!("gsmtc: RequestAsync OK, sin sesión actual (sesiones={n:?})");
            }
            Ok(Some(m)) => println!(
                "gsmtc: RequestAsync OK, sesión appId={} titleLen={} playing={}",
                m.app_id,
                m.title.chars().count(),
                m.playing
            ),
            Err(e) => panic!("gsmtc falla en app sin empaquetar: {e}"),
        }
    }
}
