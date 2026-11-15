// Widget IA (Fase 5; JW-9-02; JW-10-02; D-047): lanzadores de Claude, terminal, uso, ChatGPT y Antigravity.
// El id del widget en ajustes sigue siendo "claude". Sin estadísticas de consumo (D-044) ni proyectos.
import { claudeOpen, type ClaudeOpenAction } from "./api";
import { AiMark, Icon } from "./icons";

const LAUNCHERS: { action: ClaudeOpenAction; label: string; icon: string; brand: string; title?: string }[] = [
  { action: "app", label: "Claude", icon: "ai-claude", brand: "claude" },
  { action: "terminal", label: "Claude en la terminal", icon: "ai-terminal", brand: "terminal", title: "Abre Claude Code en tu carpeta de usuario" },
  { action: "usage", label: "Ver mi uso", icon: "ai-usage", brand: "usage" },
  { action: "chatgpt", label: "ChatGPT", icon: "chatgpt", brand: "chatgpt" },
  { action: "antigravity", label: "Antigravity", icon: "antigravity", brand: "antigravity" },
];

export function AiPanel({ onClose, onError }: { onClose: () => void; onError: (e: unknown) => void }) {
  return (
    <section className="panel-view" aria-label="IA">
      <header className="panel-head">
        <strong className="panel-title">
          <AiMark size={15} />
          IA
        </strong>
        <button className="icon-btn" data-action="close-panel" title="Cerrar" aria-label="Cerrar" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="claude-body">
        <div className="launch-grid">
          {LAUNCHERS.map((l) => (
            <button key={l.action} className="launch-btn" data-launch={l.action} data-brand={l.brand} title={l.title} onClick={() => claudeOpen(l.action).catch(onError)}>
              <Icon name={l.icon} size={16} />
              <span>{l.label}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
