//! Clima público: ciudad manual, hosts fijos y caché exclusivamente en memoria (D-080).
#![cfg_attr(
    not(test),
    deny(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing
    )
)]

use crate::cloud::{CloudError, ErrorKind, Feed};
use jarwis_auth::reqwest::{self, Url};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

const SEARCH: &str = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST: &str = "https://api.open-meteo.com/v1/forecast";
const TTL: Duration = Duration::from_secs(1800);
const FORCE_MIN: Duration = Duration::from_secs(60);
const MAX_BYTES: usize = 65536;

/// Lista cerrada: la WebView elige una acción y nunca proporciona una URL.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkTarget {
    Provider,
    Licence,
}
impl LinkTarget {
    pub fn url(&self) -> &'static str {
        match self {
            Self::Provider => "https://open-meteo.com/",
            Self::Licence => "https://open-meteo.com/en/licence",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherPlace {
    pub name: String,
    pub admin: Option<String>,
    pub country: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
}

impl WeatherPlace {
    pub fn validate(&self) -> Result<Self, String> {
        fn text(raw: &str) -> Result<String, String> {
            let trimmed = raw.trim();
            if raw.chars().any(char::is_control)
                || trimmed.is_empty()
                || trimmed.chars().count() > 80
            {
                return Err(
                    "El lugar debe tener textos de 1 a 80 caracteres, sin controles".into(),
                );
            }
            Ok(trimmed.into())
        }
        if !self.latitude.is_finite()
            || !self.longitude.is_finite()
            || !(-90.0..=90.0).contains(&self.latitude)
            || !(-180.0..=180.0).contains(&self.longitude)
        {
            return Err("Las coordenadas de la ciudad no son válidas".into());
        }
        Ok(Self {
            name: text(&self.name)?,
            admin: self.admin.as_deref().map(text).transpose()?,
            country: self.country.as_deref().map(text).transpose()?,
            ..self.clone()
        })
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeatherView {
    pub temperature: f64,
    pub maximum: Option<f64>,
    pub minimum: Option<f64>,
    pub rain_probability: Option<f64>,
    pub weather_code: u8,
    pub daily_code: Option<u8>,
    pub is_day: bool,
}

fn failure(kind: ErrorKind) -> CloudError {
    let message = match kind {
        ErrorKind::Network => {
            "Sin conexión con Open-Meteo. Se conservan los últimos datos disponibles."
        }
        ErrorKind::Quota => "Open-Meteo limitó la consulta. Vuelve a intentarlo más tarde.",
        _ => "Open-Meteo devolvió datos de clima no válidos.",
    };
    CloudError {
        kind,
        message: message.into(),
    }
}

fn search_url(query: &str) -> Result<Url, String> {
    let query = query.trim();
    if !(2..=60).contains(&query.chars().count()) || query.chars().any(char::is_control) {
        return Err("Escribe entre 2 y 60 caracteres para buscar una ciudad".into());
    }
    let mut url = Url::parse(SEARCH).map_err(|_| "No se pudo preparar la búsqueda")?;
    url.query_pairs_mut().extend_pairs([
        ("name", query),
        ("count", "5"),
        ("language", "es"),
        ("format", "json"),
    ]);
    Ok(url)
}

fn forecast_url(place: &WeatherPlace) -> Result<Url, CloudError> {
    let mut url = Url::parse(FORECAST).map_err(|_| failure(ErrorKind::Other))?;
    url.query_pairs_mut().extend_pairs([
        ("latitude", format!("{:.2}", place.latitude)),
        ("longitude", format!("{:.2}", place.longitude)),
        ("current", "temperature_2m,weather_code,is_day".into()),
        (
            "daily",
            "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code"
                .into(),
        ),
        ("timezone", "auto".into()),
        ("forecast_days", "1".into()),
    ]);
    Ok(url)
}

async fn get_json<T: serde::de::DeserializeOwned>(url: Url) -> Result<T, CloudError> {
    // Sin redirecciones, cookies, autenticación ni cabeceras del usuario.
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| failure(ErrorKind::Network))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| failure(ErrorKind::Network))?;
    if !response.status().is_success() {
        return Err(failure(if response.status().as_u16() == 429 {
            ErrorKind::Quota
        } else {
            ErrorKind::Network
        }));
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(failure(ErrorKind::Other));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| failure(ErrorKind::Network))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err(failure(ErrorKind::Other));
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| failure(ErrorKind::Other))
}

#[derive(Deserialize)]
struct SearchResult {
    #[serde(default)]
    results: Vec<Candidate>,
}
#[derive(Deserialize)]
struct Candidate {
    name: String,
    admin1: Option<String>,
    country: Option<String>,
    latitude: f64,
    longitude: f64,
}
fn candidates(raw: SearchResult) -> Vec<WeatherPlace> {
    raw.results
        .into_iter()
        .filter_map(|c| {
            WeatherPlace {
                name: c.name,
                admin: c.admin1,
                country: c.country,
                latitude: c.latitude,
                longitude: c.longitude,
            }
            .validate()
            .ok()
        })
        .take(5)
        .collect()
}
pub async fn search(query: &str) -> Result<Vec<WeatherPlace>, String> {
    let url = search_url(query)?;
    get_json(url).await.map(candidates).map_err(|e| e.message)
}

#[derive(Deserialize)]
struct Forecast {
    current: Current,
    daily: Daily,
}
#[derive(Deserialize)]
struct Current {
    temperature_2m: f64,
    weather_code: u8,
    is_day: u8,
}
#[derive(Deserialize)]
struct Daily {
    temperature_2m_max: Vec<Option<f64>>,
    temperature_2m_min: Vec<Option<f64>>,
    precipitation_probability_max: Vec<Option<f64>>,
    weather_code: Vec<Option<u8>>,
}
fn valid_code(code: u8) -> bool {
    matches!(
        code,
        0..=3
            | 45
            | 48
            | 51
            | 53
            | 55
            | 56
            | 57
            | 61
            | 63
            | 65
            | 66
            | 67
            | 71
            | 73
            | 75
            | 77
            | 80
            | 81
            | 82
            | 85
            | 86
            | 95
            | 96
            | 99
    )
}
fn parse_forecast(raw: Forecast) -> Result<WeatherView, CloudError> {
    let bad = || failure(ErrorKind::Other);
    fn one<T: Copy>(items: Vec<Option<T>>) -> Result<Option<T>, CloudError> {
        if items.len() == 1 {
            Ok(items.first().copied().flatten())
        } else {
            Err(failure(ErrorKind::Other))
        }
    }
    let maximum = one(raw.daily.temperature_2m_max)?;
    let minimum = one(raw.daily.temperature_2m_min)?;
    let rain_probability = one(raw.daily.precipitation_probability_max)?;
    let daily_code = one(raw.daily.weather_code)?;
    if [Some(raw.current.temperature_2m), maximum, minimum]
        .iter()
        .flatten()
        .any(|n| !n.is_finite() || !(-100.0..=70.0).contains(n))
        || minimum.zip(maximum).is_some_and(|(min, max)| min > max)
        || rain_probability.is_some_and(|n| !n.is_finite() || !(0.0..=100.0).contains(&n))
        || raw.current.is_day > 1
        || !valid_code(raw.current.weather_code)
        || daily_code.is_some_and(|code| !valid_code(code))
    {
        return Err(bad());
    }
    Ok(WeatherView {
        temperature: raw.current.temperature_2m,
        maximum,
        minimum,
        rain_probability,
        weather_code: raw.current.weather_code,
        daily_code,
        is_day: raw.current.is_day == 1,
    })
}

#[derive(Default)]
struct Cache {
    place: Option<WeatherPlace>,
    generation: u64,
    attempted: Option<Instant>,
    data: Option<WeatherView>,
    updated_at: Option<u64>,
    error: Option<CloudError>,
}
impl Cache {
    fn feed(&self) -> Feed<WeatherView> {
        Feed {
            data: self.data.clone(),
            updated_at: self.updated_at,
            error: self.error.clone(),
        }
    }
    fn begin(&mut self, force: bool, now: Instant) -> Option<(WeatherPlace, u64)> {
        let place = self.place.clone()?;
        if self.attempted.is_some_and(|at| {
            now.saturating_duration_since(at) < if force { FORCE_MIN } else { TTL }
        }) {
            return None;
        }
        self.attempted = Some(now);
        Some((place, self.generation))
    }
    fn finish(&mut self, generation: u64, result: Result<WeatherView, CloudError>) {
        if generation != self.generation {
            return;
        }
        match result {
            Ok(data) => {
                self.data = Some(data);
                self.updated_at = Some(chrono::Utc::now().timestamp_millis().max(0) as u64);
                self.error = None;
            }
            Err(e) => self.error = Some(e),
        }
    }
}
#[derive(Default)]
pub struct Weather(Mutex<Cache>);
impl Weather {
    fn lock(&self) -> MutexGuard<'_, Cache> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
    pub fn set_place(&self, place: Option<WeatherPlace>) {
        let mut cache = self.lock();
        if cache.place != place {
            *cache = Cache {
                place,
                generation: cache.generation.wrapping_add(1),
                ..Cache::default()
            };
        }
    }
    pub async fn today(&self, force: bool) -> Feed<WeatherView> {
        let request = self.lock().begin(force, Instant::now());
        if let Some((place, generation)) = request {
            let result = match forecast_url(&place) {
                Ok(url) => get_json(url).await.and_then(parse_forecast),
                Err(e) => Err(e),
            };
            self.lock().finish(generation, result);
        }
        self.lock().feed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn place() -> WeatherPlace {
        WeatherPlace {
            name: " Madrid ".into(),
            admin: None,
            country: Some(" España ".into()),
            latitude: 40.4168,
            longitude: -3.7038,
        }
    }
    fn raw() -> Forecast {
        serde_json::from_value(serde_json::json!({"current":{"temperature_2m":20.5,"weather_code":1,"is_day":1},"daily":{"temperature_2m_max":[24.0],"temperature_2m_min":[12.0],"precipitation_probability_max":[15.0],"weather_code":[3]}})).unwrap()
    }
    #[test]
    fn validates_place() {
        assert_eq!(place().validate().unwrap().name, "Madrid");
        for n in [f64::NAN, f64::INFINITY, -91.0, 91.0] {
            assert!(WeatherPlace {
                latitude: n,
                ..place()
            }
            .validate()
            .is_err());
        }
        for n in [f64::NAN, f64::NEG_INFINITY, -181.0, 181.0] {
            assert!(WeatherPlace {
                longitude: n,
                ..place()
            }
            .validate()
            .is_err());
        }
        for name in ["".into(), "x\n".into(), "ñ".repeat(81)] {
            assert!(WeatherPlace { name, ..place() }.validate().is_err());
        }
        assert!(WeatherPlace {
            admin: Some("a\0".into()),
            ..place()
        }
        .validate()
        .is_err());
        assert!(WeatherPlace {
            country: Some("x".repeat(81)),
            ..place()
        }
        .validate()
        .is_err());
        assert!(WeatherPlace {
            latitude: -90.0,
            longitude: 180.0,
            name: "ñ".repeat(80),
            ..place()
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn urls_encode_queries_and_round_coordinates() {
        let q = "A &name=otro/ñ?";
        let url = search_url(q).unwrap();
        assert_eq!(url.host_str(), Some("geocoding-api.open-meteo.com"));
        assert_eq!(url.scheme(), "https");
        assert_eq!(url.query_pairs().find(|(k, _)| k == "name").unwrap().1, q);
        assert_eq!(url.query_pairs().count(), 4);
        for q in ["a", "", "\nx\ny"] {
            assert!(search_url(q).is_err());
        }
        assert!(search_url(&"x".repeat(61)).is_err());
        let url = forecast_url(&place()).unwrap();
        let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.host_str(), Some("api.open-meteo.com"));
        assert_eq!(pairs["latitude"], "40.42");
        assert_eq!(pairs["longitude"], "-3.70");
        assert_eq!(pairs["forecast_days"], "1");
        assert_eq!(pairs["timezone"], "auto");
    }
    #[test]
    fn sanitizes_responses() {
        assert_eq!(parse_forecast(raw()).unwrap().temperature, 20.5);
        let mut r = raw();
        r.current.temperature_2m = f64::NAN;
        assert!(parse_forecast(r).is_err());
        let mut r = raw();
        r.daily.temperature_2m_min = vec![Some(30.0)];
        assert!(parse_forecast(r).is_err());
        let mut r = raw();
        r.daily.precipitation_probability_max = vec![Some(101.0)];
        assert!(parse_forecast(r).is_err());
        let mut r = raw();
        r.daily.temperature_2m_max.clear();
        assert!(parse_forecast(r).is_err());
        let mut r = raw();
        r.current.weather_code = 4;
        assert!(parse_forecast(r).is_err());
        let mut r = raw();
        r.current.is_day = 2;
        assert!(parse_forecast(r).is_err());
        let results = SearchResult {
            results: (0..8)
                .map(|i| Candidate {
                    name: if i == 0 { "\0".into() } else { "Ciudad".into() },
                    admin1: None,
                    country: None,
                    latitude: 1.0,
                    longitude: 2.0,
                })
                .collect(),
        };
        assert_eq!(candidates(results).len(), 5);
    }
    #[test]
    fn ttl_force_errors_and_invalidation() {
        let w = Weather::default();
        w.set_place(Some(place()));
        let now = Instant::now();
        let (_, g) = w.lock().begin(false, now).unwrap();
        w.lock().finish(g, Ok(parse_forecast(raw()).unwrap()));
        assert!(w
            .lock()
            .begin(true, now + Duration::from_secs(59))
            .is_none());
        assert!(w
            .lock()
            .begin(false, now + Duration::from_secs(1799))
            .is_none());
        assert!(w.lock().begin(false, now + TTL).is_some());
        w.lock().finish(g, Err(failure(ErrorKind::Network)));
        assert!(w.lock().feed().data.is_some());
        assert!(w.lock().feed().error.is_some());
        assert!(w.lock().begin(true, now + TTL + FORCE_MIN).is_some());
        w.set_place(None);
        w.lock().finish(g, Ok(parse_forecast(raw()).unwrap()));
        assert!(w.lock().feed().data.is_none());
        w.set_place(Some(WeatherPlace {
            latitude: 2.0,
            ..place()
        }));
        assert!(w.lock().begin(false, now).is_some());
    }
    #[test]
    fn attribution_uses_only_fixed_destinations() {
        for (key, url) in [
            ("provider", "https://open-meteo.com/"),
            ("licence", "https://open-meteo.com/en/licence"),
        ] {
            let target: LinkTarget = serde_json::from_value(serde_json::json!(key)).unwrap();
            assert_eq!(target.url(), url);
        }
        for key in ["https://evil.example/", "https://open-meteo.com/", "Provider", ""] {
            assert!(serde_json::from_value::<LinkTarget>(serde_json::json!(key)).is_err());
        }
    }
    #[test]
    fn null_daily_values_preserve_current_weather() {
        let original = serde_json::json!({"current":{"temperature_2m":20.5,"weather_code":1,"is_day":1},"daily":{"temperature_2m_max":[24.0],"temperature_2m_min":[12.0],"precipitation_probability_max":[15.0],"weather_code":[3]}});
        for key in ["temperature_2m_max", "temperature_2m_min", "precipitation_probability_max", "weather_code"] {
            let mut value = original.clone();
            value["daily"][key] = serde_json::json!([null]);
            let view = parse_forecast(serde_json::from_value(value).unwrap()).unwrap();
            assert_eq!(view.temperature, 20.5);
            assert_eq!(view.maximum.is_none(), key == "temperature_2m_max");
            assert_eq!(view.minimum.is_none(), key == "temperature_2m_min");
            assert_eq!(view.rain_probability.is_none(), key == "precipitation_probability_max");
            assert_eq!(view.daily_code.is_none(), key == "weather_code");
        }
        let mut r = raw();
        r.daily.temperature_2m_max = vec![None];
        r.daily.temperature_2m_min = vec![None];
        r.daily.precipitation_probability_max = vec![None];
        r.daily.weather_code = vec![None];
        assert!(parse_forecast(r).is_ok());
        let mut r = raw();
        r.daily.temperature_2m_max = vec![Some(f64::NAN)];
        assert!(parse_forecast(r).is_err());
        let mut r = raw();
        r.daily.weather_code = vec![Some(4)];
        assert!(parse_forecast(r).is_err());
    }
    #[test]
    fn concurrent_today_returns_cached_result_after_completion() {
        let w = Weather::default();
        w.set_place(Some(place()));
        let (_, generation) = w.lock().begin(false, Instant::now()).unwrap();
        let pending = tauri::async_runtime::block_on(w.today(false));
        assert!(pending.data.is_none() && pending.error.is_none());
        w.lock().finish(generation, Ok(parse_forecast(raw()).unwrap()));
        let completed = tauri::async_runtime::block_on(w.today(false));
        assert_eq!(completed.data.unwrap().temperature, 20.5);
    }
    #[test]
    fn no_place_never_requests() {
        let w = Weather::default();
        assert!(w.lock().begin(true, Instant::now()).is_none());
        let feed = tauri::async_runtime::block_on(w.today(true));
        assert!(feed.data.is_none() && feed.error.is_none());
        assert!(w.lock().attempted.is_none());
    }
    #[test]
    #[ignore = "Una única petición pública autorizada; ejecutar explícitamente"]
    fn public_madrid_parse() {
        let result = tauri::async_runtime::block_on(async {
            get_json(forecast_url(&place()).unwrap())
                .await
                .and_then(parse_forecast)
        });
        assert!(result.is_ok(), "La consulta pública debe poder sanearse");
    }
}
