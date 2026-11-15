//! Reloj (D-029): temporizadores, alarmas y avisos, programados en el núcleo.
//!
//! La lógica es pura: el tiempo entra como [`Now`] para probarla sin dormir.
//! [`Scheduler::run`] es el único hilo, que duerme hasta el próximo vencimiento
//! y se despierta con un `Condvar` cuando cambian los temporizadores o las alarmas.
//!
//! - Temporizadores y «posponer»: reloj monotónico (`Instant`), inmunes a los
//!   cambios de hora.
//! - Alarmas: hora local. Cada comprobación avisa las que vencieron en la
//!   ventana `(última comprobación, ahora]`, así una alarma que venció con el PC
//!   suspendido se avisa una sola vez al reanudar.
//! - El cronómetro vive en la interfaz: no vence nunca y solo se mide con instantes.

use chrono::{Datelike, Days, NaiveDateTime, NaiveTime};
use serde::{Deserialize, Serialize};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

pub const SNOOZE: Duration = Duration::from_secs(5 * 60);
/// Tope de espera mientras haya algo programado. En Windows 8+ las esperas no
/// cuentan el tiempo suspendido y no se enteran de los cambios de hora: el tope
/// acota el retraso tras reanudar o cambiar la hora.
// ponytail: tope de 30 s; si hace falta precisión al segundo tras suspender,
// escuchar WM_POWERBROADCAST/WM_TIMECHANGE o usar un waitable timer absoluto.
pub const GUARD: Duration = Duration::from_secs(30);
const MAX_LABEL: usize = 40;
const MAX_TIMERS: usize = 20;
pub const MAX_ALARMS: usize = 50;
const MAX_TIMER_SECS: u64 = 24 * 3600;

/// Alarma persistida en los ajustes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Alarm {
    pub id: u64,
    pub hour: u8,
    pub minute: u8,
    /// Días de repetición: 0 = lunes … 6 = domingo. Vacío = una sola vez.
    pub days: Vec<u8>,
    pub label: String,
    pub enabled: bool,
}

impl Default for Alarm {
    fn default() -> Self {
        Self { id: 0, hour: 7, minute: 0, days: Vec::new(), label: String::new(), enabled: true }
    }
}

fn clean_label(s: &str) -> String {
    s.trim().chars().filter(|c| !c.is_control()).take(MAX_LABEL).collect()
}

/// Valores en rango, días ordenados sin duplicados e ids únicos (0 = nueva).
pub fn normalize_alarms(alarms: Vec<Alarm>) -> Vec<Alarm> {
    let mut next = alarms.iter().map(|a| a.id).max().unwrap_or(0);
    let mut seen = Vec::new();
    alarms
        .into_iter()
        .take(MAX_ALARMS)
        .map(|mut a| {
            a.hour = a.hour.min(23);
            a.minute = a.minute.min(59);
            a.days.retain(|d| *d < 7);
            a.days.sort_unstable();
            a.days.dedup();
            a.label = clean_label(&a.label);
            if a.id == 0 || seen.contains(&a.id) {
                next += 1;
                a.id = next;
            }
            seen.push(a.id);
            a
        })
        .collect()
}

/// Próxima vez que suena `alarm` estrictamente después de `after` (hora local).
pub fn next_occurrence(alarm: &Alarm, after: NaiveDateTime) -> Option<NaiveDateTime> {
    if !alarm.enabled {
        return None;
    }
    let time = NaiveTime::from_hms_opt(alarm.hour.into(), alarm.minute.into(), 0)?;
    (0..=7u64)
        .filter_map(|d| after.date().checked_add_days(Days::new(d)))
        .map(|date| date.and_time(time))
        .find(|t| {
            *t > after && (alarm.days.is_empty() || alarm.days.contains(&(t.weekday().num_days_from_monday() as u8)))
        })
}

/// Instante actual en ambos relojes.
#[derive(Debug, Clone, Copy)]
pub struct Now {
    pub mono: Instant,
    pub local: NaiveDateTime,
}

impl Now {
    pub fn real() -> Self {
        Self { mono: Instant::now(), local: chrono::Local::now().naive_local() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Timer,
    Alarm,
}

/// Aviso pendiente en la isla hasta que se detiene o se pospone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub id: u64,
    pub kind: Kind,
    /// Id del temporizador o de la alarma.
    pub source: u64,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimerAction {
    Pause,
    Resume,
    Cancel,
}

#[derive(Debug, Clone, Copy)]
enum Run {
    Until(Instant),
    Paused(Duration),
}

#[derive(Debug, Clone)]
struct Timer {
    id: u64,
    label: String,
    duration: Duration,
    run: Run,
}

/// Lo que ve la interfaz. Los restantes son relativos al momento de la respuesta.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub timers: Vec<TimerView>,
    pub alerts: Vec<Alert>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerView {
    pub id: u64,
    pub label: String,
    pub duration_ms: u64,
    pub remaining_ms: u64,
    pub running: bool,
}

/// Estado del reloj. Las alarmas llevan la hora desde la que están «armadas»
/// para que una alarma nueva o editada no avise un vencimiento anterior.
#[derive(Debug, Default)]
pub struct Clock {
    alarms: Vec<(Alarm, NaiveDateTime)>,
    timers: Vec<Timer>,
    snoozes: Vec<(u64, String, Instant)>,
    alerts: Vec<Alert>,
    last_check: Option<NaiveDateTime>,
    next_id: u64,
}

impl Clock {
    fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    pub fn set_alarms(&mut self, alarms: &[Alarm], now: NaiveDateTime) {
        let old = std::mem::take(&mut self.alarms);
        self.alarms = alarms
            .iter()
            .map(|a| {
                let armed = old.iter().find(|(o, _)| o == a).map_or(now, |(_, t)| *t);
                (a.clone(), armed)
            })
            .collect();
    }

    pub fn add_timer(&mut self, label: &str, secs: u64, now: Instant) -> Result<(), String> {
        if !(1..=MAX_TIMER_SECS).contains(&secs) {
            return Err("La duración debe estar entre 1 segundo y 24 horas".into());
        }
        if self.timers.len() >= MAX_TIMERS {
            return Err(format!("Máximo {MAX_TIMERS} temporizadores"));
        }
        let duration = Duration::from_secs(secs);
        let id = self.id();
        self.timers.push(Timer { id, label: clean_label(label), duration, run: Run::Until(now + duration) });
        Ok(())
    }

    /// `false` si el temporizador no existe.
    pub fn control_timer(&mut self, id: u64, action: TimerAction, now: Instant) -> bool {
        let Some(i) = self.timers.iter().position(|t| t.id == id) else { return false };
        let t = &mut self.timers[i];
        match (action, t.run) {
            (TimerAction::Pause, Run::Until(due)) => t.run = Run::Paused(due.saturating_duration_since(now)),
            (TimerAction::Resume, Run::Paused(left)) => t.run = Run::Until(now + left),
            (TimerAction::Cancel, _) => {
                self.timers.remove(i);
            }
            _ => {}
        }
        true
    }

    /// Quita un aviso; si es de alarma y `snooze`, vuelve a sonar en 5 min.
    pub fn dismiss(&mut self, alert_id: u64, snooze: bool, now: Instant) {
        if let Some(i) = self.alerts.iter().position(|a| a.id == alert_id) {
            let a = self.alerts.remove(i);
            if snooze && a.kind == Kind::Alarm {
                self.snoozes.push((a.source, a.label, now + SNOOZE));
            }
        }
    }

    pub fn has_alerts(&self) -> bool {
        !self.alerts.is_empty()
    }

    pub fn view(&self, now: Instant) -> View {
        View {
            timers: self
                .timers
                .iter()
                .map(|t| {
                    let (left, running) = match t.run {
                        Run::Until(due) => (due.saturating_duration_since(now), true),
                        Run::Paused(left) => (left, false),
                    };
                    TimerView {
                        id: t.id,
                        label: t.label.clone(),
                        duration_ms: t.duration.as_millis() as u64,
                        remaining_ms: left.as_millis() as u64,
                        running,
                    }
                })
                .collect(),
            alerts: self.alerts.clone(),
        }
    }

    /// Vence lo que toque en `now` y devuelve los avisos nuevos, del más antiguo al más reciente.
    pub fn tick(&mut self, now: &Now) -> Vec<Alert> {
        // (cuánto hace que venció, tipo, origen, nombre)
        let mut due: Vec<(Duration, Kind, u64, String)> = Vec::new();

        self.timers.retain(|t| match t.run {
            Run::Until(at) if at <= now.mono => {
                due.push((now.mono - at, Kind::Timer, t.id, t.label.clone()));
                false
            }
            _ => true,
        });
        self.snoozes.retain(|(source, label, at)| {
            let fired = *at <= now.mono;
            if fired {
                due.push((now.mono - *at, Kind::Alarm, *source, label.clone()));
            }
            !fired
        });
        // Si la hora retrocedió (cambio manual), la ventana empieza en `now`.
        let last = self.last_check.filter(|l| *l <= now.local).unwrap_or(now.local);
        for (alarm, armed) in &mut self.alarms {
            let from = last.max(*armed);
            if let Some(at) = next_occurrence(alarm, from).filter(|at| *at <= now.local) {
                let ago = (now.local - at).to_std().unwrap_or_default();
                due.push((ago, Kind::Alarm, alarm.id, alarm.label.clone()));
                if alarm.days.is_empty() {
                    alarm.enabled = false;
                }
            }
        }
        self.last_check = Some(now.local);

        due.sort_by_key(|d| std::cmp::Reverse(d.0));
        let fired: Vec<Alert> = due
            .into_iter()
            .map(|(_, kind, source, label)| Alert { id: self.id(), kind, source, label })
            .collect();
        self.alerts.extend(fired.iter().cloned());
        fired
    }

    /// Cuánto dormir desde `now`; `None` si no hay nada programado.
    pub fn next_wake(&self, now: &Now) -> Option<Duration> {
        let mono = self
            .timers
            .iter()
            .filter_map(|t| match t.run {
                Run::Until(at) => Some(at),
                Run::Paused(_) => None,
            })
            .chain(self.snoozes.iter().map(|s| s.2))
            .map(|at| at.saturating_duration_since(now.mono));
        let local = self
            .alarms
            .iter()
            .filter_map(|(a, _)| next_occurrence(a, now.local))
            .map(|at| (at - now.local).to_std().unwrap_or_default());
        mono.chain(local).min().map(|d| d.min(GUARD))
    }
}

/// El reloj compartido entre los comandos y el hilo programador.
#[derive(Default)]
pub struct Scheduler {
    clock: Mutex<Clock>,
    changed: Condvar,
}

impl Scheduler {
    fn lock(&self) -> MutexGuard<'_, Clock> {
        self.clock.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Solo lectura: no despierta al programador.
    pub fn read<R>(&self, f: impl FnOnce(&Clock) -> R) -> R {
        f(&self.lock())
    }

    /// Lee o modifica el reloj y despierta al programador para que recalcule.
    pub fn with<R>(&self, f: impl FnOnce(&mut Clock) -> R) -> R {
        let r = f(&mut self.lock());
        self.changed.notify_one();
        r
    }

    /// Bucle del hilo programador. `on_fired` se llama sin el bloqueo tomado.
    pub fn run(&self, mut on_fired: impl FnMut(Vec<Alert>)) {
        let mut clock = self.lock();
        loop {
            let now = Now::real();
            let fired = clock.tick(&now);
            if !fired.is_empty() {
                drop(clock);
                on_fired(fired);
                clock = self.lock();
                continue;
            }
            // El bloqueo se mantiene desde `tick` hasta la espera: ningún cambio se pierde.
            clock = match clock.next_wake(&now) {
                Some(d) => self.changed.wait_timeout(clock, d).map(|r| r.0).unwrap_or_else(|p| p.into_inner().0),
                None => self.changed.wait(clock).unwrap_or_else(|p| p.into_inner()),
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    /// 2026-10-19 es lunes.
    fn at(day: u32, h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, day).unwrap().and_hms_opt(h, m, 0).unwrap()
    }
    fn alarm(id: u64, hour: u8, minute: u8, days: &[u8]) -> Alarm {
        Alarm { id, hour, minute, days: days.to_vec(), ..Alarm::default() }
    }

    #[test]
    fn once_today_or_tomorrow() {
        let a = alarm(1, 7, 30, &[]);
        assert_eq!(next_occurrence(&a, at(19, 6, 0)), Some(at(19, 7, 30)));
        assert_eq!(next_occurrence(&a, at(19, 7, 30)), Some(at(20, 7, 30)), "estrictamente después");
        assert_eq!(next_occurrence(&a, at(19, 9, 0)), Some(at(20, 7, 30)));
        assert_eq!(next_occurrence(&Alarm { enabled: false, ..a }, at(19, 6, 0)), None);
    }

    #[test]
    fn repeat_days_and_weekday_change() {
        // Solo viernes (4), desde el miércoles 21.
        assert_eq!(next_occurrence(&alarm(1, 8, 0, &[4]), at(21, 12, 0)), Some(at(23, 8, 0)));
        // Lunes a viernes, desde el viernes por la tarde: el lunes siguiente.
        assert_eq!(next_occurrence(&alarm(1, 8, 0, &[0, 1, 2, 3, 4]), at(23, 9, 0)), Some(at(26, 8, 0)));
        // Solo lunes, el mismo lunes ya pasada la hora: una semana después.
        assert_eq!(next_occurrence(&alarm(1, 8, 0, &[0]), at(19, 8, 1)), Some(at(26, 8, 0)));
        // Domingo 23:59 → lunes 00:10 (cambio de día de la semana).
        assert_eq!(next_occurrence(&alarm(1, 0, 10, &[0]), at(25, 23, 59)), Some(at(26, 0, 10)));
    }

    #[test]
    fn crosses_midnight() {
        assert_eq!(next_occurrence(&alarm(1, 0, 5, &[]), at(19, 23, 58)), Some(at(20, 0, 5)));
        // Fin de mes.
        assert_eq!(next_occurrence(&alarm(1, 0, 5, &[]), at(31, 23, 58)).map(|t| t.date()), NaiveDate::from_ymd_opt(2026, 11, 1));
    }

    #[test]
    fn normalize_assigns_ids_and_clamps() {
        let raw = vec![
            Alarm { id: 0, hour: 30, minute: 99, days: vec![6, 1, 1, 9], label: "  Gym \n".into(), enabled: true },
            Alarm { id: 5, ..Alarm::default() },
            Alarm { id: 5, ..Alarm::default() },
        ];
        let n = normalize_alarms(raw);
        assert_eq!((n[0].hour, n[0].minute, n[0].days.clone(), n[0].label.as_str()), (23, 59, vec![1, 6], "Gym"));
        let ids: Vec<u64> = n.iter().map(|a| a.id).collect();
        assert_eq!(ids, [6, 5, 7]);
    }

    fn now(mono: Instant, local: NaiveDateTime) -> Now {
        Now { mono, local }
    }

    #[test]
    fn timers_fire_in_due_order_without_sleeping() {
        let t0 = Instant::now();
        let local = at(19, 10, 0);
        let mut c = Clock::default();
        c.add_timer("c", 3, t0).unwrap();
        c.add_timer("a", 1, t0).unwrap();
        c.add_timer("b", 2, t0).unwrap();
        assert_eq!(c.next_wake(&now(t0, local)), Some(Duration::from_secs(1)));

        let fired = c.tick(&now(t0 + Duration::from_millis(2500), local));
        let labels: Vec<&str> = fired.iter().map(|a| a.label.as_str()).collect();
        assert_eq!(labels, ["a", "b"]);
        assert_eq!(c.next_wake(&now(t0 + Duration::from_millis(2500), local)), Some(Duration::from_millis(500)));
        assert_eq!(c.tick(&now(t0 + Duration::from_secs(3), local))[0].label, "c");
        assert_eq!(c.view(t0).alerts.len(), 3);
        assert_eq!(c.next_wake(&now(t0 + Duration::from_secs(3), local)), None, "nada programado");
    }

    #[test]
    fn pause_resume_cancel() {
        let t0 = Instant::now();
        let s = |n| t0 + Duration::from_secs(n);
        let local = at(19, 10, 0);
        let mut c = Clock::default();
        c.add_timer("", 10, t0).unwrap();
        let id = c.view(t0).timers[0].id;
        c.control_timer(id, TimerAction::Pause, s(4));
        assert!(c.tick(&now(s(20), local)).is_empty(), "pausado no vence");
        assert_eq!(c.next_wake(&now(s(20), local)), None);
        c.control_timer(id, TimerAction::Resume, s(20));
        assert_eq!(c.view(s(20)).timers[0].remaining_ms, 6000);
        assert!(c.tick(&now(s(25), local)).is_empty());
        assert_eq!(c.tick(&now(s(26), local)).len(), 1);
        c.add_timer("", 10, t0).unwrap();
        let id = c.view(t0).timers[0].id;
        assert!(c.control_timer(id, TimerAction::Cancel, t0));
        assert!(c.view(t0).timers.is_empty());
        assert!(!c.control_timer(id, TimerAction::Pause, t0));
        assert!(c.add_timer("", 0, t0).is_err());
    }

    #[test]
    fn alarm_after_sleep_fires_once_and_snooze() {
        let t0 = Instant::now();
        let mut c = Clock::default();
        c.set_alarms(&[alarm(1, 7, 0, &[]), alarm(2, 7, 0, &[0, 1, 2, 3, 4, 5, 6])], at(18, 22, 0));
        assert!(c.tick(&now(t0, at(18, 23, 0))).is_empty());
        // El PC durmió desde el domingo 23:00 hasta el miércoles 9:00: cada alarma avisa una vez.
        let fired = c.tick(&now(t0, at(21, 9, 0)));
        assert_eq!(fired.iter().map(|a| a.source).collect::<Vec<_>>(), [1, 2]);
        assert!(c.tick(&now(t0, at(21, 9, 1))).is_empty(), "no se repite");
        // La de una sola vez queda desactivada; la diaria vuelve mañana.
        assert_eq!(c.next_wake(&now(t0, at(21, 9, 1))), Some(GUARD));
        assert!(next_occurrence(&c.alarms[0].0, at(21, 9, 1)).is_none());

        // Posponer: vuelve a sonar a los 5 min (reloj monotónico).
        let alert = fired[1].id;
        c.dismiss(alert, true, t0);
        assert_eq!(c.view(t0).alerts.len(), 1);
        assert!(c.tick(&now(t0 + SNOOZE - Duration::from_secs(1), at(21, 9, 2))).is_empty());
        let again = c.tick(&now(t0 + SNOOZE, at(21, 9, 6)));
        assert_eq!((again.len(), again[0].source, again[0].kind), (1, 2, Kind::Alarm));
        // Detener (sin posponer) no deja nada pendiente.
        c.dismiss(again[0].id, false, t0);
        assert!(c.snoozes.is_empty());
    }

    #[test]
    fn new_alarm_does_not_fire_for_the_past_and_clock_going_back() {
        let t0 = Instant::now();
        let mut c = Clock::default();
        assert!(c.tick(&now(t0, at(19, 6, 0))).is_empty());
        // Se crea a las 9:00 una alarma de las 7:00 tras horas sin comprobaciones.
        c.set_alarms(&[alarm(1, 7, 0, &[])], at(19, 9, 0));
        assert!(c.tick(&now(t0, at(19, 9, 0))).is_empty());
        // La hora retrocede a las 6:00: no avisa nada y la alarma vuelve a las 7:00.
        assert!(c.tick(&now(t0, at(19, 6, 0))).is_empty());
        assert!(c.tick(&now(t0, at(19, 6, 59))).is_empty());
        // Ventana (6:59, 7:00]; desde 9:00 armada, así que no hasta mañana.
        assert!(c.tick(&now(t0, at(19, 7, 0))).is_empty());
        assert_eq!(c.tick(&now(t0, at(20, 7, 0))).len(), 1);
    }
}
