//! Cálculo puro de la geometría de la barra (sin dependencias de Tauri).
//!
//! Todo se calcula en píxeles físicos a partir del área de trabajo del monitor
//! (que ya excluye la barra de tareas) y de su factor de escala DPI.

use serde::{Deserialize, Serialize};

/// Borde de la pantalla al que se ancla la barra.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    #[default]
    Top,
    Bottom,
    Left,
    Right,
}

/// Modo de la barra.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Compact,
    Expanded,
}

/// Forma de la isla en pantalla. El orden es de prioridad (base → ampliaciones),
/// no de tamaño: Mini es más alta que Compact (D-056). No se persiste: `minimized`
/// y el modo guardado dan la base; un panel o un aviso la amplían.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Shape {
    Mini,
    Compact,
    Expanded,
    /// Panel del reloj (cronómetro, temporizadores, alarmas).
    Panel,
}

impl From<Mode> for Shape {
    fn from(m: Mode) -> Self {
        match m {
            Mode::Compact => Shape::Compact,
            Mode::Expanded => Shape::Expanded,
        }
    }
}

/// Posición de la isla a lo largo de cada borde: fracción 0–1 del recorrido entre
/// márgenes que marca el **centro** de la isla (0 = esquina inicial, 0,5 = centro,
/// 1 = esquina final), común a todas las formas; cada forma se recorta para no salir
/// del área (JW-15-04, amplía D-047). Por borde y no por monitor (D-047): la fracción
/// ya es relativa al monitor y los nombres de monitor cambian.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EdgeOffsets {
    pub top: f64,
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
}

impl Default for EdgeOffsets {
    fn default() -> Self {
        Self { top: 0.5, bottom: 0.5, left: 0.5, right: 0.5 }
    }
}

impl EdgeOffsets {
    pub fn get(&self, edge: Edge) -> f64 {
        match edge {
            Edge::Top => self.top,
            Edge::Bottom => self.bottom,
            Edge::Left => self.left,
            Edge::Right => self.right,
        }
    }

    pub fn with(mut self, edge: Edge, v: f64) -> Self {
        let v = clamp_fraction(v);
        match edge {
            Edge::Top => self.top = v,
            Edge::Bottom => self.bottom = v,
            Edge::Left => self.left = v,
            Edge::Right => self.right = v,
        }
        self
    }

    pub fn sanitize(self) -> Self {
        Self {
            top: clamp_fraction(self.top),
            bottom: clamp_fraction(self.bottom),
            left: clamp_fraction(self.left),
            right: clamp_fraction(self.right),
        }
    }
}

/// Limita a [0, 1]; no finito → 0,5 (centro).
pub fn clamp_fraction(v: f64) -> f64 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        0.5
    }
}

/// Rectángulo en píxeles físicos.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Separación lógica entre la barra y el borde del área de trabajo.
const MARGIN: f64 = 8.0;

/// Recorrido útil y píxel físico en unidades CSS. La UI calcula el anclaje con
/// el tamaño animado, incluso mientras la ventana conserva el tamaño anterior.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct BarTrack {
    pub width: f64,
    pub height: f64,
    pub pixel: f64,
}

pub fn bar_track(work_area: Rect, scale: f64) -> BarTrack {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let margin = 2 * px_margin(scale);
    BarTrack {
        width: f64::from(work_area.width.saturating_sub(margin)) / scale,
        height: f64::from(work_area.height.saturating_sub(margin)) / scale,
        pixel: 1.0 / scale,
    }
}

/// Tamaño lógico (largo a lo largo del borde, grosor perpendicular al borde).
fn logical_size(edge: Edge, shape: Shape) -> (f64, f64) {
    let horizontal = matches!(edge, Edge::Top | Edge::Bottom);
    match (horizontal, shape) {
        // Pastilla con mascota de 140×52 (D-056); 4 px por lado dentro de la ventana.
        (true, Shape::Mini) => (148.0, 60.0),
        (false, Shape::Mini) => (124.0, 60.0),
        // Compacto: píldora con el reloj y los iconos de los widgets.
        (true, Shape::Compact) => (340.0, 44.0),
        (true, Shape::Expanded) => (1000.0, 112.0),
        (true, Shape::Panel) => (720.0, 300.0),
        (false, Shape::Compact) => (328.0, 52.0),
        (false, Shape::Expanded) => (780.0, 200.0),
        (false, Shape::Panel) => (520.0, 340.0),
    }
}

/// Alto lógico mínimo del panel cuando la interfaz pide uno a medida (JW-11-02b).
pub const PANEL_MIN_HEIGHT: f64 = 160.0;

/// Tamaño lógico con el alto de contenido pedido por el panel: el alto de la
/// ventana (grosor en arriba/abajo, largo en izquierda/derecha) se acota entre
/// `PANEL_MIN_HEIGHT` y el fijo. Otras formas, o un valor no finito: sin cambios.
fn fitted_size(edge: Edge, shape: Shape, panel_height: Option<f64>) -> (f64, f64) {
    let (len, thick) = logical_size(edge, shape);
    match panel_height {
        Some(h) if shape == Shape::Panel && h.is_finite() => {
            if matches!(edge, Edge::Top | Edge::Bottom) {
                (len, h.clamp(PANEL_MIN_HEIGHT, thick))
            } else {
                (h.clamp(PANEL_MIN_HEIGHT, len), thick)
            }
        }
        _ => (len, thick),
    }
}

/// `MARGIN` en píxeles físicos (escala no válida → 1).
fn px_margin(scale: f64) -> u32 {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    (MARGIN * scale).round() as u32
}

/// Calcula el rectángulo físico de la barra dentro de `work_area`.
///
/// El centro de la barra se sitúa a lo largo del borde según `offset` (fracción
/// saneada del recorrido entre márgenes; 0,5 = centro), igual para todas las formas;
/// se separa `MARGIN` lógicos del borde y nunca sobresale del área de trabajo (se
/// desplaza o recorta si no cabe).
#[allow(dead_code)] // Lo usan los tests y examples/presence_probe.rs.
pub fn bar_rect(work_area: Rect, scale: f64, edge: Edge, shape: impl Into<Shape>, offset: f64) -> Rect {
    bar_rect_fit(work_area, scale, edge, shape, offset, None)
}

/// Como `bar_rect`, con el alto lógico de contenido que pide el panel abierto
/// (`None` = alto fijo). El anclaje al borde y la fracción no cambian.
pub fn bar_rect_fit(
    work_area: Rect,
    scale: f64,
    edge: Edge,
    shape: impl Into<Shape>,
    offset: f64,
    panel_height: Option<f64>,
) -> Rect {
    rect_for_size(work_area, scale, edge, fitted_size(edge, shape.into(), panel_height), offset)
}

/// Ventana intermedia entre dos formas que no se contienen (una es más larga y la
/// otra más gruesa, p. ej. Compact↔Mini, D-056): el máximo de cada lado, con el
/// mismo anclaje y fracción, para que el morph no se recorte. `None` si una
/// contiene a la otra (basta con crecer ya o encoger tras la animación).
pub fn transition_rect(
    work_area: Rect,
    scale: f64,
    edge: Edge,
    from: Shape,
    to: Shape,
    offset: f64,
    panel_height: Option<f64>,
) -> Option<Rect> {
    let (a, b) = (fitted_size(edge, from, panel_height), fitted_size(edge, to, panel_height));
    let contains = |x: (f64, f64), y: (f64, f64)| x.0 >= y.0 && x.1 >= y.1;
    if contains(a, b) || contains(b, a) {
        return None;
    }
    Some(rect_for_size(work_area, scale, edge, (a.0.max(b.0), a.1.max(b.1)), offset))
}

/// Rectángulo físico para un tamaño lógico (largo, grosor) dado.
fn rect_for_size(work_area: Rect, scale: f64, edge: Edge, (len_l, thick_l): (f64, f64), offset: f64) -> Rect {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let px = |v: f64| (v * scale).round() as u32;
    let margin = px_margin(scale);

    let horizontal = matches!(edge, Edge::Top | Edge::Bottom);
    let (avail_len, avail_thick) = if horizontal {
        (work_area.width, work_area.height)
    } else {
        (work_area.height, work_area.width)
    };
    // Recorta al espacio disponible descontando el margen a ambos lados.
    let len = px(len_l).min(avail_len.saturating_sub(2 * margin)).max(1);
    let thick = px(thick_l).min(avail_thick.saturating_sub(2 * margin)).max(1);

    // Centro común a todas las formas (JW-15-04); la forma se desplaza para caber.
    let (base, span) = track(avail_len, 0, margin);
    let center = f64::from(base) + f64::from(span) * clamp_fraction(offset);
    let (lo, free) = track(avail_len, len, margin);
    let along = (center - f64::from(len) / 2.0).round().clamp(f64::from(lo), f64::from(lo + free)) as i32;
    match edge {
        Edge::Top => Rect { x: work_area.x + along, y: work_area.y + margin as i32, width: len, height: thick },
        Edge::Bottom => Rect {
            x: work_area.x + along,
            y: work_area.y + work_area.height.saturating_sub(thick + margin) as i32,
            width: len,
            height: thick,
        },
        Edge::Left => Rect { x: work_area.x + margin as i32, y: work_area.y + along, width: thick, height: len },
        Edge::Right => Rect {
            x: work_area.x + work_area.width.saturating_sub(thick + margin) as i32,
            y: work_area.y + along,
            width: thick,
            height: len,
        },
    }
}

/// Recorrido a lo largo del borde: inicio (el margen, o menos si no cabe) y
/// longitud libre, de modo que 0 y 1 dejan el margen en las esquinas.
fn track(avail: u32, len: u32, margin: u32) -> (u32, u32) {
    let base = margin.min(avail.saturating_sub(len) / 2);
    (base, avail.saturating_sub(len + 2 * base))
}

/// Fracción a lo largo de `edge` cuyo centro de isla es el punto `(x, y)` (p. ej. el
/// centro de la ventana al soltar), limitada a [0, 1]. No depende de la forma: soltar
/// cualquier forma donde está la deja en el mismo sitio. Sin recorrido: 0,5.
pub fn offset_at(work_area: Rect, scale: f64, edge: Edge, x: f64, y: f64) -> f64 {
    let (start, avail, c) = if matches!(edge, Edge::Top | Edge::Bottom) {
        (work_area.x, work_area.width, x)
    } else {
        (work_area.y, work_area.height, y)
    };
    let (base, span) = track(avail, 0, px_margin(scale));
    if span == 0 {
        return 0.5;
    }
    clamp_fraction((c - f64::from(start) - f64::from(base)) / f64::from(span))
}

/// Migración única (JW-15-04): fracción antigua (D-047, recorrido libre de cada forma)
/// → fracción de centro que deja Compact en el mismo píxel en este monitor.
pub fn center_offset_from_legacy(work_area: Rect, scale: f64, edge: Edge, old: f64) -> f64 {
    let scale = if scale.is_finite() && scale > 0.0 { scale } else { 1.0 };
    let margin = px_margin(scale);
    let (start, avail) = if matches!(edge, Edge::Top | Edge::Bottom) {
        (work_area.x, work_area.width)
    } else {
        (work_area.y, work_area.height)
    };
    let len_l = logical_size(edge, Shape::Compact).0;
    let len = ((len_l * scale).round() as u32).min(avail.saturating_sub(2 * margin)).max(1);
    let (base, free) = track(avail, len, margin);
    let along = f64::from(base) + (f64::from(free) * clamp_fraction(old)).round();
    let c = f64::from(start) + along + f64::from(len) / 2.0;
    offset_at(work_area, scale, edge, c, c)
}

impl EdgeOffsets {
    /// Aplica `center_offset_from_legacy` a los cuatro bordes con el monitor dado.
    pub fn legacy_to_center(self, work_area: Rect, scale: f64) -> Self {
        let f = |e| center_offset_from_legacy(work_area, scale, e, self.get(e));
        Self { top: f(Edge::Top), bottom: f(Edge::Bottom), left: f(Edge::Left), right: f(Edge::Right) }
    }
}

/// Borde del área de trabajo más cercano al punto `(x, y)` (p. ej. el centro de
/// la ventana al soltar un arrastre). Distancias con signo: un punto fuera del
/// área queda pegado al lado por el que salió. Empate: arriba, abajo, izquierda, derecha.
pub fn nearest_edge(work_area: Rect, x: i32, y: i32) -> Edge {
    let (right, bottom) = (work_area.x + work_area.width as i32, work_area.y + work_area.height as i32);
    [(Edge::Top, y - work_area.y), (Edge::Bottom, bottom - y), (Edge::Left, x - work_area.x), (Edge::Right, right - x)]
        .into_iter()
        .min_by_key(|&(_, d)| d)
        .map_or(Edge::Top, |(e, _)| e)
}

/// Índice del monitor (rectángulos físicos completos) que contiene el punto, o
/// `None` si cae fuera de todos (p. ej. en un hueco entre pantallas).
pub fn monitor_at(monitors: &[Rect], x: i32, y: i32) -> Option<usize> {
    monitors
        .iter()
        .position(|m| x >= m.x && y >= m.y && x < m.x + m.width as i32 && y < m.y + m.height as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fracción al soltar la ventana `r` sin moverla (centro exacto, como `drop_target`).
    fn drop_at(wa: Rect, scale: f64, edge: Edge, r: Rect) -> f64 {
        offset_at(wa, scale, edge, f64::from(r.x) + f64::from(r.width) / 2.0, f64::from(r.y) + f64::from(r.height) / 2.0)
    }

    /// Centro a lo largo del borde, en píxeles físicos.
    fn along_center(edge: Edge, r: Rect) -> f64 {
        if matches!(edge, Edge::Top | Edge::Bottom) {
            f64::from(r.x) + f64::from(r.width) / 2.0
        } else {
            f64::from(r.y) + f64::from(r.height) / 2.0
        }
    }

    fn centered(wa: Rect, scale: f64, edge: Edge, shape: impl Into<Shape>) -> Rect {
        bar_rect(wa, scale, edge, shape, 0.5)
    }

    const FHD: Rect = Rect { x: 0, y: 0, width: 1920, height: 1032 }; // 1080p con barra de tareas de 48 px

    #[test]
    fn morph_centers_match_each_shape_before_and_after_native_resize() {
        // Equivalente a --along-shift en CSS: redondear los dos orígenes a
        // píxeles físicos, usando el tamaño animado y el de la ventana actual.
        for wa in [FHD, Rect { x: -2560, y: 40, width: 2560, height: 1400 }] {
            for scale in [1.0, 1.25, 1.5, 2.0] {
                let track = bar_track(wa, scale);
                for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
                    let horizontal = matches!(edge, Edge::Top | Edge::Bottom);
                    let length = if horizontal { track.width } else { track.height };
                    let origin = f64::from(if horizontal { wa.x } else { wa.y }) + f64::from(px_margin(scale));
                    for offset in [0.0, 0.05, 0.5, 0.95, 1.0] {
                        let compact = bar_rect(wa, scale, edge, Shape::Compact, offset);
                        let expanded = bar_rect(wa, scale, edge, Shape::Expanded, offset);
                        let len = |r: Rect| f64::from(if horizontal { r.width } else { r.height }) / scale;
                        let start = |size: f64| ((length * offset - size / 2.0).clamp(0.0, (length - size).max(0.0)) * scale).round() / scale;
                        let window = len(expanded);
                        for (from, to) in [(compact, expanded), (expanded, compact)] {
                            for step in 0..=4 {
                                let progress = f64::from(step) / 4.0;
                                let size = len(from) + (len(to) - len(from)) * progress;
                                let shift = start(size) - start(window) - (window - size) / 2.0;
                                let screen = along_center(edge, expanded) + shift * scale;
                                let expected = origin + (length * offset).clamp(size / 2.0, length - size / 2.0) * scale;
                                // Centro ideal, con hasta medio píxel por redondeo del origen.
                                assert!((screen - expected).abs() <= 0.500001, "{edge:?} {scale} {offset} {progress}");
                                if step == 0 {
                                    assert!((screen - along_center(edge, from)).abs() < 0.000001);
                                }
                                if step == 4 {
                                    assert!((screen - along_center(edge, to)).abs() < 0.000001);
                                }
                            }
                        }
                        // Cambiar la ventana al principio/final no añade desplazamiento.
                        let size = len(compact);
                        assert!((start(size) * scale + size * scale / 2.0 + origin - along_center(edge, compact)).abs() < 0.000001);
                    }
                }
            }
        }
    }

    fn inside(r: Rect, wa: Rect) -> bool {
        r.x >= wa.x
            && r.y >= wa.y
            && r.x + r.width as i32 <= wa.x + wa.width as i32
            && r.y + r.height as i32 <= wa.y + wa.height as i32
    }

    #[test]
    fn top_compact_100_percent() {
        let r = centered(FHD, 1.0, Edge::Top, Mode::Compact);
        assert_eq!(r, Rect { x: 790, y: 8, width: 340, height: 44 });
    }

    #[test]
    fn bottom_expanded_150_percent_sits_above_taskbar() {
        // 4K a 150 %: área de trabajo 3840x2088.
        let wa = Rect { x: 0, y: 0, width: 3840, height: 2088 };
        let r = centered(wa, 1.5, Edge::Bottom, Mode::Expanded);
        assert_eq!((r.width, r.height), (1500, 168));
        assert_eq!(r.y + r.height as i32, 2088 - 12);
        assert_eq!(r.x, (3840 - 1500) / 2);
    }

    #[test]
    fn left_and_right_are_vertical() {
        let l = centered(FHD, 1.25, Edge::Left, Mode::Compact);
        assert_eq!((l.x, l.width, l.height), (10, 65, 410));
        let r = centered(FHD, 1.25, Edge::Right, Mode::Compact);
        assert_eq!(r.x + r.width as i32, 1920 - 10);
        assert_eq!(r.y, l.y);
    }

    #[test]
    fn secondary_monitor_with_negative_origin() {
        // Monitor a la izquierda del principal, con barra de tareas arriba.
        let wa = Rect { x: -2560, y: 40, width: 2560, height: 1400 };
        let r = centered(wa, 1.0, Edge::Top, Mode::Compact);
        assert_eq!((r.x, r.y), (-2560 + 1110, 48));
        assert!(inside(r, wa));
    }

    #[test]
    fn clamps_to_tiny_work_area_at_all_edges_and_scales() {
        let wa = Rect { x: 100, y: 100, width: 600, height: 400 };
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0, 3.0] {
            for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
                for shape in [Shape::Mini, Shape::Compact, Shape::Expanded, Shape::Panel] {
                    let r = centered(wa, scale, edge, shape);
                    assert!(inside(r, wa), "{edge:?} {shape:?} {scale}: {r:?}");
                    assert!(r.width > 0 && r.height > 0);
                }
            }
        }
    }

    #[test]
    fn left_expanded_fits_nine_cards() {
        // 9 tarjetas + pie en vertical expandido (JW-9-04): 780x200 lógicos.
        let r = centered(FHD, 1.0, Edge::Left, Mode::Expanded);
        assert_eq!((r.width, r.height), (200, 780));
        assert!(inside(r, FHD));
    }

    #[test]
    fn panel_is_larger_than_expanded() {
        let e = centered(FHD, 1.0, Edge::Top, Shape::Expanded);
        let p = centered(FHD, 1.0, Edge::Top, Shape::Panel);
        assert_eq!((p.y, p.width, p.height), (e.y, 720, 300));
        assert!(Shape::Mini < Shape::Compact && Shape::Compact < Shape::Expanded && Shape::Expanded < Shape::Panel);
    }

    #[test]
    fn mini_is_priority_lowest_but_taller_than_compact() {
        // D-056: el orden de Shape es de prioridad, no de tamaño.
        let m = centered(FHD, 1.0, Edge::Top, Shape::Mini);
        let c = centered(FHD, 1.0, Edge::Top, Shape::Compact);
        assert_eq!((m.width, m.height, c.width, c.height), (148, 60, 340, 44));
        let v = centered(FHD, 1.0, Edge::Left, Shape::Mini);
        assert_eq!((v.width, v.height), (60, 124));
        assert!(Shape::Mini < Shape::Compact && m.height > c.height);
    }

    #[test]
    fn transition_rect_is_union_only_when_shapes_cross() {
        let s = 1.25;
        for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
            let horizontal = matches!(edge, Edge::Top | Edge::Bottom);
            // Compact↔Mini: largo de Compact, grosor de Mini, mismo anclaje y fracción.
            let (len, thick) = if horizontal { (340.0, 60.0) } else { (328.0, 60.0) };
            let px = |v: f64| (v * s).round() as u32;
            for offset in [0.0, 0.3, 1.0] {
                for (a, b) in [(Shape::Mini, Shape::Compact), (Shape::Compact, Shape::Mini)] {
                    let r = transition_rect(FHD, s, edge, a, b, offset, None).expect("se cruzan");
                    assert_eq!((r.width, r.height), if horizontal { (px(len), px(thick)) } else { (px(thick), px(len)) });
                    let c = bar_rect(FHD, s, edge, Shape::Compact, offset);
                    let m = bar_rect(FHD, s, edge, Shape::Mini, offset);
                    // Contiene la ventana de origen y la de destino en el lado del borde.
                    assert!(inside(r, FHD) && r.width >= c.width.max(m.width) && r.height >= c.height.max(m.height));
                    match edge {
                        Edge::Top => assert_eq!(r.y, c.y),
                        Edge::Bottom => assert_eq!(r.y + r.height as i32, c.y + c.height as i32),
                        Edge::Left => assert_eq!(r.x, c.x),
                        Edge::Right => assert_eq!(r.x + r.width as i32, c.x + c.width as i32),
                    }
                    if horizontal { assert_eq!(r.x, c.x) } else { assert_eq!(r.y, c.y) }
                }
            }
            // Una forma contiene a la otra: sin paso intermedio.
            assert_eq!(transition_rect(FHD, s, edge, Shape::Compact, Shape::Expanded, 0.5, None), None);
            assert_eq!(transition_rect(FHD, s, edge, Shape::Panel, Shape::Mini, 0.5, Some(200.0)), None);
            assert_eq!(transition_rect(FHD, s, edge, Shape::Mini, Shape::Mini, 0.5, None), None);
        }
    }

    #[test]
    fn panel_height_fits_content_on_every_edge() {
        let fit = |edge, h| bar_rect_fit(FHD, 1.5, edge, Shape::Panel, 0.5, h);
        for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
            let full = centered(FHD, 1.5, edge, Shape::Panel);
            assert_eq!(fit(edge, None), full, "sin alto: el fijo");
            assert_eq!(fit(edge, Some(9999.0)), full, "tope: el fijo");
            assert_eq!(fit(edge, Some(f64::NAN)), full);
            assert_eq!(fit(edge, Some(-5.0)).height, 240, "mínimo 160 lógicos a 150 %");
            let r = fit(edge, Some(200.0));
            assert_eq!((r.width, r.height), (full.width, 300), "{edge:?}: solo cambia el alto");
            assert!(inside(r, FHD));
        }
        // Anclaje: arriba conserva la y; abajo, el borde inferior; los laterales, la x.
        let (t, b) = (fit(Edge::Top, Some(200.0)), fit(Edge::Bottom, Some(200.0)));
        assert_eq!(t.y, centered(FHD, 1.5, Edge::Top, Shape::Panel).y);
        assert_eq!(b.y + b.height as i32, 1032 - 12);
        assert_eq!(fit(Edge::Left, Some(200.0)).x, 12);
        let r = fit(Edge::Right, Some(200.0));
        assert_eq!(r.x + r.width as i32, 1920 - 12);
        // Otras formas ignoran el alto.
        assert_eq!(bar_rect_fit(FHD, 1.0, Edge::Top, Mode::Compact, 0.5, Some(200.0)), centered(FHD, 1.0, Edge::Top, Mode::Compact));
    }

    #[test]
    fn invalid_scale_falls_back_to_one() {
        assert_eq!(centered(FHD, 0.0, Edge::Top, Mode::Compact), centered(FHD, 1.0, Edge::Top, Mode::Compact));
        assert_eq!(centered(FHD, f64::NAN, Edge::Top, Mode::Compact), centered(FHD, 1.0, Edge::Top, Mode::Compact));
    }

    #[test]
    fn nearest_edge_picks_closest_side() {
        assert_eq!(nearest_edge(FHD, 960, 30), Edge::Top);
        assert_eq!(nearest_edge(FHD, 960, 1000), Edge::Bottom);
        assert_eq!(nearest_edge(FHD, 30, 500), Edge::Left);
        assert_eq!(nearest_edge(FHD, 1890, 500), Edge::Right);
        // Esquina: gana el lado más próximo.
        assert_eq!(nearest_edge(FHD, 20, 40), Edge::Left);
        // Fuera del área (otro monitor a la derecha): borde derecho.
        assert_eq!(nearest_edge(FHD, 2500, 500), Edge::Right);
        // Origen negativo y empate en el centro exacto: arriba.
        let wa = Rect { x: -2560, y: 40, width: 2560, height: 1400 };
        assert_eq!(nearest_edge(wa, -2540, 700), Edge::Left);
        assert_eq!(nearest_edge(Rect { x: 0, y: 0, width: 100, height: 100 }, 50, 50), Edge::Top);
    }

    #[test]
    fn monitor_at_finds_screen_under_point() {
        // Físicos: principal 4K al 150 %, a la izquierda 1080p al 100 % (origen
        // negativo) y a la derecha uno vertical al 125 % desplazado hacia abajo.
        let mons = [
            Rect { x: 0, y: 0, width: 3840, height: 2160 },
            Rect { x: -1920, y: 0, width: 1920, height: 1080 },
            Rect { x: 3840, y: 300, width: 1350, height: 2400 },
        ];
        assert_eq!(monitor_at(&mons, 0, 0), Some(0));
        assert_eq!(monitor_at(&mons, -1, 500), Some(1));
        assert_eq!(monitor_at(&mons, -1920, 1079), Some(1));
        assert_eq!(monitor_at(&mons, 3839, 2159), Some(0));
        assert_eq!(monitor_at(&mons, 3840, 2159), Some(2));
        // Huecos: debajo del de la izquierda y encima del vertical.
        assert_eq!(monitor_at(&mons, -100, 1500), None);
        assert_eq!(monitor_at(&mons, 4000, 100), None);
        assert_eq!(monitor_at(&[], 0, 0), None);
    }

    #[test]
    fn offset_fractions_along_edge() {
        // Centro sobre el recorrido entre márgenes (1920 - 2·8 = 1904); 0 y 1 dejan el margen.
        let at = |o: f64| bar_rect(FHD, 1.0, Edge::Top, Mode::Compact, o);
        assert_eq!(at(0.0).x, 8);
        assert_eq!(at(1.0).x + at(1.0).width as i32, 1920 - 8);
        assert_eq!(at(0.5), centered(FHD, 1.0, Edge::Top, Mode::Compact), "0,5 = centrado");
        assert_eq!(at(0.25).x, 8 + 476 - 170, "centro en 8 + 0,25·1904");
        // Vertical: a lo largo de la altura.
        let l = bar_rect(FHD, 1.0, Edge::Left, Mode::Compact, 1.0);
        assert_eq!(l.y + l.height as i32, 1032 - 8);
        // Fuera de rango o NaN: saneado (nunca sale del área de trabajo).
        assert_eq!(at(-3.0), at(0.0));
        assert_eq!(at(7.0), at(1.0));
        assert_eq!(at(f64::NAN), at(0.5));
        assert_eq!(at(f64::INFINITY), at(0.5));
        assert_eq!(clamp_fraction(f64::NEG_INFINITY), 0.5);
    }

    #[test]
    fn offset_on_secondary_monitor_with_negative_origin() {
        let wa = Rect { x: -2560, y: 40, width: 2560, height: 1400 };
        for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
            for o in [0.0, 0.3, 0.5, 1.0] {
                let r = bar_rect(wa, 1.25, edge, Mode::Expanded, o);
                assert!(inside(r, wa), "{edge:?} {o}: {r:?}");
                // Soltar donde está la deja en el mismo sitio (fracción exacta salvo recorte).
                assert_eq!(bar_rect(wa, 1.25, edge, Mode::Expanded, drop_at(wa, 1.25, edge, r)), r, "{edge:?} {o}");
            }
        }
        assert_eq!(bar_rect(wa, 1.0, Edge::Top, Mode::Compact, 0.0).x, -2560 + 8);
    }

    #[test]
    fn offset_at_clamps_and_handles_no_room() {
        assert_eq!(offset_at(FHD, 1.0, Edge::Top, -5000.0, 10.0), 0.0);
        assert_eq!(offset_at(FHD, 1.0, Edge::Top, 5000.0, 10.0), 1.0);
        assert_eq!(offset_at(FHD, 1.0, Edge::Left, 10.0, 5000.0), 1.0);
        assert_eq!(offset_at(FHD, 1.0, Edge::Top, 960.0, 10.0), 0.5);
        // Sin recorrido entre márgenes: centro.
        let tiny = Rect { x: 0, y: 0, width: 16, height: 16 };
        assert_eq!(offset_at(tiny, 1.0, Edge::Top, 0.0, 0.0), 0.5);
        let o = EdgeOffsets { top: f64::NAN, bottom: -1.0, left: 2.0, right: 0.2 }.sanitize();
        assert_eq!((o.get(Edge::Top), o.get(Edge::Bottom), o.get(Edge::Left), o.get(Edge::Right)), (0.5, 0.0, 1.0, 0.2));
        assert_eq!(EdgeOffsets::default().with(Edge::Right, 0.7).get(Edge::Right), 0.7);
    }

    #[test]
    fn mini_geometry_and_drop_offsets_on_all_edges_and_scales() {
        let wa = Rect { x: -1920, y: 40, width: 1920, height: 1040 };
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let margin = (8.0_f64 * scale).round() as i32;
            for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
                let horizontal = matches!(edge, Edge::Top | Edge::Bottom);
                for offset in [0.0, 0.5, 1.0] {
                    let r = bar_rect(wa, scale, edge, Shape::Mini, offset);
                    let (len_l, thick_l) = if horizontal { (148.0, 60.0) } else { (124.0, 60.0) };
                    let (len, thick) = ((len_l * scale).round() as u32, (thick_l * scale).round() as u32);
                    assert_eq!((r.width, r.height), if horizontal { (len, thick) } else { (thick, len) });
                    assert!(inside(r, wa));
                    match edge {
                        Edge::Top => assert_eq!(r.y, wa.y + margin),
                        Edge::Bottom => assert_eq!(r.y + r.height as i32, wa.y + wa.height as i32 - margin),
                        Edge::Left => assert_eq!(r.x, wa.x + margin),
                        Edge::Right => assert_eq!(r.x + r.width as i32, wa.x + wa.width as i32 - margin),
                    }
                    let (along, start, avail) = if horizontal { (r.x, wa.x, wa.width) } else { (r.y, wa.y, wa.height) };
                    // Centro en margen + fracción del recorrido entre márgenes, desplazado para caber.
                    let center = f64::from(margin) + f64::from(avail as i32 - 2 * margin) * offset;
                    let want = ((center - f64::from(len) / 2.0).round() as i32).clamp(margin, avail as i32 - margin - len as i32);
                    assert_eq!(along, start + want);
                    assert_eq!(bar_rect(wa, scale, edge, Shape::Mini, drop_at(wa, scale, edge, r)), r);
                    assert_eq!(bar_rect_fit(wa, scale, edge, Shape::Mini, offset, Some(250.0)), r);
                }
            }
        }
    }

    #[test]
    fn presence_cycles_keep_center_and_offsets() {
        // JW-15-04: minimizar/restaurar N veces no mueve la isla ni cambia barOffsets.
        let wa = Rect { x: -1920, y: 40, width: 1920, height: 1040 };
        for scale in [1.0, 1.25, 1.5, 2.0] {
            let margin = (8.0_f64 * scale).round() as i32;
            for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
                let horizontal = matches!(edge, Edge::Top | Edge::Bottom);
                let (start, avail) = if horizontal { (wa.x, wa.width) } else { (wa.y, wa.height) };
                // Recortada: pegada al margen inicial o final.
                let clipped = |r: Rect| {
                    let (a, len) = if horizontal { (r.x, r.width) } else { (r.y, r.height) };
                    a == start + margin || a + len as i32 == start + avail as i32 - margin
                };
                for base in [Shape::Compact, Shape::Expanded] {
                    for o in [0.0, 0.3, 0.5, 0.8, 1.0] {
                        let offsets = EdgeOffsets::default().with(edge, o);
                        let first = (bar_rect(wa, scale, edge, base, o), bar_rect(wa, scale, edge, Shape::Mini, o));
                        for _ in 0..20 {
                            // Ciclo sin arrastre: solo cambia `minimized`; las fracciones no se tocan.
                            let s = offsets.get(edge);
                            let (full, mini) = (bar_rect(wa, scale, edge, base, s), bar_rect(wa, scale, edge, Shape::Mini, s));
                            assert_eq!((full, mini), first, "{scale} {edge:?} {base:?} {o}: sin deriva");
                            if !clipped(full) && !clipped(mini) {
                                assert!((along_center(edge, full) - along_center(edge, mini)).abs() <= 1.0, "{scale} {edge:?} {base:?} {o}");
                            }
                            // La unión (si la hubiera) comparte el centro con la forma completa.
                            if let Some(u) = transition_rect(wa, scale, edge, base, Shape::Mini, s, None) {
                                assert!(clipped(u) || (along_center(edge, u) - along_center(edge, full)).abs() <= 0.5);
                            }
                            // Soltar sin mover (en Mini o en la forma completa) no mueve esa ventana.
                            for (shape, r) in [(Shape::Mini, mini), (base, full)] {
                                let o2 = drop_at(wa, scale, edge, r);
                                assert_eq!(bar_rect(wa, scale, edge, shape, o2), r, "{scale} {edge:?} {shape:?} {o}");
                                if !clipped(r) {
                                    assert!((o2 - o).abs() < 1.0 / f64::from(avail), "{scale} {edge:?} {o}: {o2}");
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn legacy_offsets_migrate_without_moving_compact() {
        for (wa, scale) in [(FHD, 1.0), (FHD, 1.25), (Rect { x: -2560, y: 40, width: 2560, height: 1400 }, 1.5), (FHD, 2.0)] {
            let margin = (8.0_f64 * scale).round() as u32;
            for edge in [Edge::Top, Edge::Bottom, Edge::Left, Edge::Right] {
                let horizontal = matches!(edge, Edge::Top | Edge::Bottom);
                let (start, avail) = if horizontal { (wa.x, wa.width) } else { (wa.y, wa.height) };
                let len = ((logical_size(edge, Shape::Compact).0 * scale).round() as u32).min(avail - 2 * margin);
                for old in [0.0, 0.1, 0.3, 0.5, 0.65, 0.8, 1.0] {
                    // Posición antigua de Compact (D-047): margen + fracción del recorrido libre.
                    let free = avail - len - 2 * margin;
                    let legacy = start + (margin + (f64::from(free) * old).round() as u32) as i32;
                    let new = EdgeOffsets::default().with(edge, old).legacy_to_center(wa, scale).get(edge);
                    let r = bar_rect(wa, scale, edge, Shape::Compact, new);
                    assert_eq!(if horizontal { r.x } else { r.y }, legacy, "{scale} {edge:?} {old}");
                    assert!((0.0..=1.0).contains(&new));
                }
            }
        }
    }
}
