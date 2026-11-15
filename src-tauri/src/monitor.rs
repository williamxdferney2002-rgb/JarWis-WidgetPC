//! Monitoreo del sistema (JW-3-01).
//!
//! Sin hilo ni sondeo propio: la interfaz llama a `system_snapshot` solo
//! mientras la isla está visible y decide el intervalo. Cada llamada refresca
//! CPU, memoria y redes; los discos se releen como mucho cada 60 s.

use serde::Serialize;
use std::time::{Duration, Instant};
use sysinfo::{Disks, Networks, System};

const DISK_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Ok,
    Warn,
    Crit,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub percent: u8,
    pub charging: bool,
    pub on_ac: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub cpu: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub disk_used: u64,
    pub disk_total: u64,
    pub net_rx_bps: u64,
    pub net_tx_bps: u64,
    pub uptime_secs: u64,
    pub battery: Option<Battery>,
    pub level: Level,
}

fn pct(used: u64, total: u64) -> f64 {
    if total == 0 {
        0.0
    } else {
        used as f64 * 100.0 / total as f64
    }
}

/// Nivel de alerta. Pura para poder probarla. `cpu = None`: sin muestra previa (no cuenta).
pub fn level(cpu: Option<f32>, mem_pct: f64, disk_pct: f64, battery: Option<Battery>) -> Level {
    let cpu = cpu.unwrap_or(0.0);
    // Batería baja solo cuenta si no está cargando ni enchufada.
    let low_batt = |max: u8| battery.is_some_and(|b| !b.charging && !b.on_ac && b.percent <= max);
    if cpu >= 90.0 || mem_pct >= 90.0 || low_batt(10) {
        Level::Crit
    } else if cpu >= 70.0 || mem_pct >= 80.0 || disk_pct >= 95.0 || low_batt(20) {
        Level::Warn
    } else {
        Level::Ok
    }
}

/// Interpreta `SYSTEM_POWER_STATUS`. `None` = sin batería o estado desconocido.
pub fn battery_from(ac_line: u8, flag: u8, percent: u8) -> Option<Battery> {
    // 128 = sin batería; 255 = estado desconocido; porcentaje 255 = desconocido.
    if flag == 255 || flag & 128 != 0 || percent > 100 {
        return None;
    }
    Some(Battery { percent, charging: flag & 8 != 0, on_ac: ac_line == 1 })
}

#[cfg(windows)]
fn battery() -> Option<Battery> {
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s = SYSTEM_POWER_STATUS::default();
    // SAFETY: puntero válido a una estructura propia durante la llamada.
    unsafe { GetSystemPowerStatus(&mut s) }.ok()?;
    battery_from(s.ACLineStatus, s.BatteryFlag, s.BatteryLifePercent)
}

#[cfg(not(windows))]
fn battery() -> Option<Battery> {
    None
}

pub struct Monitor {
    sys: System,
    /// Hay una muestra de CPU anterior: el % ya es real.
    cpu_sampled: bool,
    nets: Networks,
    net_at: Instant,
    disks: Disks,
    disk: (u64, u64),
    disk_at: Option<Instant>,
}

impl Monitor {
    pub fn new() -> Self {
        Self {
            sys: System::new(),
            cpu_sampled: false,
            nets: Networks::new_with_refreshed_list(),
            net_at: Instant::now(),
            disks: Disks::new(),
            disk: (0, 0),
            disk_at: None,
        }
    }

    /// (usado, total) de la unidad del sistema, con caché de 60 s.
    fn system_disk(&mut self) -> (u64, u64) {
        if self.disk_at.is_some_and(|t| t.elapsed() < DISK_TTL) {
            return self.disk;
        }
        self.disks.refresh(true);
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let root = format!("{}\\", drive.trim_end_matches('\\'));
        self.disk = self
            .disks
            .iter()
            .find(|d| d.mount_point().to_string_lossy().eq_ignore_ascii_case(&root))
            .map(|d| (d.total_space().saturating_sub(d.available_space()), d.total_space()))
            .unwrap_or((0, 0));
        self.disk_at = Some(Instant::now());
        self.disk
    }

    pub fn snapshot(&mut self) -> Snapshot {
        self.sys.refresh_cpu_usage();
        self.sys.refresh_memory();
        self.nets.refresh(true);
        let secs = self.net_at.elapsed().as_secs_f64();
        self.net_at = Instant::now();
        let (rx, tx) = self.nets.values().fold((0u64, 0u64), |(r, t), n| {
            (r.saturating_add(n.received()), t.saturating_add(n.transmitted()))
        });
        let rate = |bytes: u64| if secs > 0.0 { (bytes as f64 / secs) as u64 } else { 0 };
        let (disk_used, disk_total) = self.system_disk();
        // Primera llamada: sin muestra previa el % no es fiable → 0 y fuera de `level`.
        let cpu = std::mem::replace(&mut self.cpu_sampled, true)
            .then(|| self.sys.global_cpu_usage())
            .map(|c| if c.is_finite() { c.clamp(0.0, 100.0) } else { 0.0 });
        let (mem_used, mem_total) = (self.sys.used_memory(), self.sys.total_memory());
        let battery = battery();
        Snapshot {
            cpu: cpu.unwrap_or(0.0),
            mem_used,
            mem_total,
            disk_used,
            disk_total,
            net_rx_bps: rate(rx),
            net_tx_bps: rate(tx),
            uptime_secs: System::uptime(),
            battery,
            level: level(cpu, pct(mem_used, mem_total), pct(disk_used, disk_total), battery),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batt(percent: u8, charging: bool, on_ac: bool) -> Option<Battery> {
        Some(Battery { percent, charging, on_ac })
    }

    #[test]
    fn levels() {
        assert_eq!(level(None, 50.0, 50.0, None), Level::Ok, "sin muestra de CPU");
        assert_eq!(level(None, 90.0, 0.0, None), Level::Crit);
        assert_eq!(level(Some(10.0), 50.0, 50.0, None), Level::Ok);
        assert_eq!(level(Some(70.0), 0.0, 0.0, None), Level::Warn);
        assert_eq!(level(Some(0.0), 80.0, 0.0, None), Level::Warn);
        assert_eq!(level(Some(0.0), 0.0, 95.0, None), Level::Warn);
        assert_eq!(level(Some(0.0), 0.0, 100.0, None), Level::Warn, "disco lleno no es crítico");
        assert_eq!(level(Some(90.0), 0.0, 0.0, None), Level::Crit);
        assert_eq!(level(Some(0.0), 90.0, 0.0, None), Level::Crit);
        assert_eq!(level(Some(69.9), 79.9, 94.9, batt(21, false, false)), Level::Ok);
        assert_eq!(level(Some(0.0), 0.0, 0.0, batt(20, false, false)), Level::Warn);
        assert_eq!(level(Some(0.0), 0.0, 0.0, batt(10, false, false)), Level::Crit);
        // Cargando o enchufada: la batería baja no alerta.
        assert_eq!(level(Some(0.0), 0.0, 0.0, batt(5, true, true)), Level::Ok);
        assert_eq!(level(Some(0.0), 0.0, 0.0, batt(5, false, true)), Level::Ok);
    }

    #[test]
    fn battery_flags() {
        assert_eq!(battery_from(255, 128, 255), None, "sin batería");
        assert_eq!(battery_from(1, 255, 50), None, "estado desconocido");
        assert_eq!(battery_from(0, 0, 255), None, "porcentaje desconocido");
        assert_eq!(battery_from(1, 8 | 1, 80), batt(80, true, true));
        assert_eq!(battery_from(0, 4, 3), batt(3, false, false));
        assert_eq!(battery_from(255, 2, 15), batt(15, false, false), "AC desconocido = no enchufada");
    }

    #[test]
    fn snapshot_does_not_panic() {
        let mut m = Monitor::new();
        let a = m.snapshot();
        let b = m.snapshot();
        assert_eq!(a.cpu, 0.0, "primera llamada sin muestra previa");
        assert!(a.mem_total > 0 && b.cpu >= 0.0 && b.cpu <= 100.0);
        let json = serde_json::to_string(&b).unwrap();
        assert!(json.contains("\"memUsed\"") && json.contains("\"netRxBps\"") && json.contains("\"level\""));
    }
}
