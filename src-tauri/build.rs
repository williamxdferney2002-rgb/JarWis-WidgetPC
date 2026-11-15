fn main() {
    // Los ejemplos nativos necesitan el mismo manifiesto Common Controls v6.
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=examples/presence_probe.manifest");
        println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
        // Cargo pasa cada argumento entero al enlazador: una ruta con espacios no se parte.
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("examples/presence_probe.manifest");
        println!("cargo:rustc-link-arg-examples=/MANIFESTINPUT:{}", manifest.display());
    }
    // Los comandos propios exigen permiso explícito en las capabilities.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_settings",
            "bar_track",
            "patch_settings",
            "alarm_add",
            "alarm_set_enabled",
            "alarm_remove",
            "widget_move",
            "set_minimized",
            "list_monitors",
            "get_status",
            "open_settings",
            "clock_state",
            "timer_add",
            "timer_control",
            "alert_dismiss",
            "set_panel",
            "clipboard_list",
            "clipboard_copy",
            "clipboard_pin",
            "clipboard_delete",
            "clipboard_clear",
            "clipboard_pause",
            "system_snapshot",
            "power_mode",
            "power_set",
            "power_open",
            "get_shortcuts",
            "set_shortcuts",
            "open_shortcut",
            "list_store_apps",
            "audio_state",
            "set_volume",
            "set_muted",
            "list_audio_devices",
            "open_sound_settings",
            "open_focus_settings",
            "open_workspace",
            "set_workspaces",
            "media_state",
            "media_control",
            "media_open",
            "bar_menu",
            "bar_drag",
            "weather_today",
            "weather_search",
            "weather_open",
            "cloud_mail",
            "cloud_agenda",
            "cloud_month",
            "cloud_open",
            "cloud_status",
            "cloud_login",
            "cloud_logout",
            "claude_open",
            "show_codex_pet",
        ]),
    ))
    .expect("failed to run tauri-build");
}
