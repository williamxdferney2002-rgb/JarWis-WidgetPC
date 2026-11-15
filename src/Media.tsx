// Panel de audio y multimedia: volumen, silencio y sesión multimedia del sistema.
// Consulta al núcleo solo mientras está abierto (cada ~2 s).
import { useEffect, useRef, useState } from "react";
import {
  audioState,
  mediaControl,
  mediaOpen,
  mediaState,
  openSoundSettings,
  setMuted,
  setVolume,
  usePageVisible,
  type AudioState,
  type MediaAction,
  type MediaState,
} from "./api";
import { Icon } from "./icons";

export function MediaPanel({ active, onClose, onError }: { active: boolean; onClose: () => void; onError: (e: unknown) => void }) {
  const visible = usePageVisible(active);
  const [audio, setAudio] = useState<AudioState | null | undefined>(undefined);
  const [media, setMedia] = useState<MediaState | null>(null);
  const [volume, setVol] = useState(0);
  const touched = useRef(0); // última vez que el usuario movió el deslizador
  const debounce = useRef(0);
  const controlRefresh = useRef(0);
  const refresh = useRef(() => {});
  const failing = useRef(false); // avisa solo del primer error seguido

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    refresh.current = () => {
      if (!alive || document.hidden) return;
      audioState().then((a) => {
        if (!alive) return;
        failing.current = false;
        setAudio(a);
        if (a && Date.now() - touched.current > 1500) setVol(a.volume);
      }, (e) => {
        if (!alive) return;
        if (!failing.current) onError(e);
        failing.current = true;
      });
      mediaState().then(
        (m) => alive && setMedia(m),
        () => {},
      );
    };
    refresh.current();
    const id = window.setInterval(refresh.current, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
      window.clearTimeout(debounce.current);
      window.clearTimeout(controlRefresh.current);
    };
  }, [visible]);

  const onVolume = (v: number) => {
    setVol(v);
    touched.current = Date.now();
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => setVolume(v).catch(onError), 80);
  };
  const control = (a: MediaAction) => mediaControl(a).then(() => {
    window.clearTimeout(controlRefresh.current);
    controlRefresh.current = window.setTimeout(() => refresh.current(), 400);
  }, onError);

  return (
    <section className="panel-view" aria-label="Audio y multimedia">
      <header className="panel-head">
        <strong className="panel-title">
          <Icon name="media" size={14} />
          Audio y multimedia
        </strong>
        <button className="icon-btn" data-action="close-panel" title="Cerrar" aria-label="Cerrar" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="stats media">
        <div className="col" data-part="audio">
          <span className="muted">Salida de audio</span>
          {audio === null ? (
            <strong>Sin dispositivo de salida</strong>
          ) : (
            <>
              <strong className="ellipsis" title={audio?.deviceName}>
                {audio?.deviceName ?? "…"}
              </strong>
              <div className="vol-row">
                <button
                  className="icon-btn"
                  data-action="mute"
                  aria-pressed={audio?.muted}
                  title={audio?.muted ? "Activar el sonido" : "Silenciar"}
                  aria-label={audio?.muted ? "Activar el sonido" : "Silenciar"}
                  onClick={() => audio && setMuted(!audio.muted).then(refresh.current, onError)}
                >
                  <Icon name={audio?.muted ? "mute" : "volume"} />
                </button>
                <input
                  className="slider grow"
                  type="range"
                  min={0}
                  max={100}
                  value={volume}
                  aria-label="Volumen"
                  disabled={!audio}
                  onChange={(e) => onVolume(Number(e.target.value))}
                />
                <span className="mono vol-num">{volume}</span>
              </div>
            </>
          )}
          <button className="pill" data-action="sound-settings" onClick={() => openSoundSettings().catch(onError)}>
            Cambiar dispositivo
          </button>
        </div>
        <div className="col" data-part="media">
          <span className="muted">Reproducción</span>
          {media ? (
            <>
              <strong className="ellipsis" title={media.title}>
                {media.title || "Sin título"}
              </strong>
              <span className="muted ellipsis">{media.artist}</span>
            </>
          ) : (
            <strong className="muted">Nada reproduciéndose</strong>
          )}
          <div className="btn-row launchers">
            <button className="launch-btn" data-launch="spotify" data-brand="spotify" onClick={() => mediaOpen("spotify").catch(onError)}>
              <Icon name="waves" size={14} />
              Spotify
            </button>
            <button className="launch-btn" data-launch="youtube" data-brand="youtube" onClick={() => mediaOpen("youtube").catch(onError)}>
              <Icon name="video" size={14} />
              YouTube
            </button>
            <button className="launch-btn" data-launch="netflix" data-brand="netflix" onClick={() => mediaOpen("netflix").catch(onError)}>
              <Icon name="netflix" size={14} />
              Netflix
            </button>
          </div>
          <div className="btn-row transport">
            <button className="icon-btn" data-action="prev" title="Anterior" aria-label="Anterior" disabled={!media?.canPrev} onClick={() => control("prev")}>
              <Icon name="prev" />
            </button>
            <button
              className="icon-btn"
              data-action="play-pause"
              title={media?.playing ? "Pausar" : "Reproducir"}
              aria-label={media?.playing ? "Pausar" : "Reproducir"}
              disabled={!media?.canPlayPause}
              onClick={() => control("playPause")}
            >
              <Icon name={media?.playing ? "pause" : "play"} />
            </button>
            <button className="icon-btn" data-action="next" title="Siguiente" aria-label="Siguiente" disabled={!media?.canNext} onClick={() => control("next")}>
              <Icon name="next" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
