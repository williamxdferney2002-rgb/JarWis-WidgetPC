import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Bar from "./Bar";
import SettingsView from "./SettingsView";
import { setPanel } from "./api";
import "./styles.css";

// Un único bundle: cada ventana muestra su vista según su etiqueta.
const isBar = getCurrentWindow().label === "bar";
if (isBar) document.documentElement.classList.add("bar");

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    if (isBar) void setPanel(true, 160).catch(() => {});
  }

  render() {
    if (this.state.failed) return (
      <main className="recovery-card has-error">
        <p role="alert">Ocurrió un error al mostrar JarWis. Recarga la ventana para volver a intentarlo.</p>
        <button className="btn" onClick={() => {
          // Restaurar también el tamaño nativo que se amplió para mostrar el error.
          if (isBar) void setPanel(false).catch(() => {}).then(() => window.location.reload());
          else window.location.reload();
        }}>Recargar</button>
      </main>
    );
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><ErrorBoundary>{isBar ? <Bar /> : <SettingsView />}</ErrorBoundary></StrictMode>,
);
