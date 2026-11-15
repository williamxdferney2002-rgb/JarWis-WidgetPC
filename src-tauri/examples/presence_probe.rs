//! Prueba aislada de tamaño nativo: sin ajustes, plugins ni datos del usuario.
use std::time::Duration;
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl};

#[allow(dead_code)]
#[path = "../src/layout.rs"]
mod layout;

fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap();
    let data = root.join("target/jw-15-01-probe/webview");
    std::fs::create_dir_all(&data).unwrap();
    let mut context = tauri::generate_context!();
    let window = &mut context.config_mut().app.windows[0];
    window.url = WebviewUrl::External("about:blank".parse().unwrap());
    window.data_directory = Some(data);
    tauri::Builder::default()
        .setup(|app| {
            let win = app.get_webview_window("bar").unwrap();
            win.show()?;
            let app = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(1));
                let mut rows = Vec::new();
                let mut logical_rows = Vec::new();
                let mut geometry_rows = Vec::new();
                let mut passed = true;
                for (index, monitor) in win.available_monitors().unwrap().iter().enumerate() {
                  let position = monitor.work_area().position;
                  win.set_position(PhysicalPosition::new(position.x + 100, position.y + 100)).unwrap();
                  std::thread::sleep(Duration::from_millis(500));
                  for scale in [1.0, 1.25, 1.5, 2.0] {
                    for (orientation, width, height) in [("horizontal", 72.0, 36.0), ("vertical", 36.0, 72.0)] {
                        let requested = PhysicalSize::new((width * scale) as u32, (height * scale) as u32);
                        win.set_size(requested).unwrap();
                        std::thread::sleep(Duration::from_millis(250));
                        let inner = win.inner_size().unwrap();
                        let outer = win.outer_size().unwrap();
                        passed &= inner == requested && outer == requested;
                        rows.push(serde_json::json!({
                            "scale_calculated": scale, "orientation": orientation,
                            "requested": [requested.width, requested.height],
                            "inner": [inner.width, inner.height], "outer": [outer.width, outer.height],
                            "actual_scale": win.scale_factor().unwrap(), "monitor_index": index,
                            "monitor_scale": monitor.scale_factor(),
                        }));
                    }
                  }
                  for (width, height) in [(72.0, 36.0), (36.0, 72.0)] {
                    win.set_size(LogicalSize::new(width, height)).unwrap();
                    std::thread::sleep(Duration::from_millis(250));
                    let inner = win.inner_size().unwrap();
                    let outer = win.outer_size().unwrap();
                    let scale = monitor.scale_factor();
                    passed &= inner == PhysicalSize::new((width * scale).round() as u32, (height * scale).round() as u32) && outer == inner;
                    logical_rows.push(serde_json::json!({
                        "monitor_index": index, "actual_scale": win.scale_factor().unwrap(),
                        "logical_requested": [width, height], "inner": [inner.width, inner.height], "outer": [outer.width, outer.height],
                    }));
                  }
                  let wa = monitor.work_area();
                  let work = layout::Rect { x: wa.position.x, y: wa.position.y, width: wa.size.width, height: wa.size.height };
                  for edge in [layout::Edge::Top, layout::Edge::Bottom, layout::Edge::Left, layout::Edge::Right] {
                    for offset in [0.0, 0.5, 1.0] {
                        let r = layout::bar_rect(work, monitor.scale_factor(), edge, layout::Shape::Mini, offset);
                        win.set_position(PhysicalPosition::new(r.x, r.y)).unwrap();
                        win.set_size(PhysicalSize::new(r.width, r.height)).unwrap();
                        std::thread::sleep(Duration::from_millis(200));
                        let actual = win.outer_position().unwrap();
                        let size = win.outer_size().unwrap();
                        passed &= (actual.x, actual.y, size.width, size.height) == (r.x, r.y, r.width, r.height);
                        geometry_rows.push(serde_json::json!({
                            "monitor_index": index, "actual_scale": win.scale_factor().unwrap(), "edge": edge, "offset": offset,
                            "requested_rect": [r.x, r.y, r.width, r.height], "outer_rect": [actual.x, actual.y, size.width, size.height],
                        }));
                    }
                  }
                }
                #[cfg(windows)]
                let minimum = unsafe {
                    use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXMINTRACK, SM_CYMINTRACK};
                    [GetSystemMetrics(SM_CXMINTRACK), GetSystemMetrics(SM_CYMINTRACK)]
                };
                let result = serde_json::json!({"passed": passed, "system_min_track": minimum,
                    "measurements": rows, "logical_measurements": logical_rows, "geometry_measurements": geometry_rows});
                let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
                std::fs::write(root.join("target/jw-15-01-probe/result.json"), serde_json::to_vec_pretty(&result).unwrap()).unwrap();
                // Deja tiempo para contrastar el último rectángulo con mouse.ps1.
                std::thread::sleep(Duration::from_secs(15));
                app.exit(if passed { 0 } else { 1 });
            });
            Ok(())
        })
        .run(context)
        .expect("falló la prueba nativa aislada");
}
