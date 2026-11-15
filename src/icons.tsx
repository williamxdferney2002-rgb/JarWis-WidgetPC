// Iconos lineales inline (24×24, trazo de 1.5) para no añadir una librería.
import type { ReactNode } from "react";
import type { CodexPetIcon } from "./api";
import dragon from "./assets/codex-pet/dragon.png";

const paths: Record<string, ReactNode> = {
  focus: <><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" /></>,
  moon: <path d="M20 14A8.5 8.5 0 0 1 10 4a8.5 8.5 0 1 0 10 10Z" />,
  fog: <path d="M4 8h16M3 12h18M5 16h14M8 20h8" />,
  rain: <><path d="M6 15a4 4 0 1 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 1 1 1 9" /><path d="m8 17-1 3m6-3-1 3m6-3-1 3" /></>,
  snow: <><path d="M12 3v18M4 7l16 10M4 17 20 7M9 4l3 3 3-3M9 20l3-3 3 3" /></>,
  storm: <><path d="M6 15a4 4 0 1 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 1 1 1 9" /><path d="m12 13-3 5h5l-3 5" /></>,
  "codex-pet": (
    <g shapeRendering="crispEdges" stroke="none">
      <path d="M2 4h6v2h8V4h6v12h-4v4H6v-4H2Z" fill="#D99B62" />
      <path d="M2 4h4v10H2Zm16 0h4v10h-4Z" fill="#975D38" />
      <path d="M6 10h2v2H6Zm10 0h2v2h-2Zm-6 4h4v2h-4Zm0 4h4v2h-4Z" fill="#38271E" />
    </g>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  system: <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />,
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  today: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
    </>
  ),
  claude: <path d="M12 3.5c.6 4.4 2.9 7 8.5 8.5-5.6 1.5-7.9 4.1-8.5 8.5-.6-4.4-2.9-7-8.5-8.5 5.6-1.5 7.9-4.1 8.5-8.5Z" />,
  // Iconos propios (sin logos de marca): ondas de sonido y pantalla con triángulo de reproducción.
  waves: <path d="M4 10v4M8 7v10M12 4.5v15M16 8v8M20 10.5v3" />,
  video: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="3.5" />
      <path d="m10.5 9.5 4 2.5-4 2.5Z" />
    </>
  ),
  // Marcas (JW-10-02): dibujos propios y sencillos con los colores de cada marca; no son los logos oficiales.
  netflix: (
    <>
      <path d="M6.5 3.5h3.2v17H6.5zM14.3 3.5h3.2v17h-3.2z" fill="#E50914" stroke="none" />
      <path d="M6.5 3.5h3.2l7.8 17h-3.2z" fill="#B20710" stroke="none" />
    </>
  ),
  telegram: (
    <>
      <circle cx="12" cy="12" r="10" fill="#2AABEE" stroke="none" />
      <path d="m5.5 11.5 13-5-3 12-4-3-2 2v-4l6-5-7 4Z" fill="#fff" stroke="none" />
    </>
  ),
  whatsapp: (
    <>
      <path d="M4 20.5 5 16a9 9 0 1 1 3 3.5Z" fill="#25D366" stroke="none" />
      <path d="m8.5 7.5-1 2c1 4 3 6 7 7l2-1-2-2-1.5 1c-1.5-.5-3-2-3.5-3.5l1-1.5Z" stroke="#fff" />
    </>
  ),
  "ai-claude": <path d="M12 3c.6 4.6 2.9 7.2 9 9-6.1 1.8-8.4 4.4-9 9-.6-4.6-2.9-7.2-9-9 6.1-1.8 8.4-4.4 9-9Z" fill="#D97757" stroke="none" />,
  "ai-terminal": (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="3" fill="#012456" stroke="none" />
      <path d="m7 9.5 3.5 2.5L7 14.5" stroke="#fff" strokeWidth={1.8} />
      <path d="M12.5 15h4.5" stroke="#fff" strokeWidth={1.8} />
    </>
  ),
  "ai-usage": (
    <>
      <rect x="4" y="12" width="4" height="8" rx="1" fill="#D97757" stroke="none" />
      <rect x="10" y="4" width="4" height="16" rx="1" fill="#E5484D" stroke="none" />
      <rect x="16" y="8" width="4" height="12" rx="1" fill="#F0883E" stroke="none" />
    </>
  ),
  chatgpt: (
    <>
      <path d="M12 3 19.8 7.5v9L12 21l-7.8-4.5v-9Z" stroke="#10A37F" strokeWidth={2} />
      <circle cx="12" cy="12" r="2.6" fill="#10A37F" stroke="none" />
    </>
  ),
  antigravity: (
    <>
      <path d="M12 3.5 3.5 20h4.2L12 11.5Z" fill="#4285F4" stroke="none" />
      <path d="M12 3.5 20.5 20h-4.2L12 11.5Z" fill="#9B72CB" stroke="none" />
    </>
  ),
  // Iconos elegibles para los accesos rápidos (SHORTCUT_ICONS); video, folder, mail y app ya existen arriba.
  music: <path d="M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 9 18Zm10-2a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 19 16Z" />,
  chat: <path d="M4 5.5h16v10H10l-4 3.5v-3.5H4Z" />,
  code: <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 6l-3 12" />,
  game: (
    <>
      <rect x="3" y="8" width="18" height="9" rx="4.5" />
      <path d="M8 10.5v4M6 12.5h4M15.5 11.5h.01M17.5 13.5h.01" />
    </>
  ),
  shop: <path d="M4 6h2l2 10h9l2-7H7M10 20h.01M16 20h.01" />,
  bank: <path d="M3.5 9 12 4l8.5 5M5.5 10v7M10 10v7M14 10v7M18.5 10v7M3.5 19.5h17" />,
  web: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c-3 3.5-3 13.5 0 17M12 3.5c3 3.5 3 13.5 0 17" />
    </>
  ),
  doc: <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V3.5ZM14 3.5v4h4M9 12h6M9 15.5h6" />,
  photo: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m4 17 5-4 3 2.5 3-3 5 4" />
    </>
  ),
  cloud: <path d="M7 18a4 4 0 0 1-.5-8 5.5 5.5 0 0 1 10.500 1.500A3.3 3.3 0 0 1 17 18Z" />,
  terminal: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <path d="m7.5 10 3 2-3 2M12.5 15h4" />
    </>
  ),
  key: <path d="M14.5 9.500a4 4 0 1 1-4 4l-6 6V17h2.5v-2h2l1.500-1.500M16 9.500h.01" />,
  star: <path d="m12 3.5 2.6 5.4 5.9.8-4.300 4.1 1 5.8L12 16.8 6.800 19.6l1-5.8L3.5 9.7l5.9-.8Z" />,
  home: <path d="M4 11.500 12 4l8 7.5M6 10v10h4.5v-5.5h3V20H18V10" />,
  clipboard: (
    <>
      <rect x="5.5" y="4.5" width="13" height="16" rx="2" />
      <path d="M9 4.5V3.5h6v1M9 10h6M9 14h4" />
    </>
  ),
  pin: <path d="M9 4h6l-1 5 3 3H7l3-3-1-5ZM12 12v8" />,
  // Nota musical (pop) en rojo: dos corcheas unidas con brillo.
  media: (
    <>
      <path d="M9 17.5V6l10-2v11.5" stroke="#ff3b4e" strokeWidth={1.8} />
      <circle cx="6.8" cy="17.6" r="2.7" fill="#ff3b4e" stroke="none" />
      <circle cx="16.8" cy="15.6" r="2.7" fill="#ff3b4e" stroke="none" />
      <path d="M9 9.2 19 7.2" stroke="#ff3b4e" strokeWidth={2.2} />
    </>
  ),
  shortcuts: <path d="M13 3.5 6 13h5l-1 7.5L18 11h-5l0-7.5Z" />,
  volume: <path d="M4 10v4h3.5L12 18V6l-4.5 4H4ZM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />,
  mute: <path d="M4 10v4h3.5L12 18V6l-4.5 4H4ZM15.5 9.5l5 5M20.5 9.5l-5 5" />,
  prev: <path d="M7 5.5v13M18 5.5v13l-9-6.5 9-6.5Z" />,
  next: <path d="M17 5.5v13M6 5.5v13l9-6.5-9-6.5Z" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  app: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 9h16" />
    </>
  ),
  folder: <path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2.5h8a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V7Z" />,
  file: <path d="M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V3.5ZM14 3.5v4h4" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </>
  ),
  expand: <path d="m6 9 6 6 6-6" />,
  collapse: <path d="m6 15 6-6 6 6" />,
  minimize: <path d="M5 16h14" />,
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
  close: <path d="M7 7l10 10M17 7 7 17" />,
  play: <path d="M8 5.5v13l10-6.5-10-6.5Z" />,
  pause: <path d="M9 6v12M15 6v12" />,
  flag: <path d="M6 20V4.5M6 5h10l-2 3.5 2 3.5H6" />,
  reset: <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />,
  bell: <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15L6 16.5ZM10 20.5h4" />,
  grip: (
    <>
      <circle cx="9" cy="7" r=".9" />
      <circle cx="15" cy="7" r=".9" />
      <circle cx="9" cy="12" r=".9" />
      <circle cx="15" cy="12" r=".9" />
      <circle cx="9" cy="17" r=".9" />
      <circle cx="15" cy="17" r=".9" />
    </>
  ),
};

/** Imagen decorativa de Codex; conserva los píxeles y la proporción del dragón. */
export function CodexPetArt({ icon, size = 16 }: { icon: CodexPetIcon; size?: number }) {
  return icon === "dragon"
    // El sprite tiene margen transparente: un poco más ancho que los iconos de trazo para reconocerse.
    ? <img className="codex-pet-art" src={dragon} width={Math.round(size * 1.375)} alt="" aria-hidden="true" draggable={false} />
    : <Icon name="codex-pet" size={size} />;
}

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? <circle cx="12" cy="12" r="3" />}
    </svg>
  );
}

/** Monograma «IA»: la I azul (ChatGPT) y la A naranja (Antigravity). */
export function AiMark({ size = 16 }: { size?: number }) {
  return (
    <span className="ai-mark" style={{ fontSize: size }} aria-hidden="true">
      <i>I</i>
      <b>A</b>
    </span>
  );
}
