import type { Mascot } from "./api";
import airH from "./assets/mascots/air-h.webp";
import airV from "./assets/mascots/air-v.webp";
import fireH from "./assets/mascots/fire-h.webp";
import fireV from "./assets/mascots/fire-v.webp";
import waterH from "./assets/mascots/water-h.webp";
import waterV from "./assets/mascots/water-v.webp";
import earthH from "./assets/mascots/earth-h.webp";
import earthV from "./assets/mascots/earth-v.webp";

/** Imágenes de la mascota por orientación: h (bordes superior/inferior) y v (izquierdo/derecho). */
export const mascotImages: Record<Mascot, { h: string; v: string }> = {
  air: { h: airH, v: airV },
  fire: { h: fireH, v: fireV },
  water: { h: waterH, v: waterV },
  earth: { h: earthH, v: earthV },
};

export const MASCOT_LABELS: [Mascot, string][] = [
  ["air", "Aire"],
  ["fire", "Fuego"],
  ["water", "Agua"],
  ["earth", "Tierra"],
];
