import base from "../../vite.config.ts";

// Pruebas nativas largas: no recargar la WebView durante operaciones de Tauri.
export default { ...base, server: { ...base.server, hmr: false, watch: null } };
